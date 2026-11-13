/**
 * Round-2 regression & contract tests: offline sidecar /v1/videos (official
 * vLLM-Omni shape), binary-safe downloads, outputDir override, cancel latency,
 * real-adapter offline error mapping, and ctx.jobs host-UI integration.
 * All tests run against local mock servers / real adapters — NO real remote
 * generation calls are ever made.
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

const BYTES = Buffer.from([0x00, 0xff, 0x80, 0x41, 0xe7, 0xa0, 0x8d, 0xe2, 0x82, 0xac, 0x7f, 0xc3, 0x28]);

test('contract: offline sidecar multipart /v1/videos async end-to-end (official vLLM-Omni shape)', async () => {
  let polls = 0;
  let seenMultipart = '';
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/videos') {
      let b = [];
      req.on('data', (c) => b.push(c));
      req.on('end', () => {
        seenMultipart = (req.headers['content-type'] ?? '').startsWith('multipart/form-data') ? 'yes' : `no:${req.headers['content-type']}`;
        const text = Buffer.concat(b).toString('utf8');
        assert.ok(text.includes('name="prompt"'), 'prompt must be a multipart form field');
        assert.ok(text.includes('a cat'));
        json(res, 200, { id: 'vid-9', status: 'queued', created_at: 1 });
      });
    } else if (req.method === 'GET' && req.url === '/v1/videos/vid-9') {
      polls += 1;
      if (polls === 1) json(res, 200, { id: 'vid-9', status: 'queued', progress: 0 });
      else if (polls === 2) json(res, 200, { id: 'vid-9', status: 'in_progress', progress: 60 });
      else json(res, 200, { id: 'vid-9', status: 'completed', progress: 100 });
    } else if (req.url === '/v1/videos/vid-9/content') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(BYTES);
    } else if (req.method === 'DELETE' && req.url === '/v1/videos/vid-9') {
      json(res, 200, { deleted: true });
    } else {
      json(res, 404, {});
    }
  });
  const base = await listen(server);
  try {
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({ outputDir: await mkdtemp(join(tmpdir(), 'synth-')), backends: { 'local-h3-sidecar': { baseUrl: base, pollIntervalMs: 20, timeoutMs: 20000 } } });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.wait((await jobs.start({ backend: 'local-h3-sidecar', model: 'minimax-h3', modality: 'video', prompt: 'a cat', size: '1280x720' })).id);
    assert.equal(seenMultipart, 'yes', 'submit must use multipart/form-data per official videos_api.md');
    assert.equal(rec.status, 'succeeded');
    assert.equal(rec.remoteId, 'vid-9');
    const bytes = await readFile(rec.artifacts[0].path);
    assert.ok(bytes.equals(BYTES), 'multi-byte + 0xff/0x80 binary must survive byte-for-byte');
    // DELETE cancel path configured (vLLM-Omni cancellation)
    assert.equal(cfg.backends['local-h3-sidecar'].cancelMethod, 'DELETE');
  } finally {
    server.close();
  }
});

test('contract: sidecar sync mode SYNTHMEDIA_SIDECAR_SYNC=1 returns raw MP4 bytes via /v1/videos/sync', async () => {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/videos/sync') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(BYTES);
    } else {
      json(res, 404, {});
    }
  });
  const base = await listen(server);
  process.env['SYNTHMEDIA_SIDECAR_SYNC'] = '1';
  try {
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({ outputDir: await mkdtemp(join(tmpdir(), 'synth-')), backends: { 'local-h3-sidecar': { baseUrl: base, timeoutMs: 20000 } } });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.wait((await jobs.start({ backend: 'local-h3-sidecar', model: 'minimax-h3', modality: 'video', prompt: 'sync' })).id);
    assert.equal(rec.status, 'succeeded');
    const bytes = await readFile(rec.artifacts[0].path);
    assert.ok(bytes.equals(BYTES));
  } finally {
    server.close();
    delete process.env['SYNTHMEDIA_SIDECAR_SYNC'];
  }
});

test('config: overrides.outputDir is honored (was previously ignored)', async () => {
  delete process.env['SYNTHMEDIA_OUTPUT_DIR'];
  const { resolveConfig } = await import('../lib/config.js');
  const explicit = join(tmpdir(), 'synthmedia-explicit-out-check');
  const cfg = resolveConfig({ outputDir: explicit });
  assert.equal(cfg.outputDir, explicit, 'explicit overrides.outputDir must win');
  // env still respected when no override
  process.env['SYNTHMEDIA_OUTPUT_DIR'] = '/tmp/synthmedia-env-out';
  const viaEnv = resolveConfig({});
  assert.equal(viaEnv.outputDir, '/tmp/synthmedia-env-out');
  delete process.env['SYNTHMEDIA_OUTPUT_DIR'];
  const dflt = resolveConfig({});
  assert.equal(dflt.outputDir, 'synthmedia-output');
  // jobs actually write under the honored dir
  const { createBackendRegistry } = await import('../lib/backends/index.js');
  const { JobManager } = await import('../lib/jobs.js');
  const dir = await mkdtemp(join(tmpdir(), 'synth-'));
  const jobs = new JobManager(resolveConfig({ outputDir: dir }), createBackendRegistry(resolveConfig({ outputDir: dir })));
  const rec = await jobs.start({ backend: 'zgci-h3', model: 'minimax-h3', modality: 'video', prompt: 'p' });
  await jobs.cancel(rec.id);
  const onDisk = JSON.parse(await readFile(join(dir, rec.id, 'job.json'), 'utf8'));
  assert.equal(onDisk.id, rec.id);
});

test('cancellation responds immediately (no poll-interval-scale delay)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synth-'));
  const { resolveConfig } = await import('../lib/config.js');
  const { createBackendRegistry } = await import('../lib/backends/index.js');
  const { JobManager } = await import('../lib/jobs.js');
  const cfg = resolveConfig({ outputDir: dir, backends: { 'local-h3': { baseUrl: 'http://127.0.0.1:9', pollIntervalMs: 10_000, timeoutMs: 600_000 } } });
  const jobs = new JobManager(cfg, createBackendRegistry(cfg));
  const rec = await jobs.start({ backend: 'local-h3', model: 'minimax-h3', modality: 'video', prompt: 'v' });
  const t0 = Date.now();
  const after = await jobs.cancel(rec.id);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1500, `cancel took ${elapsed}ms — sleep must wake on abort immediately, not wait the 10s poll interval`);
  assert.equal(after.status, 'cancelled');
});

test('real task-api adapter maps network failure to E_OFFLINE_UNAVAILABLE (no fake backend)', async () => {
  const { resolveConfig } = await import('../lib/config.js');
  const { createBackendRegistry } = await import('../lib/backends/index.js');
  const { JobManager } = await import('../lib/jobs.js');
  const dir = await mkdtemp(join(tmpdir(), 'synth-'));
  // port 9 (discard) is refused on macOS/Linux: a REAL adapter, REAL network failure
  process.env.SYNTHMEDIA_LOCAL_H3_AUTH = 'u:p';
  try {
  const cfg = resolveConfig({ outputDir: dir, backends: { 'local-h3': { baseUrl: 'http://127.0.0.1:9', timeoutMs: 3000 } } });
  const jobs = new JobManager(cfg, createBackendRegistry(cfg));
  const rec = await jobs.wait((await jobs.start({ backend: 'local-h3', model: 'minimax-h3', modality: 'video', prompt: 'v' })).id);
  assert.equal(rec.status, 'failed');
  assert.equal(rec.error.code, 'E_OFFLINE_UNAVAILABLE');
  assert.match(rec.error.message, /never silently forwarded/);
  const { OfflineUnavailableError } = await import('../lib/errors.js');
  assert.ok(rec.error.message.length > 0);
  // also offline sidecar adapter, same mapping
  const cfg2 = resolveConfig({ outputDir: dir, backends: { 'local-h3-sidecar': { baseUrl: 'http://127.0.0.1:9', timeoutMs: 3000 } } });
  const jobs2 = new JobManager(cfg2, createBackendRegistry(cfg2));
  const rec2 = await jobs2.wait((await jobs2.start({ backend: 'local-h3-sidecar', model: 'minimax-h3', modality: 'video', prompt: 'v' })).id);
  assert.equal(rec2.error.code, 'E_OFFLINE_UNAVAILABLE');
  } finally { delete process.env.SYNTHMEDIA_LOCAL_H3_AUTH; }
});

test('ctx.jobs integration: jobs register with the host Jobs UI and settle with proper outcomes', async () => {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/videogen') json(res, 200, { task_id: 'V1' });
    else if (req.url === '/v1/videogen/V1') json(res, 200, { status: 'completed', progress: 100 });
    else if (req.url === '/v1/videogen/V1/content') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(Buffer.from('MP4X'));
    } else json(res, 404, {});
  });
  const base = await listen(server);
  try {
    process.env.SYNTHMEDIA_LOCAL_H3_AUTH = 'u:p';
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const { buildSynthMediaTools } = await import('../lib/tools.js');

    // Minimal structural mock of the DSH JobRegistry contract.
    const registered = [];
    const hostJobs = {
      start(spec) {
        assert.equal(typeof spec.run, 'function');
        const progressLines = [];
        const handle = { id: `synthmedia-${registered.length + 1}`, append() {}, updateProgress: (l) => progressLines.push(l) };
        const hooks = spec.run(handle);
        registered.push({ spec, hooks, progressLines });
        return handle.id;
      },
    };

    const dir = await mkdtemp(join(tmpdir(), 'synth-'));
    const cfg = resolveConfig({ outputDir: dir, backends: { 'local-h3': { baseUrl: base, pollIntervalMs: 20, timeoutMs: 20000 } } });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg), hostJobs);
    const tools = Object.fromEntries(buildSynthMediaTools(jobs).map((d) => [d.name, d]));
    const exec = { signal: new AbortController().signal };
    const gen = await tools['synthmedia_generate'].execute({ backend: 'local-h3', model: 'minimax-h3', modality: 'video', prompt: 'ui test' }, exec);
    assert.equal(registered.length, 1, 'job must be registered with the host registry');
    assert.equal(registered[0].spec.kind, 'synthmedia');
    assert.match(registered[0].spec.label, /local-h3\/minimax-h3/);
    const final = await tools['synthmedia_wait'].execute({ id: gen.job.id }, exec);
    assert.equal(final.job.status, 'succeeded');
    // host job settled as completed with real progress lines
    const outcome = await registered[0].hooks.done;
    assert.equal(outcome.status, 'completed');
    assert.ok(registered[0].progressLines.some((l) => l.includes('100%')), `progress must reach the host UI, got ${JSON.stringify(registered[0].progressLines)}`);

    // cancellation path: host hook cancel settles the job as killed
    const server2 = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/videogen') json(res, 200, { task_id: 'V2' });
      else if (req.url === '/v1/videogen/V2') json(res, 200, { status: 'in_progress', progress: 10 });
      else json(res, 404, {});
    });
    const base2 = await listen(server2);
    try {
      const cfg2 = resolveConfig({ outputDir: dir, backends: { 'local-h3': { baseUrl: base2, pollIntervalMs: 20, timeoutMs: 20000 } } });
      const jobs2 = new JobManager(cfg2, createBackendRegistry(cfg2), hostJobs);
      const tools2 = Object.fromEntries(buildSynthMediaTools(jobs2).map((d) => [d.name, d]));
      const gen2 = await tools2['synthmedia_generate'].execute({ backend: 'local-h3', model: 'minimax-h3', modality: 'video', prompt: 'kill me' }, exec);
      const reg = registered[registered.length - 1];
      reg.hooks.cancel('user requested');
      const done2 = await reg.hooks.done;
      assert.equal(done2.status, 'killed');
      const st = await tools2['synthmedia_status'].execute({ id: gen2.job.id }, exec);
      assert.equal(st.job.status, 'cancelled');
    } finally {
      server2.close();
    }
  } finally {
    server.close();
    delete process.env.SYNTHMEDIA_LOCAL_H3_AUTH;
  }
});

test('apply(): without ctx.jobs the plugin still works (UI face optional)', async () => {
  const { apply } = await import('../lib/index.js');
  const registered = [];
  apply({ tools: { register: (d) => registered.push(d.name) } }, { outputDir: await mkdtemp(join(tmpdir(), 'synth-')) });
  assert.equal(registered.length, 5);
});
