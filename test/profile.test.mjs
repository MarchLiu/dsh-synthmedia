/**
 * Three-layer decoupling + configuration-profile contracts:
 * 1. Model presets cover every required model id, carry capability data only,
 *    and are fully overridable (env list / explicit profile model list).
 * 2. ProviderProfile credentials resolve per call through ctx.credentials
 *    (DSH credential reference) with process.env as fallback — no value is
 *    ever persisted or returned.
 * 3. Legacy `kind` spellings normalise to canonical protocol ids; an unknown
 *    protocol is a hard configuration error (never a silent route).
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

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const REQUIRED_MODELS = [
  'doubao-seedance-2.0',
  'doubao-seedance-2.0-fast',
  'doubao-seedance-2.0-mini',
  'doubao-seedance-2.5',
  'doubao-seedream-5.0-flash',
  'doubao-seedream-5.0-pro',
  'doubao-seed-tts-2.0',
];

test('model presets: all required ids exist with capability-only data', async () => {
  const { MODEL_PRESETS, PRESET_MODEL_IDS, presetModels } = await import('../lib/presets.js');
  // The seven Volcengine Ark presets are exactly the Ark video/image/audio set.
  assert.deepEqual(presetModels('volcengine-ark-compatible', 'video'), REQUIRED_MODELS.slice(0, 4));
  assert.deepEqual(presetModels('volcengine-ark-compatible', 'image'), REQUIRED_MODELS.slice(4, 6));
  assert.deepEqual(presetModels('volcengine-ark-compatible', 'audio'), [REQUIRED_MODELS[6]]);
  for (const id of REQUIRED_MODELS) {
    assert.ok(PRESET_MODEL_IDS.includes(id), `${id} must be a declared preset`);
  }
  // MiniMax official H3 model presets ride their own protocol.
  assert.deepEqual(presetModels('minimax-video-compatible', 'video'), [
    'MiniMax-H3',
    'MiniMax-H3-Highspeed',
    'MiniMax-H3-Lite',
    'MiniMax-H3-Max',
  ]);
  for (const id of REQUIRED_MODELS) {
    const p = MODEL_PRESETS[id];
    assert.equal(p.id, id);
    assert.equal(p.protocol, 'volcengine-ark-compatible');
    // ModelCapability must not carry connection or secret information.
    for (const forbidden of ['baseUrl', 'authEnv', 'credentialRef', 'paths', 'headers', 'apiKey']) {
      assert.ok(!(forbidden in p), `preset ${id} must not carry '${forbidden}'`);
    }
  }
  assert.ok(MODEL_PRESETS['doubao-seedance-2.5'].maxDurationSeconds >= 15);
  assert.deepEqual(MODEL_PRESETS['doubao-seed-tts-2.0'].formats, ['mp3', 'pcm', 'ogg_opus']);
  // Official MiniMax ids/limits are used verbatim (never the zgci `minimax-h3` alias).
  assert.equal(MODEL_PRESETS['MiniMax-H3'].protocol, 'minimax-video-compatible');
  assert.equal(MODEL_PRESETS['MiniMax-H3-Max'].minDurationSeconds, 5);
  assert.ok(!('baseUrl' in MODEL_PRESETS['MiniMax-H3']));
});

test('regression: zgci-h3 timeout covers the observed ~29.6 min real queue (not the old 10 min)', async () => {
  const { defaultConfig } = await import('../lib/config.js');
  const zgci = defaultConfig().backends['zgci-h3'];
  assert.equal(zgci.timeoutMs, 3_600_000, 'zgci-h3 must allow a 60-minute real queue');
  // The one authorized live run queued/running ~29.6 min with progress 0.
  assert.ok(zgci.timeoutMs >= 29.6 * 60 * 1000, 'the default must exceed the observed queue plus generation');
  // The validation script's wait cap is the same budget; keep them in sync.
  const script = await readFile(new URL('../scripts/zgci-real-validate.mjs', import.meta.url), 'utf8');
  assert.match(script, /const WAIT_CAP_MS = 60 \* 60 \* 1000;/);
});

test('model presets are overridable: env list and explicit profile model list', async () => {
  const { resolveConfig } = await import('../lib/config.js');
  process.env.SYNTHMEDIA_BZA_SEEDANCE_MODELS = 'doubao-seedance-2.5,my-private-video-model';
  try {
    const cfg = resolveConfig({});
    assert.deepEqual(cfg.backends['bza-seedance'].models, ['doubao-seedance-2.5', 'my-private-video-model']);
    assert.equal(cfg.backends['bza-seedance'].model, 'doubao-seedance-2.5');
  } finally {
    delete process.env.SYNTHMEDIA_BZA_SEEDANCE_MODELS;
  }
  // Explicit profile override wins and a single model override becomes the list.
  const cfg2 = resolveConfig({ backends: { 'bza-seedance': { model: 'gateway-video-9000' } } });
  assert.deepEqual(cfg2.backends['bza-seedance'].models, ['gateway-video-9000']);

  // Unknown model is still a hard routing error (no silent remap).
  const { createBackendRegistry } = await import('../lib/backends/index.js');
  const { JobManager } = await import('../lib/jobs.js');
  const jobs = new JobManager(cfg2, createBackendRegistry(cfg2));
  await assert.rejects(
    () => jobs.start({ backend: 'bza-seedance', model: 'unknown-model', modality: 'video', prompt: 'x' }),
    (err) => err.code === 'E_MODEL',
  );
});

test('provider profile: credentials resolve per call through ctx.credentials (DSH reference)', async () => {
  let seenAuth = '';
  const server = createServer((req, res) => {
    seenAuth = req.headers.authorization ?? '';
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/videos') json(res, 201, { id: 'v-cred-1', status: 'queued' });
      else if (req.method === 'GET' && req.url === '/v1/videos/v-cred-1') json(res, 200, { status: 'completed', progress: 100 });
      else if (req.method === 'GET' && req.url === '/v1/videos/v-cred-1/content') {
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        res.end(Buffer.from([0x00, 0xff, 0x80]));
      } else json(res, 404, {});
    });
  });
  const base = await listen(server);
  delete process.env.SYNTHMEDIA_DSH_REF_TEST;
  let resolveCalls = 0;
  try {
    const { apply } = await import('../lib/index.js');
    const defs = new Map();
    const ctx = {
      tools: { register: (d) => defs.set(d.name, d) },
      // Host credential provider seam: the value exists ONLY here.
      credentials: {
        async resolve(ref) {
          resolveCalls += 1;
          return ref === 'DSH_HUB_REF' ? { value: 'dsh-only-secret-777', source: 'store' } : undefined;
        },
      },
    };
    apply(ctx, {
      outputDir: await mkdtemp(join(tmpdir(), 'synth-cred-')),
      backends: {
        'dsh-hub': {
          protocol: 'openai-video-compatible',
          model: 'minimax-h3',
          models: ['minimax-h3'],
          modalities: ['video'],
          baseUrl: base,
          authStyle: 'bearer',
          credentialRef: 'DSH_HUB_REF',
          online: true,
          timeoutMs: 20_000,
          pollIntervalMs: 20,
          protocolVerified: true,
          paths: { submit: '/v1/videos', status: '/v1/videos/{id}', content: '/v1/videos/{id}/content' },
        },
      },
    });
    assert.equal(defs.size, 5);
    const gen = await defs.get('synthmedia_generate').execute(
      { backend: 'dsh-hub', model: 'minimax-h3', modality: 'video', prompt: 'paper boat' },
      { signal: new AbortController().signal },
    );
    const waited = await defs.get('synthmedia_wait').execute({ id: gen.job.id }, { signal: new AbortController().signal });
    assert.equal(waited.job.status, 'succeeded');
    assert.ok(seenAuth === 'Bearer dsh-only-secret-777', 'the host credential provider value must reach the wire');
    assert.ok(resolveCalls >= 1, 'credential resolved through ctx.credentials');
    assert.ok(!JSON.stringify(waited).includes('dsh-only-secret-777'), 'credential never appears in tool output');
  } finally {
    server.close();
  }
});

test('provider profile: legacy kind aliases normalise; unknown protocol is a hard error', async () => {
  const { resolveConfig, normalizeProtocol } = await import('../lib/config.js');
  assert.equal(normalizeProtocol('ark'), 'volcengine-ark-compatible');
  assert.equal(normalizeProtocol('task-api'), 'openai-video-compatible');
  assert.equal(normalizeProtocol('openai-compatible'), 'openai-chat-compatible');
  assert.equal(normalizeProtocol('volcengine-ark-compatible'), 'volcengine-ark-compatible');
  assert.throws(() => normalizeProtocol('sora-v9'), (err) => err.code === 'E_CONFIG');

  const cfg = resolveConfig({
    backends: {
      'legacy-profile': {
        kind: 'task-api', model: 'minimax-h3', modalities: ['video'],
        baseUrl: 'http://127.0.0.1:9', authStyle: 'none', online: false, timeoutMs: 1000,
        paths: { submit: '/v1/videos', status: '/v1/videos/{id}', content: '/v1/videos/{id}/content' },
      },
    },
  });
  assert.equal(cfg.backends['legacy-profile'].protocol, 'openai-video-compatible');
  // Profile spelling aliases: baseURL / apiKeyEnv are accepted.
  const cfgAlias = resolveConfig({
    backends: {
      'alias-profile': {
        protocol: 'openai-video-compatible', model: 'm', modalities: ['video'],
        baseURL: 'http://127.0.0.1:9/', authStyle: 'bearer', apiKeyEnv: 'MY_KEY_NAME',
        online: true, timeoutMs: 1000, protocolVerified: true,
        paths: { submit: '/v1/videos', status: '/v1/videos/{id}', content: '/v1/videos/{id}/content' },
      },
    },
  });
  assert.equal(cfgAlias.backends['alias-profile'].baseUrl, 'http://127.0.0.1:9');
  assert.equal(cfgAlias.backends['alias-profile'].authEnv, 'MY_KEY_NAME');
  await assert.rejects(async () => resolveConfig({ backends: { bad: { protocol: 'sora-v9', baseUrl: 'http://x' } } }), (err) => err.code === 'E_CONFIG');
});

test('stored config referencing the removed openai-video preset degrades to a custom profile without crashing', async () => {
  // The `openai-video` preset profile was removed (official Sora API shut
  // down 2026-09-24). A user config that still carries an override block for
  // that id must not crash: it degrades to a custom openai-video-compatible
  // backend (the adapter remains in service for third-party gateways).
  const { resolveConfig } = await import('../lib/config.js');
  const cfg = resolveConfig({
    backends: {
      'openai-video': { baseUrl: 'http://legacy-gw.example', model: 'sora-2', modalities: ['video'], online: false },
    },
  });
  const b = cfg.backends['openai-video'];
  assert.ok(b, 'profile id must still resolve as a custom backend');
  assert.equal(b.protocol, 'openai-video-compatible');
  assert.equal(b.baseUrl, 'http://legacy-gw.example');
  assert.equal(b.model, 'sora-2');
});

test('apply() wires a real ctx.jobs registry: host job registered, progress pushed, terminal outcome', async () => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/chat/completions') {
        json(res, 200, { choices: [{ message: { content: 'host-ui-ok' } }] });
      } else json(res, 404, {});
    });
  });
  const base = await listen(server);
  try {
    const { apply } = await import('../lib/index.js');
    const defs = new Map();
    const progress = [];
    const registered = [];
    let settled = null;
    const hostJobs = {
      start(spec) {
        const handle = {
          id: `synthmedia-${registered.length + 1}`,
          append() {},
          updateProgress(line) { progress.push(line); },
        };
        const hooks = spec.run(handle);
        registered.push({ spec, handle, hooks });
        hooks.done.then((o) => { settled = o; });
        return handle.id;
      },
    };
    // DSH service seam: the registry is read with ctx.get('jobs') (and may be
    // loaded after this plugin), not by dereferencing ctx.jobs directly.
    apply(
      { tools: { register: (d) => defs.set(d.name, d) }, get: (n) => (n === 'jobs' ? hostJobs : undefined) },
      {
        outputDir: await mkdtemp(join(tmpdir(), 'synth-host-')),
        backends: {
          'chat-text': {
            protocol: 'openai-chat-compatible', model: 'text-model', models: ['text-model'],
            modalities: ['text'], baseUrl: base, authStyle: 'none', online: true,
            timeoutMs: 10_000, protocolVerified: true,
          },
        },
      },
    );
    assert.equal(defs.size, 5);
    const gen = await defs.get('synthmedia_generate').execute(
      { backend: 'chat-text', model: 'text-model', modality: 'text', prompt: 'hi' },
      { signal: new AbortController().signal, agent: { id: 'sess-owner-1' }, callId: 'call-1', rootCallId: 'root-1' },
    );
    const done = await defs.get('synthmedia_wait').execute({ id: gen.job.id }, { signal: new AbortController().signal });
    assert.equal(done.job.status, 'succeeded');
    assert.equal(registered.length, 1, 'exactly one host job registered for one job');
    assert.equal(registered[0].spec.kind, 'synthmedia');
    assert.match(registered[0].spec.label, /chat-text\/text-model/);
    // Owner fencing + durable tool-call identity (JobSpec.owner/toolCall).
    assert.equal(registered[0].spec.owner, 'sess-owner-1', 'the initiating agent session id must be the host job owner');
    assert.deepEqual(registered[0].spec.toolCall, { callId: 'call-1', rootCallId: 'root-1' });
    assert.ok(progress.length >= 1, 'progress lines reach the host Jobs UI');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(settled.status, 'completed');
  } finally {
    server.close();
  }
});

test('apply(): an unavailable optional jobs service never throws (cordis proxy contract)', async () => {
  // Cordis's context proxy THROWS on `ctx.jobs` when the fiber did not inject or
  // no active provider supplies it. The plugin must only use ctx.get('jobs').
  const { apply } = await import('../lib/index.js');
  const registered = [];
  const hostile = {
    tools: { register: (d) => registered.push(d.name) },
    get: () => undefined,
    get jobs() {
      throw new Error('cannot get property "jobs" without inject');
    },
  };
  apply(hostile, { outputDir: await mkdtemp(join(tmpdir(), 'synth-hostile-')) });
  assert.equal(registered.length, 5, 'the plugin loads without the optional jobs service');
});

test('apply(): the OPTIONAL jobs service is late-bound through ctx.inject(["jobs"])', async () => {
  // Same shape the shipped producers use (dsh-tool-bash): ctx.get('jobs') is
  // undefined at load time, then ctx.inject(["jobs"], …) runs once the service
  // appears. No host registry ⇒ private jobs still work.
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/chat/completions') {
        json(res, 200, { choices: [{ message: { content: 'late-bound-ok' } }] });
      } else json(res, 404, {});
    });
  });
  const base = await listen(server);
  try {
    const { apply } = await import('../lib/index.js');
    const defs = new Map();
    const pending = [];
    const registered = [];
    const hostJobs = {
      start(spec) {
        const hooks = spec.run({ id: 'host-job-1', append() {}, updateProgress() {} });
        registered.push(spec);
        void hooks.done;
        return 'host-job-1';
      },
    };
    apply(
      {
        tools: { register: (d) => defs.set(d.name, d) },
        get: () => undefined,
        inject: (deps, callback) => { pending.push({ deps, callback }); return undefined; },
      },
      {
        outputDir: await mkdtemp(join(tmpdir(), 'synth-late-')),
        backends: {
          'chat-text': {
            protocol: 'openai-chat-compatible', model: 'text-model', models: ['text-model'],
            modalities: ['text'], baseUrl: base, authStyle: 'none', online: true,
            timeoutMs: 10_000, protocolVerified: true,
          },
        },
      },
    );
    assert.equal(defs.size, 5, 'tools work without the optional jobs service');
    // v0.2: the config-page services add two more optional bindings — one
    // more ['jobs'] re-bind (downloads manager) and one ['commands'] (the
    // /synthmedia command). The FIRST pending is still the generation-jobs
    // re-bind, which is what this test exercises.
    // Sub-task round: a third optional binding ['webServer'] registers the
    // artifact download route (degrades silently when the host has none).
    assert.equal(pending.length, 3, 'jobs re-bind + commands + webServer route are the only late bindings');
    assert.deepEqual(pending[0].deps, ['jobs']);
    assert.deepEqual(pending.map((p) => p.deps[0]).includes('webServer'), true);
    assert.equal(registered.length, 0);

    // Bind later, exactly as the host would.
    for (const p of pending) {
      if (p.deps[0] === 'jobs') p.callback({ get: (n) => (n === 'jobs' ? hostJobs : undefined) });
    }
    const gen = await defs.get('synthmedia_generate').execute(
      { backend: 'chat-text', model: 'text-model', modality: 'text', prompt: 'late' },
      { signal: new AbortController().signal, agent: { id: 'sess-late' } },
    );
    const done = await defs.get('synthmedia_wait').execute({ id: gen.job.id }, { signal: new AbortController().signal });
    assert.equal(done.job.status, 'succeeded');
    assert.equal(registered.length, 1, 'jobs started after late binding reach the host UI');
    assert.equal(registered[0].kind, 'synthmedia');
    assert.equal(registered[0].owner, 'sess-late');
  } finally {
    server.close();
  }
});

test('default profiles: zgci speaks the video task protocol (never chat); bza base URL is configurable', async () => {
  const { resolveConfig } = await import('../lib/config.js');
  const cfg = resolveConfig({});
  const zgci = cfg.backends['zgci-h3'];
  assert.equal(zgci.protocol, 'openai-video-compatible');
  assert.equal(zgci.baseUrl, 'https://hub.zgci.org');
  assert.equal(zgci.model, 'minimax-h3');
  assert.equal(zgci.paths.submit, '/v1/videos');
  assert.equal(zgci.paths.status, '/v1/videos/{id}');
  assert.equal(zgci.paths.content, '/v1/videos/{id}/content');
  assert.ok(!JSON.stringify(zgci).includes('chat/completions'), 'zgci must never route through chat');
  // Regression: the one authorized live run spent ~29.6 min queued with
  // progress 0 before generation started. The old 600_000 ms (10 min) cap
  // aborted healthy tasks, so the default must be the 60-minute budget that
  // matches the validation script's WAIT_CAP_MS.
  assert.equal(zgci.timeoutMs, 3_600_000, 'zgci-h3 default timeout must be 60 minutes for real queueing');
  assert.ok(zgci.timeoutMs >= 45 * 60 * 1000, 'zgci-h3 timeout must stay above the observed ~30 min queue');

  assert.equal(cfg.backends['bza-seedance'].baseUrl, 'https://llm.inner.bza.edu.cn/plan/v3');
  assert.equal(cfg.backends['bza-seedance'].protocol, 'volcengine-ark-compatible');
  assert.equal(cfg.backends['bza-seedance'].paths.submit, '/contents/generations/tasks');
  assert.equal(cfg.backends['bza-seedance'].paths.status, '/contents/generations/tasks/{id}');

  process.env.SYNTHMEDIA_BZA_BASE_URL = 'https://my-own-relay.example/v9';
  try {
    const cfg2 = resolveConfig({});
    assert.equal(cfg2.backends['bza-seedance'].baseUrl, 'https://my-own-relay.example/v9');
    assert.equal(cfg2.backends['bza-seedream'].baseUrl, 'https://my-own-relay.example/v9');
    assert.equal(cfg2.backends['bza-seed-tts'].baseUrl, 'https://my-own-relay.example/v9');
  } finally {
    delete process.env.SYNTHMEDIA_BZA_BASE_URL;
  }
});
