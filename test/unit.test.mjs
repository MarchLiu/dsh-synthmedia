import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeText, SynthError, OfflineUnavailableError } from '../lib/errors.js';
import { defaultConfig, validateBackend, resolveConfig } from '../lib/config.js';
import { JobManager } from '../lib/jobs.js';
import { createBackendRegistry } from '../lib/backends/index.js';

test('sanitizeText redacts bearer/basic/api-key shapes', () => {
  const out = sanitizeText('failed: Authorization: Bearer abc123XYZdef and sk-abcdefghijklmnop but keep http 404');
  assert.ok(!out.includes('abc123XYZdef'));
  assert.ok(!out.includes('sk-abcdefghijklmnop'));
  assert.ok(out.includes('404'));
});

test('config: task-api requires {id} paths', () => {
  assert.throws(
    () => validateBackend({ id: 'x', kind: 'task-api', model: 'm', modalities: ['video'], baseUrl: 'http://x', authStyle: 'bearer', authEnv: 'X', online: true, timeoutMs: 1000, paths: { submit: '/s', status: '/noid', content: '/c/{id}' } }),
    (e) => e instanceof SynthError && e.code === 'E_CONFIG',
  );
});

test('config: defaults include all required backends with correct routing', () => {
  const cfg = defaultConfig();
  for (const id of ['local-h3', 'local-h3-sidecar', 'zgci-h3', 'bza-seedance', 'bza-seedream', 'bza-seed-tts']) {
    assert.ok(cfg.backends[id], `missing backend ${id}`);
  }
  assert.ok(!cfg.backends['bza-seestream'], 'Seestream placeholder must be gone (superseded by Seedream facts)');
  assert.equal(cfg.backends['zgci-h3'].baseUrl, 'https://hub.zgci.org');
  assert.equal(cfg.backends['zgci-h3'].model, 'minimax-h3');
  assert.equal(cfg.backends['local-h3'].online, false);
  assert.equal(cfg.backends['local-h3-sidecar'].online, false);
  // bza: real doubao model IDs verbatim (from user screenshot), never UNVERIFIED-in-ID
  assert.equal(cfg.backends['bza-seedance'].model, 'doubao-seedance-2.0');
  assert.deepEqual(cfg.backends['bza-seedance'].models, ['doubao-seedance-2.0', 'doubao-seedance-2.0-fast', 'doubao-seedance-2.0-mini', 'doubao-seedance-2.5']);
  assert.equal(cfg.backends['bza-seedream'].model, 'doubao-seedream-5.0-flash');
  assert.deepEqual(cfg.backends['bza-seedream'].models, ['doubao-seedream-5.0-flash', 'doubao-seedream-5.0-pro']);
  assert.equal(cfg.backends['bza-seed-tts'].model, 'doubao-seed-tts-2.0');
  // verification metadata: seedance live-verified 2026-11-17 (task
  // cgt-c-20261117152106-dtbms); seedream live-verified 2026-11-17
  // (doubao-seedream-5.0-pro, HTTP 200); TTS hard-blocked (gateway 404s)
  for (const id of ['bza-seed-tts']) {
    assert.equal(cfg.backends[id].protocolVerified, false, `${id} protocolVerified must be false`);
  }
  assert.equal(cfg.backends['bza-seedream'].protocolVerified, true, 'bza-seedream protocolVerified must be true (verified 2026-11-17)');
  assert.equal(cfg.backends['bza-seedance'].protocolVerified, true, 'bza-seedance protocolVerified must be true (verified 2026-11-17)');
  assert.equal(cfg.backends['bza-seed-tts'].blockRealSubmit, true);
  assert.equal(cfg.backends['zgci-h3'].protocolVerified, true);
  // bza base URL default is the bza proxy, never the public Ark address
  assert.equal(cfg.backends['bza-seedance'].baseUrl, 'https://llm.inner.bza.edu.cn/plan/v3');
  const allDefaults = JSON.stringify(defaultConfig());
  assert.ok(!allDefaults.includes('ark.cn-beijing.volces.com'), 'public Ark base URL must never be hardcoded as a default');
});

test('router: unknown backend fails hard, no fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synth-'));
  const cfg = resolveConfig({ outputDir: dir });
  const jobs = new JobManager(cfg, createBackendRegistry(cfg));
  await assert.rejects(
    () => jobs.start({ backend: 'some-cloud', model: 'x', modality: 'video', prompt: 'p' }),
    (e) => e instanceof SynthError && e.code === 'E_NO_BACKEND',
  );
});

test('router: wrong model rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synth-'));
  const cfg = resolveConfig({ outputDir: dir });
  const jobs = new JobManager(cfg, createBackendRegistry(cfg));
  await assert.rejects(
    () => jobs.start({ backend: 'zgci-h3', model: 'gpt-9', modality: 'video', prompt: 'p' }),
    (e) => e instanceof SynthError && e.code === 'E_MODEL',
  );
});

test('inline text backend: job completes, artifact on disk, secret in payload sanitized', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synth-'));
  const cfg = resolveConfig({ outputDir: dir });
  const fake = {
    id: 'fake-text',
    capabilities: () => ({ modalities: ['text'], models: ['minimax-h3'], online: true }),
    // deliberately leaks a credential-shaped string; must never reach the record
    create: async () => ({ remoteId: 'inline', inline: { text: 'ok Bearer supersecret999', mimeType: 'text/plain' } }),
    poll: async () => ({ status: 'succeeded', progress: 100 }),
    fetch: async () => { throw new Error('unused'); },
  };
  const jobs = new JobManager(cfg, new Map([['fake-text', fake]]));
  const rec = await jobs.wait((await jobs.start({ backend: 'fake-text', model: 'minimax-h3', modality: 'text', prompt: 'hi' })).id);
  assert.equal(rec.status, 'succeeded');
  const raw = JSON.stringify(rec);
  assert.ok(!raw.includes('supersecret999'), 'secret leaked into job record');
  assert.ok(rec.artifacts[0].path.endsWith('result.txt'));
});

test('offline backend failure stays offline: structured error, no cloud call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synth-'));
  const cfg = resolveConfig({ outputDir: dir });
  let cloudCalled = false;
  const localFail = {
    id: 'local-h3',
    capabilities: () => ({ modalities: ['video'], models: ['minimax-h3'], online: false }),
    create: async () => { throw new OfflineUnavailableError('local-h3', 'ECONNREFUSED 127.0.0.1:8791'); },
    poll: async () => ({ status: 'running', progress: 0 }),
    fetch: async () => { throw new Error('unused'); },
  };
  const cloud = {
    id: 'zgci-h3',
    capabilities: () => ({ modalities: ['video'], models: ['minimax-h3'], online: true }),
    create: async () => { cloudCalled = true; throw new Error('should not be called'); },
    poll: async () => ({ status: 'running', progress: 0 }),
    fetch: async () => { throw new Error('unused'); },
  };
  const jobs = new JobManager(cfg, new Map([['local-h3', localFail], ['zgci-h3', cloud]]));
  const rec = await jobs.wait((await jobs.start({ backend: 'local-h3', model: 'minimax-h3', modality: 'video', prompt: 'v' })).id);
  assert.equal(rec.status, 'failed');
  assert.equal(rec.error.code, 'E_OFFLINE_UNAVAILABLE');
  assert.equal(cloudCalled, false, 'offline failure was silently forwarded to cloud');
});

test('cancellation flips job to cancelled with sanitized error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synth-'));
  const cfg = resolveConfig({ outputDir: dir });
  let cancelledRemote = false;
  const backend = {
    id: 'slow',
    capabilities: () => ({ modalities: ['video'], models: ['m'], online: false }),
    create: async () => ({ remoteId: 'r1' }),
    poll: async (_id, signal) => {
      await new Promise((res, rej) => {
        const t = setTimeout(res, 5000);
        signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true });
      });
      return { status: 'running', progress: 5 };
    },
    fetch: async () => ({ bytes: Buffer.alloc(0), mimeType: 'video/mp4' }),
    cancel: async () => { cancelledRemote = true; },
  };
  const jobs = new JobManager(cfg, new Map([['slow', backend]]));
  const rec = await jobs.start({ backend: 'slow', model: 'm', modality: 'video', prompt: 'v' });
  await jobs.cancel(rec.id);
  const after = await jobs.get(rec.id);
  assert.equal(after.status, 'cancelled');
  assert.equal(cancelledRemote, true);
});

test('timeout produces timeout status with sanitized error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synth-'));
  const cfg = resolveConfig({ outputDir: dir, backends: { 'slow-t': { timeoutMs: 80, pollIntervalMs: 30, paths: { submit: '/s', status: '/s/{id}', content: '/s/{id}/c' } } } });
  const backend = {
    id: 'slow-t',
    capabilities: () => ({ modalities: ['video'], models: ['m'], online: false }),
    create: async () => ({ remoteId: 'r1' }),
    poll: async (_id, signal) => {
      await new Promise((res) => {
        const t = setTimeout(res, 5000);
        signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
      });
      return { status: 'running', progress: 1 };
    },
    fetch: async () => ({ bytes: Buffer.alloc(0), mimeType: 'video/mp4' }),
  };
  const jobs = new JobManager(cfg, new Map([['slow-t', backend]]));
  const rec = await jobs.start({ backend: 'slow-t', model: 'm', modality: 'video', prompt: 'v' });
  const after = await jobs.wait(rec.id);
  assert.equal(after.status, 'timeout');
  assert.equal(after.error.code, 'E_TIMEOUT');
});
