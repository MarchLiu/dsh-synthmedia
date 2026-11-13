// Server-side read-only model fetch channel (/synthmedia fetch-models):
// URL normalization, SSRF guard (protocol allowlist, private-host refusal
// with the built-in-preset allowlist exception) and failure fallback.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normBase,
  remoteModelsUrl,
  isPrivateHost,
  guardModelListUrl,
  fetchRemoteModels,
  presetBaseUrls,
} from '../lib/page/fetch-models.js';

// Deterministic DNS stub: the SSRF guard resolves before connecting, so tests
// inject the answer set and NEVER perform a real lookup or network request.
// 203.0.113.0/24 is TEST-NET-3 (public, documentation-only).
const publicLookup = async () => [{ address: '203.0.113.10', family: 4 }];
const guard = (url, presets = [], lookup = publicLookup) => guardModelListUrl(url, presets, { lookup });

test('remoteModelsUrl normalization: /v1 base appends only /models, bare host gets /v1/models', () => {
  assert.equal(remoteModelsUrl('https://hub.zgci.org'), 'https://hub.zgci.org/v1/models');
  assert.equal(remoteModelsUrl('https://hub.zgci.org/'), 'https://hub.zgci.org/v1/models');
  assert.equal(remoteModelsUrl('https://hub.zgci.org/v1'), 'https://hub.zgci.org/v1/models');
  assert.equal(remoteModelsUrl('https://hub.zgci.org/v1/'), 'https://hub.zgci.org/v1/models');
  assert.equal(remoteModelsUrl('https://llm.inner.bza.edu.cn/plan/v3/'), 'https://llm.inner.bza.edu.cn/plan/v3/models');
  assert.equal(remoteModelsUrl(' https://api.example.com '), 'https://api.example.com/v1/models');
  assert.equal(remoteModelsUrl(''), null);
  assert.equal(remoteModelsUrl(undefined), null);
});

test('isPrivateHost: loopback / RFC1918 / link-local / CGNAT / localhost / IPv6 ULA', () => {
  for (const h of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '100.64.0.1', 'localhost', '::1', 'fe80::1', 'fc00::1']) {
    assert.equal(isPrivateHost(h), true, h);
  }
  for (const h of ['hub.zgci.org', '8.8.8.8', '172.32.0.1', '192.169.1.1', '::2']) {
    assert.equal(isPrivateHost(h), false, h);
  }
});

test('guardModelListUrl: protocol allowlist and credential rejection', async () => {
  assert.equal((await guard('file:///etc/passwd')).ok, false);
  const data = await guard('data:text/plain,x');
  assert.equal(data.ok, false);
  assert.match(data.reason, /http\/https/);
  const cred = await guard('https://user:pass@hub.zgci.org');
  assert.equal(cred.ok, false);
  assert.match(cred.reason, /凭据/);
  assert.equal((await guard('https://hub.zgci.org')).ok, true);
  assert.equal((await guard('http://10.0.0.9')).ok, false);
});

test('guardModelListUrl: private hosts refused unless baseURL exactly matches a preset base', async () => {
  const presets = ['http://127.0.0.1:8787/v1', 'https://hub.zgci.org'];
  assert.equal((await guard('http://127.0.0.1:9999', presets)).ok, false);
  assert.equal((await guard('https://192.168.1.4/v1', presets)).ok, false);
  const allowed = await guard('http://127.0.0.1:8787/v1', presets);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.url, 'http://127.0.0.1:8787/v1/models');
  // trailing-slash-tolerant exact match against the preset allowlist
  assert.equal((await guard('http://127.0.0.1:8787/v1/', presets)).ok, true);
  // a preset entry does NOT open the door for sibling paths on a private host
  assert.equal((await guard('http://127.0.0.1:8787/admin', presets)).ok, false);
  assert.match((await guard('http://127.0.0.1:9999', presets)).reason, /私有|回环/);
});

test('fetchRemoteModels: failure modes resolve {ok:false} without throwing, ids-only success', async () => {
  // HTTP failure
  const badStatus = await fetchRemoteModels('https://hub.zgci.org', {
    lookup: publicLookup,
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  assert.equal(badStatus.ok, false);
  assert.match(badStatus.reason, /401/);
  // SSRF guard wins before any request
  const ssrf = await fetchRemoteModels('http://169.254.169.254/latest', { fetchImpl: async () => { throw new Error('MUST NOT FETCH'); } });
  assert.equal(ssrf.ok, false);
  assert.match(ssrf.reason, /私有|回环/);
  // odd body shape
  const odd = await fetchRemoteModels('https://hub.zgci.org', {
    lookup: publicLookup,
    fetchImpl: async () => ({ ok: true, json: async () => ({ object: 'list' }) }),
  });
  assert.equal(odd.ok, false);
  // success: data[] of objects → ids only, credentials never echoed
  const okFetch = (url, init) => {
    assert.equal(url, 'https://hub.zgci.org/v1/models');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error', 'redirects must not bypass the SSRF guard');
    assert.deepEqual(init.headers, { authorization: 'Bearer pasted-secret' });
    return Promise.resolve({ ok: true, json: async () => ({ data: [
      { id: 'minimax-h3', name: 'MiniMax H3' },
      { id: 'glm-5.3' },
      'seedance-1.0-pro',
      { id: 'minimax-h3' },
      { nope: true },
    ] }) });
  };
  const good = await fetchRemoteModels('https://hub.zgci.org', { token: 'pasted-secret', lookup: publicLookup, fetchImpl: okFetch });
  assert.equal(good.ok, true);
  assert.deepEqual(good.models, [
    { id: 'minimax-h3', name: 'MiniMax H3' },
    { id: 'glm-5.3' },
    { id: 'seedance-1.0-pro' },
  ]);
  // auth-env resolver failure degrades to anonymous, request still made
  const anon = await fetchRemoteModels('https://hub.zgci.org', {
    resolveCredential: async () => { throw new Error('resolver down'); },
    authEnv: 'SYNTHMEDIA_OPENAI_API_KEY',
    lookup: publicLookup,
    fetchImpl: (url, init) => {
      assert.deepEqual(init.headers, {});
      return Promise.resolve({ ok: true, json: async () => ({ models: [{ id: 'm1' }] }) });
    },
  });
  assert.equal(anon.ok, true);
  assert.deepEqual(anon.models, [{ id: 'm1' }]);
  // network error
  const net = await fetchRemoteModels('https://hub.zgci.org', { lookup: publicLookup, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(net.ok, false);
  assert.match(net.reason, /ECONNREFUSED/);
});

test('presetBaseUrls reads the effective config backends; resolve failure yields []', () => {
  const bases = presetBaseUrls({});
  assert.ok(Array.isArray(bases) && bases.length > 0);
  assert.ok(bases.every((b) => typeof b === 'string' && b.startsWith('http')));
});

test('normBase is trim/trailing-slash/case tolerant', () => {
  assert.equal(normBase(' HTTPS://Hub.Zgci.Org/ '), 'https://hub.zgci.org');
  assert.equal(normBase(null), '');
});


// --- SSRF bypass regressions (verified: mapped IPv6 + DNS-resolved private) --

test('isPrivateHost: IPv4-mapped / IPv4-compatible IPv6 judged by embedded IPv4', () => {
  // IPv4-mapped ::ffff:a.b.c.d — the URL parser normalizes dotted to hex groups.
  for (const h of ['::ffff:7f00:1', '::ffff:127.0.0.1', '[::ffff:7f00:1]', '::ffff:a9fe:a9fe',
    '::ffff:c0a8:101', '::ffff:ac10:1', '::ffff:a00:1', '0:0:0:0:0:ffff:7f00:1']) {
    assert.equal(isPrivateHost(h), true, h);
  }
  // Deprecated IPv4-compatible ::a.b.c.d — loopback / link-local / RFC1918.
  for (const h of ['::7f00:1', '::127.0.0.1', '::a9fe:a9fe', '::c0a8:101', '::ac10:1']) {
    assert.equal(isPrivateHost(h), true, h);
  }
  // Embedded public IPv4 stays public, in both forms.
  for (const h of ['::ffff:8.8.8.8', '::ffff:808:808', '::8.8.8.8', '::808:808']) {
    assert.equal(isPrivateHost(h), false, h);
  }
  // Pre-existing behaviour is preserved: ::2 == 0.0.0.2 is not treated as a
  // reachable private target, while :: and ::1 were already refused.
  assert.equal(isPrivateHost('::2'), false);
  assert.equal(isPrivateHost('::'), true);
  assert.equal(isPrivateHost('::1'), true);
  // A regular global IPv6 address and a zone-id form do not crash the parser.
  assert.equal(isPrivateHost('2001:db8::1'), false);
  assert.equal(isPrivateHost('fe80::1%eth0'), true);
});

test('guardModelListUrl: IPv4-mapped / compatible IPv6 literals are refused before any DNS', async () => {
  const forbidden = ['http://[::ffff:7f00:1]', 'http://[::ffff:127.0.0.1]',
    'http://[::ffff:a9fe:a9fe]', 'http://[::ffff:c0a8:101]', 'http://[::7f00:1]',
    'http://[::127.0.0.1]', 'http://[::a9fe:a9fe]'];
  for (const url of forbidden) {
    let lookupCalls = 0;
    const result = await guardModelListUrl(url, [], {
      lookup: async () => { lookupCalls += 1; return []; },
    });
    assert.equal(result.ok, false, url);
    assert.match(result.reason, /私有|回环/, url);
    assert.equal(lookupCalls, 0, `literal IP must be judged without DNS: ${url}`);
  }
  // The mapped address of a public IPv4 target is still allowed.
  assert.equal((await guard('http://[::ffff:8.8.8.8]')).ok, true);
  // An exact preset entry still opens exactly its own private baseURL.
  const presets = ['http://[::ffff:7f00:1]:8787/v1'];
  assert.equal((await guard('http://[::ffff:7f00:1]:8787/v1', presets)).ok, true);
});

test('guardModelListUrl: DNS answers are checked (127.0.0.1.nip.io style)', async () => {
  let asked = '';
  const nip = await guardModelListUrl('http://127.0.0.1.nip.io', [], {
    lookup: async (host) => { asked = host; return [{ address: '127.0.0.1', family: 4 }]; },
  });
  assert.equal(nip.ok, false);
  assert.equal(asked, '127.0.0.1.nip.io', 'the hostname is resolved, not the literal');
  assert.match(nip.reason, /127\.0\.0\.1/);
  assert.match(nip.reason, /私有|回环/);

  // Public answers pass and keep the model-list URL shape.
  const ok = await guard('https://api.example.com');
  assert.equal(ok.ok, true);
  assert.equal(ok.url, 'https://api.example.com/v1/models');

  // An IPv6 private answer is caught too.
  const v6 = await guardModelListUrl('https://v6.example.com', [], {
    lookup: async () => [{ address: '::1', family: 6 }],
  });
  assert.equal(v6.ok, false);

  // ANY private record among several rejects (split-horizon / multi-A).
  const mixed = await guardModelListUrl('https://mixed.example.com', [], {
    lookup: async () => [{ address: '203.0.113.10', family: 4 }, { address: '10.0.0.5', family: 4 }],
  });
  assert.equal(mixed.ok, false);
  assert.match(mixed.reason, /10\.0\.0\.5/);

  // Unresolvable / empty / malformed answer sets fail closed.
  const nx = await guardModelListUrl('https://nx.example.com', [], {
    lookup: async () => { throw new Error('ENOTFOUND'); },
  });
  assert.equal(nx.ok, false);
  assert.match(nx.reason, /解析失败/);
  assert.equal((await guardModelListUrl('https://empty.example.com', [], { lookup: async () => [] })).ok, false);
  assert.equal((await guardModelListUrl('https://junk.example.com', [], { lookup: async () => [{ family: 4 }] })).ok, false);
});

test('guardModelListUrl: exact preset match keeps the allowlist exception for privately-resolving names', async () => {
  const presets = ['http://internal.example.test/v1'];
  let lookupCalls = 0;
  const lookup = async () => { lookupCalls += 1; return [{ address: '10.1.2.3', family: 4 }]; };
  const allowed = await guardModelListUrl('http://internal.example.test/v1', presets, { lookup });
  assert.equal(allowed.ok, true);
  assert.equal(lookupCalls, 0, 'a preset entry is an explicit allowlist; no DNS needed');
  // A sibling path on the same name is NOT covered by the preset.
  const sibling = await guardModelListUrl('http://internal.example.test/admin', presets, { lookup });
  assert.equal(sibling.ok, false);
  assert.equal(lookupCalls, 1);
});

test('fetchRemoteModels: DNS rebinding (public answer, then private before dispatch) is refused', async () => {
  const answers = [[{ address: '203.0.113.10', family: 4 }], [{ address: '127.0.0.1', family: 4 }]];
  let lookups = 0;
  let fetched = 0;
  const rebinding = await fetchRemoteModels('https://rebind.example.com', {
    lookup: async () => answers[Math.min(lookups++, answers.length - 1)],
    fetchImpl: async () => { fetched += 1; throw new Error('MUST NOT FETCH'); },
  });
  assert.equal(rebinding.ok, false);
  assert.match(rebinding.reason, /发送请求前/);
  assert.match(rebinding.reason, /私有|回环/);
  assert.equal(fetched, 0, 'no request after the pre-dispatch re-resolution turned private');
  assert.equal(lookups, 2, 'guard resolution + pre-dispatch re-resolution');

  // Private on the very first answer: refused by the guard, no re-resolution.
  lookups = 0;
  fetched = 0;
  const alreadyPrivate = await fetchRemoteModels('https://rebind.example.com', {
    lookup: async () => { lookups += 1; return [{ address: '169.254.169.254', family: 4 }]; },
    fetchImpl: async () => { fetched += 1; throw new Error('MUST NOT FETCH'); },
  });
  assert.equal(alreadyPrivate.ok, false);
  assert.equal(lookups, 1);
  assert.equal(fetched, 0);
});

test('runPageCommand fetch-models: a hostname resolving to a private address is refused', async () => {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; throw new Error('MUST NOT FETCH'); };
  try {
    const answer = await runPageCommand(
      fakeServices({ lookup: async () => [{ address: '127.0.0.1', family: 4 }] }),
      'fetch-models http://127.0.0.1.nip.io',
    );
    assert.equal(answer.kind, 'error');
    assert.match(answer.text, /模型拉取失败/);
    assert.match(answer.text, /私有|回环/);
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- /synthmedia fetch-models command wiring ---------------------------------

import { runPageCommand } from '../lib/page/snapshot.js';

function fakeServices(overrides = {}) {
  return {
    manager: {},
    options: { dataDir: 'synthmedia-data' },
    config: {},
    lookup: publicLookup,
    ...overrides,
  };
}

test('runPageCommand fetch-models: SSRF refusal and success path, no credential echo', async () => {
  const refused = await runPageCommand(fakeServices(), 'fetch-models http://169.254.169.254/latest');
  assert.equal(refused.kind, 'error');
  assert.match(refused.text, /模型拉取失败/);
  assert.ok(!refused.text.includes('Bearer'));
  const missing = await runPageCommand(fakeServices(), 'fetch-models');
  assert.equal(missing.kind, 'error');
  assert.match(missing.text, /用法/);
  const services = fakeServices({
    resolveCredential: async (name) => {
      assert.equal(name, 'SYNTHMEDIA_OPENAI_API_KEY', 'env-var names are case-sensitive');
      return 'resolved-secret';
    },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://hub.zgci.org/v1/models');
    assert.equal(init.headers.authorization, 'Bearer resolved-secret');
    return { ok: true, json: async () => ({ data: [{ id: 'minimax-h3' }, { id: 'glm-5.3' }] }) };
  };
  try {
    const ok = await runPageCommand(services, 'fetch-models https://hub.zgci.org --auth-env SYNTHMEDIA_OPENAI_API_KEY');
    assert.equal(ok.kind, 'success');
    assert.match(ok.text, /已拉取 2 个模型/);
    assert.match(ok.text, /暂不支持/);
    assert.deepEqual(ok.json, { models: ['minimax-h3', 'glm-5.3'] });
    assert.ok(!JSON.stringify(ok).includes('resolved-secret'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('runPageCommand fetch-models preserves pasted token case and never echoes it', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.headers.authorization, 'Bearer MiXeD-Case-Secret');
    assert.equal(init.redirect, 'error');
    return { ok: true, json: async () => ({ data: [{ id: 'minimax-h3', name: 'MiniMax H3' }] }) };
  };
  try {
    const answer = await runPageCommand(
      fakeServices(),
      'fetch-models https://hub.zgci.org --token MiXeD-Case-Secret',
    );
    assert.equal(answer.kind, 'success');
    assert.match(answer.text, /MiniMax H3/);
    assert.deepEqual(answer.json, { models: ['minimax-h3'] });
    assert.ok(!JSON.stringify(answer).includes('MiXeD-Case-Secret'));
  } finally {
    globalThis.fetch = realFetch;
  }
});
