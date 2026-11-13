// Phase-two IA rendering tests for the rewritten settings card
// (client/client.js): six-section information architecture, unified
// draft→「保存并生效」write model, and the three new volatile config fields.
// Same React-free technique as render-regression.test.mjs: the ModuleLoader
// template runs with a minimal jsx runtime + hook stub and the produced
// element trees are asserted structurally.
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
		react, jsxRuntime, hooks,
		reset() { hooks.length = 0; idx = 0; effects = []; },
		reuse() { idx = 0; },
	};
}

const T = (key) => key; // locale stub: keys ARE the labels we assert on
const T_OF = (dict) => (key, vars) => {
	let s = dict[key] ?? key;
	for (const [k, v] of Object.entries(vars ?? {})) s = s.replace('{' + k + '}', v);
	return s;
};

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
	let card;
	const dictionaries = [];
	const ctx = {
		effect: (fn) => { fn(); },
		locale: { register: (ns, dict) => dictionaries.push(dict), bind: () => T },
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
	return { card, runtime, dictionaries };
}

// --- fixtures ---------------------------------------------------------------
const BUILTINS = [
	{ id: 'zgci-h3', protocol: 'openai-video-compatible', baseUrl: 'https://hub.zgci.org', models: ['minimax-h3'], modalities: ['video'], online: false, protocolVerified: true, liveVerified: false },
	{ id: 'bza-seedance', protocol: 'volcengine-ark-compatible', baseUrl: 'https://llm.inner.bza.edu.cn/plan/v3', models: ['doubao-seedance-2.0'], modalities: ['video'], online: true, protocolVerified: true, liveVerified: false },
];
const PROVIDERS = [
	{ id: 'zgci', displayName: 'zgci hub', baseURL: 'https://hub.zgci.org', models: ['glm-5.3'] },
];
function payload(overrides = {}) {
	return { builtins: BUILTINS, providers: PROVIDERS, generatedAt: 'test', ...overrides };
}
const CFG = {
	customProfiles: '[]',
	providerOrder: '[]',
	enabledDshResources: '[]',
	enabledTools: '[]',
	outputDir: 'synthmedia-output',
	dataDir: 'synthmedia-data',
	providersPatchPath: '',
	defaultTimeoutMs: 1800000,
};
// Per-test host ConfigForm: capture form writes locally, no cross-test leak.
function readyForm(capture) {
	return {
		state: { status: 'ready', value: { ...CFG }, revision: 1 },
		mutate: (ops) => { capture.push(...ops); return true; },
	};
}
function formWith(capture, valueOverrides) {
	return {
		state: { status: 'ready', value: { ...CFG, ...valueOverrides }, revision: 1 },
		mutate: (ops) => { capture.push(...ops); return true; },
	};
}

const SECTION_ORDER = ['overview', 'sources', 'priority', 'ecosystems', 'toolchain', 'advanced'];

test('six sections render in the fixed order with their titles', () => {
	const { card } = loadModule(payload());
	const tree = card({ view: 'page', form: readyForm([]), directMutate: undefined, t: T });
	const sections = findByType(tree, 'div', (d) => typeof d.props['data-section'] === 'string').map((d) => d.props['data-section']);
	assert.deepEqual(sections, SECTION_ORDER);
	for (const id of SECTION_ORDER) {
		assert.ok(findByKey(tree, 'section:' + id).length === 1, 'section header keyed ' + id);
		assert.ok(collectStrings(tree).includes('section.' + id), 'title text present: ' + id);
	}
	// Priority notice: explicit-backend wording, no automatic fallback promised.
	assert.ok(textOf(tree).includes('section.priorityDesc'));
});

test('DSH subscription checkbox → enabledDshResources JSON via one save batch', () => {
	const { card, runtime } = loadModule(payload());
	const calls = [];
	const form = readyForm(calls); // host ConfigForm writes captured here
	const directMutate = async (ops) => { calls.push({ __direct: ops }); return { ok: true }; };
	let tree = card({ view: 'page', form, directMutate, t: T });
	const label = findByType(tree, 'label', (l) => textOf(l).includes('minimax-h3'))[0];
	assert.ok(label, 'supported suggestion row rendered as a checkable label');
	const box = findByType(label, 'input', (i) => i.props.type === 'checkbox')[0];
	assert.notEqual(box.props.disabled, true);
	box.props.onChange({ target: { checked: true } });
	runtime.reuse();
	tree = card({ view: 'page', form, directMutate, t: T });
	const saveBtn = findByType(tree, 'button', (b) => textOf(b) === 'settings.save')[0];
	assert.notEqual(saveBtn.props.disabled, true);
	saveBtn.props.onClick();
	assert.equal(calls.length, 1, 'exactly one op reached the host ConfigForm');
	assert.deepEqual(calls[0].path, ['enabledDshResources']);
	assert.deepEqual(JSON.parse(calls[0].value), ['zgci::minimax-h3']);
	assert.ok(calls.every((c) => !c.__direct), 'host path accepted the batch; directMutate never needed');
});

test('priority up-move → providerOrder JSON (global order, default badge follows)', () => {
	const { card, runtime } = loadModule(payload());
	const calls = [];
	const form = readyForm(calls);
	const directMutate = async () => ({ ok: true });
	let tree = card({ view: 'page', form, directMutate, t: T });
	// Both profiles listed; first is the video default (h3 supported).
	const row2 = findByKey(tree, 'prio:bza-seedance')[0];
	assert.ok(row2, 'second priority row present');
	const up = findByType(row2, 'button', (b) => textOf(b) === 'priority.up')[0];
	assert.notEqual(up.props.disabled, true);
	up.props.onClick();
	runtime.reuse();
	tree = card({ view: 'page', form, directMutate, t: T });
	const saveBtn = findByType(tree, 'button', (b) => textOf(b) === 'settings.save')[0];
	saveBtn.props.onClick();
	assert.deepEqual(JSON.parse(calls[0].value), ['bza-seedance', 'zgci-h3']);
	// After the move, the NEW first row (bza-seedance) has its Up/Top disabled.
	const newFirst = findByKey(tree, 'prio:bza-seedance')[0];
	assert.equal(findByType(newFirst, 'button', (b) => textOf(b) === 'priority.up')[0].props.disabled, true);
});

test('toolchain checkbox → enabledTools JSON; unchecked rows show install hint', () => {
	const { card, runtime } = loadModule(payload({ tools: [
		{ name: 'ffmpeg', enabled: false, installed: true, path: '/opt/homebrew/bin/ffmpeg', version: 'ffmpeg version 7', installHint: 'brew install ffmpeg' },
	] }));
	const calls = [];
	const form = readyForm(calls);
	const directMutate = async () => ({ ok: true });
	let tree = card({ view: 'page', form, directMutate, t: T });
	for (const name of ['ffmpeg', 'imagemagick', 'gimp', 'blender']) {
		const row = findByKey(tree, 'tool:' + name)[0];
		assert.ok(row, 'tool row rendered: ' + name);
		assert.ok(textOf(row).includes('install:'), 'install hint shown for ' + name);
	}
	const ffmpeg = findByKey(tree, 'tool:ffmpeg')[0];
	assert.ok(textOf(ffmpeg).includes('/opt/homebrew/bin/ffmpeg'), 'probed status shows path');
	const box = findByType(ffmpeg, 'input', (i) => i.props.type === 'checkbox')[0];
	box.props.onChange({ target: { checked: true } });
	runtime.reuse();
	tree = card({ view: 'page', form, directMutate, t: T });
	findByType(tree, 'button', (b) => textOf(b) === 'settings.save')[0].props.onClick();
	assert.deepEqual(JSON.parse(calls[0].value), ['ffmpeg']);
});

test('unsupported-ecosystem rows are disabled and not checkable', () => {
	const { card } = loadModule(payload({ providers: [{ id: 'wan', displayName: 'wan hub', baseURL: 'https://wan.example.com', models: ['wan2.2-t2v-a3b'] }] }));
	const tree = card({ view: 'page', form: readyForm([]), directMutate: undefined, t: T });
	const block = findByKey(tree, 'unsupported:wan')[0];
	assert.ok(block, 'unsupported block rendered');
	const text = textOf(block);
	assert.ok(text.includes('wan2.2-t2v-a3b'));
	assert.ok(text.includes('import.unsupported'), 'marked 暂不支持');
	const boxes = findByType(block, 'input', (i) => i.props.type === 'checkbox');
	assert.ok(boxes.length > 0);
	for (const b of boxes) {
		assert.equal(b.props.disabled, true, 'checkbox disabled');
		assert.equal(b.props.checked, false, 'not checkable');
	}
	// And no enabled label anywhere suggests it.
	for (const l of findByType(tree, 'label')) assert.ok(!textOf(l).includes('wan2.2-t2v-a3b'), 'must not be a checkable suggestion');
});

test('i18n: zh and en dictionaries expose the exact same key set', () => {
	const { dictionaries } = loadModule(payload());
	assert.equal(dictionaries.length, 1, 'one locale dictionary registered');
	const zhKeys = Object.keys(dictionaries[0].zh).sort();
	const enKeys = Object.keys(dictionaries[0].en).sort();
	assert.deepEqual(enKeys, zhKeys, 'zh is the key-set baseline; en must match exactly');
	assert.ok(zhKeys.includes('section.overview') && zhKeys.includes('settings.save'), 'new IA keys present');
});

test('no credential values in the DOM: token input is a password field and never leaks as text', () => {
	const { card, runtime } = loadModule(payload());
	const SECRET = 'sk-super-secret-token-value-123';
	const form = readyForm([]);
	let tree = card({ view: 'page', form, directMutate: undefined, t: T });
	const token = findByType(tree, 'input', (i) => i.props.placeholder === 'import.tokenPlaceholder')[0];
	assert.equal(token.props.type, 'password', 'token input must be type=password');
	token.props.onChange({ target: { value: SECRET } });
	runtime.reuse();
	tree = card({ view: 'page', form, directMutate: undefined, t: T });
	const texts = collectStrings(tree).join(' ');
	assert.ok(!texts.includes(SECRET), 'the token VALUE must never appear as text');
	// authEnv everywhere is a NAME, and the custom editor only edits names.
	assert.ok(!texts.includes('API_KEY_VALUE'));
});

test('no ConfigForm: unified save path still works (draft → directMutate batch)', () => {
	const { card, runtime } = loadModule(payload({ providers: [] }));
	const calls = [];
	const directMutate = async (ops) => { calls.push({ path: ops[0].path, value: ops[0].value, __direct: true }); return { ok: true }; };
	let tree = card({ view: 'page', form: undefined, directMutate, t: T });
	const box = findByKey(tree, 'tool:gimp')[0];
	findByType(box, 'input', (i) => i.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } });
	runtime.reuse();
	tree = card({ view: 'page', form: undefined, directMutate, t: T });
	const saveBtn = findByType(tree, 'button', (b) => textOf(b) === 'settings.save')[0];
	assert.notEqual(saveBtn.props.disabled, true, 'save reachable without ConfigForm');
	saveBtn.props.onClick();
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].path, ['enabledTools']);
	assert.deepEqual(JSON.parse(calls[0].value), ['gimp']);
	assert.equal(calls[0].__direct, true, 'no ConfigForm → the plugin directMutate path carried the write');
});

test('delete requires a second (confirm) click; first click only arms the confirm', () => {
	const { card, runtime } = loadModule(payload());
	const calls = [];
	const MINE = [{ id: 'mine', protocol: 'openai-video-compatible', baseUrl: 'https://x.example.com', models: ['sora-2'], modalities: ['video'], online: false }];
	const directMutate = async () => ({ ok: true });
	let tree = card({ view: 'page', form: formWith(calls, { customProfiles: JSON.stringify(MINE) }), directMutate, t: T });
	const row = findByKey(tree, 'custom:mine')[0];
	assert.ok(row, 'custom profile row rendered');
	const del = findByType(row, 'button', (b) => textOf(b) === 'custom.delete')[0];
	del.props.onClick();
	runtime.reuse();
	tree = card({ view: 'page', form: formWith(calls, { customProfiles: JSON.stringify(MINE) }), directMutate, t: T });
	// Nothing written yet; the button now asks for confirmation.
	assert.equal(calls.length, 0, 'first click only arms the confirm');
	const confirm = findByKey(tree, 'custom:mine')[0];
	const confirmBtn = findByType(confirm, 'button', (b) => textOf(b) === 'custom.confirmDelete')[0];
	assert.ok(confirmBtn, 'confirm label shown after the first click');
	confirmBtn.props.onClick();
	runtime.reuse();
	tree = card({ view: 'page', form: formWith(calls, { customProfiles: JSON.stringify(MINE) }), directMutate, t: T });
	findByType(tree, 'button', (b) => textOf(b) === 'settings.save')[0].props.onClick();
	const op = calls.find((o) => o.path[0] === 'customProfiles');
	assert.ok(op, 'customProfiles op committed');
	assert.deepEqual(JSON.parse(op.value), [], 'profile removed after confirm + save');
});
