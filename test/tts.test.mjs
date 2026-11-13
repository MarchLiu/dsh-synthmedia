/**
 * Seed TTS (official Doubao voice async protocol) contract test.
 *
 * Shape taken from the OFFICIAL docs:
 * - submit: POST {base}/api/v3/tts/submit, headers X-Api-Key,
 *   X-Api-Resource-Id: seed-tts-2.0, X-Api-Request-Id; body
 *   {user:{uid}, unique_id, req_params:{text, speaker, audio_params}} →
 *   {code:20000000, message:'OK', data:{task_id}}
 * - query:  POST {base}/api/v3/tts/query, body {task_id} →
 *   data.task_status 1 running / 2 succeeded (+ audio_url) / 3 failed
 * - the audio is then downloaded from audio_url.
 *
 * All requests hit a local mock server. NO real vendor call is made.
 * @module
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

const AUDIO_BYTES = Buffer.from([
  0x49, 0x44, 0x33, 0x00, 0xff, 0xfb, 0x90, 0x80,
  0xe7, 0xa0, 0x8d, 0xe2, 0x82, 0xac, 0x0a, 0x00,
]);

test('ark TTS: official async submit → query → audio_url download, bytes intact', async () => {
  const seen = { submitHeaders: null, submitBody: null, queryBodies: [], audioAuth: 'none' };
  let queries = 0;
  const server = createServer((req, res) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'POST' && req.url === '/api/v3/tts/submit') {
        seen.submitHeaders = req.headers;
        seen.submitBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 20000000,
          message: 'OK',
          data: { task_id: seen.submitBody.unique_id, req_text_length: 3, task_status: 0 },
        }));
      } else if (req.method === 'POST' && req.url === '/api/v3/tts/query') {
        queries += 1;
        seen.queryBodies.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (queries === 1) {
          res.end(JSON.stringify({ code: 20000000, message: 'OK', data: { task_status: 1 } }));
        } else {
          res.end(JSON.stringify({
            code: 20000000,
            message: 'OK',
            data: { task_status: 2, audio_url: `http://127.0.0.1:${server.address().port}/audio/out.mp3` },
          }));
        }
      } else if (req.method === 'GET' && req.url === '/audio/out.mp3') {
        seen.audioAuth = req.headers['authorization'] ?? 'none';
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end(AUDIO_BYTES);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
    });
  });
  const base = await listen(server);
  try {
    process.env.SYNTHMEDIA_TTS_TEST_KEY = 'tts-test-key-9f9f';
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({
      outputDir: await mkdtemp(join(tmpdir(), 'synth-tts-')),
      backends: {
        'my-tts': {
          protocol: 'volcengine-ark-compatible',
          model: 'doubao-seed-tts-2.0',
          models: ['doubao-seed-tts-2.0'],
          modalities: ['audio'],
          baseUrl: base,
          authStyle: 'raw',
          authHeader: 'X-Api-Key',
          authEnv: 'SYNTHMEDIA_TTS_TEST_KEY',
          online: true,
          timeoutMs: 20_000,
          pollIntervalMs: 20,
          protocolVerified: true,
          paths: { submit: '/api/v3/tts/submit', status: '/api/v3/tts/query' },
          tts: {
            resourceId: 'seed-tts-2.0',
            speaker: 'zh_female_xiaohe_uranus_bigtts',
            format: 'mp3',
            sampleRate: 24000,
            uid: 'synthmedia-test',
            resourceHeader: 'X-Api-Resource-Id',
            requestIdHeader: 'X-Api-Request-Id',
          },
        },
      },
    });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.wait((await jobs.start({ backend: 'my-tts', model: 'doubao-seed-tts-2.0', modality: 'audio', prompt: '你好' })).id);

    assert.equal(rec.status, 'succeeded');
    assert.equal(rec.artifacts.length, 1);
    assert.equal(rec.artifacts[0].kind, 'audio');
    assert.equal(rec.artifacts[0].mimeType, 'audio/mpeg');
    assert.ok(rec.artifacts[0].path.endsWith('result.mp3'));
    const bytes = await readFile(rec.artifacts[0].path);
    assert.ok(bytes.equals(AUDIO_BYTES), 'audio bytes (0xff/0x80/multibyte) must survive byte-for-byte');

    // Official request shape.
    assert.equal(seen.submitHeaders['x-api-key'], 'tts-test-key-9f9f', 'credential goes in X-Api-Key');
    assert.equal(seen.submitHeaders['x-api-resource-id'], 'seed-tts-2.0');
    assert.match(String(seen.submitHeaders['x-api-request-id']), /^[0-9a-f-]{36}$/, 'request id header is a UUID');
    assert.equal(seen.submitBody.req_params.text, '你好');
    assert.equal(seen.submitBody.req_params.speaker, 'zh_female_xiaohe_uranus_bigtts');
    assert.equal(seen.submitBody.req_params.audio_params.format, 'mp3');
    assert.equal(seen.submitBody.req_params.audio_params.sample_rate, 24000);
    assert.equal(seen.submitBody.user.uid, 'synthmedia-test');
    // Query carries the task id in the body.
    assert.ok(seen.queryBodies.length >= 2);
    assert.equal(seen.queryBodies[0].task_id, rec.remoteId);
    // The signed audio URL must not receive the API key.
    assert.equal(seen.audioAuth, 'none');
    // Secret never appears in the persisted record.
    assert.ok(!JSON.stringify(rec).includes('tts-test-key-9f9f'));
  } finally {
    server.close();
    delete process.env.SYNTHMEDIA_TTS_TEST_KEY;
  }
});

test('ark TTS: error codes are structured and sanitized (code 45000001)', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 45000001, message: 'invalid speaker; key=sk-leak-me-1234567890' }));
  });
  const base = await listen(server);
  try {
    process.env.SYNTHMEDIA_TTS_TEST_KEY = 'tts-test-key-9f9f';
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({
      outputDir: await mkdtemp(join(tmpdir(), 'synth-tts-')),
      backends: {
        'my-tts': {
          protocol: 'volcengine-ark-compatible', model: 'doubao-seed-tts-2.0', models: ['doubao-seed-tts-2.0'],
          modalities: ['audio'], baseUrl: base, authStyle: 'raw', authHeader: 'X-Api-Key',
          authEnv: 'SYNTHMEDIA_TTS_TEST_KEY', online: true, timeoutMs: 20_000, pollIntervalMs: 20,
          protocolVerified: true, paths: { submit: '/tts/submit', status: '/tts/query' },
          tts: { speaker: 'v1', resourceId: 'seed-tts-2.0' },
        },
      },
    });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.wait((await jobs.start({ backend: 'my-tts', model: 'doubao-seed-tts-2.0', modality: 'audio', prompt: 'x' })).id);
    assert.equal(rec.status, 'failed');
    assert.equal(rec.error.code, 'E_REMOTE');
    assert.ok(rec.error.message.includes('45000001'));
    assert.ok(!rec.error.message.includes('sk-leak-me'), 'credential-shaped text is redacted');
  } finally {
    server.close();
    delete process.env.SYNTHMEDIA_TTS_TEST_KEY;
  }
});

test('ark TTS: unverified profile blocks before any network I/O (zero requests)', async () => {
  let requests = 0;
  const server = createServer(() => { requests += 1; });
  const base = await listen(server);
  try {
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({
      outputDir: await mkdtemp(join(tmpdir(), 'synth-tts-')),
      backends: {
        'my-tts': {
          protocol: 'volcengine-ark-compatible', model: 'doubao-seed-tts-2.0', models: ['doubao-seed-tts-2.0'],
          modalities: ['audio'], baseUrl: base, authStyle: 'raw', authHeader: 'X-Api-Key',
          authEnv: 'SYNTHMEDIA_TTS_TEST_KEY', online: true, timeoutMs: 20_000, pollIntervalMs: 20,
          protocolVerified: false, paths: { submit: '/tts/submit', status: '/tts/query' },
          tts: { speaker: 'v1' },
        },
      },
    });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.wait((await jobs.start({ backend: 'my-tts', model: 'doubao-seed-tts-2.0', modality: 'audio', prompt: 'x' })).id);
    assert.equal(rec.status, 'failed');
    assert.equal(rec.error.code, 'E_PROTOCOL_UNVERIFIED');
    assert.equal(requests, 0);
  } finally {
    server.close();
  }
});
