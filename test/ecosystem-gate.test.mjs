/**
 * Ecosystem gate (phase one): SUPPORTED_ECOSYSTEMS = h3 | seedance, 'other'
 * exclusion from default routing, and the guarantee that existing presets are
 * NOT deleted (preset-set assertion must stay green).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const eco = await import('../lib/page/ecosystems.js');
const presets = await import('../lib/presets.js');
const { resolveConfig } = await import('../lib/config.js');

test('SUPPORTED_ECOSYSTEMS is exactly h3 + seedance', () => {
  assert.deepEqual([...eco.SUPPORTED_ECOSYSTEMS], ['h3', 'seedance']);
});

test('modelEcosystem: seedance family (video/image/audio) and h3 family', () => {
  assert.equal(eco.modelEcosystem('doubao-seedance-2.0'), 'seedance');
  assert.equal(eco.modelEcosystem('doubao-seedream-5.0-pro'), 'seedance');
  assert.equal(eco.modelEcosystem('doubao-seed-tts-2.0'), 'seedance');
  assert.equal(eco.modelEcosystem('minimax-h3'), 'h3');
  assert.equal(eco.modelEcosystem('MiniMax-H3-Highspeed'), 'h3');
  // minimax-video-compatible protocol maps to h3 even with an opaque id.
  assert.equal(eco.modelEcosystem('some-relay-id', 'minimax-video-compatible'), 'h3');
});

test('modelEcosystem: everything else is other (bare h3, LLM ids, wan/gemini/openai media)', () => {
  assert.equal(eco.modelEcosystem('h3'), 'other');
  assert.equal(eco.modelEcosystem('glm-5.3'), 'other');
  assert.equal(eco.modelEcosystem('wan2.2-t2v-plus'), 'other');
  assert.equal(eco.modelEcosystem('imagen-4.0-generate-001'), 'other');
  assert.equal(eco.modelEcosystem('gpt-image-1'), 'other');
  // ark protocol alone never promotes a non-seed* id.
  assert.equal(eco.modelEcosystem('ark-code-latest', 'volcengine-ark-compatible'), 'other');
});

test('modelGate/profileGate: supported flags + reason for other', () => {
  const ok = eco.modelGate('minimax-h3');
  assert.equal(ok.supported, true);
  assert.equal(ok.reason, undefined);
  const blocked = eco.profileGate({ model: 'gpt-image-1', protocol: 'openai-images-compatible' });
  assert.equal(blocked.ecosystem, 'other');
  assert.equal(blocked.supported, false);
  assert.ok(blocked.reason && blocked.reason.length > 0);
});

test('gateBackends over the resolved preset config: h3/seedance presets supported, other flagged but PRESENT', () => {
  const cfg = resolveConfig({});
  const gates = eco.gateBackends(cfg.backends);
  assert.equal(gates['zgci-h3'].ecosystem, 'h3');
  assert.equal(gates['local-h3-sidecar'].ecosystem, 'h3');
  assert.equal(gates['bza-seedance'].ecosystem, 'seedance');
  assert.equal(gates['bza-seedream'].ecosystem, 'seedance');
  assert.equal(gates['bza-seed-tts'].ecosystem, 'seedance');
  assert.equal(gates['minimax-official'].ecosystem, 'h3');
  // 'other' ecosystems: flagged unsupported, but the profile still exists.
  assert.equal(gates['gemini-imagen'].supported, false);
  assert.equal(gates['openai-images'].supported, false);
  assert.ok(cfg.backends['gemini-imagen'], "'other' preset must NOT be deleted");
  assert.ok(cfg.backends['openai-images'], "'other' preset must NOT be deleted");
});

test('existing preset set is untouched (PRESET_MODEL_IDS assertion)', () => {
  assert.ok(presets.PRESET_MODEL_IDS.length >= 10);
  assert.ok(presets.PRESET_MODEL_IDS.includes('doubao-seedance-2.0'));
  assert.ok(presets.PRESET_MODEL_IDS.includes('MiniMax-H3'));
});

test("capabilities enrichment via JobManager: 'other' backends keep serving explicit ids, marked supported:false", async () => {
  const { createBackendRegistry } = await import('../lib/backends/index.js');
  const { JobManager } = await import('../lib/jobs.js');
  const cfg = resolveConfig({});
  const jobs = new JobManager(cfg, createBackendRegistry(cfg));
  const list = jobs.listBackends();
  const ids = new Set(list.map((b) => b.id));
  for (const id of ['zgci-h3', 'bza-seedance', 'gemini-imagen', 'openai-images']) {
    assert.ok(ids.has(id), `${id} still listed in capabilities`);
  }
  jobs.dispose();
});
