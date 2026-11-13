// Import-panel media suggestions (suggestionsForProvider): DSH providers
// declare LLM models only, so media candidates must come from baseURL-matched
// built-in presets plus manual additions. Locks the exact behavior the client
// card mirrors (client/client.js suggestionsForProvider).
import test from 'node:test';
import assert from 'node:assert/strict';

import { suggestionsForProvider } from '../lib/page/providers.js';

const BUILTINS = [
  { id: 'zgci-h3', protocol: 'openai-video-compatible', baseUrl: 'https://hub.zgci.org', models: ['minimax-h3'], modalities: ['video'] },
  { id: 'bza-seedance', protocol: 'volcengine-ark-compatible', baseUrl: 'https://llm.inner.bza.edu.cn/plan/v3', models: ['doubao-seedance-2.0', 'doubao-seedance-2.5'], modalities: ['video'] },
  { id: 'bza-seedream', protocol: 'volcengine-ark-compatible', baseUrl: 'https://llm.inner.bza.edu.cn/plan/v3', models: ['doubao-seedream-5.0-pro'], modalities: ['image'] },
];

test('baseURL match against built-in presets suggests media models', () => {
  const out = suggestionsForProvider(
    { baseURL: 'https://hub.zgci.org/', models: ['glm-5.3', 'glm-4.5-air'] },
    BUILTINS,
  );
  // Defect-3 fix: LLM ids on a preset-matching baseURL are NOT promoted to
  // media models — only the preset's own minimax-h3 id is suggested.
  const ids = out.map((s) => s.id);
  assert.deepEqual(ids, ['minimax-h3']);
  const h3 = out.find((s) => s.id === 'minimax-h3');
  assert.equal(h3.ecosystem, 'minimax-h3');
  assert.equal(h3.modality, 'video');
  assert.equal(h3.source, 'preset');
  // LLM ids stay unsupported → omitted (no ecosystem), not greyed entries.
  assert.equal(out.filter((s) => s.ecosystem === undefined).length, 0);
});

test('bza baseURL aggregates Seedance + Seedream series across presets', () => {
  const out = suggestionsForProvider(
    { baseURL: 'https://llm.inner.bza.edu.cn/plan/v3', models: ['kimi-k2'] },
    BUILTINS,
  );
  const byId = Object.fromEntries(out.map((s) => [s.id, s]));
  assert.equal(byId['doubao-seedance-2.0'].ecosystem, 'volcengine-seedance');
  assert.equal(byId['doubao-seedream-5.0-pro'].ecosystem, 'volcengine-seedance');
  assert.equal(byId['doubao-seedream-5.0-pro'].modality, 'image');
  assert.equal(byId['doubao-seedance-2.0'].source, 'preset');
});

test('manual ids are appended and classified, trailing slash tolerant', () => {
  const out = suggestionsForProvider(
    { baseURL: 'https://hub.zgci.org', models: [] },
    BUILTINS,
    ['minimax-h3-relay', 'totally-unknown-model'],
  );
  const byId = Object.fromEntries(out.map((s) => [s.id, s]));
  assert.equal(byId['minimax-h3-relay'].ecosystem, 'minimax-h3');
  assert.equal(byId['minimax-h3-relay'].source, 'manual');
  // Defect-3 fix: an unknown manual id is NOT promoted via the preset's wire
  // protocol — it stays unsupported (the UI greys it 暂不支持).
  assert.equal(byId['totally-unknown-model'], undefined);
});

test('LLM/embedding ids on preset-matching baseURLs are never classified as media (defect 3)', () => {
  const zgci = suggestionsForProvider(
    { baseURL: 'https://hub.zgci.org', models: ['glm-5.3', 'text-embedding-3-large'] },
    BUILTINS,
  );
  assert.deepEqual(zgci.map((s) => s.id), ['minimax-h3']);
  const bza = suggestionsForProvider(
    { baseURL: 'https://llm.inner.bza.edu.cn/plan/v3', models: ['deepseek-latest', 'kimi-k3.1-pro'] },
    BUILTINS,
  );
  // Only ids literally listed by the matched presets (doubao-* series) come
  // back; deepseek-latest / kimi-k3.1-pro stay unsupported.
  assert.deepEqual(bza.map((s) => s.id).sort(),
    ['doubao-seedance-2.0', 'doubao-seedance-2.5', 'doubao-seedream-5.0-pro']);
});

test('unmatched baseURL yields no unsupported suggestions', () => {
  const out = suggestionsForProvider(
    { baseURL: 'https://api.kimi.com/coding/v1', models: ['kimi-k2', 'moonshot-v1'] },
    BUILTINS,
  );
  assert.deepEqual(out, []);
});

test('provider-declared media ids classify by id first', () => {
  const out = suggestionsForProvider(
    { baseURL: 'https://llm.inner.bza.edu.cn/plan/v3', models: ['doubao-seedance-3.0-pro'] },
    BUILTINS,
  );
  const first = out.find((s) => s.id === 'doubao-seedance-3.0-pro');
  assert.equal(first.ecosystem, 'volcengine-seedance');
  assert.equal(first.modality, 'video');
  assert.equal(first.source, 'provider');
});
