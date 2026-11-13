/**
 * `/synthmedia detect` + `/synthmedia json` wiring for phase one: the
 * toolchain section is driven by enabledTools only, probes are injected here
 * (so this test spawns no process) and the ecosystem gates/order ride along in
 * the JSON payload. No network, no real hardware dependency.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const { runPageCommand } = await import('../lib/page/snapshot.js');

const REPORT = {
  platform: 'darwin',
  arch: 'arm64',
  cpuCount: 12,
  cpuModel: 'Apple M3 Max',
  totalMemBytes: 128 * 1024 ** 3,
  freeDiskBytes: 900 * 1024 ** 3,
  appleSilicon: true,
  gpuInfo: 'Apple M3 Max',
  runtimes: { python: 'Python 3.12.4', uv: 'uv 0.8.13', node: 'v24.22.2' },
};

/** PageServices stub: injected probes, no process spawn, no real filesystem. */
function services(config, calls) {
  return {
    manager: { list: () => [], manifestNow: () => ({ downloadsDir: '/tmp/sm-downloads', entries: [] }) },
    options: { dataDir: '/tmp/synthmedia-page-detect' },
    config,
    collectReport: async () => REPORT,
    detectTools: async (enabled) => {
      calls.push(...enabled);
      return enabled.map((name) => ({
        name,
        enabled: true,
        installed: name !== 'blender',
        ...(name !== 'blender' ? { path: `/usr/local/bin/${name}`, version: `${name} 1.2.3` } : {}),
        installHint: `brew install ${name}`,
      }));
    },
  };
}

test('detect: only enabled tools are probed; result carries text + json.tools', async () => {
  const calls = [];
  const r = await runPageCommand(services({ enabledTools: '["ffmpeg","imagemagick"]' }, calls), 'detect');
  assert.equal(r.kind, 'success');
  assert.deepEqual(calls, ['ffmpeg', 'imagemagick'], 'disabled tools must never be probed');
  assert.match(r.text, /工具链/);
  assert.match(r.text, /ffmpeg✓/);
  assert.doesNotMatch(r.text, /blender/, 'a non-enabled tool must not be reported at all');
});

test('detect: enabled but missing binary is reported as ✗ and stays non-fatal', async () => {
  const calls = [];
  const r = await runPageCommand(services({ enabledTools: '["blender"]' }, calls), 'detect');
  assert.deepEqual(calls, ['blender']);
  assert.match(r.text, /blender✗/);
  assert.equal(r.json.tools[0].installed, false);
});

test('detect: no enabledTools ⇒ explicit 未启用 line, zero probes', async () => {
  const calls = [];
  const r = await runPageCommand(services({}, calls), 'detect');
  assert.deepEqual(calls, []);
  assert.match(r.text, /工具链：未启用/);
  assert.deepEqual(r.json.tools, []);
});

test('json: snapshot carries order/priority/effectiveDefault/ecosystems/tools', async () => {
  const calls = [];
  const r = await runPageCommand(
    services({ enabledTools: '["ffmpeg"]', providerOrder: '["zgci-h3"]' }, calls),
    'json',
  );
  assert.equal(r.kind, 'success');
  const snap = r.json;
  assert.deepEqual(snap.order, ['zgci-h3']);
  const zgci = snap.profiles.find((p) => p.id === 'zgci-h3');
  assert.equal(zgci.priority, 1);
  assert.equal(zgci.ecosystem, 'h3');
  assert.equal(zgci.supported, true);
  assert.equal(zgci.effectiveDefault, true, 'h3 video default with an h3 profile ranked first');
  assert.equal(snap.tools.length, 1);
  // Unsupported ecosystems stay listed but are never the default.
  const gemini = snap.profiles.find((p) => p.id === 'gemini-veo');
  assert.equal(gemini.supported, false);
  assert.notEqual(gemini.effectiveDefault, true);
});
