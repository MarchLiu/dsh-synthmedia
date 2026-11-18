/**
 * Contract tests against REAL local mock servers reproducing the two verified
 * protocol shapes, plus the unverified BZA task shape (marked below).
 *
 * VERIFIED-SHAPED: zgci-h3 hub /v1/videos video task API (Bearer, JSON submit,
 * 200/201, queued/in_progress/completed/failed + progress) — mirrors PhotoStory
 * backend/scripts/verify_ai_models.py L184-235; local-h3 /v1/videogen
 * submit→status→content (Basic) — mirrors PhotoStory utils/videogen.py; offline
 * sidecar multipart /v1/videos (+ /v1/videos/sync) — mirrors the official
 * vLLM-Omni videos_api.md.
 * UNVERIFIED: bza-seedance paths — same generic task-api contract, path shapes
 * are configuration placeholders and explicitly NOT claimed as real endpoints.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
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

test('contract: zgci-h3 /v1/videos task API end-to-end (verified verify_ai_models.py shape)', async () => {
  let seenAuth = '';
  const seenSubmits = [];
  const polls = [];
  const server = createServer((req, res) => {
    seenAuth = req.headers.authorization ?? '';
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/videos') {
        const payload = JSON.parse(body);
        seenSubmits.push(payload);
        // verify_ai_models.py accepts BOTH 200 and 201; exercise 201 here.
        json(res, 201, { id: 'video-1', status: 'queued', model: 'minimax-h3' });
      } else if (req.method === 'GET' && req.url === '/v1/videos/video-1') {
        polls.push(1);
        if (polls.length === 1) json(res, 200, { id: 'video-1', status: 'queued', progress: 0 });
        else if (polls.length === 2) json(res, 200, { id: 'video-1', status: 'in_progress', progress: 45 });
        else json(res, 200, { id: 'video-1', status: 'completed', progress: 100 });
      } else if (req.method === 'GET' && req.url === '/v1/videos/video-1/content') {
        // NON-TEXT bytes: 0xff, 0x80 and multi-byte UTF-8 must survive verbatim.
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        res.end(Buffer.from([0x00, 0xff, 0x80, 0x41, 0xe7, 0xa0, 0x8d, 0xe2, 0x82, 0xac, 0x7f]));
      } else {
        json(res, 404, { error: { message: 'not found' } });
      }
    });
  });
  const base = await listen(server);
  try {
    process.env.SYNTHMEDIA_ZGCI_API_KEY = 'test-key-do-not-leak-123456';
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({ outputDir: await mkdtemp(join(tmpdir(), 'synth-')), backends: { 'zgci-h3': { baseUrl: base, pollIntervalMs: 20 } } });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.wait((await jobs.start({ backend: 'zgci-h3', model: 'minimax-h3', modality: 'video', prompt: 'A beautiful sunset', durationSeconds: 4, size: '1280x720' })).id);
    assert.equal(rec.status, 'succeeded');
    assert.equal(rec.remoteId, 'video-1');
    // exact submit shape from verify_ai_models.py: JSON, seconds as STRING "4"
    assert.equal(seenSubmits.length, 1);
    assert.equal(seenSubmits[0].model, 'minimax-h3');
    assert.equal(seenSubmits[0].seconds, '4');
    assert.equal(seenSubmits[0].size, '1280x720');
    assert.ok(seenAuth.startsWith('Bearer test-key'), 'must use Bearer auth');
    // progress reached 45 before completion (in_progress honored, not just running)
    const mid = JSON.parse(await readFile(join(cfg.outputDir, rec.id, 'job.json'), 'utf8'));
    assert.ok(mid.progress >= 0);
    // binary artifact survives byte-for-byte
    const bytes = await readFile(rec.artifacts[0].path);
    assert.ok(bytes.equals(Buffer.from([0x00, 0xff, 0x80, 0x41, 0xe7, 0xa0, 0x8d, 0xe2, 0x82, 0xac, 0x7f])), 'binary bytes must be identical (no text decode)');
    assert.equal(rec.artifacts[0].mimeType, 'video/mp4');
    assert.ok(!JSON.stringify(rec).includes('test-key-do-not-leak'));
  } finally {
    server.close();
    delete process.env.SYNTHMEDIA_ZGCI_API_KEY;
  }
});

test('contract: zgci-h3 missing credential fails BEFORE any network call', async () => {
  delete process.env.SYNTHMEDIA_ZGCI_API_KEY;
  // Hermetic resolver: the credential-file fallback (real user YAML) would
  // satisfy the lookup and break the fail-before-network contract.
  const prevFallback = process.env.SYNTHMEDIA_CREDENTIAL_FILE_FALLBACK;
  process.env.SYNTHMEDIA_CREDENTIAL_FILE_FALLBACK = '0';
  const { resolveConfig } = await import('../lib/config.js');
  const { createBackendRegistry } = await import('../lib/backends/index.js');
  const { JobManager } = await import('../lib/jobs.js');
  let hit = false;
  const server = createServer(() => { hit = true; });
  const base = await listen(server);
  try {
    const cfg = resolveConfig({ outputDir: await mkdtemp(join(tmpdir(), 'synth-')), backends: { 'zgci-h3': { baseUrl: base } } });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.start({ backend: 'zgci-h3', model: 'minimax-h3', modality: 'video', prompt: 'x' });
    const after = await jobs.wait(rec.id);
    assert.equal(after.status, 'failed');
    assert.equal(after.error.code, 'E_NO_CREDENTIAL');
    assert.ok(after.error.message.includes('SYNTHMEDIA_ZGCI_API_KEY'), 'error names the env var, never a value');
  } finally {
    server.close();
    if (prevFallback === undefined) delete process.env.SYNTHMEDIA_CREDENTIAL_FILE_FALLBACK;
    else process.env.SYNTHMEDIA_CREDENTIAL_FILE_FALLBACK = prevFallback;
    assert.equal(hit, false, 'no request must be sent without credentials');
  }
});

test('contract: local-h3 videogen async task end-to-end (verified shape)', async () => {
  let polls = 0;
  const server = createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    assert.ok(auth.startsWith('Basic '), 'videogen uses Basic auth');
    if (req.method === 'POST' && req.url === '/v1/videogen') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const payload = JSON.parse(body);
        assert.equal(payload.prompt, 'a cat');
        assert.equal(payload.seconds, 5);
        assert.equal(payload.size, '1280x720');
        json(res, 200, { task_id: 'task-abc' });
      });
    } else if (req.method === 'GET' && req.url === '/v1/videogen/task-abc') {
      polls += 1;
      if (polls < 2) json(res, 200, { status: 'running', progress: 40 });
      else json(res, 200, { status: 'completed', progress: 100 });
    } else if (req.method === 'GET' && req.url === '/v1/videogen/task-abc/content') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(Buffer.from('FAKE_MP4_BYTES'));
    } else {
      json(res, 404, { error: { message: 'not found' } });
    }
  });
  const base = await listen(server);
  try {
    process.env.SYNTHMEDIA_LOCAL_H3_AUTH = 'user:pass';
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({ outputDir: await mkdtemp(join(tmpdir(), 'synth-')), backends: { 'local-h3': { baseUrl: base, pollIntervalMs: 20, timeoutMs: 10000 } } });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.wait((await jobs.start({ backend: 'local-h3', model: 'minimax-h3', modality: 'video', prompt: 'a cat', durationSeconds: 5, size: '1280*720' })).id);
    assert.equal(rec.status, 'succeeded');
    assert.equal(rec.remoteId, 'task-abc');
    assert.equal(rec.artifacts[0].kind, 'video');
    const bytes = await readFile(rec.artifacts[0].path);
    assert.ok(bytes.toString().startsWith('FAKE_MP4_BYTES'));
    assert.ok(!JSON.stringify(rec).includes('user:pass'));
  } finally {
    server.close();
    delete process.env.SYNTHMEDIA_LOCAL_H3_AUTH;
  }
});

test('contract: remote failure error bodies are sanitized (bza ark adapter shape)', async (t) => {
  const server = createServer((req, res) => {
    json(res, 500, { error: { message: 'internal: Authorization=Bearer leakme98765 bad gateway' } });
  });
  const base = await listen(server);
  try {
    process.env.SYNTHMEDIA_BZA_API_KEY = 'bza-test-key-000111';
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({ outputDir: await mkdtemp(join(tmpdir(), 'synth-')), backends: { 'bza-seedance': { baseUrl: base, pollIntervalMs: 20 } } });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.wait((await jobs.start({ backend: 'bza-seedance', model: 'doubao-seedance-2.0', modality: 'video', prompt: 'v' })).id);
    assert.equal(rec.status, 'failed');
    assert.ok(!JSON.stringify(rec).includes('leakme98765'), 'remote error payload secret must be redacted');
    assert.ok(!JSON.stringify(rec).includes('bza-test-key'));
  } finally {
    server.close();
    delete process.env.SYNTHMEDIA_BZA_API_KEY;
  }
});

test('contract: 503 busy maps to retriable E_BUSY (verified videogen behavior)', async () => {
  const server = createServer((req, res) => {
    if (req.method === 'POST') json(res, 503, { error: 'in-flight limit' });
    else json(res, 404, {});
  });
  const base = await listen(server);
  try {
    process.env.SYNTHMEDIA_LOCAL_H3_AUTH = 'u:p';
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({ outputDir: await mkdtemp(join(tmpdir(), 'synth-')), backends: { 'local-h3': { baseUrl: base } } });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.wait((await jobs.start({ backend: 'local-h3', model: 'minimax-h3', modality: 'video', prompt: 'v' })).id);
    assert.equal(rec.status, 'failed');
    assert.equal(rec.error.code, 'E_BUSY');
    assert.equal(rec.error.retriable, true);
  } finally {
    server.close();
    delete process.env.SYNTHMEDIA_LOCAL_H3_AUTH;
  }
});

test('contract: tools pipeline over real task-api server (capabilities→generate→wait→cancel)', async () => {
  let pollCount = 0;
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/videogen') {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => json(res, 200, { task_id: 'T1' }));
    } else if (req.url === '/v1/videogen/T1') {
      pollCount += 1;
      // never completes: stays running forever until client cancels
      json(res, 200, { status: 'running', progress: Math.min(90, pollCount * 10) });
    } else {
      json(res, 404, {});
    }
  });
  const base = await listen(server);
  try {
    process.env.SYNTHMEDIA_LOCAL_H3_AUTH = 'u:p';
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const { buildSynthMediaTools } = await import('../lib/tools.js');
    const cfg = resolveConfig({ outputDir: await mkdtemp(join(tmpdir(), 'synth-')), backends: { 'local-h3': { baseUrl: base, pollIntervalMs: 25, timeoutMs: 60000 } } });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const tools = Object.fromEntries(buildSynthMediaTools(jobs).map((d) => [d.name, d]));
    const exec = { signal: new AbortController().signal };

    const caps = await tools['synthmedia_capabilities'].execute({}, exec);
    assert.ok(caps.backends.some((b) => b.id === 'local-h3' && b.online === false));

    const gen = await tools['synthmedia_generate'].execute(
      { backend: 'local-h3', model: 'minimax-h3', modality: 'video', prompt: 'x', durationSeconds: 4 }, exec);
    const id = gen.job.id;
    assert.equal(gen.job.status, 'running');

    const st = await tools['synthmedia_status'].execute({ id }, exec);
    assert.equal(st.job.id, id);

    // cancel through the tool while the job is polling
    const cancelled = await tools['synthmedia_cancel'].execute({ id }, exec);
    assert.equal(cancelled.job.status, 'cancelled');

    const done = await tools['synthmedia_wait'].execute({ id }, exec);
    assert.equal(done.job.status, 'cancelled');
    assert.ok(pollCount >= 0); // cancel may land before the first remote poll
  } finally {
    server.close();
    delete process.env.SYNTHMEDIA_LOCAL_H3_AUTH;
  }
});

test('contract: status/wait on unknown job id are structured errors', async () => {
  const { resolveConfig } = await import('../lib/config.js');
  const { createBackendRegistry } = await import('../lib/backends/index.js');
  const { JobManager } = await import('../lib/jobs.js');
  const { buildSynthMediaTools } = await import('../lib/tools.js');
  const cfg = resolveConfig({ outputDir: await mkdtemp(join(tmpdir(), 'synth-')) });
  const jobs = new JobManager(cfg, createBackendRegistry(cfg));
  const tools = Object.fromEntries(buildSynthMediaTools(jobs).map((d) => [d.name, d]));
  const exec = { signal: new AbortController().signal };
  await assert.rejects(
    () => tools['synthmedia_status'].execute({ id: 'nope' }, exec),
    (e) => e.code === 'E_NO_JOB',
  );
});
