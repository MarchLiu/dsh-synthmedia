/**
 * MiniMax official video V2 (MiniMax-H3) protocol contract tests.
 *
 * Wire shape and field names come from the OFFICIAL MiniMax documentation
 * (platform.minimax.io):
 * - create:  POST /v2/video_generation
 *            {model, content:[{type:'text',text}], resolution:'480P'|'768P'|'2K',
 *             duration:4..15, ratio?} → {task_id}
 * - query:   GET /v2/query/video_generation/{task_id} →
 *            {task:{id,status:'queued'|'running'|'succeeded'|'failed'|'cancelled',
 *                   content:{url}, error:{code,message}}}
 * - delete:  DELETE /v2/video_generation/{task_id} →
 *            {task_id, action:'cancelled'|'deleted', status}
 * - errors:  OpenAI-style {type:'error', error:{type,message,http_code}, request_id}
 *
 * EVERYTHING here runs against a local mock server. NO real MiniMax call is
 * ever made, and no credential value is hardcoded (a throwaway env value is
 * injected per test and deleted afterwards).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
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

/** Read a request body as JSON. */
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

test('minimax-official: full task cycle create → queued/running → succeeded → signed URL download', async () => {
  const seen = { submit: null, auth: '', cdnAuth: null, cdnHits: 0, polls: 0 };
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v2/video_generation') {
      seen.auth = req.headers['authorization'] ?? '';
      seen.submit = await readJson(req);
      json(res, 200, { task_id: '424010985738629' });
    } else if (req.method === 'GET' && req.url === '/v2/query/video_generation/424010985738629') {
      seen.polls += 1;
      if (seen.polls === 1) {
        json(res, 200, { task: { id: '424010985738629', model: 'MiniMax-H3', status: 'queued' } });
      } else if (seen.polls === 2) {
        json(res, 200, { task: { id: '424010985738629', model: 'MiniMax-H3', status: 'running' } });
      } else {
        json(res, 200, {
          task: {
            id: '424010985738629',
            model: 'MiniMax-H3',
            status: 'succeeded',
            content: { url: `${base}/cdn/h3-output.mp4` },
            resolution: '768P',
            duration: 5,
            ratio: '16:9',
            task_type: 'generation',
            modality: 'video',
            updated_at: 1785125946,
          },
        });
      }
    } else if (req.method === 'GET' && req.url === '/cdn/h3-output.mp4') {
      seen.cdnHits += 1;
      seen.cdnAuth = req.headers['authorization'] ?? null;
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(BIN);
    } else {
      json(res, 404, {});
    }
  });
  const base = await listen(server);
  process.env.MINIMAX_API_KEY = 'mm-test-key-0001';
  try {
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const dir = await mkdtemp(join(tmpdir(), 'synth-minimax-'));
    const cfg = resolveConfig({
      outputDir: dir,
      backends: { 'minimax-official': { baseUrl: base, pollIntervalMs: 20, timeoutMs: 30_000 } },
    });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.wait(
      (await jobs.start({
        backend: 'minimax-official',
        model: 'MiniMax-H3',
        modality: 'video',
        prompt: 'a paper boat drifting on still water',
        durationSeconds: 5,
        size: '768P',
      })).id,
    );

    assert.equal(rec.status, 'succeeded');
    assert.equal(rec.remoteId, '424010985738629');
    assert.equal(seen.auth, 'Bearer mm-test-key-0001', 'official Bearer auth');
    // Official V2 create body: content array, resolution/duration/ratio — no `size`.
    assert.equal(seen.submit.model, 'MiniMax-H3');
    assert.deepEqual(seen.submit.content, [{ type: 'text', text: 'a paper boat drifting on still water' }]);
    assert.equal(seen.submit.resolution, '768P');
    assert.equal(seen.submit.duration, 5);
    assert.equal(seen.submit.ratio, '16:9');
    assert.ok(!('size' in seen.submit), 'the V2 protocol has no pixel size field');
    assert.equal(seen.polls, 3, 'queued → running → succeeded polled through the unified job');
    assert.equal(seen.cdnHits, 1);
    assert.equal(seen.cdnAuth, null, 'the signed CDN URL is fetched WITHOUT the API key');
    assert.equal(rec.artifacts.length, 1);
    assert.equal(rec.artifacts[0].mimeType, 'video/mp4');
    // Official query carries no completed_at: the terminal updated_at is the
    // provider's completion instant, kept apart from the LOCAL download time.
    assert.equal(rec.remoteCompletedAt, new Date(1785125946 * 1000).toISOString());
    assert.ok(rec.downloadedAt, 'local download completion time is recorded');
    assert.ok(Date.parse(rec.finishedAt) >= Date.parse(rec.downloadedAt));
    assert.notEqual(rec.remoteCompletedAt, rec.downloadedAt);
    const bytes = await readFile(rec.artifacts[0].path);
    assert.ok(bytes.equals(BIN), 'binary artifact survives byte-for-byte (0xff/0x80/multi-byte)');
  } finally {
    delete process.env.MINIMAX_API_KEY;
    server.close();
  }
});

test('minimax-official: only DOCUMENTED V2 fields are sent; relay extras come from extraBody', async () => {
  const seen = { submit: null };
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v2/video_generation') {
      seen.submit = await readJson(req);
      json(res, 200, { task_id: '424010985738640' });
    } else if (req.method === 'GET' && req.url === '/v2/query/video_generation/424010985738640') {
      json(res, 200, {
        task: { id: '424010985738640', status: 'succeeded', content: { url: `${base}/cdn/x.mp4` }, updated_at: 1785125946 },
      });
    } else if (req.method === 'GET' && req.url === '/cdn/x.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(BIN);
    } else json(res, 404, {});
  });
  const base = await listen(server);
  process.env.MINIMAX_API_KEY = 'mm-test-key-0006';
  try {
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({
      outputDir: await mkdtemp(join(tmpdir(), 'synth-minimax-')),
      backends: {
        'minimax-official': {
          baseUrl: base,
          pollIntervalMs: 10,
          timeoutMs: 20_000,
          // Relay/gateway-specific documented options are configuration, not code.
          extraBody: { extra: { prompt_expansion_mode: 'quality' } },
        },
      },
    });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.wait(
      (await jobs.start({
        backend: 'minimax-official',
        model: 'MiniMax-H3-Max',
        modality: 'video',
        prompt: 'p',
        durationSeconds: 5,
        size: '768P',
        seed: 42,
        negativePrompt: 'blurry',
      })).id,
    );
    assert.equal(rec.status, 'succeeded');
    assert.equal(seen.submit.model, 'MiniMax-H3-Max');
    assert.deepEqual(seen.submit.content, [{ type: 'text', text: 'p' }]);
    assert.equal(seen.submit.resolution, '768P');
    assert.equal(seen.submit.duration, 5);
    assert.equal(seen.submit.ratio, '16:9');
    // The V2 schema documents neither seed nor negative_prompt: never invented.
    assert.ok(!('seed' in seen.submit), 'seed is not part of the documented V2 schema');
    assert.ok(!('negative_prompt' in seen.submit), 'negative_prompt is not part of the documented V2 schema');
    assert.ok(!('size' in seen.submit), 'no pixel size field exists');
    // Explicit profile configuration does reach the wire (documented `extra`).
    assert.deepEqual(seen.submit.extra, { prompt_expansion_mode: 'quality' });
  } finally {
    delete process.env.MINIMAX_API_KEY;
    server.close();
  }
});

test('minimax-official: failed task maps task.error {code,message} into a sanitized structured failure', async () => {
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v2/video_generation') {
      json(res, 200, { task_id: '424010985738630' });
    } else if (req.method === 'GET' && req.url === '/v2/query/video_generation/424010985738630') {
      json(res, 200, {
        task: {
          id: '424010985738630',
          model: 'MiniMax-H3',
          status: 'failed',
          error: { code: '1026', message: 'video description contains sensitive content' },
        },
      });
    } else json(res, 404, {});
  });
  const base = await listen(server);
  process.env.MINIMAX_API_KEY = 'mm-test-key-0002';
  try {
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({
      outputDir: await mkdtemp(join(tmpdir(), 'synth-minimax-')),
      backends: { 'minimax-official': { baseUrl: base, pollIntervalMs: 20, timeoutMs: 30_000 } },
    });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.wait(
      (await jobs.start({ backend: 'minimax-official', model: 'MiniMax-H3', modality: 'video', prompt: 'x', durationSeconds: 4 })).id,
    );
    assert.equal(rec.status, 'failed');
    assert.equal(rec.error.code, '1026', 'the official task error code is preserved');
    assert.match(rec.error.message, /sensitive content/);
  } finally {
    delete process.env.MINIMAX_API_KEY;
    server.close();
  }
});

test('minimax-official: OpenAI-style error envelope maps to a structured E_AUTH with zero task created', async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    json(res, 401, {
      type: 'error',
      error: {
        type: 'authorized_error',
        message: "login fail: Please carry the API secret key in the 'Authorization' field of the request header (1004)",
        http_code: '401',
      },
      request_id: '021785229015510a2c883cf675b9804d',
    });
  });
  const base = await listen(server);
  process.env.MINIMAX_API_KEY = 'mm-bad-key-0003';
  try {
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({
      outputDir: await mkdtemp(join(tmpdir(), 'synth-minimax-')),
      backends: { 'minimax-official': { baseUrl: base, pollIntervalMs: 20, timeoutMs: 30_000 } },
    });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.wait(
      (await jobs.start({ backend: 'minimax-official', model: 'MiniMax-H3', modality: 'video', prompt: 'x', durationSeconds: 4 })).id,
    );
    assert.equal(rec.status, 'failed');
    assert.equal(rec.error.code, 'E_AUTH');
    assert.match(rec.error.message, /401/);
    assert.equal(requests, 1, 'a rejected create is attempted exactly once (no retry loop)');
  } finally {
    delete process.env.MINIMAX_API_KEY;
    server.close();
  }
});

test('minimax-official: cancel sends DELETE to /v2/video_generation/{task_id} (best effort)', async () => {
  const seen = { deleteCalled: false, deleteUrl: '', auth: '' };
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v2/video_generation') {
      json(res, 200, { task_id: 'cancel-me-1' });
    } else if (req.method === 'GET' && req.url === '/v2/query/video_generation/cancel-me-1') {
      json(res, 200, { task: { id: 'cancel-me-1', status: 'running' } });
    } else if (req.method === 'DELETE' && req.url === '/v2/video_generation/cancel-me-1') {
      seen.deleteCalled = true;
      seen.deleteUrl = req.url;
      seen.auth = req.headers['authorization'] ?? '';
      json(res, 200, { task_id: 'cancel-me-1', action: 'cancelled', status: 'cancelled' });
    } else json(res, 404, {});
  });
  const base = await listen(server);
  process.env.MINIMAX_API_KEY = 'mm-test-key-0004';
  try {
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({
      outputDir: await mkdtemp(join(tmpdir(), 'synth-minimax-')),
      backends: { 'minimax-official': { baseUrl: base, pollIntervalMs: 20, timeoutMs: 60_000 } },
    });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.start({ backend: 'minimax-official', model: 'MiniMax-H3', modality: 'video', prompt: 'x', durationSeconds: 4 });
    // Wait until at least one poll has happened (remote id recorded).
    for (let i = 0; i < 100 && !(await jobs.get(rec.id))?.remoteId; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const after = await jobs.cancel(rec.id);
    assert.equal(after.status, 'cancelled');
    assert.ok(seen.deleteCalled, 'the documented DELETE cancel endpoint must be called');
    assert.equal(seen.deleteUrl, '/v2/video_generation/cancel-me-1');
    assert.equal(seen.auth, 'Bearer mm-test-key-0004');
  } finally {
    delete process.env.MINIMAX_API_KEY;
    server.close();
  }
});

test('minimax-official: missing credential fails BEFORE any network call', async () => {
  let requests = 0;
  const server = createServer(() => {
    requests += 1;
  });
  const base = await listen(server);
  delete process.env.MINIMAX_API_KEY;
  try {
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({
      outputDir: await mkdtemp(join(tmpdir(), 'synth-minimax-')),
      backends: { 'minimax-official': { baseUrl: base } },
    });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.wait(
      (await jobs.start({ backend: 'minimax-official', model: 'MiniMax-H3', modality: 'video', prompt: 'x', durationSeconds: 4 })).id,
    );
    assert.equal(rec.status, 'failed');
    assert.equal(rec.error.code, 'E_NO_CREDENTIAL');
    assert.equal(requests, 0, 'no byte may reach the network without a credential');
  } finally {
    server.close();
  }
});

test('minimax size mapping: official 480P/768P/2K tokens and exact WxH pairs; everything else is E_SIZE', async () => {
  const { mapMinimaxVideoSize } = await import('../lib/backends/minimax.js');

  assert.deepEqual(mapMinimaxVideoSize('768P', 'MiniMax-H3', 'p'), { resolution: '768P' });
  assert.deepEqual(mapMinimaxVideoSize('768p', 'MiniMax-H3', 'p'), { resolution: '768P' });
  assert.deepEqual(mapMinimaxVideoSize('2k', 'MiniMax-H3', 'p'), { resolution: '2K' });
  assert.deepEqual(mapMinimaxVideoSize('480P', 'MiniMax-H3-Lite', 'p'), { resolution: '480P' });
  // Exact pixel size whose short side is a documented tier AND whose ratio is exact.
  assert.deepEqual(mapMinimaxVideoSize('768x768', 'MiniMax-H3', 'p'), { resolution: '768P', ratio: '1:1' });
  assert.deepEqual(mapMinimaxVideoSize('1024x768', 'MiniMax-H3', 'p'), { resolution: '768P', ratio: '4:3' });
  assert.deepEqual(mapMinimaxVideoSize('768*1024', 'MiniMax-H3', 'p'), { resolution: '768P', ratio: '3:4' });
  assert.deepEqual(mapMinimaxVideoSize('1792x768', 'MiniMax-H3', 'p'), { resolution: '768P', ratio: '21:9' });
  assert.deepEqual(mapMinimaxVideoSize('640x480', 'MiniMax-H3-Highspeed', 'p'), { resolution: '480P', ratio: '4:3' });

  // 16:9 / 9:16 have no exact pixel pair at these tiers (1366x768 ≠ 16:9), so
  // they are rejected rather than silently rounded — use the P token instead.
  for (const bad of ['1080p', '1920x1080', '2560x1440', '4K', '768x500', '768x432', '1366x768', '']) {
    assert.throws(
      () => mapMinimaxVideoSize(bad, 'MiniMax-H3', 'p'),
      (err) => err.code === 'E_SIZE',
      `'${bad}' must be rejected with E_SIZE (never silently downgraded)`,
    );
  }
  // Model capability limits are enforced (2K is not available on H3-Max / Lite).
  assert.throws(
    () => mapMinimaxVideoSize('2K', 'MiniMax-H3-Max', 'p'),
    (err) => err.code === 'E_SIZE',
  );
  assert.throws(
    () => mapMinimaxVideoSize('2K', 'MiniMax-H3-Lite', 'p'),
    (err) => err.code === 'E_SIZE',
  );
});

test('minimax: non-representable size and out-of-range duration fail BEFORE any request', async () => {
  let requests = 0;
  const server = createServer(() => {
    requests += 1;
  });
  const base = await listen(server);
  process.env.MINIMAX_API_KEY = 'mm-test-key-0005';
  try {
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({
      outputDir: await mkdtemp(join(tmpdir(), 'synth-minimax-')),
      backends: { 'minimax-official': { baseUrl: base, pollIntervalMs: 20, timeoutMs: 20_000 } },
    });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const badSize = await jobs.wait(
      (await jobs.start({ backend: 'minimax-official', model: 'MiniMax-H3', modality: 'video', prompt: 'x', size: '1920x1080', durationSeconds: 5 })).id,
    );
    assert.equal(badSize.status, 'failed');
    assert.equal(badSize.error.code, 'E_SIZE');

    const badDuration = await jobs.wait(
      (await jobs.start({ backend: 'minimax-official', model: 'MiniMax-H3-Max', modality: 'video', prompt: 'x', size: '768P', durationSeconds: 4 })).id,
    );
    assert.equal(badDuration.status, 'failed');
    assert.equal(badDuration.error.code, 'E_DURATION', 'MiniMax-H3-Max requires 5–15 s');

    assert.equal(requests, 0, 'all validation happened before the network');
  } finally {
    delete process.env.MINIMAX_API_KEY;
    server.close();
  }
});

test('minimax: an invalid profile default resolution is rejected, never silently replaced', async () => {
  let requests = 0;
  const server = createServer(() => { requests += 1; });
  const base = await listen(server);
  process.env.MINIMAX_API_KEY = 'mm-test-key-0007';
  try {
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const cfg = resolveConfig({
      outputDir: await mkdtemp(join(tmpdir(), 'synth-minimax-')),
      backends: {
        'minimax-official': { baseUrl: base, extraBody: { resolution: '1080P' }, timeoutMs: 5_000 },
      },
    });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const rec = await jobs.wait(
      (await jobs.start({ backend: 'minimax-official', model: 'MiniMax-H3', modality: 'video', prompt: 'p', durationSeconds: 5 })).id,
    );
    assert.equal(rec.status, 'failed');
    assert.equal(rec.error.code, 'E_SIZE', 'a configured-but-undocumented resolution must fail, not fall back to 768P');
    assert.equal(requests, 0, 'no request is made for an invalid configured resolution');
  } finally {
    delete process.env.MINIMAX_API_KEY;
    server.close();
  }
});

test('minimax defaults: official preset is doc-verified but NOT live-verified; relay stays blocked', async () => {
  const { resolveConfig } = await import('../lib/config.js');
  const cfg = resolveConfig({ outputDir: await mkdtemp(join(tmpdir(), 'synth-minimax-')) });
  const official = cfg.backends['minimax-official'];
  assert.equal(official.protocol, 'minimax-video-compatible');
  assert.equal(official.baseUrl, 'https://api.minimax.io');
  assert.equal(official.model, 'MiniMax-H3');
  assert.deepEqual([...official.models], ['MiniMax-H3', 'MiniMax-H3-Highspeed', 'MiniMax-H3-Lite', 'MiniMax-H3-Max']);
  assert.equal(official.authEnv, 'MINIMAX_API_KEY', 'the official credential reference is the documented env NAME');
  assert.equal(official.authStyle, 'bearer');
  assert.equal(official.paths.submit, '/v2/video_generation');
  assert.equal(official.paths.status, '/v2/query/video_generation/{id}');
  assert.equal(official.paths.cancel, '/v2/video_generation/{id}');
  assert.equal(official.protocolVerified, true, 'the V2 wire shape is documented');
  assert.equal(official.liveVerified, false, 'never called for real: mock-only');
  assert.ok(!JSON.stringify(official).includes('MINIMAX_API_KEY='), 'only a reference name, never a value');

  const relay = cfg.backends['minimax-relay'];
  assert.equal(relay.protocol, 'minimax-video-compatible');
  assert.equal(relay.protocolVerified, false, 'an unconfirmed relay must stay blocked');
  assert.equal(relay.blockRealSubmit, true);
  assert.equal(relay.liveVerified, false);

  // Capabilities advertise the two verification dimensions separately.
  const { createBackendRegistry } = await import('../lib/backends/index.js');
  const caps = [...createBackendRegistry(cfg).values()].map((b) => ({ id: b.id, ...b.capabilities() }));
  const byId = Object.fromEntries(caps.map((c) => [c.id, c]));
  assert.equal(byId['minimax-official'].protocolVerified, true);
  assert.equal(byId['minimax-official'].liveVerified, false);
  assert.equal(byId['minimax-official'].realSubmitAllowed, true);
  assert.equal(byId['minimax-relay'].realSubmitAllowed, false);
  assert.equal(byId['zgci-h3'].liveVerified, true, 'the one authorized zgci run was live-validated');
  assert.equal(byId['zgci-h3'].protocol, 'openai-video-compatible', 'zgci stays a third-party relay, not the official protocol');
});

test('minimax: ONE adapter reused by TWO MiniMax-compatible profiles (different URL/model/query)', async () => {
  const hits = { a: 0, b: 0 };
  const makeServer = (tag, model, extraAssert) =>
    createServer(async (req, res) => {
      if (req.method === 'POST' && req.url.startsWith('/v2/video_generation')) {
        hits[tag] += 1;
        const body = await readJson(req);
        assert.equal(body.model, model);
        extraAssert?.(req, body);
        json(res, 200, { task_id: `task-${tag}` });
      } else if (req.method === 'GET' && req.url.startsWith(`/v2/query/video_generation/task-${tag}`)) {
        json(res, 200, {
          task: { id: `task-${tag}`, status: 'succeeded', content: { url: `http://127.0.0.1:${base[tag].port}/cdn/${tag}.mp4` } },
        });
      } else if (req.method === 'GET' && req.url === `/cdn/${tag}.mp4`) {
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        res.end(BIN);
      } else json(res, 404, {});
    });
  const seenA = {};
  const s1 = makeServer('a', 'MiniMax-H3', (req) => {
    seenA.query = req.url;
    seenA.header = req.headers['x-tenant-id'];
  });
  const s2 = makeServer('b', 'MiniMax-H3-Lite');
  const base = { a: s1.address() ?? {}, b: {} };
  await new Promise((r) => s1.listen(0, '127.0.0.1', r));
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  base.a = s1.address();
  base.b = s2.address();
  try {
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const { JobManager } = await import('../lib/jobs.js');
    const dir = await mkdtemp(join(tmpdir(), 'synth-minimax-'));
    const cfg = resolveConfig({
      outputDir: dir,
      backends: {
        // The official preset pointed at a mock gateway (still the same adapter).
        'minimax-official': {
          baseUrl: `http://127.0.0.1:${base.a.port}`,
          authStyle: 'none',
          pollIntervalMs: 20,
          timeoutMs: 30_000,
          queryParams: { GroupId: '1234567890' },
          headers: { 'X-Tenant-Id': 'tenant-a' },
        },
        // A user-supplied MiniMax-compatible gateway: URL + model only.
        'my-minimax-gateway': {
          protocol: 'minimax-video-compatible',
          model: 'MiniMax-H3-Lite',
          models: ['MiniMax-H3-Lite'],
          modalities: ['video'],
          baseUrl: `http://127.0.0.1:${base.b.port}`,
          authStyle: 'none',
          online: true,
          timeoutMs: 30_000,
          pollIntervalMs: 20,
          protocolVerified: true,
          paths: {
            submit: '/v2/video_generation',
            status: '/v2/query/video_generation/{id}',
            cancel: '/v2/video_generation/{id}',
          },
        },
      },
    });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    for (const [backend, model] of [['minimax-official', 'MiniMax-H3'], ['my-minimax-gateway', 'MiniMax-H3-Lite']]) {
      const rec = await jobs.wait(
        (await jobs.start({
          backend,
          model,
          modality: 'video',
          prompt: 'p',
          durationSeconds: 4,
          size: backend === 'my-minimax-gateway' ? '480P' : '768P',
        })).id,
      );
      assert.equal(rec.status, 'succeeded', `${backend} must succeed through the SAME minimax adapter`);
      assert.ok((await readFile(rec.artifacts[0].path)).equals(BIN));
    }
    assert.deepEqual(hits, { a: 1, b: 1 }, 'each profile hit only its own gateway — configuration-level reuse');
    assert.match(seenA.query, /GroupId=1234567890/, 'generic profile queryParams reach the wire (e.g. GroupId)');
    assert.equal(seenA.header, 'tenant-a', 'generic static headers reach the wire');
  } finally {
    s1.close();
    s2.close();
  }
});

test('minimax architecture: no provider special-casing in the adapter or core modules', async () => {
  const { readFile } = await import('node:fs/promises');
  const files = [
    '../lib/backends/minimax.js',
    '../lib/backends/ark.js',
    '../lib/backends/task-api.js',
    '../lib/backends/openai-compatible.js',
    '../lib/backends/index.js',
    '../lib/jobs.js',
    '../lib/http.js',
    '../lib/tools.js',
  ];
  const here = new URL('.', import.meta.url);
  for (const f of files) {
    const text = await readFile(new URL(f, here), 'utf8');
    // Strip comments: prose may name deployments, executable logic must not.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const vendor of ['minimax-official', 'minimax-relay', 'api.minimax.io', 'bza', 'zgci', 'seedance', 'seedream', 'hub.']) {
      assert.ok(!code.includes(vendor), `${f} must not special-case '${vendor}' in code (comments ok)`);
    }
    // The adapter is selected by PROTOCOL, never by a provider id branch.
    assert.ok(!/provider\s*===|provider\s*==\s*['"]/.test(code), `${f} must not branch on provider identity`);
  }
  // The size mapper exists as a pure protocol function (directly unit-testable).
  const status = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(status.type, 'module');
  const dir = await mkdtemp(join(tmpdir(), 'synth-minimax-'));
  assert.ok((await stat(dir)).isDirectory());
});
