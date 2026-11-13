/**
 * Toolchain detection with injected probes: 4 tools × installed / missing /
 * timeout / non-zero-exit paths, disabled tools are never probed, and the
 * imagemagick magick→convert fallback. No real process is spawned here.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const { detectToolchain } = await import('../lib/page/toolchain.js');
const ALL = ['ffmpeg', 'imagemagick', 'gimp', 'blender'];

/** Scripted probe factory: binary → behaviour. 'timeout'/'fail' simulate probe errors. */
function scriptedProbes(table, { calls = [] } = {}) {
  return {
    calls,
    async which(name) {
      calls.push(['which', name]);
      return table[name]?.path;
    },
    async version(name, args) {
      calls.push(['version', name, ...args]);
      const t = table[name];
      if (!t) return undefined;
      if (t.mode === 'timeout' || t.mode === 'fail') return undefined;
      return t.version;
    },
    platform: () => 'darwin',
  };
}

const ALL_INSTALLED = {
  ffmpeg: { path: '/usr/local/bin/ffmpeg', version: 'ffmpeg version 7.1' },
  magick: { path: '/opt/homebrew/bin/magick', version: 'Version: ImageMagick 7.1.2' },
  gimp: { path: '/opt/homebrew/bin/gimp', version: 'GIMP 3.0' },
  blender: { path: '/usr/local/bin/blender', version: 'Blender 4.5.1 LTS' },
};

test('all four tools installed: correct binary names probed, paths/versions returned', async () => {
  const calls = [];
  const out = await detectToolchain(ALL, scriptedProbes(ALL_INSTALLED, { calls }));
  assert.equal(out.length, 4);
  for (const t of out) {
    assert.equal(t.installed, true);
    assert.equal(t.enabled, true);
    assert.ok(t.path && t.version);
    assert.equal(t.unknownData, undefined);
  }
  // imagemagick must be probed via the real binary name `magick`.
  assert.ok(calls.some((c) => c[0] === 'which' && c[1] === 'magick'));
  assert.ok(!calls.some((c) => c[1] === 'imagemagick'));
  // ffmpeg uses `-version`, the rest `--version`.
  assert.ok(calls.some((c) => c[0] === 'version' && c[1] === 'ffmpeg' && c[2] === '-version'));
  assert.ok(calls.some((c) => c[0] === 'version' && c[1] === 'blender' && c[2] === '--version'));
});

test('missing binaries → installed:false, installHint present (darwin)', async () => {
  const out = await detectToolchain(ALL, scriptedProbes({}));
  for (const t of out) {
    assert.equal(t.installed, false);
    assert.equal(t.path, undefined);
    assert.equal(t.installHint, `brew install ${t.name}`);
  }
});

test('timeout / non-zero exit degrade to installed:true + unknownData (path was found)', async () => {
  const hanging = {
    ...ALL_INSTALLED,
    blender: { path: '/usr/local/bin/blender', mode: 'timeout' },
    gimp: { path: '/opt/homebrew/bin/gimp', mode: 'fail' },
  };
  const out = await detectToolchain(ALL, scriptedProbes(hanging));
  const blender = out.find((t) => t.name === 'blender');
  const gimp = out.find((t) => t.name === 'gimp');
  assert.equal(blender.installed, true);
  assert.equal(blender.unknownData, true);
  assert.equal(blender.version, undefined);
  assert.equal(gimp.installed, true);
  assert.equal(gimp.unknownData, true);
});

test('disabled tools are reported enabled:false and NEVER probed', async () => {
  const calls = [];
  const out = await detectToolchain(['ffmpeg'], scriptedProbes(ALL_INSTALLED, { calls }));
  assert.equal(out.length, 4);
  const blender = out.find((t) => t.name === 'blender');
  assert.equal(blender.enabled, false);
  assert.equal(blender.installed, false);
  assert.ok(!calls.some((c) => c.includes('blender')));
  const ffmpeg = out.find((t) => t.name === 'ffmpeg');
  assert.equal(ffmpeg.installed, true);
});

test('imagemagick: no `magick` binary but `convert` present → legacy fallback wins', async () => {
  const legacy = {
    convert: { path: '/usr/bin/convert', version: 'Version: ImageMagick 6.9.12' },
  };
  const out = await detectToolchain(['imagemagick'], scriptedProbes(legacy));
  const t = out.find((x) => x.name === 'imagemagick');
  assert.equal(t.name, 'imagemagick');
  assert.equal(t.installed, true);
  assert.equal(t.version, 'Version: ImageMagick 6.9.12');
});

test('installHint varies by platform', async () => {
  const linux = await detectToolchain(['ffmpeg'], { ...scriptedProbes({}), platform: () => 'linux' });
  assert.equal(linux.find((t) => t.name === 'ffmpeg').installHint, 'sudo apt-get install ffmpeg');
  const win = await detectToolchain(['gimp'], { ...scriptedProbes({}), platform: () => 'win32' });
  assert.equal(win.find((t) => t.name === 'gimp').installHint, 'winget install GIMP.GIMP');
});
