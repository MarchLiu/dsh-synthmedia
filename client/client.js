// dsh-synthmedia client module: the「SynthMedia」settings card on the Plugins
// page (plugins.item / plugins.row.config / plugins.bundle.config seats — the
// exact mechanism @mars.liu/dsh-cybernetics uses) plus a「媒体服务」
// conversation tab that reaches the server half through the /synthmedia
// command transport for live data (real profile set, system detection,
// download progress).
//
// Hand-written ModuleLoader wrapper, same format the host bundler emits and
// the same convention dsh-cybernetics ships (its lib/client.js is also
// hand-written). The registration id MUST equal the package manifest name:
// the client-modules boot graph keys rows by the manifest name and silently
// skips rows registered under any other id.
//
// The page data (built-in presets snapshot + DSH providers snapshot) is baked
// in at build time by scripts/build-client.mjs; the session tab always reads
// LIVE data from /synthmedia instead.
/* global window */
window.__ModuleLoader__.load({
	id: 'dsh-synthmedia',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		const react = require('react');
		const jsx = require('react/jsx-runtime');

		const PAGE_DATA = /*__PAGE_DATA__*/{"builtins":[],"providers":[],"generatedAt":"template"};

		//#region locale dictionaries (zh is the key-set source of truth)
		const NS = 'synthmedia';
		const zh = {
			'settings.title': 'SynthMedia 媒体生成',
			'settings.description': 'ProviderProfile 一览、DSH providers 导入、自定义 Profile 与离线模型。凭据只保存环境变量名，永不保存密钥值。保存配置后插件自动重载生效。',
			'settings.cardLabel': 'SynthMedia 配置',
			'settings.summaryReady': '{n} 个 ProviderProfile 生效中',
			'settings.unavailable': '设置通道不可用（宿主未提供该插件的 ConfigForm）。重启宿主后重试。',
			'settings.saving': '保存中…',
			'settings.saveFailed': '保存失败，请重试。',
			'section.profiles': '生效中的 ProviderProfile',
			'section.profilesDesc': '内置 preset 与用户自定义 Profile。verified 徽标：协议=文档形状已核验；实测=对该部署发起过真实调用。',
			'section.import': '从 DSH providers 导入',
			'section.importDesc': '勾选要暴露给 SynthMedia 的 provider/模型。仅火山 Seedance 生态与 MiniMax H3 生态受支持，其余置灰「暂不支持」。凭据环境变量名可修改后应用。',
			'section.custom': '自定义 Provider / 模型',
			'section.customDesc': '新建 SynthMedia 特有 Profile（id、协议、baseURL、凭据环境变量名、模型 id）。支持编辑与删除。',
			'badge.protocol': '协议✓', 'badge.noProtocol': '协议✗', 'badge.live': '实测✓', 'badge.noLive': '实测✗',
			'badge.blocked': '已封锁', 'badge.offline': '离线', 'badge.online': '在线',
			'import.apply': '应用勾选（写入自定义 Profile）',
			'import.authEnv': '凭据环境变量名',
			'import.none': '（构建时未发现 DSH providers 数据；可在会话「媒体服务」页用 /synthmedia providers 查看实时清单）',
			'import.unsupported': '暂不支持',
			'import.manualHint': 'DSH providers 只声明 LLM 聊天模型；打开配置页时会尝试 GET {baseURL}/v1/models 动态拉取真实模型清单（可选 Bearer token，仅内存），拉取失败回退为按 baseURL 匹配内置 preset 推荐媒体模型，也可手动补充模型 id。',
			'import.manualPlaceholder': '手动补充模型 id',
			'import.manualAdd': '补充',
			'import.applied': '已写入 {n} 个自定义 Profile，保存后生效。',
			'import.tokenLabel': 'Bearer token（可选，仅本次内存使用，不保存）',
			'import.tokenPlaceholder': '留空 = 匿名拉取',
			'import.fetch': '拉取模型', 'import.fetching': '拉取中…',
			'import.fetchOk': '已拉取 {n} 个模型',
			'import.fetchFailed': '动态拉取失败（网络/CORS/鉴权），已回退为内置 preset 建议。',
			'import.unsupportedHeader': '暂不支持（远程清单中的非媒体模型）',
			'custom.add': '添加', 'custom.update': '保存修改', 'custom.delete': '删除', 'custom.edit': '编辑',
			'custom.field.id': 'Profile id', 'custom.field.protocol': '协议',
			'custom.field.baseUrl': 'Base URL', 'custom.field.authEnv': '凭据环境变量名',
			'custom.field.models': '模型 id（逗号分隔）', 'custom.field.modalities': '模态（逗号分隔 video/image/audio）',
			'custom.field.online': '在线（可发起真实调用）',
			'custom.invalid': '表单校验失败：{msg}',
			'custom.empty': '暂无自定义 Profile。',
			'corrupt': '存储的自定义配置有问题：{msg}',
			'view.tab': '媒体服务',
			'view.description': '实时 Profile 数据、系统资源检测与离线 H3 下载。',
			'view.needsSession': '此视图需要会话命令通道（remote.commands）。',
			'view.detect': '检测系统资源', 'view.detecting': '检测中…',
			'view.refresh': '刷新数据', 'view.loading': '加载中…',
			'view.profiles': '实时 Profile 列表', 'view.dl': '离线 H3 模型下载',
			'view.dlStart': '开始下载', 'view.dlCancel': '取消', 'view.dlUrlPending': 'URL 待填（编辑插件数据目录 downloads.json 后可用）',
			'view.dlRunning': '下载中…每 3 秒自动刷新',
			'view.verdict': '离线 H3 可行性',
			'view.verdictFull': '充足', 'view.verdictTight': '勉强', 'view.verdictNo': '不足',
		};
		const en = {
			'settings.title': 'SynthMedia media generation',
			'settings.description': 'Provider profiles, DSH-provider import, custom profiles and offline model downloads. Credentials are stored as env-var NAMES only. Saving reloads the plugin.',
			'settings.cardLabel': 'SynthMedia settings',
			'settings.summaryReady': '{n} provider profile(s) effective',
			'settings.unavailable': 'Settings transport unavailable (host does not serve this plugin ConfigForm yet). Restart the host and retry.',
			'settings.saving': 'Saving…',
			'settings.saveFailed': 'Save failed, please retry.',
			'section.profiles': 'Effective ProviderProfiles',
			'section.profilesDesc': 'Built-in presets and user-defined profiles. verified badges: protocol = documented shape verified; live = a real call succeeded against this deployment.',
			'section.import': 'Import from DSH providers',
			'section.importDesc': 'Pick provider/models to expose to SynthMedia. Only the Volcengine Seedance and MiniMax H3 ecosystems are supported; everything else is greyed out.',
			'section.custom': 'Custom provider / models',
			'section.customDesc': 'Create SynthMedia-specific profiles (id, protocol, baseURL, credential env-var name, model ids). Edit and delete supported.',
			'badge.protocol': 'proto✓', 'badge.noProtocol': 'proto✗', 'badge.live': 'live✓', 'badge.noLive': 'live✗',
			'badge.blocked': 'blocked', 'badge.offline': 'offline', 'badge.online': 'online',
			'import.apply': 'Apply selection (writes custom profiles)',
			'import.authEnv': 'Credential env var name',
			'import.none': '(No DSH-provider snapshot baked at build time; use /synthmedia providers in the session tab for live data)',
			'import.unsupported': 'unsupported',
			'import.manualHint': 'DSH providers declare LLM chat models only; opening the page tries GET {baseURL}/v1/models for the live model list (optional Bearer token, memory only). On failure it falls back to baseURL-matched built-in preset suggestions, and model ids can always be added manually.',
			'import.manualPlaceholder': 'Add a model id manually',
			'import.manualAdd': 'Add',
			'import.applied': 'Wrote {n} custom profile(s). Takes effect after save.',
			'import.tokenLabel': 'Bearer token (optional, memory only, never stored)',
			'import.tokenPlaceholder': 'empty = anonymous fetch',
			'import.fetch': 'Fetch models', 'import.fetching': 'Fetching…',
			'import.fetchOk': 'Fetched {n} model(s)',
			'import.fetchFailed': 'Live fetch failed (network/CORS/auth); fell back to built-in preset suggestions.',
			'import.unsupportedHeader': 'Unsupported (non-media models in the live list)',
			'custom.add': 'Add', 'custom.update': 'Save changes', 'custom.delete': 'Delete', 'custom.edit': 'Edit',
			'custom.field.id': 'Profile id', 'custom.field.protocol': 'Protocol',
			'custom.field.baseUrl': 'Base URL', 'custom.field.authEnv': 'Credential env var name',
			'custom.field.models': 'Model ids (comma separated)', 'custom.field.modalities': 'Modalities (video/image/audio)',
			'custom.field.online': 'Online (real submissions allowed)',
			'custom.invalid': 'Form invalid: {msg}',
			'custom.empty': 'No custom profiles yet.',
			'corrupt': 'Stored custom config problem: {msg}',
			'view.tab': 'Media',
			'view.description': 'Live profiles, system resource detection and offline H3 downloads.',
			'view.needsSession': 'This view needs the session command transport (remote.commands).',
			'view.detect': 'Detect system resources', 'view.detecting': 'Detecting…',
			'view.refresh': 'Refresh', 'view.loading': 'Loading…',
			'view.profiles': 'Live profile list', 'view.dl': 'Offline H3 model downloads',
			'view.dlStart': 'Start download', 'view.dlCancel': 'Cancel', 'view.dlUrlPending': 'URL pending (edit downloads.json in the plugin data dir)',
			'view.dlRunning': 'Downloading… auto-refresh every 3s',
			'view.verdict': 'Offline H3 feasibility',
			'view.verdictFull': 'sufficient', 'view.verdictTight': 'tight', 'view.verdictNo': 'insufficient',
		};
		//#endregion

		const PROTOCOL_OPTIONS = [
			'openai-video-compatible', 'videogen-task-api', 'minimax-video-compatible',
			'volcengine-ark-compatible', 'openai-chat-compatible',
			'dashscope-wan-compatible', 'google-genmedia-compatible', 'openai-images-compatible',
		];
		const ECOSYSTEM_PROTOCOL = {
			'volcengine-seedance': 'volcengine-ark-compatible',
			'minimax-h3': 'minimax-video-compatible',
			'aliyun-wan': 'dashscope-wan-compatible',
			'google-gemini': 'google-genmedia-compatible',
			'openai-media': 'openai-video-compatible',
		};
		const ECOSYSTEM_MODALITIES = {
			seedance: 'video', seedream: 'image', seedTts: 'audio', minimax: 'video',
			wan: 'video', wanx: 'image', imagen: 'image', veo: 'video', gptImage: 'image', sora: 'video',
		};
		const DEFAULT_AUTH_ENV = {
			'volcengine-seedance': 'SYNTHMEDIA_BZA_API_KEY',
			'minimax-h3': 'MINIMAX_API_KEY',
			'aliyun-wan': 'SYNTHMEDIA_DASHSCOPE_API_KEY',
			'google-gemini': 'SYNTHMEDIA_GEMINI_API_KEY',
			'openai-media': 'SYNTHMEDIA_OPENAI_API_KEY',
		};
		//#region tiny view helpers

		const styles = {
			card: { padding: 14, borderRadius: 10, border: '1px solid var(--dsh-border, #30363d)', display: 'flex', flexDirection: 'column', gap: 12 },
			section: { display: 'flex', flexDirection: 'column', gap: 6 },
			title: { fontSize: 13, fontWeight: 600 },
			desc: { fontSize: 12, opacity: 0.75, lineHeight: 1.5 },
			row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
			input: { padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsh-border, #30363d)', background: 'transparent', color: 'inherit', fontSize: 12 },
			button: { padding: '4px 10px', borderRadius: 6, border: '1px solid var(--dsh-border, #30363d)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 },
			table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
			cell: { borderBottom: '1px solid var(--dsh-border, #21262d)', padding: '4px 6px', textAlign: 'left', verticalAlign: 'top' },
			badge: (ok, warn) => ({
				display: 'inline-block', fontSize: 11, padding: '1px 6px', borderRadius: 8,
				color: ok ? '#3fb950' : warn ? '#d29922' : '#8b949e',
				border: '1px solid currentColor', marginRight: 4,
			}),
			note: { fontSize: 12, whiteSpace: 'pre-wrap', color: '#d29922' },
			good: { fontSize: 12, whiteSpace: 'pre-wrap', color: '#3fb950' },
			muted: { fontSize: 12, opacity: 0.7, whiteSpace: 'pre-wrap' },
			pre: { fontSize: 12, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace' },
			grey: { opacity: 0.45 },
		};

		function badge(key, ok, t) {
			const label = key === 'protocol' ? (ok ? t('badge.protocol') : t('badge.noProtocol'))
				: key === 'live' ? (ok ? t('badge.live') : t('badge.noLive'))
				: key === 'blocked' ? t('badge.blocked')
				: ok ? t('badge.online') : t('badge.offline');
			return jsx.jsx('span', { style: styles.badge(key === 'blocked' ? false : ok, key === 'protocol' ? !ok : undefined), children: label }, key + String(ok));
		}

		/** Lenient client-side parse of the stored customProfiles JSON. */
		function parseCustomLocal(raw) {
			if (typeof raw !== 'string' || raw.trim() === '') return { list: [], error: null };
			try {
				const parsed = JSON.parse(raw);
				if (!Array.isArray(parsed)) return { list: [], error: 'customProfiles 必须是 JSON 数组' };
				return { list: parsed.filter((e) => e && typeof e === 'object'), error: null };
			} catch (e) {
				return { list: [], error: 'customProfiles 不是合法 JSON：' + e.message };
			}
		}

		function ecosystemOfModel(id) {
			if (/seedance/i.test(id)) return { key: 'volcengine-seedance', tag: 'Seedance 视频', modality: ECOSYSTEM_MODALITIES.seedance };
			if (/seedream/i.test(id)) return { key: 'volcengine-seedance', tag: 'Seedream 图像', modality: ECOSYSTEM_MODALITIES.seedream };
			if (/seed[-_]?tts/i.test(id)) return { key: 'volcengine-seedance', tag: 'Seed TTS', modality: ECOSYSTEM_MODALITIES.seedTts };
			if (/minimax/i.test(id) && /h3/i.test(id)) return { key: 'minimax-h3', tag: 'MiniMax H3', modality: ECOSYSTEM_MODALITIES.minimax };
			if (/^wan[\d.]*-t2v/i.test(id) || /^wan2[\d.]*-i2v/i.test(id)) return { key: 'aliyun-wan', tag: '万相视频', modality: ECOSYSTEM_MODALITIES.wan };
			if (/^wanx[\d.]*-t2i/i.test(id)) return { key: 'aliyun-wan', tag: '万相图像', modality: ECOSYSTEM_MODALITIES.wanx };
			if (/^imagen-[\d.]/i.test(id)) return { key: 'google-gemini', tag: 'Imagen 图像', modality: ECOSYSTEM_MODALITIES.imagen };
			if (/^veo-[\d.]/i.test(id)) return { key: 'google-gemini', tag: 'Veo 视频', modality: ECOSYSTEM_MODALITIES.veo };
			if (/^gpt-image/i.test(id)) return { key: 'openai-media', tag: 'GPT Image', modality: ECOSYSTEM_MODALITIES.gptImage };
			if (/^sora-?\d/i.test(id)) return { key: 'openai-media', tag: 'Sora 视频', modality: ECOSYSTEM_MODALITIES.sora };
			return null;
		}

		// Import-panel media suggestions: DSH providers declare LLM chat models
		// only, so the panel ALSO derives candidates from the built-in presets
		// whose baseUrl equals the provider's baseURL (hub.zgci.org → minimax-h3,
		// bza → Seedance/Seedream/SeedTTS), plus manually added ids. Mirrors the
		// server-side suggestionsForProvider (src/page/providers.ts) — keep the
		// two in sync.
		const BUILTIN_ECO_OF_PROTOCOL = {
			'minimax-video-compatible': 'minimax-h3',
			'volcengine-ark-compatible': 'volcengine-seedance',
			'dashscope-wan-compatible': 'aliyun-wan',
			'google-genmedia-compatible': 'google-gemini',
			'openai-video-compatible': 'openai-media',
			'openai-images-compatible': 'openai-media',
		};
		const normBase = (u) => String(u ?? '').trim().replace(/\/+$/, '').toLowerCase();
		function suggestionsForProvider(prov, builtins, manualIds) {
			const providerBase = normBase(prov.baseURL);
			const matched = builtins.filter((b) => providerBase !== '' && normBase(b.baseUrl) === providerBase);
			const ordered = [];
			const seen = new Set();
			const push = (id, source) => {
				const clean = String(id ?? '').trim();
				if (clean === '' || seen.has(clean)) return;
				seen.add(clean);
				ordered.push({ id: clean, source });
			};
			for (const m of prov.models ?? []) push(typeof m === 'string' ? m : m.id, 'provider');
			for (const b of matched) for (const id of b.models ?? []) push(id, 'preset');
			for (const id of manualIds ?? []) push(id, 'manual');
			const out = [];
			for (const { id } of ordered) {
				let eco = ecosystemOfModel(id);
				if (!eco && matched.length > 0) {
					// Protocol fallback ONLY for ids literally listed by a matched
					// preset — unknown/LLM ids on a preset-matching baseURL must
					// stay unsupported (greyed「暂不支持」), never promoted to media.
					const b = matched.find((x) => (x.models ?? []).includes(id));
					if (b) {
						const key = BUILTIN_ECO_OF_PROTOCOL[b.protocol];
						if (key) {
							const firstModality = (b.modalities ?? [])[0];
							eco = {
								key,
								tag: b.id ?? key,
								modality: ['image', 'audio'].includes(firstModality) ? firstModality : 'video',
							};
						}
					}
				}
				if (eco) out.push({ id, eco });
			}
			return out;
		}

		/** OpenAI-compatible model-list URL for a provider baseURL: a /v1 base
		 * already includes the version segment, anything else gets /v1 appended. */
		function remoteModelsUrl(baseURL) {
			const base = String(baseURL ?? '').trim().replace(/\/+$/, '');
			if (base === '') return null;
			return /\/v\d+$/.test(base) ? base + '/models' : base + '/v1/models';
		}

		/**
		 * Live model list for one provider: GET {baseURL}/v1/models, optional
		 * Bearer token (user-pasted, memory only — never persisted, never a
		 * credential VALUE read from the host). Returns the model ids or null;
		 * every failure mode (network, CORS, auth, odd shape) resolves null so
		 * the panel falls back to the preset suggestions.
		 */
		async function fetchProviderModels(baseURL, token) {
			const url = remoteModelsUrl(baseURL);
			if (url === null || typeof fetch !== 'function') return null;
			try {
				const headers = String(token ?? '').trim() !== '' ? { Authorization: 'Bearer ' + String(token).trim() } : {};
				const answer = await fetch(url, { headers, credentials: 'omit' });
				if (!answer.ok) return null;
				const body = await answer.json();
				const list = Array.isArray(body && body.data) ? body.data
					: Array.isArray(body && body.models) ? body.models
					: Array.isArray(body) ? body : [];
				const ids = list.map((m) => (m && typeof m === 'object' ? m.id : m)).filter((id) => typeof id === 'string' && id !== '');
				return ids.length > 0 ? ids : null;
			} catch { return null; }
		}
		//#endregion

		//#region settings card
		/**
		 * The settings card; shared by all three seats, two views and two form
		 * shapes — the exact host contract dsh-cybernetics implements:
		 *  - view: the host Plugins page renders the folded「内置插件配置」card
		 *    with renderSlot("plugins.item", { view: "summary" }) and opens the
		 *    detail page with renderSlot("plugins.item", { view: "page", form });
		 *    "summary" MUST render a one-line span or the group card flattens.
		 *  - form: on the detail pages the host passes its own ConfigPageForm
		 *    { state, mutate } as an OWNER prop (spreads AFTER inject), which
		 *    shadows the injected live controller (getSnapshot/subscribe/mutate).
		 *    The card must speak both shapes; reading getSnapshot on the host
		 *    shape yields undefined and shows the「通道不可用」state even when
		 *    the channel is healthy.
		 * The write path: host/live mutate first; the plugin's own bound
		 * remote.settings.mutate (directMutate, namespace = the profile entry
		 * id `synthmedia`) is the fallback when the form write refuses.
		 */
		const NO_FORM_SNAP = { status: 'unavailable' };
		const noopSubscribe = () => () => {};
		function SettingsCard(props) {
			const { directMutate, t } = props;
			const view = props.view === 'summary' ? 'summary' : 'page';
			// Baked page data: must be defined BEFORE any hook/useEffect reads it
			// (TDZ fix — the providersRef init below runs at first render, ahead
			// of the old definitions further down).
			const builtins = Array.isArray(PAGE_DATA.builtins) ? PAGE_DATA.builtins : [];
			const providers = Array.isArray(PAGE_DATA.providers) ? PAGE_DATA.providers : [];
			const rawForm = props.form;
			const hostForm = rawForm !== null && typeof rawForm === 'object'
				&& typeof rawForm.mutate === 'function'
				&& rawForm.state !== null && typeof rawForm.state === 'object' ? rawForm : undefined;
			const liveForm = hostForm === undefined && rawForm !== null && typeof rawForm === 'object'
				&& typeof rawForm.getSnapshot === 'function' ? rawForm : undefined;
			const liveSnap = react.useSyncExternalStore(
				liveForm ? (cb) => liveForm.subscribe(cb) : noopSubscribe,
				liveForm ? () => liveForm.getSnapshot() : () => NO_FORM_SNAP,
			);
			const snap = hostForm !== undefined ? hostForm.state : liveSnap;
			const ready = snap !== undefined && snap !== null && snap.status === 'ready';
			const cfg = ready && snap.value && typeof snap.value === 'object' ? snap.value : {};
			const [saving, setSaving] = react.useState(false);
			const [failed, setFailed] = react.useState(false);
			const [note, setNote] = react.useState(null);
			const [checked, setChecked] = react.useState({});
			const [importAuthEnv, setImportAuthEnv] = react.useState('');
			const [manualModels, setManualModels] = react.useState({});
			const [draft, setDraft] = react.useState(null); // custom-editor draft (object) or null
			// Live /v1/models pull state per provider: { ids, error } | undefined.
			// Fetched once per provider when the detail page mounts; failure keeps
			// the preset fallback (fetchProviderModels resolves null → error note).
			const [remoteModels, setRemoteModels] = react.useState({});
			const [importToken, setImportToken] = react.useState('');
			const pullProvider = react.useCallback(async (prov, token) => {
				setRemoteModels((prev) => ({ ...prev, [prov.id]: { ids: [], error: null, loading: true } }));
				const ids = await fetchProviderModels(prov.baseURL, token);
				setRemoteModels((prev) => ({ ...prev, [prov.id]: ids === null
					? { ids: [], error: 'fetch-failed', loading: false }
					: { ids, error: null, loading: false } }));
			}, []);
			const providersRef = react.useRef(null);
			if (providersRef.current === null) providersRef.current = providers;
			react.useEffect(() => {
				for (const prov of providersRef.current) {
					if (typeof prov.baseURL === 'string' && prov.baseURL.trim() !== '') void pullProvider(prov, '');
				}
				// Once per mount; the fetch button re-runs with the optional token.
			}, [pullProvider]);

			const mutateForm = (ops, revision) => {
				if (hostForm !== undefined) return Promise.resolve(hostForm.mutate(ops, revision));
				if (liveForm && typeof liveForm.mutate === 'function') return liveForm.mutate(ops, revision);
				return Promise.resolve(false);
			};
			// Write path (directMutate fix): when the ConfigForm channel is
			// missing (ready=false) the plugin's own remote.settings.mutate is
			// an INDEPENDENT, fully usable write path — it must stay reachable,
			// otherwise import/add are dead buttons with no recovery.
			const canDirect = typeof directMutate === 'function';
			const writeProfiles = (list, okNote) => {
				if (!ready && !canDirect) return;
				setSaving(true); setFailed(false); setNote(null);
				const op = { op: 'set', path: ['customProfiles'], value: JSON.stringify(list, null, 2) };
				const guard = setTimeout(() => { setSaving(false); setFailed(true); }, 15000);
				const viaDirect = () => {
					if (!canDirect) { clearTimeout(guard); setSaving(false); setFailed(true); return; }
					Promise.resolve(directMutate([op]))
						.then((answer) => {
							clearTimeout(guard); setSaving(false);
							if (answer && typeof answer === 'object' && answer.ok === false) setFailed(true);
							else setNote({ ok: true, text: okNote });
						})
						.catch(() => { clearTimeout(guard); setSaving(false); setFailed(true); });
				};
				if (!ready) { viaDirect(); return; }
				Promise.resolve(mutateForm([op], snap.revision))
					.then((accepted) => {
						if (accepted !== false) { clearTimeout(guard); setSaving(false); setNote({ ok: true, text: okNote }); return; }
						viaDirect();
					})
					.catch(() => { clearTimeout(guard); setSaving(false); setFailed(true); });
			};

			const custom = parseCustomLocal(cfg['customProfiles']);

			if (view === 'summary') {
				// Folded「内置插件配置」row: one line — profile count, or the
				// unavailable hint while the channel is not served.
				const n = builtins.length + custom.list.length;
				return jsx.jsx('span', { children: ready ? t('settings.summaryReady', { n: String(n) }) : t('settings.unavailable') });
			}

			const profileRow = (p, isCustom) => jsx.jsxs('tr', { key: p.id + (isCustom ? '#custom' : ''), children: [
				jsx.jsx('td', { style: styles.cell, children: [
					p.id + ' ',
					isCustom ? jsx.jsx('span', { style: styles.badge(true), children: 'custom' }) : null,
					jsx.jsx('br', {}),
					badge('protocol', p.protocolVerified === true, t),
					badge('live', p.liveVerified === true, t),
					badge('online', p.online !== false, t),
					p.blockRealSubmit ? badge('blocked', false, t) : null,
				] }),
				jsx.jsx('td', { style: styles.cell, children: p.protocol }),
				jsx.jsx('td', { style: { ...styles.cell, fontFamily: 'ui-monospace, monospace' }, children: p.baseUrl ?? p.baseURL }),
				jsx.jsx('td', { style: styles.cell, children: (p.models ?? []).join(', ') }),
				jsx.jsx('td', { style: styles.cell, children: p.authEnv ?? '（无需凭据）' }),
				isCustom ? jsx.jsx('td', { style: styles.cell, children: jsx.jsx('button', {
					type: 'button', style: styles.button,
					onClick: () => setDraft({
						...p,
						__editing: true,
						modelsInput: (p.models ?? []).join(','),
						modalitiesInput: (p.modalities ?? []).join(','),
					}),
					children: t('custom.edit'),
				}) }) : jsx.jsx('td', { style: styles.cell }),
			] });

			// Import: group supported models per provider+ecosystem. Candidate
			// sources: (a) suggestionsForProvider — provider-declared ids ∪
			// base-URL preset matches ∪ manual additions (preset fallback kept);
			// (b) LIVE /v1/models ids, classified STRICTLY by id pattern — an
			// id-classifiable remote model joins the supported list with a
			// 'remote' badge, anything else (LLM / embedding / unknown) is
			// greyed「暂不支持」 instead of inheriting the preset's protocol.
			const suggestionsFor = (prov) => {
				const base = suggestionsForProvider(prov, builtins, manualModels[prov.id] ?? []);
				const seen = new Set(base.map((s) => s.id));
				const remoteState = remoteModels[prov.id];
				const remoteExtra = [];
				for (const id of remoteState && remoteState.ids || []) {
					if (seen.has(id)) continue;
					const eco = ecosystemOfModel(id);
					if (!eco) continue;
					seen.add(id);
					remoteExtra.push({ id, eco, source: 'remote' });
				}
				return [...base, ...remoteExtra];
			};
			const unsupportedFor = (prov) => {
				const supported = new Set(suggestionsFor(prov).map((s) => s.id));
				const declared = (prov.models ?? []).map((m) => (typeof m === 'string' ? m : m.id));
				const seen = new Set();
				const out = [];
				for (const id of [...(remoteModels[prov.id] && remoteModels[prov.id].ids || []), ...(manualModels[prov.id] ?? []), ...declared]) {
					if (supported.has(id) || seen.has(id)) continue;
					seen.add(id);
					out.push(id);
				}
				return out;
			};
			const addManual = (provId, raw) => {
				const ids = String(raw ?? '').split(/[,;，；\s]+/).map((s) => s.trim()).filter(Boolean);
				if (ids.length === 0) return;
				// ONE functional state update: appends the ids AND clears the
				// input from the freshest snapshot, so the React batch update can
				// no longer let the stale input-clear overwrite the append.
				setManualModels((prev) => {
					const existing = prev[provId] ?? [];
					return {
						...prev,
						[provId]: [...existing, ...ids.filter((id) => !existing.includes(id))],
						['__input__' + provId]: '',
					};
				});
			};
			const applyImport = () => {
				const picked = [];
				const authEnvFor = (eco) => (importAuthEnv.trim() !== '' ? importAuthEnv.trim() : DEFAULT_AUTH_ENV[eco]);
				for (const prov of providers) {
					const byEco = {};
					for (const s of suggestionsFor(prov)) {
						const eco = s.eco;
						if (!eco || checked[prov.id + '/' + s.id] !== true) continue;
						(byEco[eco.key] = byEco[eco.key] || []).push({ id: s.id, modality: eco.modality });
					}
					for (const [eco, list] of Object.entries(byEco)) {
						const modalities = [...new Set(list.map((m) => m.modality))];
						// openai-media splits by surface: images API vs videos task API.
						const protocol = eco === 'openai-media' && modalities.includes('image') && !modalities.includes('video')
							? 'openai-images-compatible'
							: ECOSYSTEM_PROTOCOL[eco];
						picked.push({
							id: ('dsh-' + prov.id + '-' + eco.replace(/^[a-z]+-/, '')).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''),
							protocol,
							baseUrl: prov.baseURL ?? '',
							authEnv: authEnvFor(eco),
							models: list.map((m) => m.id),
							modalities,
							online: false,
						});
					}
				}
				if (picked.length === 0) { setNote({ ok: false, text: '未勾选任何受支持的模型。' }); return; }
				// baseUrl must be http(s) for the server schema; warn otherwise.
				if (picked.some((p) => !/^https?:\/\//.test(p.baseUrl))) {
					setNote({ ok: false, text: '所选 provider 缺少 http(s) baseURL，无法生成 Profile。' });
					return;
				}
				writeProfiles([...custom.list.filter((p) => !picked.some((q) => q.id === p.id)), ...picked], t('import.applied', { n: picked.length }));
			};

			const submitDraft = (mode) => {
				const d = draft;
				if (!d) return;
				const models = String(d.modelsInput ?? (d.models ?? []).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
				const modalities = String(d.modalitiesInput ?? (d.modalities ?? []).join(',')).split(',').map((s) => s.trim()).filter((s) => ['video', 'image', 'audio'].includes(s));
				const entry = {
					id: String(d.id ?? '').trim().toLowerCase(),
					protocol: d.protocol,
					baseUrl: String(d.baseUrl ?? '').trim().replace(/\/+$/, ''),
					...(String(d.authEnv ?? '').trim() !== '' ? { authEnv: String(d.authEnv).trim() } : {}),
					authStyle: String(d.authEnv ?? '').trim() !== '' ? 'bearer' : 'none',
					models,
					modalities,
					online: d.online !== false,
				};
				if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(entry.id)) { setNote({ ok: false, text: t('custom.invalid', { msg: 'id 必须是 [a-z0-9-] 短横线串' }) }); return; }
				if (!/^https?:\/\//.test(entry.baseUrl)) { setNote({ ok: false, text: t('custom.invalid', { msg: 'Base URL 必须是 http(s)' }) }); return; }
				if (models.length === 0) { setNote({ ok: false, text: t('custom.invalid', { msg: '至少一个模型 id' }) }); return; }
				if (modalities.length === 0) { setNote({ ok: false, text: t('custom.invalid', { msg: '至少一个模态' }) }); return; }
				let list = custom.list.filter((p) => p.id !== entry.id);
				if (mode !== 'delete') list = [...list, entry];
				writeProfiles(list, mode === 'delete' ? entry.id + ' 已删除' : entry.id + ' 已保存');
				setDraft(null);
			};

			const draftField = (label, key, opts = {}) => jsx.jsxs('div', { style: styles.row, children: [
				jsx.jsx('span', { style: { ...styles.desc, minWidth: 130 }, children: label }),
				opts.choices
					? jsx.jsx('select', { style: styles.input, value: draft[key] ?? '', onChange: (e) => setDraft({ ...draft, [key]: e.target.value }), children: opts.choices.map((c) => jsx.jsx('option', { value: c, children: c }, c)) })
					: jsx.jsx('input', { style: { ...styles.input, minWidth: 260 }, type: opts.bool ? 'checkbox' : 'text', ...(opts.bool ? { checked: draft[key] !== false } : { value: draft[key] ?? '' }), onChange: (e) => setDraft({ ...draft, [key]: opts.bool ? e.target.checked : e.target.value }) }),
			] }, key);

			return jsx.jsxs('div', { style: styles.card, children: [
				jsx.jsxs('div', { style: styles.section, children: [
					jsx.jsx('div', { style: styles.title, children: t('settings.title') }),
					jsx.jsx('div', { style: styles.desc, children: t('settings.description') }),
				] }),
				jsx.jsxs('div', { style: styles.section, children: [
					jsx.jsx('div', { style: styles.title, children: t('section.profiles') }),
					jsx.jsx('div', { style: styles.desc, children: t('section.profilesDesc') }),
					ready ? jsx.jsx('table', { style: styles.table, children: [
						jsx.jsx('thead', { children: jsx.jsxs('tr', { children: [
							['Profile', 'Protocol', 'Base URL', 'Models', '凭据环境变量名', ''].map((h, i) => jsx.jsx('th', { style: styles.cell, children: h }, 'h' + i)),
						] }) }),
						jsx.jsx('tbody', { children: [...builtins.map((p) => profileRow(p, false)), ...custom.list.map((p) => profileRow(p, true))] }),
					] }) : jsx.jsx('div', { style: styles.muted, children: t('settings.unavailable') }),
					custom.error ? jsx.jsx('div', { style: styles.note, children: t('corrupt', { msg: custom.error }) }) : null,
				] }),
				jsx.jsxs('div', { style: styles.section, children: [
					jsx.jsx('div', { style: styles.title, children: t('section.import') }),
					jsx.jsx('div', { style: styles.desc, children: t('section.importDesc') }),
					providers.length === 0
						? jsx.jsx('div', { style: styles.muted, children: t('import.none') })
						: jsx.jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 }, children: [
							jsx.jsx('div', { style: styles.desc, children: t('import.manualHint') }),
						jsx.jsxs('div', { style: styles.row, children: [
							jsx.jsx('span', { style: styles.desc, children: t('import.tokenLabel') }),
							jsx.jsx('input', {
								type: 'password', style: { ...styles.input, minWidth: 220 },
								value: importToken, placeholder: t('import.tokenPlaceholder'),
								onChange: (e) => setImportToken(e.target.value),
							}),
							...providers.map((prov) => typeof prov.baseURL === 'string' && prov.baseURL.trim() !== ''
								? jsx.jsx('button', {
									type: 'button', style: styles.button,
									disabled: remoteModels[prov.id] !== undefined && remoteModels[prov.id].loading === true,
									onClick: () => void pullProvider(prov, importToken),
									children: remoteModels[prov.id] !== undefined && remoteModels[prov.id].loading === true
										? t('import.fetching') : t('import.fetch') + ' · ' + (prov.displayName ?? prov.id),
								}, 'fetch:' + prov.id)
								: []),
						] }),
							...providers.map((prov) => {
								const suggestions = suggestionsFor(prov);
								const remoteState = remoteModels[prov.id];
								const unsupported = unsupportedFor(prov);
								return jsx.jsxs('div', { style: { ...styles.section, marginLeft: 8 }, children: [
									jsx.jsxs('div', { style: styles.desc, children: [
										(prov.displayName ?? prov.id) + ' · ' + (prov.baseURL ?? ''),
										remoteState && remoteState.loading !== true && remoteState.error === null && remoteState.ids.length > 0
											? ' · ' + t('import.fetchOk', { n: String(remoteState.ids.length) })
											: null,
										remoteState && remoteState.loading !== true && remoteState.error !== null
											? jsx.jsx('span', { style: { ...styles.desc, color: '#d29922' }, children: ' · ' + t('import.fetchFailed') }) : null,
									] }),
									suggestions.length === 0
										? jsx.jsx('div', { style: { ...styles.muted, marginLeft: 8 }, children: '（未发现受支持的媒体模型；可手动补充）' })
										: jsx.jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 }, children: suggestions.map((s) => {
											const key = prov.id + '/' + s.id;
											return jsx.jsxs('label', { style: styles.row, children: [
												jsx.jsx('input', { type: 'checkbox', checked: checked[key] === true, onChange: (e) => setChecked({ ...checked, [key]: e.target.checked }) }),
												jsx.jsx('code', { children: s.id }),
												jsx.jsx('span', { style: styles.badge(true), children: s.eco.tag }),
												s.source === 'provider' ? null : jsx.jsx('span', { style: styles.badge(s.source === 'preset'), children: s.source === 'preset' ? 'preset' : (remoteState && remoteState.ids.includes(s.id) ? 'remote' : 'manual') }),
											] }, key);
										}) }),
									unsupported.length > 0 ? jsx.jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, marginLeft: 8 }, children: [
										jsx.jsx('div', { style: { ...styles.desc, color: '#8b949e' }, children: t('import.unsupportedHeader') + '（' + unsupported.length + '）' }),
										jsx.jsx('div', { style: { ...styles.grey, fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: 4 }, children: unsupported.map((id) => jsx.jsxs('span', { style: styles.row, children: [jsx.jsx('code', { children: id }), ' ' + t('import.unsupported')] }, id)) }),
									] }, 'unsupported:' + prov.id) : null,
									jsx.jsxs('div', { style: styles.row, children: [
										jsx.jsx('input', {
											style: { ...styles.input, minWidth: 220 },
											value: (manualModels['__input__' + prov.id] ?? ''),
											placeholder: t('import.manualPlaceholder'),
											onChange: (e) => setManualModels({ ...manualModels, ['__input__' + prov.id]: e.target.value }),
										}),
										jsx.jsx('button', {
											type: 'button', style: styles.button,
											onClick: () => addManual(prov.id, manualModels['__input__' + prov.id]),
											children: t('import.manualAdd'),
										}),
									] }, 'manual:' + prov.id),
								] }, prov.id);
							}),
						] }),
					providers.length > 0 ? jsx.jsxs('div', { style: styles.row, children: [
						jsx.jsx('span', { style: styles.desc, children: t('import.authEnv') }),
						jsx.jsx('input', { style: { ...styles.input, minWidth: 220 }, value: importAuthEnv, onChange: (e) => setImportAuthEnv(e.target.value), placeholder: DEFAULT_AUTH_ENV['volcengine-seedance'] + ' / ' + DEFAULT_AUTH_ENV['minimax-h3'] }),
						jsx.jsx('button', { type: 'button', style: styles.button, disabled: (!ready && !canDirect) || saving, onClick: applyImport, children: t('import.apply') }),
					] }) : null,
				] }),
				jsx.jsxs('div', { style: styles.section, children: [
					jsx.jsx('div', { style: styles.title, children: t('section.custom') }),
					jsx.jsx('div', { style: styles.desc, children: t('section.customDesc') }),
					draft === null
						? jsx.jsx('button', { type: 'button', style: styles.button, disabled: (!ready && !canDirect), onClick: () => setDraft({ id: '', protocol: 'openai-video-compatible', baseUrl: '', authEnv: '', modelsInput: '', modalitiesInput: 'video', online: false }), children: t('custom.add') })
						: jsx.jsxs('div', { style: { ...styles.card, borderStyle: 'dashed' }, children: [
							draftField(t('custom.field.id'), 'id'),
							draftField(t('custom.field.protocol'), 'protocol', { choices: PROTOCOL_OPTIONS }),
							draftField(t('custom.field.baseUrl'), 'baseUrl'),
							draftField(t('custom.field.authEnv'), 'authEnv'),
							draftField(t('custom.field.models'), 'modelsInput'),
							draftField(t('custom.field.modalities'), 'modalitiesInput'),
							draftField(t('custom.field.online'), 'online', { bool: true }),
							jsx.jsxs('div', { style: styles.row, children: [
								draft.__editing
									? jsx.jsx('button', { type: 'button', style: styles.button, onClick: () => submitDraft('update'), children: t('custom.update') })
									: jsx.jsx('button', { type: 'button', style: styles.button, onClick: () => submitDraft('add'), children: t('custom.add') }),
								jsx.jsx('button', { type: 'button', style: { ...styles.button, color: '#f85149' }, onClick: () => submitDraft('delete'), children: t('custom.delete') }),
								jsx.jsx('button', { type: 'button', style: styles.button, onClick: () => setDraft(null), children: '×' }),
							] }),
						] }),
					custom.list.length === 0 ? jsx.jsx('div', { style: styles.muted, children: t('custom.empty') }) : null,
				] }),
				note !== null ? jsx.jsx('div', { style: note.ok ? styles.good : styles.note, children: note.text }) : null,
				saving ? jsx.jsx('div', { style: styles.muted, children: t('settings.saving') }) : null,
				failed ? jsx.jsx('div', { style: styles.note, children: t('settings.saveFailed') }) : null,
			] });
		}
		//#endregion

		//#region conversation tab (live data via /synthmedia command)
		const VERDICT_STYLE = { '充足': '#3fb950', '勉强': '#d29922', '不足': '#f85149' };

		function MediaView(props) {
			const { sessionId, execute, t } = props;
			const [snapshot, setSnapshot] = react.useState(null);
			const [detectText, setDetectText] = react.useState(null);
			const [assessment, setAssessment] = react.useState(null);
			const [busy, setBusy] = react.useState('');
			const [error, setError] = react.useState(null);

			const run = react.useCallback(async (line) => {
				if (typeof execute !== 'function') { setError(t('view.needsSession')); return null; }
				try {
					const outcome = await execute(sessionId, line);
					if (outcome && outcome.ok === false) throw new Error(outcome.error && outcome.error.message ? outcome.error.message : 'transport error');
					const result = outcome && outcome.value ? outcome.value.result : outcome;
					if (result && result.kind === 'error') throw new Error(result.text ?? 'command error');
					return result ?? null;
				} catch (e) { setError(String(e.message ?? e)); return null; }
			}, [execute, sessionId]);

			const loadSnapshot = react.useCallback(async () => {
				setBusy('load');
				const result = await run('/synthmedia json');
				setBusy('');
				if (result && result.json) setSnapshot(result.json);
			}, [run]);

			react.useEffect(() => { if (typeof execute === 'function') void loadSnapshot(); }, [execute, loadSnapshot]);

			// Poll downloads while any is running.
			react.useEffect(() => {
				const list = snapshot && Array.isArray(snapshot.downloads) ? snapshot.downloads : [];
				if (!list.some((d) => d.status === 'running')) return undefined;
				const timer = setInterval(() => { void loadSnapshot(); }, 3000);
				return () => clearInterval(timer);
			}, [snapshot, loadSnapshot]);

			const detect = async () => {
				setBusy('detect'); setDetectText(null); setAssessment(null);
				const result = await run('/synthmedia detect');
				setBusy('');
				if (result) { setDetectText(result.text ?? ''); setAssessment(result.json && result.json.assessment ? result.json.assessment : null); }
			};
			const dlAction = async (verb, id) => {
				setBusy('dl:' + id + verb);
				await run('/synthmedia dl ' + verb + (id ? ' ' + id : ''));
				setBusy('');
				await loadSnapshot();
			};

			const verdictColor = (v) => VERDICT_STYLE[v] ?? '#8b949e';
			const downloads = snapshot && Array.isArray(snapshot.downloads) ? snapshot.downloads : [];
			const manifestEntries = snapshot && snapshot.downloadManifest && Array.isArray(snapshot.downloadManifest.entries) ? snapshot.downloadManifest.entries : [];

			return jsx.jsxs('div', { style: { ...styles.card, margin: 12 }, children: [
				jsx.jsx('div', { style: styles.title, children: t('view.tab') + ' — ' + t('view.description') }),
				error ? jsx.jsx('div', { style: styles.note, children: error }) : null,
				jsx.jsxs('div', { style: styles.row, children: [
					jsx.jsx('button', { type: 'button', style: styles.button, onClick: () => void loadSnapshot(), disabled: busy === 'load', children: busy === 'load' ? t('view.loading') : t('view.refresh') }),
					jsx.jsx('button', { type: 'button', style: styles.button, onClick: () => void detect(), disabled: busy === 'detect' || typeof execute !== 'function', children: busy === 'detect' ? t('view.detecting') : t('view.detect') }),
				] }),
				assessment ? jsx.jsxs('div', { style: styles.section, children: [
					jsx.jsxs('div', { style: styles.row, children: [
						jsx.jsx('span', { style: styles.title, children: t('view.verdict') + '：' }),
						jsx.jsx('span', { style: { ...styles.title, color: verdictColor(assessment.overall) }, children: assessment.overall }),
					] }),
					jsx.jsx('div', { style: styles.pre, children: (assessment.dimensions ?? []).map((d) => `${d.dimension}：${d.value} → ${d.verdict}`).join('\n') }),
				] }) : null,
				detectText ? jsx.jsx('div', { style: styles.pre, children: detectText }) : null,
				snapshot ? jsx.jsxs('div', { style: styles.section, children: [
					jsx.jsx('div', { style: styles.title, children: t('view.profiles') + `（${snapshot.profiles.length}）` }),
					jsx.jsx('div', { style: styles.pre, children: snapshot.profiles.map((p) => `${p.id} [${p.source}] ${p.protocol} ${p.baseUrl} 模型=[${p.models.join(', ')}] 凭据env=${p.authEnv ?? '无'} 协议${p.protocolVerified ? '✓' : '✗'}/实测${p.liveVerified ? '✓' : '✗'}${p.blockRealSubmit ? ' 已封锁' : ''}`).join('\n') }),
					snapshot.customProfilesError ? jsx.jsx('div', { style: styles.note, children: snapshot.customProfilesError }) : null,
				] }) : null,
				jsx.jsxs('div', { style: styles.section, children: [
					jsx.jsx('div', { style: styles.title, children: t('view.dl') }),
					manifestEntries.length === 0
						? jsx.jsx('div', { style: styles.muted, children: '下载清单为空（配置 dataDir 后自动生成默认 H3 清单）。' })
						: jsx.jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 }, children: manifestEntries.map((e) => {
							const prog = downloads.find((d) => d.id === e.id);
							const st = prog && prog.status !== undefined ? prog : { id: e.id, name: e.name, status: 'idle' };
							return jsx.jsxs('div', { style: styles.row, children: [
								jsx.jsx('code', { children: st.id }),
								jsx.jsx('span', { style: styles.desc, children: st.name }),
								prog && prog.status === 'running'
									? jsx.jsxs('span', { style: styles.desc, children: [
										(prog.percent !== undefined ? prog.percent + '%' : ''),
										' ' + Math.round((prog.downloadedBytes ?? 0) / 1024 / 1024) + ' MiB',
										prog.speedBps ? ' ' + (prog.speedBps / 1024 / 1024).toFixed(1) + ' MiB/s' : '',
										prog.etaSeconds !== undefined ? ' 剩余' + prog.etaSeconds + 's' : '',
										' ' + t('view.dlRunning'),
									] }) : null,
								prog && prog.error ? jsx.jsx('span', { style: styles.note, children: prog.error }) : null,
								/^https?:\/\//.test(String(e.url ?? ''))
									? (prog && prog.status === 'running'
										? jsx.jsx('button', { type: 'button', style: styles.button, onClick: () => void dlAction('cancel', st.id), children: t('view.dlCancel') })
										: jsx.jsx('button', { type: 'button', style: styles.button, onClick: () => void dlAction('start', st.id), children: t('view.dlStart') }))
									: jsx.jsx('span', { style: styles.grey, children: t('view.dlUrlPending') }),
							] }, st.id);
						}) }),
					jsx.jsx('div', { style: styles.muted, children: '下载目标：' + (snapshot.downloadManifest ? snapshot.downloadManifest.downloadsDir : '—') }),
				] }),
			] });
		}

		// Settings-channel namespace = the PROFILE ENTRY id (the host settings
		// service keys forms by `entry.options.id`, and the Plugins page's
		// ItemDetail derives its form via formFor(item.id) matching the served
		// namespace). Our bundle patch declares `- id: synthmedia`, so every
		// binding below must use 'synthmedia' — NOT the package manifest name.
		// Same convention dsh-cybernetics ships (its entry id IS 'dsh-cybernetics').
		const SETTINGS_ENTRY_ID = 'synthmedia';
		// v1.0.1 boot-gate fix: the client runner enforces an inject-declared
		// access guard — every namespace apply reads (slots / locale /
		// configForms / remote.*) MUST be declared here, or the read is refused
		// and the entry fiber never reaches active (the shell boot gate then
		// fails the whole page with "web boot: N entries did not activate").
		// Same convention dsh-cybernetics ships. All reads stay runtime-guarded
		// so an absent namespace degrades the feature, never the activation;
		// apply itself stays fully synchronous (zero awaits on the activation
		// path), so the module activates immediately.
		const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.settings', 'remote.commands'];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-synthmedia: dictionaries');
			const t = ctx.locale.bind(NS);

			let settingsForm;
			try { settingsForm = ctx.configForms.get(SETTINGS_ENTRY_ID); } catch { settingsForm = undefined; }
			let settingsDirectMutate;
			try {
				if (ctx.remote && ctx.remote.settings && typeof ctx.remote.settings.mutate === 'function') {
					settingsDirectMutate = (ops, expectedRevision) => ctx.remote.settings.mutate(SETTINGS_ENTRY_ID, ops, expectedRevision);
				}
			} catch { settingsDirectMutate = undefined; }
			const settingsInject = () => ({ form: settingsForm, directMutate: settingsDirectMutate });

			// Plugins-page settings card — the same three seats cybernetics uses.
			// plugins.item id MUST equal SETTINGS_ENTRY_ID: the host ItemCard
			// folds the row from this slot and ItemDetail opens view "page" for
			// item.id, computing its ConfigPageForm only when the served settings
			// namespaces contain item.id.
			try {
				ctx.effect(() => ctx.slots.inject('plugins.item', () => ctx.slots.register({
				name: 'plugins.item',
				id: SETTINGS_ENTRY_ID,
				order: 80,
				label: () => t('settings.cardLabel'),
				locale: NS,
				inject: settingsInject,
			}, SettingsCard)), 'dsh-synthmedia: plugins-page settings card');
			} catch { /* absent slots namespace degrades the card, never the activation */ }
			for (const bundleKey of ['dsh-synthmedia']) {
				try {
					ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
					name: 'plugins.row.config',
					key: bundleKey + '#' + SETTINGS_ENTRY_ID,
					locale: NS,
					inject: settingsInject,
				}, SettingsCard));
				ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
					name: 'plugins.bundle.config',
					key: bundleKey,
					locale: NS,
					inject: settingsInject,
				}, SettingsCard));
				} catch { /* absent slots namespace degrades the card, never the activation */ }
			}

			// Conversation tab: live data via the /synthmedia command transport.
			try {
			ctx.slots.inject('conversation.view', () => ctx.slots.register({
				name: 'conversation.view',
				id: 'synthmedia',
				order: 18,
				locale: NS,
				label: () => t('view.tab'),
				inject: (sessionId) => {
					let execute;
					try {
						if (ctx.remote && ctx.remote.commands && typeof ctx.remote.commands.execute === 'function') {
							execute = (sid, line) => ctx.remote.commands.execute(sid, line, []);
						}
					} catch { execute = undefined; }
					return { sessionId, execute };
				},
			}, MediaView));
			} catch { /* absent slots namespace degrades the tab, never the activation */ }
		}

		module.exports = { name: 'dsh-synthmedia', inject, apply };
		return module.exports;
	},
});
