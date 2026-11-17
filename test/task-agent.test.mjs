// Sub-task ("task agent") round: fence/path safety, reveal planning, the
// /synthmedia/api artifact route, JobManager.list session attribution, the
// new /synthmedia jobs|reveal|cancel commands and the client.js jobs-tab
// structure. React-free: the client assertions are template-structure checks
// in the render-regression style.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';

const root = join(import.meta.dirname, '..');

// Host half comes from the BUILT lib (same convention as the other suites).
const { fenceArtifactPath, fenceJobDir, planReveal, artifactContentType, createArtifactRoute } =
  await import('../lib/task-agent.js');
const { JobManager } = await import('../lib/jobs.js');
const { createPageServices, runPageCommand } = await import('../lib/page/snapshot.js');
const { createJobsEndpointRoute, jobsTokenInjection, JOBS_TOKEN_GLOBAL } = await import('../lib/jobs-endpoint.js');

const TEMPLATE = readFileSync(join(root, 'client', 'client.js'), 'utf8');

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'synthmedia-ta-'));
}

// --- fence: path safety --------------------------------------------------------

test('fenceArtifactPath accepts a real artifact inside the output root', async () => {
  const out = tmpRoot();
  try {
    mkdirSync(join(out, '0f0e0d0c-1111-2222-3333-444455556666'), { recursive: true });
    writeFileSync(join(out, '0f0e0d0c-1111-2222-3333-444455556666', 'result.mp4'), 'x');
    const p = await fenceArtifactPath(out, '0f0e0d0c-1111-2222-3333-444455556666', 'result.mp4');
    assert.equal(p, realpathSync(resolve(out, '0f0e0d0c-1111-2222-3333-444455556666', 'result.mp4')));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('fenceArtifactPath refuses traversal, absolute injection, separators and bad ids', async () => {
  const out = tmpRoot();
  try {
    const id = '0f0e0d0c-1111-2222-3333-444455556666';
    for (const [jobId, file] of [
      [id, '../secret.txt'],
      [id, '..'],
      [id, '/etc/passwd'],
      [id, 'a/b.txt'],
      [id, 'a\\b.txt'],
      [id, '.'],
      [id, ''],
      ['../' + id, 'result.mp4'],
      ['not-a-uuid', 'result.mp4'],
      ['', 'result.mp4'],
    ]) {
      assert.equal(await fenceArtifactPath(out, jobId, file), undefined, `${jobId} :: ${file}`);
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('fenceArtifactPath refuses a symlink planted inside the job dir (escape)', async () => {
  const out = tmpRoot();
  const outsideDir = tmpRoot();
  try {
    const id = '0f0e0d0c-1111-2222-3333-444455556666';
    mkdirSync(join(out, id), { recursive: true });
    writeFileSync(join(outsideDir, 'secret.txt'), 'top secret');
    symlinkSync(join(outsideDir, 'secret.txt'), join(out, id, 'result.txt'));
    assert.equal(await fenceArtifactPath(out, id, 'result.txt'), undefined);
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('fenceJobDir accepts the real job directory and refuses bad ids', async () => {
  const out = tmpRoot();
  try {
    const id = '0f0e0d0c-1111-2222-3333-444455556666';
    mkdirSync(join(out, id), { recursive: true });
    assert.equal(await fenceJobDir(out, id), realpathSync(resolve(out, id)));
    assert.equal(await fenceJobDir(out, '../etc'), undefined);
    assert.equal(await fenceJobDir(out, id + '/..'), undefined);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// --- reveal planning (pure; spawn uses shell:false with these argv arrays) ------

test('planReveal dispatches per platform and never builds a shell string', () => {
  assert.deepEqual(planReveal('darwin', '/a/b/result.mp4'), { cmd: 'open', args: ['-R', '/a/b/result.mp4'] });
  assert.deepEqual(planReveal('win32', 'C:\\a\\result.mp4'), { cmd: 'explorer', args: ['/select,C:\\a\\result.mp4'] });
  assert.deepEqual(planReveal('linux', '/a/b/result.mp4'), { cmd: 'xdg-open', args: ['/a/b'] });
  assert.equal(planReveal('sunos', '/a/b'), undefined);
  assert.equal(planReveal('darwin', ''), undefined);
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function jsonReply(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// --- generation is a non-blocking sub-task (parent never waits) -----------------

test('start(): a generation returns while the task is still running (parent is not blocked)', async () => {
  // The tool surface wraps exactly this call: synthmedia_generate returns the
  // record straight away, and only synthmedia_wait blocks. A remote task that
  // stays "running" proves start() hands back a live sub-task instead of
  // awaiting completion.
  let polls = 0;
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v2/video_generation') {
      jsonReply(res, 200, { task_id: 'slow-task-1' });
    } else if (req.method === 'GET' && req.url === '/v2/query/video_generation/slow-task-1') {
      polls += 1;
      jsonReply(res, 200, { task: { id: 'slow-task-1', model: 'MiniMax-H3', status: 'running' } });
    } else {
      jsonReply(res, 404, {});
    }
  });
  const base = await listen(server);
  const dir = mkdtempSync(join(tmpdir(), 'synth-nonblocking-'));
  process.env['MINIMAX_API_KEY'] = 'test-key-not-a-credential';
  try {
    const { resolveConfig } = await import('../lib/config.js');
    const { createBackendRegistry } = await import('../lib/backends/index.js');
    const cfg = resolveConfig({ outputDir: dir, backends: { 'minimax-official': { baseUrl: base, pollIntervalMs: 20, timeoutMs: 30_000 } } });
    const jobs = new JobManager(cfg, createBackendRegistry(cfg));
    const startedAt = Date.now();
    const rec = await jobs.start({ backend: 'minimax-official', model: 'MiniMax-H3', modality: 'video', prompt: 'not blocking', durationSeconds: 4 });
    const elapsed = Date.now() - startedAt;
    assert.equal(rec.status, 'running');
    assert.deepEqual(rec.artifacts, []);
    assert.ok(elapsed < 5_000, `start() returned in ${elapsed}ms, before the task finished`);
    await new Promise((r) => setTimeout(r, 150));
    const live = await jobs.get(rec.id);
    assert.equal(live?.status, 'running', 'the job lives on after the call returns');
    assert.ok(polls >= 1, 'the manager keeps polling in the background');
    const canceled = await jobs.cancel(rec.id);
    assert.match(String(canceled?.status), /^cancel(?:l)?ed$/, 'the sub-task is cancellable while it runs');
  } finally {
    delete process.env['MINIMAX_API_KEY'];
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tool contract: generate returns immediately, only wait blocks', () => {
  const src = readFileSync(join(root, 'src/tools.ts'), 'utf8');
  const gen = src.slice(src.indexOf("name: 'synthmedia_generate'"), src.indexOf("name: 'synthmedia_status'"));
  assert.match(gen, /await jobs\.start\(/);
  assert.doesNotMatch(gen, /jobs\.wait\(/, 'generate must not wait for completion');
  const wait = src.slice(src.indexOf("name: 'synthmedia_wait'"), src.indexOf("name: 'synthmedia_cancel'"));
  assert.match(wait, /jobs\.wait\(/, 'wait is the explicit blocking call');
});

// --- token-gated jobs endpoint --------------------------------------------------

test('jobs endpoint: rejects a missing/wrong token and requires a session', async () => {
  const calls = [];
  const route = createJobsEndpointRoute({
    token: 'a'.repeat(32),
    run: async (session) => { calls.push(session); return { kind: 'success', text: '', json: { jobs: [] } }; },
  });
  assert.equal(route.kind, 'exact');
  assert.equal(route.path, '/synthmedia/api/jobs');

  const noToken = fakeRes();
  await route.handler({ method: 'GET', url: '/synthmedia/api/jobs?session=s1' }, noToken);
  assert.equal(noToken.statusCode, 403);
  assert.match(noToken.body, /E_UNAUTHORIZED/);

  const wrongToken = fakeRes();
  await route.handler({ method: 'GET', url: '/synthmedia/api/jobs?token=' + 'b'.repeat(32) + '&session=s1' }, wrongToken);
  assert.equal(wrongToken.statusCode, 403);

  const noSession = fakeRes();
  await route.handler({ method: 'GET', url: '/synthmedia/api/jobs?token=' + 'a'.repeat(32) }, noSession);
  assert.equal(noSession.statusCode, 400);
  assert.match(noSession.body, /E_SESSION/);

  const notGet = fakeRes();
  await route.handler({ method: 'POST', url: '/synthmedia/api/jobs?token=' + 'a'.repeat(32) + '&session=s1' }, notGet);
  assert.equal(notGet.statusCode, 405);
  assert.deepEqual(calls, [], 'no command ran for a rejected request');
});

test('jobs endpoint: answers the page command JSON for the caller session', async () => {
  const seen = [];
  const route = createJobsEndpointRoute({
    token: 'c'.repeat(32),
    run: async (session) => {
      seen.push(session);
      return { kind: 'success', text: 'ok', json: { jobs: [{ id: 'job-1', status: 'running', owner: session }], downloadBase: 'http://127.0.0.1:3080/synthmedia/api/artifact' } };
    },
  });
  const res = fakeRes();
  await route.handler({ method: 'GET', url: '/synthmedia/api/jobs?token=' + 'c'.repeat(32) + '&session=session-9' }, res);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['Content-Type']), /application\/json/);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  const body = JSON.parse(res.body);
  assert.equal(body.jobs[0].id, 'job-1');
  assert.equal(body.jobs[0].owner, 'session-9');
  assert.deepEqual(seen, ['session-9']);
});

test('jobs endpoint: forwards the requested page size so history can page', async () => {
  const seen = [];
  const route = createJobsEndpointRoute({
    token: 'f'.repeat(32),
    run: async (session, limit) => { seen.push([session, limit]); return { kind: 'success', text: '', json: { jobs: [] } }; },
  });
  const big = fakeRes();
  await route.handler({ method: 'GET', url: '/synthmedia/api/jobs?token=' + 'f'.repeat(32) + '&session=s1&limit=120' }, big);
  assert.equal(big.statusCode, 200);
  const bad = fakeRes();
  await route.handler({ method: 'GET', url: '/synthmedia/api/jobs?token=' + 'f'.repeat(32) + '&session=s1&limit=abc' }, bad);
  const clamped = fakeRes();
  await route.handler({ method: 'GET', url: '/synthmedia/api/jobs?token=' + 'f'.repeat(32) + '&session=s1&limit=999' }, clamped);
  assert.deepEqual(seen, [['s1', 120], ['s1', undefined], ['s1', 200]], 'valid page sizes pass through, garbage means default, oversize clamps');
});

test('jobs endpoint: a failed command becomes a 500 with the message, never a stack', async () => {
  const route = createJobsEndpointRoute({
    token: 'd'.repeat(32),
    run: async () => ({ kind: 'error', text: '任务列表不可用：此命令需要 JobManager' }),
  });
  const res = fakeRes();
  await route.handler({ method: 'GET', url: '/synthmedia/api/jobs?token=' + 'd'.repeat(32) + '&session=s1' }, res);
  assert.equal(res.statusCode, 500);
  assert.match(res.body, /E_JOBS/);
  assert.doesNotMatch(res.body, /at \w+ \(/);
});

test('jobs endpoint: the page token row is a global injection under the shared name', () => {
  const row = jobsTokenInjection('e'.repeat(32));
  assert.deepEqual(row, { kind: 'global', name: JOBS_TOKEN_GLOBAL, value: 'e'.repeat(32) });
  assert.equal(JOBS_TOKEN_GLOBAL, '__SYNTHMEDIA_JOBS_TOKEN__');
});

// --- artifact route -------------------------------------------------------------

function fakeRes() {
  const res = {
    statusCode: 0, headers: {}, body: '', ended: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers ?? {}; },
    end(data) { if (data !== undefined) this.body += data; this.ended = true; },
    destroy() { this.ended = true; },
  };
  return res;
}

function streamRes() {
  // For the byte-streaming path: collect chunks through the pipe interface.
  const res = fakeRes();
  res.write = (chunk) => { res.body += String(chunk); return true; };
  const callbacks = {};
  res.on = (ev, cb) => { (callbacks[ev] = callbacks[ev] ?? []).push(cb); return res; };
  res.once = res.on;
  res.emit = (ev, arg) => { for (const cb of callbacks[ev] ?? []) cb(arg); };
  res.pipeNotSupported = true;
  return res;
}

test('artifact route: no unauthenticated list endpoint; unknown paths 404', async () => {
  const out = tmpRoot();
  try {
    const route = createArtifactRoute({ outputRoot: out });
    assert.equal(route.kind, 'prefix');
    assert.equal(route.path, '/synthmedia/api');
    // The list must go through the session-scoped command transport: this
    // route has no caller identity, so a job list here would leak every
    // conversation's tasks. Every non-artifact path is a plain 404.
    for (const url of ['/synthmedia/api/jobs', '/synthmedia/api/jobs?owner=anyone', '/synthmedia/api/nope']) {
      const res = fakeRes();
      await route.handler({ url }, res);
      assert.equal(res.statusCode, 404, url);
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('artifact route: streams bytes with attachment Content-Disposition and correct type', async () => {
  const out = tmpRoot();
  const id = '0f0e0d0c-1111-2222-3333-444455556666';
  try {
    mkdirSync(join(out, id), { recursive: true });
    writeFileSync(join(out, id, 'result.mp4'), 'VIDEOBYTES');
    const route = createArtifactRoute({ outputRoot: out });
    const res = streamRes();
    let piped = false;
    // capture the piped stream content via the route's own createReadStream:
    // simplest assertion here is headers + body through an intercepted pipe.
    const origPipe = undefined;
    await route.handler({ url: `/synthmedia/api/artifact/${id}/result.mp4` }, res);
    // The handler pipes a real stream; give the event loop a tick.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['Content-Type']), /^video\/mp4/);
    assert.equal(res.headers['Content-Disposition'], `attachment; filename="result.mp4"`);
    assert.match(res.body, /VIDEOBYTES/);
    void origPipe; void piped;
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('artifact route: traversal and missing files are 404, never leaked paths', async () => {
  const out = tmpRoot();
  const id = '0f0e0d0c-1111-2222-3333-444455556666';
  try {
    const route = createArtifactRoute({ outputRoot: out });
    for (const url of [
      `/synthmedia/api/artifact/${id}/..%2F..%2Fsecret.txt`,
      `/synthmedia/api/artifact/not-a-uuid/result.mp4`,
      `/synthmedia/api/artifact/${id}/missing.mp4`,
    ]) {
      const res = fakeRes();
      await route.handler({ url }, res);
      assert.equal(res.statusCode, 404, url);
      assert.ok(!res.body.includes(out));
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// --- JobManager.list: sub-task records + owner attribution -----------------------

function jobJson(dir, record) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'job.json'), JSON.stringify(record));
}

test('JobManager.list: running first, then newest; owner filter fences per session', async () => {
  const out = tmpRoot();
  try {
    const manager = new JobManager({ outputDir: out, defaultTimeoutMs: 1000, backends: {} }, new Map());
    const mk = (id, patch) => ({ id, backend: 'b', model: 'm', modality: 'video', promptPreview: '', status: 'succeeded', progress: 100, createdAt: patch.createdAt, updatedAt: patch.createdAt, artifacts: [], owner: patch.owner, ...patch });
    jobJson(join(out, '11111111-1111-4111-8111-111111111111'), mk('11111111-1111-4111-8111-111111111111', { createdAt: '2026-01-01T00:00:00Z', owner: 'agent-A' }));
    jobJson(join(out, '22222222-2222-4222-8222-222222222222'), mk('22222222-2222-4222-8222-222222222222', { createdAt: '2026-01-02T00:00:00Z', owner: 'agent-B', status: 'running', progress: 40 }));
    jobJson(join(out, '33333333-3333-4333-8333-333333333333'), mk('33333333-3333-4333-8333-333333333333', { createdAt: '2026-01-03T00:00:00Z', owner: 'agent-A' }));
    // A cybernetics-style task agent: owned by child-C, spawned by agent-A.
    jobJson(join(out, '44444444-4444-4444-8444-444444444444'), mk('44444444-4444-4444-8444-444444444444', { createdAt: '2026-01-04T00:00:00Z', owner: 'child-C', ancestors: ['agent-A'] }));
    const all = await manager.list();
    assert.deepEqual(all.map((j) => j.id), ['22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111']);
    // Session tree: agent-A's own jobs PLUS child-C's job (ancestors), never agent-B's.
    const treeA = await manager.list({ session: 'agent-A' });
    assert.deepEqual(treeA.map((j) => j.id).sort(), [
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ].sort());
    // The child still sees exactly its own job.
    const treeC = await manager.list({ session: 'child-C' });
    assert.deepEqual(treeC.map((j) => j.id), ['44444444-4444-4444-8444-444444444444']);
    const onlyA = await manager.list({ owner: 'agent-A' });
    assert.deepEqual(onlyA.map((j) => j.owner), ['agent-A', 'agent-A']);
    assert.equal(onlyA.some((j) => j.id.startsWith('2222')), false);
    assert.equal((await manager.list({ limit: 1 })).length, 1);
    // job.json shape sanity: the additive fields are present and secret-free.
    const onDisk = JSON.parse(readFileSync(join(out, '11111111-1111-4111-8111-111111111111', 'job.json'), 'utf8'));
    assert.equal(onDisk.owner, 'agent-A');
    assert.ok(!JSON.stringify(onDisk).match(/key|token|secret/i));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('JobManager.start persists owner + toolCall into the record (sub-task attribution)', async () => {
  const out = tmpRoot();
  try {
    // A stub backend so start() completes without network.
    const backend = {
      id: 'stub',
      capabilities: () => ({ id: 'stub', protocol: 'x', modalities: ['text'], models: ['m1'], online: false, protocolVerified: true, liveVerified: false, realSubmitAllowed: true }),
      create: async () => ({ remoteId: 'r1' }),
      poll: async () => ({ status: 'succeeded', progress: 100 }),
      fetch: async () => ({ bytes: Buffer.from('hi'), mimeType: 'text/plain' }),
    };
    const manager = new JobManager({ outputDir: out, defaultTimeoutMs: 1000, backends: { stub: { timeoutMs: 1000, pollIntervalMs: 10 } } }, new Map([['stub', backend]]));
    const record = await manager.start({ backend: 'stub', model: 'm1', modality: 'text', prompt: 'hi' }, { owner: 'agent-C', ancestors: ['agent-root'], toolCall: { callId: 'c1', rootCallId: 'r0' } });
    assert.equal(record.owner, 'agent-C');
    assert.deepEqual(record.ancestors, ['agent-root']);
    assert.deepEqual(record.toolCall, { callId: 'c1', rootCallId: 'r0' });
    const mine = await manager.list({ owner: 'agent-C' });
    assert.equal(mine.some((j) => j.id === record.id), true);
    const fromRoot = await manager.list({ session: 'agent-root' });
    assert.equal(fromRoot.some((j) => j.id === record.id), true);
    await manager.wait(record.id);
    const onDisk = JSON.parse(readFileSync(join(out, record.id, 'job.json'), 'utf8'));
    assert.equal(onDisk.owner, 'agent-C');
    assert.deepEqual(onDisk.ancestors, ['agent-root']);
    assert.deepEqual(onDisk.toolCall, { callId: 'c1', rootCallId: 'r0' });
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// --- frame conditioning (first/last frame images) --------------------------------

test('generate tool: frame paths become data URIs with magic-byte mime checks', async () => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { writeFileSync } = await import('node:fs');
  let body = undefined;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      body = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'task-frames', status: 'Submitted' }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const out = tmpRoot();
  try {
    // Minimal magic-byte-valid images (JPEG SOI marker / PNG signature).
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const first = join(out, 'first.jpg');
    const last = join(out, 'last.png');
    writeFileSync(first, jpg);
    writeFileSync(last, png);
    const { apply } = await import('../lib/index.js');
    const defs = new Map();
    const ctx = {
      tools: { register: (d) => defs.set(d.name, d) },
      get: () => undefined,
      inject: (_deps, cb) => cb(ctx),
      on: () => () => {},
    };
    apply(ctx, {
      outputDir: out,
      backends: {
        // minimax-video-compatible preset with frame conditioning exercised
        'h3-test': {
          protocol: 'minimax-video-compatible', model: 'MiniMax-H3', models: ['MiniMax-H3'], modalities: ['video'],
          baseUrl: base, authStyle: 'none', online: true, timeoutMs: 5000, protocolVerified: true,
          paths: { submit: '/videos', status: '/videos/{id}', cancel: '/videos/{id}' },
        },
      },
    });
    const gen = await defs.get('synthmedia_generate').execute(
      { backend: 'h3-test', model: 'MiniMax-H3', modality: 'video', prompt: 'fold', firstFrame: first, lastFrame: last },
      { signal: new AbortController().signal, agent: { id: 'agent-F' } },
    );
    const record = gen.job;
    assert.deepEqual(record.frameImages, ['first_frame', 'last_frame'], 'roles are recorded on the job, never the bytes');
    // The first poll tick is delayed one interval, so wait for the SUBMIT to
    // hit the fake server (the tool itself returned immediately).
    for (let i = 0; i < 50 && body === undefined; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(body, 'submit reached the wire');
    // The WIRE body carries content entries with data URIs and roles, and NO ratio.
    assert.equal(body.model, 'MiniMax-H3');
    assert.equal(body.content.length, 3);
    assert.equal(body.content[0].type, 'text');
    assert.equal(body.content[1].role, 'first_frame');
    assert.match(body.content[1].image_url.url, /^data:image\/jpeg;base64,/);
    assert.equal(body.content[2].role, 'last_frame');
    assert.match(body.content[2].image_url.url, /^data:image\/png;base64,/);
    assert.equal(body.ratio, undefined, 'image-led requests omit ratio');

    // Bad input: missing file, oversized, wrong magic — structured errors, zero HTTP.
    await assert.rejects(
      () => defs.get('synthmedia_generate').execute(
        { backend: 'h3-test', model: 'MiniMax-H3', modality: 'video', prompt: 'x', firstFrame: join(out, 'missing.jpg') },
        { signal: new AbortController().signal },
      ),
      /file not readable/,
    );
    const textFile = join(out, 'fake.jpg');
    writeFileSync(textFile, Buffer.from('not an image at all'));
    await assert.rejects(
      () => defs.get('synthmedia_generate').execute(
        { backend: 'h3-test', model: 'MiniMax-H3', modality: 'video', prompt: 'x', firstFrame: textFile },
        { signal: new AbortController().signal },
      ),
      /unsupported image format/,
    );
    assert.equal(body.content.length, 3, 'failed calls never reach the wire');
  } finally { rmSync(out, { recursive: true, force: true }); server.close(); }
});



function fakeServices(overrides = {}) {
  return {
    manager: { list: () => [], manifestNow: () => ({ downloadsDir: '/tmp/dl', entries: [] }) },
    options: { dataDir: tmpRoot() },
    config: { customProfiles: '[]' },
    ...overrides,
  };
}

test('runPageCommand jobs: caller-scoped tree, explicit owner only for self', async () => {
  const calls = [];
  const jobs = {
    async list(filter) { calls.push(filter); return [{ id: 'j1', status: 'running', progress: 30, backend: 'b', model: 'm', modality: 'video', owner: 'agent-A', artifacts: [] }]; },
    async get() { return undefined; },
    async cancel() { return { id: 'j1' }; },
  };
  const services = fakeServices({ jobs, downloadBase: 'http://127.0.0.1:3080/synthmedia/api/artifact' });
  // Caller identity (the invoking agent) scopes the listing to its session tree.
  const answer = await runPageCommand(services, 'jobs', { caller: 'agent-A' });
  assert.equal(answer.kind, 'success');
  assert.equal(answer.json.jobs.length, 1);
  assert.equal(answer.json.downloadBase, 'http://127.0.0.1:3080/synthmedia/api/artifact');
  assert.deepEqual(calls[0], { session: 'agent-A', limit: 50 });
  // Its own owner argument is accepted (still the session tree).
  await runPageCommand(services, 'jobs agent-A', { caller: 'agent-A' });
  assert.deepEqual(calls[1], { session: 'agent-A', limit: 50 });
  // Another conversation's owner is refused, never listed.
  const denied = await runPageCommand(services, 'jobs agent-B', { caller: 'agent-A' });
  assert.equal(denied.kind, 'error');
  // Unscoped (same-process) call keeps the explicit/global shape used by tests.
  await runPageCommand(services, 'jobs agent-A');
  assert.deepEqual(calls[2], { owner: 'agent-A', limit: 50 });
  const noJobs = await runPageCommand(fakeServices(), 'jobs');
  assert.equal(noJobs.kind, 'error');
});

test('runPageCommand jobs --limit: pages through the never-pruned history', async () => {
  const calls = [];
  const jobs = {
    async list(filter) { calls.push(filter); return []; },
    async get() { return undefined; },
    async cancel() { return undefined; },
  };
  const services = fakeServices({ jobs });
  await runPageCommand(services, 'jobs --limit 120', { caller: 'agent-A' });
  assert.deepEqual(calls[0], { session: 'agent-A', limit: 120 }, 'page size reaches the manager');
  await runPageCommand(services, 'jobs --limit 9999', { caller: 'agent-A' });
  assert.deepEqual(calls[1], { session: 'agent-A', limit: 200 }, 'page size is clamped');
  await runPageCommand(services, 'jobs --limit abc', { caller: 'agent-A' });
  assert.deepEqual(calls[2], { session: 'agent-A', limit: 50 }, 'garbage falls back to the default');
  // The owner argument still works when the flag is present.
  await runPageCommand(services, 'jobs agent-A --limit 20', { caller: 'agent-A' });
  assert.deepEqual(calls[3], { session: 'agent-A', limit: 20 });
});

test('runPageCommand reveal: fence refused outside outputDir, injected reveal spy used', async () => {
  const out = tmpRoot();
  const id = '0f0e0d0c-1111-2222-3333-444455556666';
  try {
    mkdirSync(join(out, id), { recursive: true });
    const goodPath = join(out, id, 'result.mp4');
    writeFileSync(goodPath, 'x');
    const realGood = realpathSync(goodPath);
    const revealed = [];
    const jobs = {
      async get(jobId) {
        return jobId === id
          ? { id, artifacts: [{ path: goodPath }] }
          : { id: jobId, artifacts: [{ path: '/etc/passwd' }] };
      },
      list: async () => [],
      cancel: async () => ({}),
    };
    const services = fakeServices({ jobs, outputRoot: () => out, reveal: async (p) => { revealed.push(p); } });
    const ok = await runPageCommand(services, `reveal ${id}`);
    assert.equal(ok.kind, 'success');
    assert.deepEqual(revealed, [realGood]);
    // A caller that does not own the job cannot reveal it.
    const denied = await runPageCommand(services, `reveal ${id}`, { caller: 'agent-X' });
    assert.equal(denied.kind, 'error');
    const bad = await runPageCommand(services, 'reveal 99999999-9999-4999-8999-999999999999');
    assert.equal(bad.kind, 'error');
    const noJobs = await runPageCommand(fakeServices(), `reveal ${id}`);
    assert.equal(noJobs.kind, 'error');
    const usage = await runPageCommand(services, 'reveal');
    assert.equal(usage.kind, 'error');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('runPageCommand cancel: happy path, ownership gate and missing JobManager degrade', async () => {
  const cancelled = [];
  const jobs = {
    async get(id) { return { id, owner: 'agent-A', artifacts: [] }; },
    list: async () => [],
    async cancel(id) { cancelled.push(id); return { id, status: 'cancelled' }; },
  };
  const services = fakeServices({ jobs });
  const ok = await runPageCommand(services, 'cancel abc', { caller: 'agent-A' });
  assert.equal(ok.kind, 'success');
  assert.deepEqual(cancelled, ['abc']);
  const denied = await runPageCommand(services, 'cancel abc', { caller: 'agent-Z' });
  assert.equal(denied.kind, 'error');
  assert.deepEqual(cancelled, ['abc']);
  assert.equal((await runPageCommand(fakeServices(), 'cancel abc')).kind, 'error');
  assert.equal((await runPageCommand(services, 'cancel')).kind, 'error');
});

// --- client.js structure (template assertions, render-regression style) ----------

test('client template: sidebar tab registered via optional service, never top-level inject', () => {
  // The jobs tab is registered through betterSidebar's registerTab…
  assert.match(TEMPLATE, /svc\.registerTab\(\{/);
  assert.match(TEMPLATE, /id: SIDEBAR_TAB_ID/);
  assert.match(TEMPLATE, /'synthmedia:jobs'/);
  assert.match(TEMPLATE, /ctx\.get\('betterSidebar'\)/);
  assert.match(TEMPLATE, /ctx\.inject\(\['betterSidebar'\]/);
  // The registration disposer is tied to the fiber (HMR-safe, no duplicate id).
  assert.match(TEMPLATE, /ctx\.effect\(\(\) => dispose/);
  // …but betterSidebar must NOT be in the top-level inject list (activation gate).
  const injectLine = TEMPLATE.match(/const inject = \[[^\]]*\];/);
  assert.ok(injectLine, 'inject list present');
  assert.ok(!injectLine[0].includes('betterSidebar'));
});

test('client template: visibility-gated polling, preview via onOpenFile, command wiring', () => {
  assert.match(TEMPLATE, /visible === false\) return undefined/); // polling stops when hidden
  assert.match(TEMPLATE, /pollMs: 2000/);
  assert.match(TEMPLATE, /'\/synthmedia jobs --limit ' \+ pageSize/); // paging arm of jobsCommand()
  assert.match(TEMPLATE, /pageSize > 50\s*\n?\s*\? '\/synthmedia jobs --limit ' \+ pageSize\s*\n?\s*: '\/synthmedia jobs'/);
  assert.match(TEMPLATE, /'\/synthmedia reveal ' \+/);
  assert.match(TEMPLATE, /'\/synthmedia cancel ' \+/);
  assert.match(TEMPLATE, /onOpenFile\(abs\)/); // sidebar preview path
  assert.match(TEMPLATE, /Content-Disposition|downloadBase/); // download wiring on at least one side
});

test('client template: no-transport/timeout states exist bilingually and the tab binds our transport', () => {
  const zhBlock = TEMPLATE.slice(0, TEMPLATE.indexOf('const en ='));
  const enBlock = TEMPLATE.slice(TEMPLATE.indexOf('const en ='));
  for (const key of ['jobs.noTransport', 'jobs.timeout']) {
    assert.ok(zhBlock.includes(`'${key}':`), `${key} zh`);
    assert.ok(enBlock.includes(`'${key}':`), `${key} en`);
  }
  assert.match(TEMPLATE, /commandTransport = \(sid, line\) => ctx\.remote\.commands\.execute/);
  assert.match(TEMPLATE, /execute: commandTransport/);
  assert.match(TEMPLATE, /withTimeout\(run\(jobsCommand\(\)\)/);
});

test('client template: history stays reachable through the load-earlier pager', () => {
  const zhBlock = TEMPLATE.slice(0, TEMPLATE.indexOf('const en ='));
  const enBlock = TEMPLATE.slice(TEMPLATE.indexOf('const en ='));
  for (const key of ['jobs.more']) {
    assert.ok(zhBlock.includes(`'${key}':`), `${key} zh`);
    assert.ok(enBlock.includes(`'${key}':`), `${key} en`);
  }
  assert.match(TEMPLATE, /'data-action': 'synthmedia-jobs-more'/);
  assert.match(TEMPLATE, /list\.length >= pageSize && pageSize < 200/);
});

test('client template: the job list polls the token endpoint, not the command service', async () => {
  // Polling through commands.execute wrote command/run + command/done into the
  // session log on every tick and spammed the conversation; the panel must
  // read over a plain GET and keep the command transport only as a fallback.
  assert.match(TEMPLATE, /window\.__SYNTHMEDIA_JOBS_TOKEN__/);
  assert.match(TEMPLATE, /'\/synthmedia\/api\/jobs\?token=' \+ encodeURIComponent\(jobsToken\)/);
  assert.match(TEMPLATE, /const canFetch = !tokenStale && typeof jobsEndpoint === 'string' && jobsEndpoint !== ''/);
  assert.match(TEMPLATE, /fetch\(\s*jobsEndpoint \+ '&session=' \+ encodeURIComponent\(sessionId\) \+ '&limit=' \+ pageSize/);
  // A TIMER may only carry the token endpoint: the command service writes
  // command/run + command/done on every execution, so polling it on an interval
  // spammed the conversation. The command fallback loads on demand only.
  assert.match(TEMPLATE, /if \(!canFetch \|\| visible === false\) return undefined;/);
  assert.match(TEMPLATE, /t\('jobs.refresh'\)/);
  // A host restart rotates the page token: a 403 must degrade to the command
  // transport for the mount instead of freezing on an error.
  assert.match(TEMPLATE, /\(!res \|\| !res\.ok\) && typeof execute === 'function'/);
  assert.match(TEMPLATE, /setTokenStale\(true\)/);
  assert.match(TEMPLATE, /'data-action': 'synthmedia-jobs-refresh'/);
  // The conversation view shares the same panel, so it must forward the endpoint.
  assert.match(TEMPLATE, /jsx\.jsx\(JobsPanel, \{ execute, jobsEndpoint, t, sessionId, cwd: '', visible: true/);
  void (async () => {
    assert.ok(true);
  });
});

test('client template: panel is a flex scroll container and withTimeout is module-scope', () => {
  // better-sidebar's host is `display:flex; flex-direction:column; height:100%;
  // min-height:0`; a content-height tab body overflows the pane instead of
  // scrolling (the sidebar-unscrollable bug). The body must grow and scroll.
  assert.match(TEMPLATE, /'data-panel-host': 'synthmedia-jobs'/);
  assert.match(TEMPLATE, /flex: '1 1 auto', minHeight: 0, height: '100%', overflowY: 'auto'/);
  // withTimeout must be defined at module scope BEFORE JobsPanel (a misplaced
  // copy inside apply() shipped as "withTimeout is not defined").
  const helperAt = TEMPLATE.indexOf('function withTimeout(value, ms)');
  const panelAt = TEMPLATE.indexOf('function JobsPanel(props)');
  assert.ok(helperAt > 0 && panelAt > 0 && helperAt < panelAt, 'withTimeout precedes JobsPanel');
  assert.match(TEMPLATE, /withTimeout\(run\(jobsCommand\(\)\)/);
});

test('client template: artifact menu carries the five required actions bilingually', () => {
  for (const key of ['jobs.menu.download', 'jobs.menu.copyRel', 'jobs.menu.copyAbs', 'jobs.menu.reveal', 'jobs.menu.preview']) {
    assert.ok(TEMPLATE.includes(`'${key}':`), `locale key ${key}`);
    const zhBlock = TEMPLATE.slice(0, TEMPLATE.indexOf('const en ='));
    const enBlock = TEMPLATE.slice(TEMPLATE.indexOf('const en ='));
    assert.ok(zhBlock.includes(`'${key}':`), `${key} in zh dict`);
    assert.ok(enBlock.includes(`'${key}':`), `${key} in en dict`);
  }
});

test('artifactContentType maps media extensions', () => {
  assert.equal(artifactContentType('result.mp4'), 'video/mp4');
  assert.equal(artifactContentType('result.png'), 'image/png');
  assert.equal(artifactContentType('result.wav'), 'audio/wav');
  assert.equal(artifactContentType('result.txt'), 'text/plain; charset=utf-8');
  assert.equal(artifactContentType('result.bin'), 'application/octet-stream');
});

// --- client module activation (real factory execution, fake cordis ctx) --------

/**
 * Execute the BUILT client bundle's factory against a minimal cordis-shaped
 * context. This is stronger than the template greps: it proves the activation
 * path really calls betterSidebar.registerTab, ties the disposer to the fiber,
 * and keeps every other seat when better-sidebar is absent.
 */
function activateClient(betterSidebar, options = {}) {
  const spec = { factory: undefined };
  globalThis.window = {
    __ModuleLoader__: { load(s) { spec.factory = s.factory; } },
    ...(options.jobsToken === undefined ? {} : { __SYNTHMEDIA_JOBS_TOKEN__: options.jobsToken }),
  };
  new Function(readFileSync(join(root, 'lib', 'client.js'), 'utf8'))();
  const react = {
    useState: (v) => [v, () => {}],
    useEffect() {},
    useCallback: (f) => f,
    useMemo: (f) => f(),
    useRef: (v) => ({ current: v }),
    createElement: () => null,
  };
  // Element OBJECTS (not null) so the test can inspect the rendered tree the
  // descriptor component builds — exactly what the real runtime receives.
  const jsxRuntime = {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    Fragment: 'fragment',
  };
  const remoteCalls = [];
  const mod = spec.factory((name) => (name === 'react' ? react : jsxRuntime));
  const seats = [];
  const effects = [];
  const tabCalls = [];
  // Fake DOM for the guide-scroll shim (apply() touches document.head).
  const headChildren = [];
  const fakeStyle = {
    textContent: '',
    attrs: {},
    setAttribute(key, value) { this.attrs[key] = value; },
    remove() { const i = headChildren.indexOf(this); if (i >= 0) headChildren.splice(i, 1); },
  };
  if (options.preexistingGuideStyle) {
    fakeStyle.attrs['data-dsh-synthmedia'] = 'guide-scroll';
    headChildren.push(fakeStyle);
  }
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: () => fakeStyle,
    head: { appendChild: (node) => headChildren.push(node) },
    querySelector: () => headChildren.find((node) => node.attrs && node.attrs['data-dsh-synthmedia'] === 'guide-scroll') ?? null,
  };
  const service = betterSidebar === undefined ? undefined : {
    registerTab(descriptor) {
      tabCalls.push(descriptor);
      const dispose = () => { tabCalls.disposeCount = (tabCalls.disposeCount ?? 0) + 1; };
      return dispose;
    },
  };
  const ctx = {
    effect(fn) {
      const disposer = typeof fn === 'function' ? fn() : undefined;
      if (typeof disposer === 'function') effects.push(disposer);
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    configForms: { get: () => undefined },
    remote: {
      commands: { execute: async (sid, line) => { remoteCalls.push([sid, line]); return { kind: 'success', text: '', json: { jobs: [] } }; } },
      settings: { mutate: async () => ({}) },
    },
    slots: {
      inject: (seat, cb) => { const r = cb(); seats.push({ seat, registered: r.registered ?? true, value: r.value }); return r.dispose; },
      register: (...args) => ({ registered: true, value: args, dispose: () => {} }),
    },
    get: (name) => (name === 'betterSidebar' ? service : undefined),
    inject: (deps, cb) => { if (deps.includes('betterSidebar') && service !== undefined) cb(ctx); },
  };
  mod.apply(ctx);
  globalThis.document = previousDocument;
  return { mod, seats, effects, tabCalls, service, remoteCalls, headChildren, fakeStyle };
}

test('client activation: registers the sidebar tab through the optional service', () => {
  // Service present → exactly one tab descriptor.
  const real = activateClient(true);
  assert.equal(real.tabCalls.length, 1);
  const tab = real.tabCalls[0];
  assert.equal(tab.id, 'synthmedia:jobs');
  assert.equal(tab.single, true);
  assert.equal(tab.order, 60);
  assert.equal(typeof tab.component, 'function');
  assert.equal(tab.title(), 'jobs.title');
  // the registerTab disposer is owned by the fiber (HMR-safe teardown)
  assert.equal(real.effects.length >= 1, true);
  assert.equal(typeof real.tabCalls.disposeCount, 'undefined');
  for (const d of real.effects) d();
  assert.equal(real.tabCalls.disposeCount, 1);
});

test('client activation: the tab hands OUR command transport to the panel', async () => {
  // better-sidebar's own client fiber has no remote.commands namespace, so the
  // component must receive the transport captured in OUR fiber — otherwise the
  // panel renders「加载中…」forever (the observed live bug).
  const { tabCalls, remoteCalls } = activateClient(true, { jobsToken: 'f'.repeat(32) });
  const descriptor = tabCalls[0];
  const element = descriptor.component({
    // Deliberately transport-less ctx, as better-sidebar would provide it.
    ctx: { locale: { bind: () => (key) => key } },
    scope: { sessionId: 'sess-42', cwd: '/tmp/ws' },
    visible: true,
    onOpenFile: () => {},
  });
  const panel = element && element.props ? element.props.children : undefined;
  assert.ok(panel && panel.props, 'panel element rendered');
  assert.equal(typeof panel.props.execute, 'function', 'transport is injected through props');
  assert.equal(panel.props.sessionId, 'sess-42');
  assert.equal(panel.props.cwd, '/tmp/ws');
  assert.equal(panel.props.jobsEndpoint, '/synthmedia/api/jobs?token=' + 'f'.repeat(32),
    'the per-page token turns into the polling endpoint');
  await panel.props.execute('sess-42', '/synthmedia jobs');
  assert.deepEqual(remoteCalls, [['sess-42', '/synthmedia jobs']]);
});

test('client activation: native guide scroll shim is injected and removed with the fiber', () => {
  const { headChildren, fakeStyle, effects } = activateClient(true);
  assert.equal(headChildren.length, 1, 'one <style> attached');
  assert.equal(fakeStyle.attrs['data-dsh-synthmedia'], 'guide-scroll');
  // The shim targets the native tab body + guide class suffixes: the guide body
  // is min-height:100% + justify-content:center inside overflow:hidden, so a
  // long type list clips the top entries and cannot scroll (upstream layout bug).
  assert.match(fakeStyle.textContent, /\[class\*="_tabBody"\] \[class\*="_guide"\]/);
  assert.match(fakeStyle.textContent, /justify-content:flex-start !important/);
  assert.match(fakeStyle.textContent, /overflow-y:auto !important/);
  for (const dispose of effects) dispose();
  assert.equal(headChildren.length, 0, 'style removed on teardown');

  // Idempotent across re-activation (client reload/HMR): an existing shim is
  // reused instead of appending a second <style>.
  const again = activateClient(true, { preexistingGuideStyle: true });
  assert.equal(again.headChildren.length, 1, 'no duplicate <style> on re-activation');
});

test('client activation: without better-sidebar every other seat still registers', () => {
  const { seats } = activateClient(undefined);
  const names = seats.map((s) => s.seat);
  assert.ok(names.includes('plugins.item'), 'settings card');
  assert.ok(names.includes('conversation.view'), 'conversation media view');
  assert.ok(!names.includes('sidebar'), 'no sidebar seat invented');
});

// --- apply(): end-to-end attribution, command scoping and route wiring --------

test('apply(): a child agent generation is listed by the parent session, not by others', async () => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'attribution-ok' } }] }));
      void body;
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const out = tmpRoot();
  try {
    const { apply } = await import('../lib/index.js');
    const defs = new Map();
    const commands = new Map();
    const routes = [];
    const injectListeners = [];
    const agents = {
      get(id) {
        // The live registry: root-A is the parent of child-C.
        if (id === 'root-A') return { id, session: { meta: {} } };
        return undefined;
      },
    };
    // The web ctx is a DIFFERENT emitter from the tool ctx: index-inject
    // listeners must bind HERE (regression: binding on the tool ctx silently
    // rendered no token row in the live host).
    const webCtx = {
      // Expose the service the way the real web ctx does (service PROPERTY,
      // not only via readService on a lookup name).
      webServer: undefined,
      register: (route) => { routes.push(route); return () => {}; },
      getOrigin: () => 'http://127.0.0.1:3080',
      on: (name, fn) => { injectListeners.push({ name, fn }); return () => {}; },
    };
    webCtx.webServer = webCtx;
    const commandRegistry = { register: (d) => { commands.set(d.name, d); return () => {}; } };
    const ctx = {
      tools: { register: (d) => defs.set(d.name, d) },
      commands: commandRegistry,
      get: (name) => {
        if (name === 'agents') return agents;
        if (name === 'webServer') return webCtx;
        if (name === 'commands') return commandRegistry;
        return undefined;
      },
      inject: (deps, cb) => { cb(ctx); },
    };
    ctx.inject = (deps, cb) => { cb(Array.isArray(deps) && deps.includes('webServer') ? webCtx : ctx); };
    apply(ctx, {
      outputDir: out,
      backends: {
        'inline-text': {
          protocol: 'openai-chat-compatible', model: 'tm', models: ['tm'], modalities: ['text'],
          baseUrl: base, authStyle: 'none', online: true, timeoutMs: 5000, protocolVerified: true,
        },
      },
    });
    const gen = await defs.get('synthmedia_generate').execute(
      { backend: 'inline-text', model: 'tm', modality: 'text', prompt: 'hi' },
      {
        signal: new AbortController().signal,
        agent: { id: 'child-C', session: { meta: { parentSession: 'root-A' } } },
        callId: 'call-9', rootCallId: 'root-9',
      },
    );
    await defs.get('synthmedia_wait').execute({ id: gen.job.id }, { signal: new AbortController().signal });
    // The persisted record carries the session-tree attribution.
    const onDisk = JSON.parse(readFileSync(join(out, gen.job.id, 'job.json'), 'utf8'));
    assert.equal(onDisk.owner, 'child-C');
    assert.deepEqual(onDisk.ancestors, ['root-A']);
    // The parent conversation's command lists it; another conversation sees nothing.
    const cmd = commands.get('synthmedia');
    assert.ok(cmd, 'the /synthmedia command is registered');
    const parent = await cmd.handler({ rawInput: ' jobs', agent: { id: 'root-A' } });
    assert.equal(parent.kind, 'success');
    assert.equal(parent.json.jobs.length, 1);
    assert.equal(parent.json.jobs[0].owner, 'child-C');
    assert.equal(parent.json.downloadBase, 'http://127.0.0.1:3080/synthmedia/api/artifact');
    const foreign = await cmd.handler({ rawInput: ' jobs', agent: { id: 'other-Z' } });
    assert.equal(foreign.json.jobs.length, 0);
    // Two HTTP faces: the fenced artifact download and the token-gated jobs
    // read. Both are registered here; the plain-HTTP jobs read is NOT the
    // unauthenticated list that was removed — it needs the per-page token.
    assert.equal(routes.length, 2);
    assert.equal(routes[0].kind, 'prefix');
    assert.equal(routes[0].path, '/synthmedia/api');
    const jobsRoute = routes.find((r) => r.path === '/synthmedia/api/jobs');
    assert.ok(jobsRoute, 'jobs endpoint registered');
    assert.equal(jobsRoute.kind, 'exact');
    const denied = fakeRes();
    await jobsRoute.handler({ method: 'GET', url: '/synthmedia/api/jobs?session=root-A' }, denied);
    assert.equal(denied.statusCode, 403, 'without the page token the endpoint refuses');

    // The page token is injected through the structured index seat: the served
    // document gets `globalThis.__SYNTHMEDIA_JOBS_TOKEN__`, and that exact value
    // is what the endpoint accepts. This is the whole no-session-event read path.
    const table = [];
    for (const listener of injectListeners) {
      if (listener.name === 'webserver/index-inject') listener.fn(table);
    }
    const tokenRow = table.find((row) => row && row.name === '__SYNTHMEDIA_JOBS_TOKEN__');
    assert.ok(tokenRow, 'the page token row is pushed to the index injection table');
    assert.equal(tokenRow.kind, 'global');
    assert.match(String(tokenRow.value), /^[a-f0-9]{32}$/);

    const okRes = fakeRes();
    await jobsRoute.handler({ method: 'GET', url: `/synthmedia/api/jobs?token=${tokenRow.value}&session=root-A` }, okRes);
    assert.equal(okRes.statusCode, 200, 'the injected token is accepted');
    const okBody = JSON.parse(okRes.body);
    assert.equal(okBody.jobs.length, 1, 'the parent session reads its child generation over plain HTTP');
    assert.equal(okBody.jobs[0].owner, 'child-C');
    assert.equal(okBody.downloadBase, 'http://127.0.0.1:3080/synthmedia/api/artifact');

    const foreignHttp = fakeRes();
    await jobsRoute.handler({ method: 'GET', url: `/synthmedia/api/jobs?token=${tokenRow.value}&session=other-Z` }, foreignHttp);
    assert.equal(JSON.parse(foreignHttp.body).jobs.length, 0, 'another conversation still sees nothing');

    const forged = fakeRes();
    await jobsRoute.handler({ method: 'GET', url: `/synthmedia/api/jobs?token=${'0'.repeat(32)}&session=root-A` }, forged);
    assert.equal(forged.statusCode, 403, 'a same-length forged token is rejected');
  } finally {
    server.close();
    rmSync(out, { recursive: true, force: true });
  }
});
