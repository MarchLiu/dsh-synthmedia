/**
 * Ecosystem contract tests — Aliyun Wanxiang (dashscope-wan-compatible),
 * Google GenAI (google-genmedia-compatible) and OpenAI media
 * (openai-images-compatible + the openai-video-compatible adapter, exercised
 * via a custom in-test profile — the former `openai-video` Sora preset profile
 * was removed because the official Sora Videos API shut down on 2026-09-24;
 * the adapter itself still serves third-party compatible gateways).
 *
 * Wire shapes come from the OFFICIAL docs (fetched 2026-11):
 * - DashScope: https://help.aliyun.com/zh/model-studio/legacy-wan-text-to-video-api-reference
 *              https://help.aliyun.com/zh/model-studio/manage-asynchronous-tasks
 * - Gemini:    https://ai.google.dev/gemini-api/docs/imagen, /docs/video
 * - OpenAI:    https://developers.openai.com/api/docs/guides/image-generation
 *
 * EVERYTHING here runs against LOCAL mock servers. NO real remote generation
 * call is ever made; credentials are throwaway env values injected per test
 * and deleted afterwards.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// 0xff / 0x80 / multi-byte UTF-8 / lone-invalid sequences: must survive byte-for-byte.
const BIN = Buffer.from([0x00, 0xff, 0x80, 0x41, 0xe7, 0xa0, 0x8d, 0xe2, 0x82, 0xac, 0x7f, 0xc3, 0x28]);

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(undefined);
      }
    });
  });
}

async function makeJobs(baseOverrides) {
  const { resolveConfig } = await import('../lib/config.js');
  const { createBackendRegistry } = await import('../lib/backends/index.js');
  const { JobManager } = await import('../lib/jobs.js');
  const dir = await mkdtemp(join(tmpdir(), 'synth-eco-'));
  const cfg = resolveConfig({ outputDir: dir, backends: baseOverrides });
  return new JobManager(cfg, createBackendRegistry(cfg));
}

// ---------------------------------------------------------------- DashScope

test('dashscope-wan video: submit → poll PENDING/RUNNING → SUCCEEDED video_url → binary download, then cancel', async () => {
  const seen = { submitHeaders: {}, submit: null, polls: 0, cdnAuth: null, cancel: null };
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/services/aigc/video-generation/video-synthesis') {
      seen.submitHeaders = req.headers;
      seen.submit = await readJson(req);
      json(res, 200, { output: { task_id: 'wan-task-001', task_status: 'PENDING' }, request_id: 'r-1' });
    } else if (req.method === 'GET' && req.url === '/api/v1/tasks/wan-task-001') {
      seen.polls += 1;
      if (seen.polls === 1) json(res, 200, { output: { task_id: 'wan-task-001', task_status: 'RUNNING' } });
      else {
        json(res, 200, {
          output: {
            task_id: 'wan-task-001',
            task_status: 'SUCCEEDED',
            video_url: `${base}/oss/wan-out.mp4`,
            end_time: '2026-11-13 10:00:00.000',
          },
          usage: { video_duration: 5 },
        });
      }
    } else if (req.method === 'GET' && req.url === '/oss/wan-out.mp4') {
      seen.cdnAuth = req.headers['authorization'] ?? null;
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(BIN);
    } else if (req.method === 'POST' && req.url === '/api/v1/tasks/wan-task-001/cancel') {
      seen.cancel = await readJson(req);
      json(res, 200, { request_id: 'r-cancel' });
    } else {
      json(res, 404, { code: 'NotFound', message: 'no such route' });
    }
  });
  const base = await listen(server);
  process.env.SYNTHMEDIA_DASHSCOPE_API_KEY = 'dash-test-key-0001';
  try {
    const jobs = await makeJobs({
      'dashscope-wan-video': { baseUrl: base, pollIntervalMs: 20, timeoutMs: 30_000, protocolVerified: true, blockRealSubmit: false },
    });
    const rec = await jobs.wait(
      (await jobs.start({
        backend: 'dashscope-wan-video',
        model: 'wan2.5-t2v-preview',
        modality: 'video',
        prompt: 'a koi pond at dusk',
        durationSeconds: 5,
        size: '1280*720',
      })).id,
    );
    assert.equal(rec.status, 'succeeded');
    assert.equal(rec.remoteId, 'wan-task-001');
    // Mandatory async header + bearer auth + official body shape.
    assert.equal(seen.submitHeaders['x-dashscope-async'], 'enable');
    assert.equal(seen.submitHeaders['authorization'], 'Bearer dash-test-key-0001');
    assert.equal(seen.submit.model, 'wan2.5-t2v-preview');
    assert.deepEqual(seen.submit.input, { prompt: 'a koi pond at dusk' });
    assert.equal(seen.submit.parameters.size, '1280*720');
    assert.equal(seen.submit.parameters.duration, 5);
    // Artifact downloaded binary-safe, NO credential header on the OSS URL.
    const artifact = rec.artifacts[0];
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(artifact.path);
    assert.equal(bytes.length, BIN.length);
    assert.deepEqual([...bytes.subarray(0, 3)], [0x00, 0xff, 0x80]);
    assert.deepEqual([...bytes.subarray(-4)], [...BIN.subarray(-4)]);
    assert.equal(seen.cdnAuth, null);
  } finally {
    delete process.env.SYNTHMEDIA_DASHSCOPE_API_KEY;
    server.close();
  }
});

test('dashscope-wan video: cancelling a PENDING task hits the documented cancel endpoint', async () => {
  let polls = 0;
  let cancelHits = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url.includes('video-synthesis')) {
      json(res, 200, { output: { task_id: 'wan-pending-1', task_status: 'PENDING' } });
    } else if (req.method === 'GET' && req.url === '/api/v1/tasks/wan-pending-1') {
      polls += 1;
      json(res, 200, { output: { task_id: 'wan-pending-1', task_status: 'PENDING' } });
    } else if (req.method === 'POST' && req.url === '/api/v1/tasks/wan-pending-1/cancel') {
      cancelHits += 1;
      json(res, 200, { request_id: 'r-cancel' });
    } else {
      json(res, 404, {});
    }
  });
  const base = await listen(server);
  process.env.SYNTHMEDIA_DASHSCOPE_API_KEY = 'dash-test-key-0001b';
  try {
    const jobs = await makeJobs({
      'dashscope-wan-video': { baseUrl: base, pollIntervalMs: 20, timeoutMs: 30_000, protocolVerified: true, blockRealSubmit: false },
    });
    const started = await jobs.start({ backend: 'dashscope-wan-video', model: 'wan2.5-t2v-preview', modality: 'video', prompt: 'x' });
    await new Promise((r) => setTimeout(r, 60)); // let it poll at least once
    await jobs.cancel(started.id);
    const rec = await jobs.wait(started.id);
    assert.equal(rec.status, 'cancelled');
    assert.equal(cancelHits, 1, 'remote cancel POST /api/v1/tasks/{id}/cancel was called');
  } finally {
    delete process.env.SYNTHMEDIA_DASHSCOPE_API_KEY;
    server.close();
  }
});

test('dashscope-wanx image: submit text2image → SUCCEEDED results[].url → binary png download', async () => {
  const seen = { submit: null, cdnHits: 0 };
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/services/aigc/text2image/image-synthesis') {
      seen.submit = await readJson(req);
      json(res, 200, { output: { task_id: 'wanx-task-42', task_status: 'PENDING' }, request_id: 'r-2' });
    } else if (req.method === 'GET' && req.url === '/api/v1/tasks/wanx-task-42') {
      json(res, 200, {
        output: {
          task_id: 'wanx-task-42',
          task_status: 'SUCCEEDED',
          results: [{ url: `${base}/oss/wanx-out.png` }],
          task_metrics: { TOTAL: 1, SUCCEEDED: 1 },
        },
        usage: { image_count: 1 },
      });
    } else if (req.method === 'GET' && req.url === '/oss/wanx-out.png') {
      seen.cdnHits += 1;
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(BIN);
    } else {
      json(res, 404, {});
    }
  });
  const base = await listen(server);
  process.env.SYNTHMEDIA_DASHSCOPE_API_KEY = 'dash-test-key-0002';
  try {
    const jobs = await makeJobs({
      'dashscope-wanx-image': { baseUrl: base, pollIntervalMs: 20, timeoutMs: 30_000, protocolVerified: true, blockRealSubmit: false },
    });
    const rec = await jobs.wait(
      (await jobs.start({
        backend: 'dashscope-wanx-image',
        model: 'wanx2.1-t2i-turbo',
        modality: 'image',
        prompt: 'a watercolor mountain',
        size: '1024*1024',
      })).id,
    );
    assert.equal(rec.status, 'succeeded');
    assert.equal(rec.remoteId, 'wanx-task-42');
    assert.equal(seen.submit.model, 'wanx2.1-t2i-turbo');
    assert.equal(seen.submit.parameters.size, '1024*1024');
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(rec.artifacts[0].path);
    assert.deepEqual([...bytes], [...BIN]);
    assert.equal(seen.cdnHits, 1);
  } finally {
    delete process.env.SYNTHMEDIA_DASHSCOPE_API_KEY;
    server.close();
  }
});

test('dashscope error shape: FAILED task carries output.code/message; HTTP 401 maps to E_AUTH', async () => {
  let mode = 'task-failed';
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url.includes('video-synthesis')) {
      if (mode === 'auth') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'InvalidApiKey', message: 'Invalid API-key provided.', request_id: 'r-3' }));
      } else {
        json(res, 200, { output: { task_id: 'wan-fail-1', task_status: 'PENDING' } });
      }
    } else if (req.method === 'GET' && req.url === '/api/v1/tasks/wan-fail-1') {
      json(res, 200, { output: { task_id: 'wan-fail-1', task_status: 'FAILED', code: 'DataInspectionFailed', message: 'Output data may contain inappropriate content.' } });
    } else {
      json(res, 404, {});
    }
  });
  const base = await listen(server);
  process.env.SYNTHMEDIA_DASHSCOPE_API_KEY = 'dash-test-key-0003';
  try {
    let jobs = await makeJobs({
      'dashscope-wan-video': { baseUrl: base, pollIntervalMs: 20, timeoutMs: 30_000, protocolVerified: true, blockRealSubmit: false },
    });
    const rec = await jobs.wait(
      (await jobs.start({ backend: 'dashscope-wan-video', model: 'wan2.2-t2v-plus', modality: 'video', prompt: 'x' })).id,
    );
    assert.equal(rec.status, 'failed');
    assert.equal(rec.error.code, 'DataInspectionFailed');

    mode = 'auth';
    jobs = await makeJobs({
      'dashscope-wan-video': { baseUrl: base, timeoutMs: 30_000, protocolVerified: true, blockRealSubmit: false },
    });
    const started = await jobs.start({ backend: 'dashscope-wan-video', model: 'wan2.2-t2v-plus', modality: 'video', prompt: 'x' });
    const authRec = await jobs.wait(started.id);
    assert.equal(authRec.status, 'failed');
    assert.equal(authRec.error.code, 'E_AUTH');
    assert.match(authRec.error.message, /Invalid API-key/);
  } finally {
    delete process.env.SYNTHMEDIA_DASHSCOPE_API_KEY;
    server.close();
  }
});

// -------------------------------------------------------------- Google GenAI

test('gemini imagen: :predict returns base64 predictions, decoded binary-safe inline', async () => {
  const seen = { auth: null, submit: null };
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1beta/models/imagen-4.0-generate-001:predict') {
      seen.auth = req.headers['x-goog-api-key'] ?? null;
      seen.submit = await readJson(req);
      json(res, 200, { predictions: [{ bytesBase64Encoded: BIN.toString('base64'), mimeType: 'image/png' }] });
    } else {
      json(res, 404, { error: { code: 404, message: 'not found', status: 'NOT_FOUND' } });
    }
  });
  const base = await listen(server);
  process.env.SYNTHMEDIA_GEMINI_API_KEY = 'gem-test-key-0001';
  try {
    const jobs = await makeJobs({
      'gemini-imagen': { baseUrl: base, timeoutMs: 30_000, protocolVerified: true, blockRealSubmit: false },
    });
    const rec = await jobs.wait(
      (await jobs.start({
        backend: 'gemini-imagen',
        model: 'imagen-4.0-generate-001',
        modality: 'image',
        prompt: 'a lighthouse in fog',
        size: '1024x1024',
      })).id,
    );
    assert.equal(rec.status, 'succeeded');
    assert.equal(seen.auth, 'gem-test-key-0001', 'x-goog-api-key auth');
    assert.deepEqual(seen.submit.instances, [{ prompt: 'a lighthouse in fog' }]);
    assert.equal(seen.submit.parameters.sampleCount, 1);
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(rec.artifacts[0].path);
    assert.deepEqual([...bytes], [...BIN]);
    assert.equal(rec.artifacts[0].mimeType, 'image/png');
  } finally {
    delete process.env.SYNTHMEDIA_GEMINI_API_KEY;
    server.close();
  }
});

test('gemini veo: predictLongRunning → operation poll → video.uri download (with api key), cancel, safety-filter failure shape', async () => {
  const seen = { polls: 0, dlAuth: null, cancelled: 0 };
  let failMode = false;
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1beta/models/veo-3.1-generate-preview:predictLongRunning') {
      json(res, 200, { name: 'models/veo-3.1-generate-preview/operations/op-77' });
    } else if (req.method === 'GET' && req.url === '/v1beta/models/veo-3.1-generate-preview/operations/op-77') {
      seen.polls += 1;
      if (failMode) {
        json(res, 200, { name: 'models/veo-3.1-generate-preview/operations/op-77', done: true, error: { code: 400, message: 'prompt was blocked by safety filters' } });
      } else if (seen.polls === 1) {
        json(res, 200, { name: 'models/veo-3.1-generate-preview/operations/op-77', done: false });
      } else {
        json(res, 200, {
          name: 'models/veo-3.1-generate-preview/operations/op-77',
          done: true,
          response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${base}/files/veo-out.mp4?alt=media` } }] } },
        });
      }
    } else if (req.method === 'GET' && req.url === '/files/veo-out.mp4?alt=media') {
      seen.dlAuth = req.headers['x-goog-api-key'] ?? null;
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(BIN);
    } else if (req.method === 'POST' && req.url === '/v1beta/models/veo-3.1-generate-preview/operations/op-77:cancel') {
      seen.cancelled += 1;
      json(res, 200, { name: 'models/veo-3.1-generate-preview/operations/op-77', done: true });
    } else {
      json(res, 404, {});
    }
  });
  const base = await listen(server);
  process.env.SYNTHMEDIA_GEMINI_API_KEY = 'gem-test-key-0002';
  try {
    const jobs = await makeJobs({
      'gemini-veo': { baseUrl: base, pollIntervalMs: 20, timeoutMs: 30_000, protocolVerified: true, blockRealSubmit: false },
    });
    const rec = await jobs.wait(
      (await jobs.start({
        backend: 'gemini-veo',
        model: 'veo-3.1-generate-preview',
        modality: 'video',
        prompt: 'ocean waves from above',
        durationSeconds: 8,
      })).id,
    );
    assert.equal(rec.status, 'succeeded');
    assert.equal(rec.remoteId, 'models/veo-3.1-generate-preview/operations/op-77');
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(rec.artifacts[0].path);
    assert.deepEqual([...bytes.subarray(0, 3)], [0x00, 0xff, 0x80]);
    assert.deepEqual([...bytes], [...BIN]);
    assert.equal(seen.dlAuth, 'gem-test-key-0002', 'Google file URI download requires the api key');

    // Safety/error shape: done + google.rpc.Status error → failed job.
    failMode = true;
    const rec2 = await jobs.wait(
      (await jobs.start({ backend: 'gemini-veo', model: 'veo-3.1-generate-preview', modality: 'video', prompt: 'bad' })).id,
    );
    assert.equal(rec2.status, 'failed');
    assert.match(rec2.error.message, /safety filters/);

    // LRO cancel: cancel while the operation is still pending.
    failMode = false;
    server.close();
    const server2 = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url.includes(':predictLongRunning')) {
        json(res, 200, { name: 'models/veo-3.1-generate-preview/operations/op-cancel' });
      } else if (req.method === 'GET' && req.url === '/v1beta/models/veo-3.1-generate-preview/operations/op-cancel') {
        json(res, 200, { name: 'models/veo-3.1-generate-preview/operations/op-cancel', done: false });
      } else if (req.method === 'POST' && req.url === '/v1beta/models/veo-3.1-generate-preview/operations/op-cancel:cancel') {
        seen.cancelled += 1;
        json(res, 200, { name: 'models/veo-3.1-generate-preview/operations/op-cancel', done: true });
      } else {
        json(res, 404, {});
      }
    });
    const base2 = await listen(server2);
    try {
      const jobs2 = await makeJobs({
        'gemini-veo': { baseUrl: base2, pollIntervalMs: 20, timeoutMs: 30_000, protocolVerified: true, blockRealSubmit: false },
      });
      const started = await jobs2.start({ backend: 'gemini-veo', model: 'veo-3.1-generate-preview', modality: 'video', prompt: 'x' });
      await new Promise((r) => setTimeout(r, 60));
      await jobs2.cancel(started.id);
      const rec3 = await jobs2.wait(started.id);
      assert.equal(rec3.status, 'cancelled');
      assert.equal(seen.cancelled, 1);
    } finally {
      server2.close();
    }
  } finally {
    delete process.env.SYNTHMEDIA_GEMINI_API_KEY;
    server.close();
  }
});

// ------------------------------------------------------------------ OpenAI

test('openai images: /v1/images/generations b64_json decoded binary-safe; 401 error shape maps to E_AUTH', async () => {
  const seen = { auth: '', submit: null };
  let mode = 'ok';
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      seen.auth = req.headers['authorization'] ?? '';
      seen.submit = await readJson(req);
      if (mode === 'auth') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } }));
      } else {
        json(res, 200, { created: 1785125946, data: [{ b64_json: BIN.toString('base64'), revised_prompt: null }] });
      }
    } else {
      json(res, 404, {});
    }
  });
  const base = await listen(server);
  process.env.SYNTHMEDIA_OPENAI_API_KEY = 'oai-test-key-0001';
  try {
    let jobs = await makeJobs({
      'openai-images': { baseUrl: base, timeoutMs: 30_000, protocolVerified: true, blockRealSubmit: false },
    });
    const rec = await jobs.wait(
      (await jobs.start({
        backend: 'openai-images',
        model: 'gpt-image-1',
        modality: 'image',
        prompt: 'a glass terrarium',
        size: '1024x1024',
      })).id,
    );
    assert.equal(rec.status, 'succeeded');
    assert.equal(seen.auth, 'Bearer oai-test-key-0001');
    assert.equal(seen.submit.model, 'gpt-image-1');
    assert.equal(seen.submit.size, '1024x1024');
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(rec.artifacts[0].path);
    assert.deepEqual([...bytes], [...BIN]);

    mode = 'auth';
    jobs = await makeJobs({
      'openai-images': { baseUrl: base, timeoutMs: 30_000, protocolVerified: true, blockRealSubmit: false },
    });
    const started = await jobs.start({ backend: 'openai-images', model: 'gpt-image-1', modality: 'image', prompt: 'x' });
    const authRec = await jobs.wait(started.id);
    assert.equal(authRec.status, 'failed');
    assert.equal(authRec.error.code, 'E_AUTH');
    assert.match(authRec.error.message, /Incorrect API key/);
  } finally {
    delete process.env.SYNTHMEDIA_OPENAI_API_KEY;
    server.close();
  }
});

test('openai video protocol via a custom openai-video-compatible profile (adapter reuse): /v1/videos task cycle + DELETE cancel', async () => {
  const seen = { submit: null, cancel: null, cdnHits: 0 };
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/videos') {
      seen.submit = await readJson(req);
      json(res, 200, { id: 'video_abc', object: 'video', status: 'queued', model: 'video-gateway-m1', progress: 0, seconds: '8', size: '1280x720' });
    } else if (req.method === 'GET' && req.url === '/v1/videos/video_abc') {
      seen.polls = (seen.polls ?? 0) + 1;
      if (seen.polls === 1) json(res, 200, { id: 'video_abc', status: 'queued', progress: 0 });
      else json(res, 200, { id: 'video_abc', status: 'completed', progress: 100, completed_at: 1785125946 });
    } else if (req.method === 'GET' && req.url === '/v1/videos/video_abc/content') {
      seen.cdnHits += 1;
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(BIN);
    } else if (req.method === 'DELETE' && req.url === '/v1/videos/video_abc') {
      seen.cancel = true;
      json(res, 200, { id: 'video_abc', object: 'video', deleted: true });
    } else {
      json(res, 404, {});
    }
  });
  const base = await listen(server);
  process.env.OAI_COMPAT_KEY = 'oai-compat-key-0002';
  try {
    // The adapter is configured ONLY through a custom profile here — no
    // preset profile exists for this protocol any more, proving the adapter
    // itself remains reusable from configuration.
    const jobs = await makeJobs({
      'oai-video-gateway': {
        id: 'oai-video-gateway',
        protocol: 'openai-video-compatible',
        model: 'video-gateway-m1',
        models: ['video-gateway-m1'],
        modalities: ['video'],
        baseUrl: base,
        authEnv: 'OAI_COMPAT_KEY',
        authStyle: 'bearer',
        online: true,
        timeoutMs: 30_000,
        pollIntervalMs: 20,
        secondsAsString: true,
        cancelMethod: 'DELETE',
        paths: { submit: '/v1/videos', status: '/v1/videos/{id}', content: '/v1/videos/{id}/content', cancel: '/v1/videos/{id}' },
        protocolVerified: true,
        liveVerified: false,
      },
    });
    // Full cycle: submit → completed → binary content download.
    const rec = await jobs.wait(
      (await jobs.start({
        backend: 'oai-video-gateway',
        model: 'video-gateway-m1',
        modality: 'video',
        prompt: 'a paper boat on a stream',
        durationSeconds: 8,
        size: '1280x720',
      })).id,
    );
    assert.equal(rec.status, 'succeeded');
    assert.equal(rec.remoteId, 'video_abc');
    assert.equal(seen.submit.seconds, '8', 'seconds must be submitted as a string');
    assert.equal(seen.submit.size, '1280x720');
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(rec.artifacts[0].path);
    assert.deepEqual([...bytes], [...BIN]);
  } finally {
    delete process.env.OAI_COMPAT_KEY;
    server.close();
  }
});

test('openai video protocol: DELETE /v1/videos/{id} is the cancel call while the job is in flight', async () => {
  let cancelHits = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/videos') {
      json(res, 200, { id: 'video_running', object: 'video', status: 'in_progress', progress: 10 });
    } else if (req.method === 'GET' && req.url === '/v1/videos/video_running') {
      json(res, 200, { id: 'video_running', status: 'in_progress', progress: 10 });
    } else if (req.method === 'DELETE' && req.url === '/v1/videos/video_running') {
      cancelHits += 1;
      json(res, 200, { id: 'video_running', object: 'video', deleted: true });
    } else {
      json(res, 404, {});
    }
  });
  const base = await listen(server);
  process.env.OAI_COMPAT_KEY = 'oai-compat-key-0003';
  try {
    const jobs = await makeJobs({
      'oai-video-gateway': {
        id: 'oai-video-gateway',
        protocol: 'openai-video-compatible',
        model: 'video-gateway-m1',
        models: ['video-gateway-m1'],
        modalities: ['video'],
        baseUrl: base,
        authEnv: 'OAI_COMPAT_KEY',
        authStyle: 'bearer',
        online: true,
        timeoutMs: 30_000,
        pollIntervalMs: 20,
        cancelMethod: 'DELETE',
        paths: { submit: '/v1/videos', status: '/v1/videos/{id}', content: '/v1/videos/{id}/content', cancel: '/v1/videos/{id}' },
        protocolVerified: true,
        liveVerified: false,
      },
    });
    const started = await jobs.start({ backend: 'oai-video-gateway', model: 'video-gateway-m1', modality: 'video', prompt: 'x' });
    await new Promise((r) => setTimeout(r, 60));
    await jobs.cancel(started.id);
    const rec = await jobs.wait(started.id);
    assert.equal(rec.status, 'cancelled');
    assert.equal(cancelHits, 1, 'cancel is DELETE /v1/videos/{id}');
  } finally {
    delete process.env.OAI_COMPAT_KEY;
    server.close();
  }
});

// ------------------------------------ third-party reuse + unverified gate

test('third-party compatible profile reuses the same dashscope adapter unchanged', async () => {
  const seen = { asyncHeader: null };
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/wan/video') {
      seen.asyncHeader = req.headers['x-dashscope-async'] ?? null;
      json(res, 200, { output: { task_id: 'relay-9', task_status: 'PENDING' } });
    } else if (req.method === 'GET' && req.url === '/tasks/relay-9') {
      json(res, 200, { output: { task_id: 'relay-9', task_status: 'SUCCEEDED', video_url: `${base}/f/9.mp4` } });
    } else if (req.method === 'GET' && req.url === '/f/9.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(BIN);
    } else {
      json(res, 404, {});
    }
  });
  const base = await listen(server);
  process.env.RELAY_KEY = 'relay-key-0001';
  try {
    const jobs = await makeJobs({
      // A hypothetical third-party gateway speaking the SAME protocol shape —
      // only profile fields differ; the adapter is untouched.
      'wan-relay': {
        protocol: 'dashscope-wan-compatible',
        id: 'wan-relay',
        model: 'wan2.5-t2v-preview',
        models: ['wan2.5-t2v-preview'],
        modalities: ['video'],
        baseUrl: base,
        authEnv: 'RELAY_KEY',
        authStyle: 'bearer',
        online: true,
        timeoutMs: 30_000,
        pollIntervalMs: 20,
        paths: { submit: '/wan/video', status: '/tasks/{id}', cancel: '/tasks/{id}/cancel' },
        protocolVerified: true,
        liveVerified: false,
      },
    });
    const rec = await jobs.wait(
      (await jobs.start({ backend: 'wan-relay', model: 'wan2.5-t2v-preview', modality: 'video', prompt: 'lanterns' })).id,
    );
    assert.equal(rec.status, 'succeeded');
    assert.equal(rec.remoteId, 'relay-9');
    assert.equal(seen.asyncHeader, 'enable', 'same mandatory protocol header on a third-party deployment');
    const { readFile } = await import('node:fs/promises');
    assert.deepEqual([...(await readFile(rec.artifacts[0].path))], [...BIN]);
  } finally {
    delete process.env.RELAY_KEY;
    server.close();
  }
});

test('unverified-protocol gate: new-ecosystem profiles refuse real submission with ZERO network requests', async () => {
  const { resolveConfig } = await import('../lib/config.js');
  const { createBackendRegistry } = await import('../lib/backends/index.js');
  const cfg = resolveConfig({});
  const registry = createBackendRegistry(cfg);
  for (const id of ['dashscope-wan-video', 'dashscope-wanx-image', 'gemini-imagen', 'gemini-veo', 'openai-images']) {
    const caps = registry.get(id).capabilities();
    assert.equal(caps.protocolVerified, false, `${id} must ship protocolVerified=false (mock-only)`);
    assert.equal(caps.liveVerified, false, `${id} must ship liveVerified=false (never called)`);
    assert.equal(caps.realSubmitAllowed, false, `${id} must gate real submission`);
    const controller = new AbortController();
    await assert.rejects(
      registry.get(id).create({ backend: id, model: caps.models[0], modality: caps.modalities[0], prompt: 'x' }, controller.signal),
      (err) => err.code === 'E_PROTOCOL_UNVERIFIED',
      `${id} must throw E_PROTOCOL_UNVERIFIED before any network I/O`,
    );
  }
});
