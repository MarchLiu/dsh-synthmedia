// Config-page additions: DSH-provider classification, custom-profile schema
// with corrupt fallback, offline-H3 threshold assessment, and the download
// task lifecycle (mock wire, mock host jobs). Pure node:test, no network.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

async function importPage(name) {
  return import(`../lib/page/${name}.js`);
}

// ---------- providers ----------
test('page/classify: the two supported ecosystems and everything else', async () => {
  const { classifyModel } = await importPage('providers');
  assert.deepEqual(classifyModel('doubao-seedance-2.0'), { ecosystem: 'volcengine-seedance', modality: 'video' });
  assert.deepEqual(classifyModel('doubao-seedream-5.0-pro'), { ecosystem: 'volcengine-seedance', modality: 'image' });
  assert.deepEqual(classifyModel('doubao-seed-tts-2.0'), { ecosystem: 'volcengine-seedance', modality: 'audio' });
  assert.deepEqual(classifyModel('minimax-h3'), { ecosystem: 'minimax-h3', modality: 'video' });
  assert.deepEqual(classifyModel('MiniMax-H3-Highspeed'), { ecosystem: 'minimax-h3', modality: 'video' });
  // A bare `h3` or a code model must never classify as supported.
  assert.deepEqual(classifyModel('h3'), { ecosystem: 'unsupported' });
  assert.deepEqual(classifyModel('ark-code-latest'), { ecosystem: 'unsupported' });
  assert.deepEqual(classifyModel('glm-5.3'), { ecosystem: 'unsupported' });
});

test('page/providers: parse profile-patch YAML, skip malformed rows, survive corrupt YAML', async () => {
  const { parseDshProviders } = await importPage('providers');
  const yaml = `
- id: credentials
  config:
    path: /tmp/x
- id: llm
  config:
    providers:
      bza-plan:
        displayName: BZA
        baseURL: https://x.example/plan/v3
        models:
          - id: doubao-seedance-2.0
          - id: glm-5.3
      broken: not-an-object
- not: a provider row
`;
  const out = parseDshProviders(yaml);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'bza-plan');
  assert.equal(out[0].models.length, 2);
  assert.equal(out[0].models[0].ecosystem, 'volcengine-seedance');
  assert.equal(out[0].models[1].ecosystem, 'unsupported');
  assert.deepEqual(parseDshProviders(':::not yaml at all['), []);
  assert.deepEqual(parseDshProviders('{}'), []);
});

// ---------- custom profiles ----------
test('page/custom: schema validation, secret-value rejection, corrupt fallback', async () => {
  const { parseCustomProfiles } = await importPage('custom');
  const good = [{
    id: 'my-hub', protocol: 'minimax-video-compatible', baseUrl: 'https://hub.example/',
    authEnv: 'MY_HUB_KEY', models: ['MiniMax-H3'], modalities: ['video'],
  }];
  let out = parseCustomProfiles(JSON.stringify(good));
  assert.equal(out.error, undefined);
  assert.equal(out.profiles.length, 1);
  assert.equal(out.profiles[0].baseUrl, 'https://hub.example'); // trailing slash folded
  assert.equal(out.profiles[0].authStyle, 'bearer');

  out = parseCustomProfiles('not json {');
  assert.equal(out.profiles.length, 0);
  assert.match(out.error, /JSON/);

  out = parseCustomProfiles([{ id: "xx", protocol: "nonsense", baseUrl: 'http://x', models: ['m'], modalities: ['video'] }]);
  assert.equal(out.profiles.length, 0);
  assert.match(out.error, /protocol/);

  // A field that smells like a stored key VALUE is rejected outright.
  out = parseCustomProfiles([{ id: "xx", protocol: "openai-chat-compatible", baseUrl: 'http://x', models: ['m'], modalities: ['text'], apiKeyValue: 'sk-123' }]);
  assert.equal(out.profiles.length, 0);
  assert.match(out.error, /凭据值/);

  out = parseCustomProfiles([{ id: "xx", protocol: "openai-video-compatible", baseUrl: 'http://x', models: ['m'], modalities: ['video'] }]);
  assert.equal(out.profiles.length, 1, 'task-protocol default paths are auto-filled');
  out = parseCustomProfiles([{ id: "xx", protocol: "openai-video-compatible", baseUrl: 'http://x', models: ['m'], modalities: ['video'], protocolVerified: 'yes-not-boolean' }]);
  assert.equal(out.profiles.length, 1);
  assert.equal(out.profiles[0].protocolVerified, undefined);
});

test('page/custom + snapshot: effectiveConfig merges custom profiles over presets', async () => {
  const { effectiveConfig } = await import('../lib/page/snapshot.js');
  const custom = JSON.stringify([
    { id: 'my-hub', protocol: 'openai-video-compatible', baseUrl: 'http://127.0.0.1:9000', models: ['h3-local'], modalities: ['video'], online: false },
  ]);
  const { config } = effectiveConfig({ customProfiles: custom });
  const b = config.backends['my-hub'];
  assert.ok(b, 'custom profile is routable');
  assert.equal(b.protocol, 'openai-video-compatible');
  assert.equal(b.paths.submit, '/v1/videos');
  assert.equal(b.online, false);
  assert.ok(config.backends['zgci-h3'], 'presets survive the merge');
  // Custom id wins over a built-in with the same id.
  const override = JSON.stringify([{ id: 'zgci-h3', protocol: 'openai-video-compatible', baseUrl: 'http://127.0.0.1:9100', models: ['x'], modalities: ['video'] }]);
  const { config: cfg2 } = effectiveConfig({ customProfiles: override });
  assert.equal(cfg2.backends['zgci-h3'].baseUrl, 'http://127.0.0.1:9100');
});

// ---------- system assessment ----------
function fakeReport(over = {}) {
  return {
    platform: 'darwin', arch: 'arm64', cpuCount: 10, cpuModel: 'Apple M3 Max',
    totalMemBytes: 128 * 1024 ** 3, freeDiskBytes: 500 * 1024 ** 3,
    appleSilicon: true, gpuInfo: 'integrated', runtimes: { python: 'x', uv: 'x', node: 'x' },
    ...over,
  };
}

test('page/system: H3 threshold tiers (充足/勉强/不足) and probe-failure degradation', async () => {
  const { assessH3 } = await importPage('system');
  assert.equal(assessH3(fakeReport()).overall, '充足');
  // Memory between the 48 GiB floor and the 73 GiB need → 勉强.
  assert.equal(assessH3(fakeReport({ totalMemBytes: 64 * 1024 ** 3 })).overall, '勉强');
  assert.equal(assessH3(fakeReport({ totalMemBytes: 32 * 1024 ** 3 })).overall, '不足');
  // Disk: below the 45 GiB estimate → 不足.
  assert.equal(assessH3(fakeReport({ freeDiskBytes: 40 * 1024 ** 3 })).overall, '不足');
  assert.equal(assessH3(fakeReport({ freeDiskBytes: 60 * 1024 ** 3 })).overall, '勉强');
  // Cores below 4 → 不足; missing runtimes downgrade the runtime dimension.
  assert.equal(assessH3(fakeReport({ cpuCount: 2 })).overall, '不足');
  const missing = assessH3(fakeReport({ runtimes: { python: undefined, uv: undefined, node: 'x' } }));
  assert.equal(missing.overall, '不足');
  assert.equal(missing.dimensions.find((d) => d.dimension === '运行时').verdict, '不足');
  // Probe failure on memory → 不足 + unknownData flag (never a silent guess).
  const unknown = assessH3(fakeReport({ totalMemBytes: undefined }));
  const memDim = unknown.dimensions.find((d) => d.dimension === '内存');
  assert.equal(memDim.verdict, '不足');
  assert.equal(memDim.unknownData, true);
  assert.equal(unknown.overall, '不足');
});

// ---------- downloads ----------
function mockSource(script) {
  const calls = [];
  return {
    calls,
    async respond(url, rangeStart) {
      calls.push({ url, rangeStart });
      const chunk = { [Symbol.asyncIterator]: undefined };
      const bytes = await script(rangeStart ?? 0, calls.length);
      return { status: bytes.status ?? 200, totalBytes: bytes.total, stream: bytes.chunks };
    },
  };
}

function chunksOf(parts, total) {
  async function* gen() {
    for (const p of parts) {
      yield new TextEncoder().encode(p);
    }
  }
  return { chunks: gen(), total };
}

function mockHostJobs() {
  const jobs = [];
  return {
    jobs,
    start(spec) {
      const progress = [];
      const handle = { append() {}, updateProgress: (line) => progress.push(line) };
      const hooks = spec.run(handle);
      jobs.push({ spec, hooks, progress });
      return 'host-' + jobs.length;
    },
  };
}

async function tempDataDir() {
  return mkdtemp(join(tmpdir(), 'synth-page-'));
}

test('page/downloads: manifest defaults are placeholders; schema drops malformed entries', async () => {
  const { defaultManifest, validateManifest } = await importPage('downloads');
  const dir = await tempDataDir();
  const m = defaultManifest(join(dir, 'downloads'));
  assert.equal(m.entries.length, 1);
  assert.equal(m.entries[0].url, '', 'shipped manifest must carry NO fabricated url');
  const v = validateManifest({
    downloadsDir: '',
    entries: [
      { id: 'ok-1', name: 'a', url: 'https://x' },
      { id: 'BAD ID!', url: 'https://x' },
      'nope',
      { id: 'ok-2', url: 42 },
    ],
  }, dir);
  assert.deepEqual(v.entries.map((e) => e.id), ['ok-1', 'ok-2']);
  assert.equal(v.downloadsDir, dir);
  await rm(dir, { recursive: true, force: true });
});

test('page/downloads: lifecycle — start, progress, completion, cancel-keeps-part, resume', async () => {
  const { DownloadManager, defaultManifest } = await importPage('downloads');
  const dir = await tempDataDir();
  const downloadsDir = join(dir, 'downloads');
  const manifest = {
    downloadsDir,
    entries: [{ id: 'm1', name: 'model one', url: 'https://files.example/m1.bin' }],
  };
  const host = mockHostJobs();
  // First byte source: full 1000 bytes in 2 chunks. Second: Range request
  // resuming the remaining bytes (validated via calls[1].rangeStart).
  const sources = [];
  const mkSource = (parts, total) => mockSource(() => chunksOf(parts, total));
  const source = {
    calls: [],
    async respond(url, rangeStart) {
      const s = sources[Math.min(this.calls.length, sources.length - 1)];
      this.calls.push({ url, rangeStart });
      return s.respond(url, rangeStart);
    },
  };
  sources.push(mkSource(['a'.repeat(500), 'b'.repeat(500)], 1000));
  sources.push(mkSource(['c'.repeat(250)], 1000));

  const manager = new DownloadManager(manifest, source, host);
  assert.equal(manager.list().length, 0);

  // Unknown id + invalid url refused.
  await assert.rejects(() => manager.start('nope'), /unknown model id/);
  const emptyUrl = new DownloadManager(
    { downloadsDir, entries: [{ id: 'p1', name: 'p', url: '' }] }, source,
  );
  await assert.rejects(() => emptyUrl.start('p1'), /URL/);

  const rec = await manager.start('m1');
  assert.equal(rec.status, 'running');
  assert.equal(host.jobs.length, 1);
  assert.equal(host.jobs[0].spec.kind, 'synthmedia-download', 'downloads surface in the host Jobs UI');
  for (let i = 0; i < 200 && manager.list()[0]?.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  let done = manager.list().find((d) => d.id === 'm1');
  assert.equal(done.status, 'completed');
  assert.equal(done.downloadedBytes, 1000);
  assert.equal(done.percent, 100);
  assert.ok(done.file?.endsWith('m1.bin'));
  const content = await readFile(done.file, 'utf8');
  assert.equal(content.length, 1000);
  assert.ok(host.jobs[0].progress.length > 0, 'progress lines flow to the host handle');
  assert.deepEqual(source.calls[0], { url: 'https://files.example/m1.bin', rangeStart: undefined });

  // Cancel mid-stream: the .part file is kept for resume.
  const slowSource = mockSource(async () => {
    const abort = new Promise((resolve) => setTimeout(() => resolve(new Uint8Array(0)), 10_000));
    async function* gen() {
      yield new TextEncoder().encode('z'.repeat(400));
      await abort;
    }
    return { total: 2000, chunks: gen() };
  });
  const manager2 = new DownloadManager(manifest, slowSource, host);
  await manager2.start('m1');
  await new Promise((r) => setTimeout(r, 150));
  await manager2.cancel('m1');
  for (let i = 0; i < 200 && manager2.list()[0]?.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const cancelled = manager2.list().find((d) => d.id === 'm1');
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(existsSync(join(downloadsDir, 'm1.bin.part')), 'cancel keeps the .part for resume');
  assert.ok((await stat(join(downloadsDir, 'm1.bin.part'))).size >= 400);

  // Resume: partial exists → Range request → appended → completed.
  sources.push(mkSource(['c'.repeat(250)], 1000));
  manager.setManifest(manifest);
  const partSize = (await stat(join(downloadsDir, 'm1.bin.part'))).size;
  const src3 = chunksOf(['d'.repeat(1000 - partSize)], 1000);
  const manager3 = new DownloadManager(manifest, {
    calls: [],
    async respond(url, rangeStart) {
      this.calls.push({ url, rangeStart });
      assert.equal(rangeStart, partSize, 'resume issues a Range request from the part size');
      return { status: 206, total: 1000, stream: src3.chunks };
    },
  }, host);
  await manager3.start('m1');
  for (let i = 0; i < 200 && manager3.list()[0]?.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const resumed = manager3.list().find((d) => d.id === 'm1');
  assert.equal(resumed.status, 'completed');
  assert.equal((await readFile(join(downloadsDir, 'm1.bin'), 'utf8')).length, 1000);
  await rm(dir, { recursive: true, force: true });
});

test('page/downloads: corrupt manifest file falls back to shipped defaults', async () => {
  const { DownloadManager, defaultManifest } = await importPage('downloads');
  const dir = await tempDataDir();
  await writeFile(join(dir, 'downloads.json'), '{corrupt', 'utf8');
  const manager = new DownloadManager(defaultManifest(join(dir, 'downloads')));
  const loaded = await manager.loadManifest(join(dir, 'downloads.json'));
  assert.equal(loaded.entries.length, defaultManifest(join(dir, 'downloads')).entries.length);
  await manager.saveManifest(join(dir, 'downloads.json'));
  assert.ok(existsSync(join(dir, 'downloads.json')));
  await rm(dir, { recursive: true, force: true });
});

// ---------- command grammar (no real HTTP/LLM calls anywhere) ----------
test('page/snapshot: runPageCommand subcommands', async () => {
  const { createPageServices, runPageCommand } = await import('../lib/page/snapshot.js');
  const dir = await tempDataDir();
  const services = createPageServices({ customProfiles: '[]' }, { dataDir: dir }, undefined);
  const status = await runPageCommand(services, '');
  assert.equal(status.kind, 'success');
  assert.match(status.text, /ProviderProfile/);
  assert.match(status.text, /凭据env|authEnv|凭据环境变量名/);

  const json = await runPageCommand(services, 'json');
  assert.equal(json.kind, 'success');
  assert.ok(Array.isArray(json.json.profiles));
  assert.ok(json.json.profiles.length >= 8, 'all built-in presets appear in the snapshot');
  for (const p of json.json.profiles) {
    assert.ok(!('apiKey' in p) && !('key' in p), 'never any credential value in the snapshot');
  }

  const providers = await runPageCommand(services, 'providers');
  assert.match(providers.text, /providersPatchPath|未配置|provider/);

  const dlStartBad = await runPageCommand(services, 'dl start nope');
  assert.equal(dlStartBad.kind, 'error');
  const unknown = await runPageCommand(services, 'wat');
  assert.equal(unknown.kind, 'error');
  await rm(dir, { recursive: true, force: true });
});
