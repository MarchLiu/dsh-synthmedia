// Rendering regression tests for the settings card (client/client.js).
//
// React-free: the ModuleLoader template is evaluated with a minimal jsx
// runtime + hook stub, so the REAL SettingsCard body executes synchronously
// and the produced element trees are asserted structurally. Covers:
//  - defect 1: TDZ ReferenceError (providers before initialization) — both
//    views must render;
//  - defect 2: directMutate fallback reachable when ConfigForm is missing
//    (buttons enabled, write reaches remote.settings.mutate);
//  - defect 3: LLM ids on preset-matching baseURLs greyed 暂不支持, never
//    promoted to media models; remote /v1/models ids classified strictly by
//    id pattern;
//  - defect 4: manual model-id add keeps the id and clears the input via ONE
//    functional state update;
//  - remote pull URL normalization and failure fallback (import.fetchFailed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = readFileSync(join(root, 'client', 'client.js'), 'utf8');

// --- element-tree helpers -----------------------------------------------------

function walk(node, visit) {
  if (node === null || node === undefined || node === true || node === false) return;
  if (typeof node === 'string' || typeof node === 'number') { visit(node); return; }
  if (Array.isArray(node)) { for (const c of node) walk(c, visit); return; }
  if (typeof node === 'object' && node.props !== undefined) {
    visit(node);
    walk(node.props.children, visit);
  }
}

function collectStrings(tree) {
  const out = [];
  walk(tree, (n) => { if (typeof n === 'string' || typeof n === 'number') out.push(String(n)); });
  return out;
}

function findByType(tree, type, pred = () => true) {
  const hits = [];
  walk(tree, (n) => { if (n && typeof n === 'object' && n.type === type && pred(n)) hits.push(n); });
  return hits;
}

function findByKey(tree, key) {
  const hits = [];
  walk(tree, (n) => { if (n && typeof n === 'object' && n.key === key) hits.push(n); });
  return hits;
}

function textOf(node) { return collectStrings(node).join(''); }

// --- mini react + jsx runtime ---------------------------------------------------

function createRuntime() {
  const hooks = [];
  let idx = 0;
  let effects = [];
  const react = {
    useState(init) {
      const i = idx++;
      if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init;
      return [hooks[i], (v) => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }];
    },
    useRef(v) {
      const i = idx++;
      if (!(i in hooks)) hooks[i] = { current: v };
      return hooks[i];
    },
    useCallback(fn) {
      const i = idx++;
      if (!(i in hooks)) hooks[i] = fn;
      return hooks[i];
    },
    useEffect(fn) { effects.push(fn); },
    useSyncExternalStore(_sub, get) {
      const i = idx++;
      if (!(i in hooks)) hooks[i] = get();
      return hooks[i];
    },
  };
  const jsxRuntime = {
    jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
    jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
  };
  return {
    react,
    jsxRuntime,
    hooks,
    reset() { hooks.length = 0; idx = 0; effects = []; },
    // re-render with preserved state: rewind the hook cursor only
    reuse() { idx = 0; },
    flushEffects() {
      const pending = effects; effects = [];
      for (const fn of pending) fn();
      // pullProvider is async: let the (stubbed) fetch chain settle.
      return new Promise((resolve) => setTimeout(resolve, 25));
    },
  };
}

function loadModule(payload) {
  const runtime = createRuntime();
  const src = TEMPLATE.replace(
    /const PAGE_DATA = \/\*__PAGE_DATA__\*\/.*;/,
    'const PAGE_DATA = ' + JSON.stringify(payload) + ';',
  );
  let entry;
  const windowStub = { __ModuleLoader__: { load: (m) => { entry = m; } } };
  const requireStub = (name) => (name === 'react' ? runtime.react : runtime.jsxRuntime);
  new Function('window', src)(windowStub);
  assert.ok(entry, 'ModuleLoader.load captured');
  const moduleExports = entry.factory(requireStub);
  // Reach the SettingsCard through the plugins.item slot registration.
  let card;
  const ctx = {
    effect: (fn) => { fn(); },
    locale: { register() {}, bind: () => (key) => key },
    configForms: { get: () => undefined },
    remote: {},
    slots: {
      inject: (_name, factory) => { factory(); },
      register: (def, component) => {
        if (def.name === 'plugins.item') card = component;
        return def;
      },
    },
  };
  moduleExports.apply(ctx);
  assert.equal(typeof card, 'function', 'SettingsCard captured from plugins.item slot');
  return { card, runtime };
}

const T = (key) => key; // locale stub: keys ARE the labels we assert on

// --- fixture data -------------------------------------------------------------

const BUILTINS = [
  { id: 'zgci-h3', protocol: 'openai-video-compatible', baseUrl: 'https://hub.zgci.org', models: ['minimax-h3'], modalities: ['video'], online: false, protocolVerified: true, liveVerified: false },
];
const PROVIDERS = [
  { id: 'zgci', displayName: 'zgci hub', baseURL: 'https://hub.zgci.org', models: ['glm-5.3', 'text-embedding-3-large'] },
];

function payload(overrides = {}) {
  return { builtins: BUILTINS, providers: PROVIDERS, generatedAt: 'test', ...overrides };
}

const READY_FORM = {
  state: { status: 'ready', value: { customProfiles: '[]' }, revision: 1 },
  mutate: () => true,
};

test('defect 1: summary and page views render without TDZ ReferenceError', async () => {
  const { card, runtime } = loadModule(payload());
  const summary = card({ view: 'summary', form: READY_FORM, directMutate: undefined, t: T });
  assert.equal(summary.type, 'span');
  assert.ok(textOf(summary).includes('settings.summaryReady'));
  // !ready path
  runtime.reuse();
  const folded = card({ view: 'summary', form: undefined, directMutate: undefined, t: T });
  assert.ok(textOf(folded).includes('settings.unavailable'));
  // page view (the old code threw ReferenceError here in BOTH views)
  runtime.reuse();
  const page = card({ view: 'page', form: READY_FORM, directMutate: undefined, t: T });
  assert.ok(textOf(page).includes('settings.title'));
  assert.ok(textOf(page).includes('zgci-h3'));
  runtime.reuse();
  const pageNoForm = card({ view: 'page', form: undefined, directMutate: undefined, t: T });
  assert.ok(textOf(pageNoForm).includes('settings.unavailable'));
});

test('defect 2: directMutate write path is reachable without a ConfigForm', async () => {
  const { card, runtime } = loadModule(payload({ providers: [] }));
  const calls = [];
  const directMutate = async (ops) => { calls.push(ops); return { ok: true }; };
  let tree = card({ view: 'page', form: undefined, directMutate, t: T });
  // The add button is NOT disabled (previously gated on !ready).
  const addBtn = findByType(tree, 'button', (b) => textOf(b) === 'custom.add')[0];
  assert.ok(addBtn, 'buttons present');
  assert.notEqual(addBtn.props.disabled, true);
  // Open the custom editor, fill it, submit → op reaches directMutate.
  addBtn.props.onClick();
  runtime.reuse();
  tree = card({ view: 'page', form: undefined, directMutate, t: T });
  assert.ok(textOf(tree).includes('custom.field.id'), 'draft editor open');
  const fill = (fieldKey, value) => {
    const field = findByKey(tree, fieldKey)[0];
    const input = findByType(field, 'input', (i) => i.props.type === 'text')[0]
      ?? findByType(field, 'select')[0];
    input.props.onChange({ target: { value } });
    // re-render so the next fill reads the freshly committed draft state
    runtime.reuse();
    tree = card({ view: 'page', form: undefined, directMutate, t: T });
  };
  fill('id', 'my-profile');
  fill('baseUrl', 'https://media.example.com');
  fill('modelsInput', 'sora-2');
  fill('modalitiesInput', 'video');
  const submit = findByType(tree, 'button', (b) => textOf(b) === 'custom.add').at(-1);
  submit.props.onClick();
  assert.equal(calls.length, 1, 'directMutate called once');
  assert.deepEqual(calls[0][0].path, ['customProfiles']);
  const written = JSON.parse(calls[0][0].value);
  assert.equal(written[0].id, 'my-profile');
  assert.deepEqual(written[0].models, ['sora-2']);
});

test('defect 3: LLM ids stay 暂不支持; remote ids classified strictly by id pattern', async () => {
  const realFetch = globalThis.fetch;
  const fetchedUrls = [];
  globalThis.fetch = async (url) => {
    fetchedUrls.push(String(url));
    return { ok: true, json: async () => ({ data: [{ id: 'seedance-1-0-pro' }, { id: 'glm-5.3' }, { id: 'text-embedding-3-large' }] }) };
  };
  try {
    const { card, runtime } = loadModule(payload());
    let tree = card({ view: 'page', form: READY_FORM, directMutate: undefined, t: T });
    await runtime.flushEffects();
    runtime.reuse();
    tree = card({ view: 'page', form: READY_FORM, directMutate: undefined, t: T });
    const text = collectStrings(tree).join(' ');
    // URL normalization: /v1 base + /models
    assert.ok(fetchedUrls.every((u) => u === 'https://hub.zgci.org/v1/models'), fetchedUrls.join(','));
    // id-pattern media model from the remote list joins suggestions…
    assert.ok(text.includes('seedance-1-0-pro'));
    assert.ok(text.includes('Seedance 视频'), 'remote media id carries its ecosystem tag');
    // …while LLM/embedding ids are greyed unsupported, never promoted
    const unsupportedBlock = findByKey(tree, 'unsupported:zgci')[0];
    assert.ok(unsupportedBlock, 'unsupported section rendered');
    const unsupportedText = textOf(unsupportedBlock);
    assert.ok(unsupportedText.includes('glm-5.3'));
    assert.ok(unsupportedText.includes('text-embedding-3-large'));
    assert.ok(unsupportedText.includes('import.unsupported'));
    for (const label of findByType(tree, 'label')) {
      const lt = textOf(label);
      assert.ok(!lt.includes('glm-5.3'), `LLM id must not be a suggested media model: ${lt}`);
      assert.ok(!lt.includes('text-embedding-3-large'), lt);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('defect 4: manual add keeps the id AND clears the input (single functional update)', async () => {
  const { card, runtime } = loadModule(payload({ providers: [{ id: 'zgci', displayName: 'zgci hub', baseURL: '', models: [] }] }));
  let tree = card({ view: 'page', form: READY_FORM, directMutate: undefined, t: T });
  const typeManual = (value) => {
    const input = findByType(tree, 'input', (i) => i.props.placeholder === 'import.manualPlaceholder')[0];
    input.props.onChange({ target: { value } });
    runtime.reuse();
    tree = card({ view: 'page', form: READY_FORM, directMutate: undefined, t: T });
  };
  typeManual('my-model-1');
  const add = findByType(tree, 'button', (b) => textOf(b) === 'import.manualAdd')[0];
  add.props.onClick();
  runtime.reuse();
  tree = card({ view: 'page', form: READY_FORM, directMutate: undefined, t: T });
  // the id survives as a manual (unsupported) entry…
  const unsupportedText = textOf(findByKey(tree, 'unsupported:zgci')[0]);
  assert.ok(unsupportedText.includes('my-model-1'), unsupportedText);
  // …and the input is cleared.
  const input = findByType(tree, 'input', (i) => i.props.placeholder === 'import.manualPlaceholder')[0];
  assert.equal(input.props.value, '');
});

test('defect 2b: apply-import button is enabled without a ConfigForm (directMutate)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  try {
    const { card, runtime } = loadModule(payload());
    const tree = card({ view: 'page', form: undefined, directMutate: async () => ({ ok: true }), t: T });
    const applyBtn = findByType(tree, 'button', (b) => textOf(b) === 'import.apply')[0];
    assert.ok(applyBtn, 'apply button present');
    assert.notEqual(applyBtn.props.disabled, true);
    runtime.reuse();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('remote pull failure falls back to the preset suggestions with an error note', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  try {
    const { card, runtime } = loadModule(payload());
    let tree = card({ view: 'page', form: READY_FORM, directMutate: undefined, t: T });
    await runtime.flushEffects();
    runtime.reuse();
    tree = card({ view: 'page', form: READY_FORM, directMutate: undefined, t: T });
    const text = collectStrings(tree).join(' ');
    assert.ok(text.includes('import.fetchFailed'));
    // preset fallback still offers minimax-h3 for the matching baseURL
    assert.ok(text.includes('minimax-h3'));
  } finally {
    globalThis.fetch = realFetch;
  }
});
