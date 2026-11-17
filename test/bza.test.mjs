/**
 * bza (Volcengine Coding Plan) ark-adapter contract tests, wired to the
 * OFFICIAL Ark protocol shapes confirmed from:
 * - video: POST/GET/DELETE /contents/generations/tasks, statuses
 *   queued/running/succeeded/failed/expired, content via content.video_url
 *   (docs: create/get/cancel-or-delete video generation task API)
 * - image: POST /images/generations → {data:[{url|b64_json, output_format}]}
 * - tts: doubao-seed-tts-2.0 rides the separate Doubao voice API ⇒ real
 *   submission HARD-BLOCKED (E_PROTOCOL_UNVERIFIED, zero network I/O).
 * All tests run against a local mock server. NO real bza calls are made.
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

// 0xff / 0x80 / multi-byte UTF-8 / lone-invalid sequences: must survive byte-for-byte.
const BIN = Buffer.from([0x00, 0xff, 0x80, 0x41, 0xe7, 0xa0, 0x8d, 0xe2, 0x82, 0xac, 0x7f, 0xc3, 0x28]);

test('bza-seedance: official ark task cycle submit→poll→video_url download (binary intact)→DELETE cancel', async () => {
  let polls = 0;
  const seen = { submitBody: null, auth: '', deleteCalled: false, dlAuth: '' };
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/contents/generations/tasks') {
      let b = [];
      req.on('data', (c) => b.push(c));
      req.on('end', () => {
        seen.auth = req.headers['authorization'] ?? '';
        const body = JSON.parse(Buffer.concat(b).toString('utf8'));
        seen.submitBody = body;
        if (seen.submitCount === undefined) {
          seen.submitCount = 1;
          // Official create shape: {model, content:[{type:'text',text}]}
          assert.equal(body.model, 'doubao-seedance-2.5');
          assert.deepEqual(body.content, [{ type: 'text', text: '一只纸船' }]);
          assert.equal(body.duration, 5);
        }
        json(res, 200, { id: 'cgt-mock-0001' });
      });
    } else if (req.method === 'GET' && req.url === '/contents/generations/tasks/cgt-mock-0001') {
      polls += 1;
      if (polls === 1) json(res, 200, { id: 'cgt-mock-0001', status: 'queued' });
      else if (polls === 2) json(res, 200, { id: 'cgt-mock-0001', status: 'running' });
      else json(res, 200, { id: 'cgt-mock-0001', status: 'succeeded', content: { video_url: `http://127.0.0.1:${server.address().port}/signed/vid.mp4?sig=x` } });
    } else if (req.url?.startsWith('/signed/vid.mp4')) {
      seen.dlAuth = req.headers['authorization'] ?? 'none';
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(BIN);
    } else if (req.method === 'DELETE' && req.url === '/contents/generations/tasks/cgt-mock-0001') {
      seen.deleteCalled = true;
      json(res, 200, { id: 'cgt-mock-0001', status: 'cancelled' });
    } else {
      json(res, 404, {});
    }
  });
  const base = await listen(server);
  try {
    process.env.SYNTHMEDIA_BZA_API_KEY = 'bza-test-key-000111';
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({ outputDir: await mkdtemp(join(tmpdir(), 'synth-')), backends: { 'bza-seedance': { baseUrl: base, pollIntervalMs: 20, timeoutMs: 20000, protocolVerified: true } } });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.wait((await jobs.start({ backend: 'bza-seedance', model: 'doubao-seedance-2.5', modality: 'video', prompt: '一只纸船', durationSeconds: 5 })).id);
    assert.equal(rec.status, 'succeeded');
    assert.equal(rec.remoteId, 'cgt-mock-0001');
    assert.match(seen.auth, /^Bearer /, 'submit must use bearer auth from env name');
    assert.equal(seen.dlAuth, 'none', 'signed video_url download must NOT attach the API key');
    const bytes = await readFile(rec.artifacts[0].path);
    assert.ok(bytes.equals(BIN), 'video bytes with 0xff/0x80/multibyte must survive byte-for-byte');
    assert.equal(rec.artifacts[0].kind, 'video');

    // cancel path hits DELETE /contents/generations/tasks/{id}
    const cfg2 = resolveConfig({ outputDir: cfg.outputDir, backends: { 'bza-seedance': { baseUrl: base, pollIntervalMs: 20, timeoutMs: 20000, protocolVerified: true } } });
    const jobs2 = new JobManager(cfg2, createBackendRegistry(cfg2));
    const rec2 = await jobs2.start({ backend: 'bza-seedance', model: 'doubao-seedance-2.0', modality: 'video', prompt: 'x' });
    // wait until the remote submit landed (remoteId recorded) before cancelling
    for (let i = 0; i < 50; i += 1) {
      const cur = await jobs2.get(rec2.id);
      if (cur?.remoteId) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok((await jobs2.get(rec2.id))?.remoteId, 'submit must have landed');
    await jobs2.cancel(rec2.id);
    assert.equal(seen.deleteCalled, true, 'cancel must issue DELETE per official cancel-or-delete API');
  } finally {
    server.close();
    delete process.env.SYNTHMEDIA_BZA_API_KEY;
  }
});

test('bza-seedance: failed/expired statuses map to structured failure with sanitized remote error', async () => {
  const server = createServer((req, res) => {
    if (req.method === 'POST') json(res, 200, { id: 'cgt-mock-0002' });
    else if (req.method === 'GET') json(res, 200, { id: 'cgt-mock-0002', status: 'failed', error: { code: 'InvalidParameter.TaskTypeConstraint', message: 'bad param: Authorization=Bearer leakme999' } });
    else json(res, 404, {});
  });
  const base = await listen(server);
  try {
    process.env.SYNTHMEDIA_BZA_API_KEY = 'bza-test-key-000111';
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({ outputDir: await mkdtemp(join(tmpdir(), 'synth-')), backends: { 'bza-seedance': { baseUrl: base, pollIntervalMs: 20, timeoutMs: 20000, protocolVerified: true } } });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.wait((await jobs.start({ backend: 'bza-seedance', model: 'doubao-seedance-2.0', modality: 'video', prompt: 'v' })).id);
    assert.equal(rec.status, 'failed');
    assert.equal(rec.error.code, 'InvalidParameter.TaskTypeConstraint', 'remote error code is passed through (sanitized)');
    assert.match(rec.error.message, /bad param/);
    assert.ok(!JSON.stringify(rec).includes('leakme999'), 'remote secret redacted');
  } finally {
    server.close();
    delete process.env.SYNTHMEDIA_BZA_API_KEY;
  }
});

test('bza-seedance: tool-level size maps onto Ark resolution+ratio (never silently dropped)', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/contents/generations/tasks') {
      let b = [];
      req.on('data', (c) => b.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(b).toString('utf8'));
        seen.push(body);
        json(res, 200, { id: `cgt-size-${seen.length}` });
      });
    } else if (req.method === 'GET' && req.url?.startsWith('/contents/generations/tasks/cgt-size-')) {
      const id = req.url.split('/').pop();
      json(res, 200, { id, status: 'succeeded', content: { video_url: `http://127.0.0.1:${server.address().port}/signed/${id}.mp4` } });
    } else if (req.url?.startsWith('/signed/')) {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(BIN);
    } else {
      json(res, 404, {});
    }
  });
  const base = await listen(server);
  try {
    process.env.SYNTHMEDIA_BZA_API_KEY = 'bza-test-key-000111';
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({ outputDir: await mkdtemp(join(tmpdir(), 'synth-')), backends: { 'bza-seedance': { baseUrl: base, pollIntervalMs: 20, timeoutMs: 20000, protocolVerified: true } } });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));

    const run = async (size) => {
      const rec = await jobs.wait((await jobs.start({ backend: 'bza-seedance', model: 'doubao-seedance-2.5', modality: 'video', prompt: 'p', size })).id);
      assert.equal(rec.status, 'succeeded', `size ${size} must be accepted`);
      return rec;
    };
    await run('1280x720');
    await run('720*1280');
    await run('1080p');

    // Request-body assertions: the Ark video task API has no `size` field, so
    // the mapped pair MUST appear and the pixel/verbatim size MUST NOT.
    assert.equal(seen.length, 3);
    assert.deepEqual(seen[0].resolution, '720p');
    assert.deepEqual(seen[0].ratio, '16:9');
    assert.equal('size' in seen[0], false, 'a pixel size must never be sent to the Ark video API');
    assert.equal(seen[1].resolution, '720p');
    assert.equal(seen[1].ratio, '9:16');
    assert.equal(seen[2].resolution, '1080p');
    assert.equal(seen[2].ratio, undefined, 'a bare resolution token must not invent a ratio');
    for (const body of seen) assert.deepEqual(body.content, [{ type: 'text', text: 'p' }]);
  } finally {
    server.close();
    delete process.env.SYNTHMEDIA_BZA_API_KEY;
  }
});

test('bza-seedance: non-representable size is an explicit E_SIZE BEFORE any request', async () => {
  let requests = 0;
  const server = createServer((req, res) => { requests += 1; json(res, 500, {}); });
  const base = await listen(server);
  try {
    process.env.SYNTHMEDIA_BZA_API_KEY = 'bza-test-key-000111';
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({ outputDir: await mkdtemp(join(tmpdir(), 'synth-')), backends: { 'bza-seedance': { baseUrl: base, pollIntervalMs: 20, timeoutMs: 20000, protocolVerified: true } } });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const failures = [
      { model: 'doubao-seedance-2.5', size: '2560x1440' }, // unsupported resolution tier
      { model: 'doubao-seedance-2.5', size: '2048x858' }, // unsupported aspect ratio
      { model: 'doubao-seedance-2.5', size: '4K' }, // not a documented resolution token
      { model: 'doubao-seedance-2.0', size: '480p' }, // model tier does not support 480p
    ];
    for (const f of failures) {
      const rec = await jobs.wait((await jobs.start({ backend: 'bza-seedance', model: f.model, modality: 'video', prompt: 'p', size: f.size })).id);
      assert.equal(rec.status, 'failed', `${f.size} must fail`);
      assert.equal(rec.error.code, 'E_SIZE', `${f.size} must be an explicit E_SIZE, got ${rec.error.code}: ${rec.error.message}`);
    }
    assert.equal(requests, 0, 'no byte may reach the network for a size the protocol cannot express');
  } finally {
    server.close();
    delete process.env.SYNTHMEDIA_BZA_API_KEY;
  }
});

test('bza-seedance: every advertised video preset size maps onto the Ark protocol vocabulary', async () => {
  const { MODEL_PRESETS } = await import('../lib/presets.js');
  const { mapArkVideoSize, ARK_VIDEO_RESOLUTIONS, ARK_VIDEO_RATIOS } = await import('../lib/backends/ark.js');
  for (const cap of Object.values(MODEL_PRESETS).filter(
    (p) => p.modality === 'video' && p.protocol === 'volcengine-ark-compatible',
  )) {
    assert.ok(cap.sizes.length > 0, `preset ${cap.id} must advertise at least one size`);
    for (const size of cap.sizes) {
      const spec = mapArkVideoSize(size, cap.id, 'bza-seedance');
      assert.ok(ARK_VIDEO_RESOLUTIONS.includes(spec.resolution), `preset ${cap.id} size ${size} -> ${spec.resolution}`);
      assert.ok(cap.sizes.includes(spec.resolution), `preset ${cap.id} must only advertise resolutions the adapter emits`);
    }
    for (const ratio of cap.ratios ?? []) {
      assert.ok(ARK_VIDEO_RATIOS.includes(ratio), `preset ${cap.id} advertises undocumented ratio ${ratio}`);
    }
  }
  assert.deepEqual(mapArkVideoSize('1920x1080', 'doubao-seedance-2.0', 'x'), { resolution: '1080p', ratio: '16:9' });
  // 21:9's reduced fraction is 7:3, which is NOT a documented ratio string:
  // the match must be by VALUE (cross-multiplication), not by reduced text.
  assert.deepEqual(mapArkVideoSize('2520x1080', 'doubao-seedance-2.0', 'x'), { resolution: '1080p', ratio: '21:9' });
  assert.deepEqual(mapArkVideoSize('1440x1080', 'doubao-seedance-2.0', 'x'), { resolution: '1080p', ratio: '4:3' });
  assert.deepEqual(mapArkVideoSize('480p', 'doubao-seedance-2.5', 'x'), { resolution: '480p' });
  assert.throws(() => mapArkVideoSize('1000x1000', 'doubao-seedance-2.5', 'x'), (e) => e.code === 'E_SIZE');
  assert.throws(() => mapArkVideoSize('2048x858', 'doubao-seedance-2.5', 'x'), (e) => e.code === 'E_SIZE');
});

test('bza-seedream: response_format=url path downloads image bytes binary-safe', async () => {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/images/generations') {
      let b = [];
      req.on('data', (c) => b.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(b).toString('utf8'));
        assert.equal(body.model, 'doubao-seedream-5.0-pro');
        assert.equal(body.prompt, 'a paper boat');
        assert.equal(body.response_format, 'url');
        json(res, 200, { model: body.model, created: 1, data: [{ url: `http://127.0.0.1:${server.address().port}/img.png`, size: '1024x1024', output_format: 'png' }] });
      });
    } else if (req.url === '/img.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(BIN);
    } else {
      json(res, 404, {});
    }
  });
  const base = await listen(server);
  try {
    process.env.SYNTHMEDIA_BZA_API_KEY = 'bza-test-key-000111';
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({ outputDir: await mkdtemp(join(tmpdir(), 'synth-')), backends: { 'bza-seedream': { baseUrl: base, timeoutMs: 20000, model: 'doubao-seedream-5.0-pro', protocolVerified: true } } });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.wait((await jobs.start({ backend: 'bza-seedream', model: 'doubao-seedream-5.0-pro', modality: 'image', prompt: 'a paper boat' })).id);
    assert.equal(rec.status, 'succeeded');
    assert.equal(rec.artifacts[0].kind, 'image');
    assert.ok(rec.artifacts[0].path.endsWith('result.png'));
    const bytes = await readFile(rec.artifacts[0].path);
    assert.ok(bytes.equals(BIN), 'image bytes must survive byte-for-byte');
  } finally {
    server.close();
    delete process.env.SYNTHMEDIA_BZA_API_KEY;
  }
});

test('bza-seedream: b64_json path decodes to exact bytes (no text-decode damage)', async () => {
  const server = createServer((req, res) => {
    json(res, 200, { data: [{ b64_json: BIN.toString('base64'), output_format: 'jpeg' }] });
  });
  const base = await listen(server);
  try {
    process.env.SYNTHMEDIA_BZA_API_KEY = 'bza-test-key-000111';
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({ outputDir: await mkdtemp(join(tmpdir(), 'synth-')), backends: { 'bza-seedream': { baseUrl: base, timeoutMs: 20000, protocolVerified: true, extraBody: { response_format: 'b64_json' } } } });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.wait((await jobs.start({ backend: 'bza-seedream', model: 'doubao-seedream-5.0-flash', modality: 'image', prompt: 'p' })).id);
    assert.equal(rec.status, 'succeeded');
    assert.equal(rec.artifacts[0].mimeType, 'image/jpeg');
    const bytes = await readFile(rec.artifacts[0].path);
    assert.ok(bytes.equals(BIN));
  } finally {
    server.close();
    delete process.env.SYNTHMEDIA_BZA_API_KEY;
  }
});

test('bza-seed-tts: real submission is HARD-BLOCKED (E_PROTOCOL_UNVERIFIED, zero network requests)', async () => {
  let requests = 0;
  const server = createServer(() => { requests += 1; });
  const base = await listen(server);
  try {
    process.env.SYNTHMEDIA_BZA_API_KEY = 'bza-test-key-000111';
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({ outputDir: await mkdtemp(join(tmpdir(), 'synth-')), backends: { 'bza-seed-tts': { baseUrl: base, timeoutMs: 20000 } } });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.wait((await jobs.start({ backend: 'bza-seed-tts', model: 'doubao-seed-tts-2.0', modality: 'audio', prompt: '你好' })).id);
    assert.equal(rec.status, 'failed');
    assert.equal(rec.error.code, 'E_PROTOCOL_UNVERIFIED', 'unverified TTS protocol must refuse real submission');
    assert.equal(requests, 0, 'no byte may reach the network for a blocked protocol');
  } finally {
    server.close();
    delete process.env.SYNTHMEDIA_BZA_API_KEY;
  }
});

test('capabilities: bza backends advertise verbatim doubao IDs; seedance+seedream verified=true (2026-11-17 live runs), seed-tts stays locked', async () => {
  delete process.env.SYNTHMEDIA_BZA_SEEDANCE_MODEL;
  delete process.env.SYNTHMEDIA_BZA_SEEDREAM_MODEL;
  const { resolveConfig } = await import('../lib/config.js');
  const { createBackendRegistry } = await import('../lib/backends/index.js');
  const cfg = resolveConfig({ outputDir: await mkdtemp(join(tmpdir(), 'synth-')) });
  const jobs = new (await import('../lib/jobs.js')).JobManager(cfg, createBackendRegistry(cfg));
  const caps = jobs.listBackends();
  const byId = Object.fromEntries(caps.map((b) => [b.id, b]));
  assert.deepEqual(byId['bza-seedance'].models, ['doubao-seedance-2.0', 'doubao-seedance-2.0-fast', 'doubao-seedance-2.0-mini', 'doubao-seedance-2.5']);
  assert.deepEqual(byId['bza-seedream'].models, ['doubao-seedream-5.0-flash', 'doubao-seedream-5.0-pro']);
  assert.deepEqual(byId['bza-seed-tts'].models, ['doubao-seed-tts-2.0']);
  // bza-seedance live-verified 2026-11-17 (task cgt-c-20261117152106-dtbms);
  // bza-seedream live-verified 2026-11-17 (doubao-seedream-5.0-pro, HTTP 200,
  // 2496x1664 JPEG, synthmedia-output/bza-seedream-real/);
  // seed-tts remains unverified: /api/v3/tts/submit and /tts/submit both
  // returned HTTP 404 empty-body on the gateway (2026-11-17) ⇒ locked.
  assert.equal(byId['bza-seedance'].protocolVerified, true);
  assert.equal(byId['bza-seedream'].protocolVerified, true);
  assert.equal(byId['bza-seed-tts'].protocolVerified, false);
  assert.equal(byId['bza-seedance'].realSubmitAllowed, true, 'verified protocol must allow real submit');
  assert.equal(byId['bza-seedream'].realSubmitAllowed, true, 'verified protocol must allow real submit');
  assert.equal(byId['bza-seed-tts'].realSubmitAllowed, false);
  assert.equal(byId['zgci-h3'].protocolVerified, true);
  assert.equal(byId['local-h3-sidecar'].protocolVerified, true);
  for (const b of caps) {
    for (const m of b.models) assert.ok(!m.includes('UNVERIFIED'), `no UNVERIFIED may remain inside a model id: ${m}`);
  }
  // Canonical protocol ids are advertised (not legacy kind names).
  assert.equal(byId['bza-seedance'].protocol, 'volcengine-ark-compatible');
  assert.equal(byId['zgci-h3'].protocol, 'openai-video-compatible');
  assert.equal(byId['local-h3-sidecar'].protocol, 'openai-video-compatible');
  assert.equal(byId['local-h3'].protocol, 'videogen-task-api');
  // Per-model capability data is capability-only (no URLs / credentials).
  assert.ok(!JSON.stringify(byId).includes('llm.inner.bza'), 'capabilities must not leak connection config');
});

test('bza-profile override: an operator-verified profile may submit (guard is per profile, not vendor)', async () => {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/images/generations') {
      json(res, 200, { data: [{ b64_json: BIN.toString('base64'), output_format: 'png' }] });
    } else json(res, 404, {});
  });
  const base = await listen(server);
  try {
    process.env.SYNTHMEDIA_BZA_API_KEY = 'bza-test-key-000111';
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    // A custom profile (any gateway) opts in to the same official protocol.
    const cfg = resolveConfig({
      outputDir: await mkdtemp(join(tmpdir(), 'synth-')),
      backends: { 'my-ark-gateway': { protocol: 'volcengine-ark-compatible', model: 'doubao-seedream-5.0-pro', models: ['doubao-seedream-5.0-pro', 'other-model'], modalities: ['image'], baseUrl: base, authEnv: 'SYNTHMEDIA_BZA_API_KEY', authStyle: 'bearer', online: true, timeoutMs: 20000, protocolVerified: true, paths: { submit: '/images/generations', status: '/images/generations/{id}', content: '/images/generations/{id}' } } },
    });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const caps = jobs.listBackends().find((b) => b.id === 'my-ark-gateway');
    assert.equal(caps.realSubmitAllowed, true);
    assert.deepEqual(caps.models, ['doubao-seedream-5.0-pro', 'other-model'], 'model list is fully overridable');
    const rec = await jobs.wait((await jobs.start({ backend: 'my-ark-gateway', model: 'doubao-seedream-5.0-pro', modality: 'image', prompt: 'p' })).id);
    assert.equal(rec.status, 'succeeded');
  } finally {
    server.close();
    delete process.env.SYNTHMEDIA_BZA_API_KEY;
  }
});
