// dsh-synthmedia client module: the「SynthMedia」settings card on the Plugins
// page (plugins.item / plugins.row.config / plugins.bundle.config seats — the
// exact mechanism @mars.liu/dsh-cybernetics uses) plus a「媒体服务」
// conversation tab that reaches the server half through the /synthmedia
// command transport for live data (real profile set, system detection,
// download progress).
//
// Settings-card information architecture (phase two, single card, one column,
// fixed section order):
//   ① Overview    — read-only status strip + parse warnings (no actions);
//   ② Sources     — a) DSH subscription resources (checkboxes →
//                    enabledDshResources "providerId::modelId" +「应用勾选」
//                    generating custom-profile drafts), b) self-built media
//                    providers (id/protocol/baseURL/authEnv/models/modalities/
//                    online → customProfiles, edit/delete/test);
//   ③ Priority    — one global ordered list (up/down/top → providerOrder);
//                   display order + per-modality DEFAULT only, never an
//                   automatic fallback;
//   ④ Ecosystems  — h3 + seedance cards, everything else collapsed under
//                   「未支持（仍可显式调用）」; display only;
//   ⑤ Toolchain   — ffmpeg/imagemagick/gimp/blender checkboxes → enabledTools,
//                   probe status + one-line install hint;
//   ⑥ Advanced    — outputDir/dataDir/providersPatchPath/defaultTimeoutMs,
//                   collapsed.
// Consistency: one Section component (title + one-line desc + optional
// action + content), one Row component (name + mono meta + status badge +
// right-aligned actions), and ONE write model: local draft overrides → a
// single「保存并生效」button commits ONLY the dirty fields as one mutate
// batch (host ConfigForm first, the plugin's own remote.settings.mutate —
// directMutate — as the independent fallback when no ConfigForm exists).
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
			'settings.description': '六节式配置页：概览 / 资源来源 / 优先级 / 生态 / 工具链 / 高级。修改先入草稿，由「保存并生效」一次性提交；凭据只保存环境变量名，永不保存密钥值。',
			'settings.cardLabel': 'SynthMedia 配置',
			'settings.summaryReady': '{n} 个 ProviderProfile 生效中',
			'settings.unavailable': '设置通道不可用（宿主未提供该插件的 ConfigForm）。重启宿主后重试。',
			'settings.saving': '保存中…',
			'settings.saveFailed': '保存失败，请重试。',
			'settings.saved': '已保存并生效。',
			'settings.save': '保存并生效',
			'settings.saveDirty': '有 {n} 项未保存的修改，离开页面前请保存。',
			'section.overview': '概览',
			'section.overviewDesc': '当前生效配置一览（纯状态，无操作）。',
			'section.sources': '资源来源',
			'section.sourcesDesc': 'DSH 订阅账户资源勾选与自建影像 Provider 管理；修改先入草稿，统一由「保存并生效」提交。',
			'section.priority': '优先级',
			'section.priorityDesc': '生成时仍需显式指定 backend；此顺序只决定各模态「默认」profile 与展示顺序，不会自动 fallback。靠前优先。',
			'section.ecosystems': '生态',
			'section.ecosystemsDesc': '当前先支持 H3 与 Seedance 两个生态；其余生态不参与默认路由，仍可通过显式 backend id 调用。',
			'section.toolchain': '工具链',
			'section.toolchainDesc': '勾选后插件才探测并使用对应本地工具；未勾选的不探测（与后端一致）。',
			'section.advanced': '高级',
			'section.advancedDesc': '目录、补丁路径与超时；改动保存后随插件重载生效。',
			'overview.profiles': '生效 Profile',
			'overview.defaults': '各模态默认',
			'overview.noDefault': '（无）',
			'overview.h3': '离线 H3 判定',
			'overview.h3Unknown': '未检测（到会话「媒体服务」页运行检测获取）',
			'overview.toolsReady': '工具链就绪',
			'overview.warnings': '解析告警',
			'sources.dsh': 'DSH 订阅账户',
			'sources.dshDesc': '勾选要暴露给 SynthMedia 的媒体资源（写入 enabledDshResources，元素形如 "providerId::modelId"）。仅 H3 / Seedance 生态可勾选，其余整行置灰「暂不支持」；勾选后点「应用勾选」生成自定义 Profile 草稿。',
			'sources.custom': '自建 Provider（影像专用）',
			'sources.customDesc': '新建 SynthMedia 专用 Profile（id、协议、baseURL、凭据环境变量名、模型 id、模态、在线开关）；写入 customProfiles。凭据只保存环境变量名。',
			'badge.protocol': '协议✓', 'badge.noProtocol': '协议✗', 'badge.live': '实测✓', 'badge.noLive': '实测✗',
			'badge.blocked': '已封锁', 'badge.offline': '离线', 'badge.online': '在线',
			'badge.supported': '支持', 'badge.unsupported': '暂不支持', 'badge.default': '默认', 'badge.custom': 'custom',
			'import.apply': '应用勾选（生成 Profile 草稿）',
			'import.authEnv': '凭据环境变量名',
			'import.none': '（构建时未发现 DSH providers 数据；可在会话「媒体服务」页用 /synthmedia providers 查看实时清单）',
			'import.unsupported': '暂不支持',
			'import.manualHint': 'DSH providers 只声明 LLM 聊天模型；打开配置页时会尝试 GET {baseURL}/v1/models 动态拉取真实模型清单（可选 Bearer token，仅内存），拉取失败回退为按 baseURL 匹配内置 preset 推荐媒体模型，也可手动补充模型 id。',
			'import.manualPlaceholder': '手动补充模型 id',
			'import.manualAdd': '补充',
			'import.appliedDraft': '已生成 {n} 个自定义 Profile 草稿，点「保存并生效」后提交。',
			'import.tokenLabel': 'Bearer token（可选，仅本次内存使用，不保存）',
			'import.tokenPlaceholder': '留空 = 匿名拉取',
			'import.fetch': '拉取模型', 'import.fetching': '拉取中…',
			'import.fetchOk': '已拉取 {n} 个模型',
			'import.fetchFailed': '动态拉取失败（网络/CORS/鉴权），已回退为内置 preset 建议。',
			'import.unsupportedHeader': '暂不支持（非媒体 LLM / 未支持生态，均不可勾选）',
			'priority.top': '置顶', 'priority.up': '上移', 'priority.down': '下移',
			'priority.default': '默认',
			'priority.rank': '优先级第 {n} 位',
			'priority.empty': '暂无 Profile。',
			'eco.h3': 'MiniMax H3', 'eco.seedance': '火山 Seedance',
			'eco.families.h3': '模型家族：minimax-h3（video）',
			'eco.families.seedance': '模型家族：doubao-seedance（video）/ doubao-seedream（image）/ seed-tts（audio）',
			'eco.profiles': '当前 Profile 数',
			'eco.defaultHit': '默认命中：是',
			'eco.defaultMiss': '默认命中：否',
			'eco.unsupportedHeader': '未支持（仍可显式调用）',
			'tool.installed': '已装', 'tool.missing': '未装',
			'tool.notProbed': '未勾选（不探测）',
			'custom.add': '添加', 'custom.update': '保存修改', 'custom.delete': '删除', 'custom.edit': '编辑',
			'custom.confirmDelete': '确认删除？',
			'custom.deleted': '{id} 已从草稿移除，点「保存并生效」后提交。',
			'custom.savedDraft': '{id} 已写入草稿，点「保存并生效」后提交。',
			'custom.test': '测试连接', 'custom.testing': '测试中…',
			'custom.testOk': '可达 · {n} 个模型',
			'custom.testFail': '不可达（网络/CORS/鉴权）',
			'custom.field.id': 'Profile id', 'custom.field.protocol': '协议',
			'custom.field.baseUrl': 'Base URL', 'custom.field.authEnv': '凭据环境变量名',
			'custom.field.models': '模型 id（逗号分隔）', 'custom.field.modalities': '模态（逗号分隔 video/image/audio）',
			'custom.field.online': '在线（可发起真实调用）',
			'custom.invalid': '表单校验失败：{msg}',
			'custom.empty': '暂无自定义 Profile。',
			'advanced.outputDir': 'outputDir',
			'advanced.dataDir': 'dataDir',
			'advanced.providersPatchPath': 'providersPatchPath',
			'advanced.defaultTimeoutMs': 'defaultTimeoutMs（毫秒）',
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
			'settings.description': 'Six-section settings page: Overview / Sources / Priority / Ecosystems / Toolchain / Advanced. Edits stay in a local draft; one「Save & apply」button commits them. Credentials are stored as env-var NAMES only, never values.',
			'settings.cardLabel': 'SynthMedia settings',
			'settings.summaryReady': '{n} provider profile(s) effective',
			'settings.unavailable': 'Settings transport unavailable (host does not serve this plugin ConfigForm yet). Restart the host and retry.',
			'settings.saving': 'Saving…',
			'settings.saveFailed': 'Save failed, please retry.',
			'settings.saved': 'Saved and applied.',
			'settings.save': 'Save & apply',
			'settings.saveDirty': '{n} unsaved change(s) — save before leaving this page.',
			'section.overview': 'Overview',
			'section.overviewDesc': 'Read-only snapshot of the effective configuration (status only, no actions).',
			'section.sources': 'Sources',
			'section.sourcesDesc': 'DSH subscription resources and self-built media providers; edits stay in the draft and are committed by「Save & apply」.',
			'section.priority': 'Priority',
			'section.priorityDesc': 'Generation still takes an explicit backend; this order only picks each modality\'s DEFAULT profile and the display order — never an automatic fallback. Earlier wins.',
			'section.ecosystems': 'Ecosystems',
			'section.ecosystemsDesc': 'Currently H3 and Seedance are supported; other ecosystems never become the default but remain callable via an explicit backend id.',
			'section.toolchain': 'Toolchain',
			'section.toolchainDesc': 'Only checked tools are probed and used by the plugin; unchecked ones are never probed (matches the backend).',
			'section.advanced': 'Advanced',
			'section.advancedDesc': 'Directories, patch path and timeout; saved changes take effect with the plugin reload.',
			'overview.profiles': 'Effective profiles',
			'overview.defaults': 'Default per modality',
			'overview.noDefault': '(none)',
			'overview.h3': 'Offline H3 verdict',
			'overview.h3Unknown': 'Not detected (run detection on the「Media」session tab)',
			'overview.toolsReady': 'Toolchain ready',
			'overview.warnings': 'Parse warnings',
			'sources.dsh': 'DSH subscription account',
			'sources.dshDesc': 'Check media resources to expose to SynthMedia (writes enabledDshResources, entries shaped "providerId::modelId"). Only H3 / Seedance ecosystems are checkable; everything else is greyed out; then press「Apply selection」to generate custom-profile drafts.',
			'sources.custom': 'Self-built provider (media only)',
			'sources.customDesc': 'Create SynthMedia-specific profiles (id, protocol, baseURL, credential env-var name, model ids, modalities, online switch); writes customProfiles. Credentials are stored as env-var names only.',
			'badge.protocol': 'proto✓', 'badge.noProtocol': 'proto✗', 'badge.live': 'live✓', 'badge.noLive': 'live✗',
			'badge.blocked': 'blocked', 'badge.offline': 'offline', 'badge.online': 'online',
			'badge.supported': 'supported', 'badge.unsupported': 'unsupported', 'badge.default': 'default', 'badge.custom': 'custom',
			'import.apply': 'Apply selection (generates profile drafts)',
			'import.authEnv': 'Credential env var name',
			'import.none': '(No DSH-provider snapshot baked at build time; use /synthmedia providers in the session tab for live data)',
			'import.unsupported': 'unsupported',
			'import.manualHint': 'DSH providers declare LLM chat models only; opening the page tries GET {baseURL}/v1/models for the live model list (optional Bearer token, memory only). On failure it falls back to baseURL-matched built-in preset suggestions, and model ids can always be added manually.',
			'import.manualPlaceholder': 'Add a model id manually',
			'import.manualAdd': 'Add',
			'import.appliedDraft': 'Generated {n} custom profile draft(s); press「Save & apply」to commit.',
			'import.tokenLabel': 'Bearer token (optional, memory only, never stored)',
			'import.tokenPlaceholder': 'empty = anonymous fetch',
			'import.fetch': 'Fetch models', 'import.fetching': 'Fetching…',
			'import.fetchOk': 'Fetched {n} model(s)',
			'import.fetchFailed': 'Live fetch failed (network/CORS/auth); fell back to built-in preset suggestions.',
			'import.unsupportedHeader': 'Unsupported (non-media LLM / unsupported ecosystems — not checkable)',
			'priority.top': 'Top', 'priority.up': 'Up', 'priority.down': 'Down',
			'priority.default': 'default',
			'priority.rank': 'rank #{n}',
			'priority.empty': 'No profiles yet.',
			'eco.h3': 'MiniMax H3', 'eco.seedance': 'Volcengine Seedance',
			'eco.families.h3': 'Model families: minimax-h3 (video)',
			'eco.families.seedance': 'Model families: doubao-seedance (video) / doubao-seedream (image) / seed-tts (audio)',
			'eco.profiles': 'Profiles',
			'eco.defaultHit': 'Default hit: yes',
			'eco.defaultMiss': 'Default hit: no',
			'eco.unsupportedHeader': 'Unsupported (still explicitly callable)',
			'tool.installed': 'installed', 'tool.missing': 'missing',
			'tool.notProbed': 'unchecked (not probed)',
			'custom.add': 'Add', 'custom.update': 'Save changes', 'custom.delete': 'Delete', 'custom.edit': 'Edit',
			'custom.confirmDelete': 'Confirm delete?',
			'custom.deleted': '{id} removed from the draft; press「Save & apply」to commit.',
			'custom.savedDraft': '{id} written to the draft; press「Save & apply」to commit.',
			'custom.test': 'Test connection', 'custom.testing': 'Testing…',
			'custom.testOk': 'reachable · {n} model(s)',
			'custom.testFail': 'unreachable (network/CORS/auth)',
			'custom.field.id': 'Profile id', 'custom.field.protocol': 'Protocol',
			'custom.field.baseUrl': 'Base URL', 'custom.field.authEnv': 'Credential env var name',
			'custom.field.models': 'Model ids (comma separated)', 'custom.field.modalities': 'Modalities (video/image/audio)',
			'custom.field.online': 'Online (real submissions allowed)',
			'custom.invalid': 'Form invalid: {msg}',
			'custom.empty': 'No custom profiles yet.',
			'advanced.outputDir': 'outputDir',
			'advanced.dataDir': 'dataDir',
			'advanced.providersPatchPath': 'providersPatchPath',
			'advanced.defaultTimeoutMs': 'defaultTimeoutMs (ms)',
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
		// Phase-two supported set: mirrors src/page/ecosystems.ts
		// SUPPORTED_ECOSYSTEMS = ['h3', 'seedance'] — everything else is greyed.
		const SUPPORTED_ECO_KEYS = { 'minimax-h3': 'h3', 'volcengine-seedance': 'seedance' };
		const TOOL_NAMES = ['ffmpeg', 'imagemagick', 'gimp', 'blender'];
		//#region tiny view helpers

		const styles = {
			card: { padding: 14, borderRadius: 10, border: '1px solid var(--dsh-border, #30363d)', display: 'flex', flexDirection: 'column', gap: 12 },
			section: { display: 'flex', flexDirection: 'column', gap: 6 },
			sectionHead: { display: 'flex', gap: 8, alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' },
			title: { fontSize: 13, fontWeight: 600 },
			desc: { fontSize: 12, opacity: 0.75, lineHeight: 1.5 },
			row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
			rowItem: { display: 'flex', gap: 8, alignItems: 'center', padding: '6px 8px', borderRadius: 8, border: '1px solid var(--dsh-border, #21262d)' },
			meta: { fontSize: 11, opacity: 0.7, fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' },
			input: { padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsh-border, #30363d)', background: 'transparent', color: 'inherit', fontSize: 12 },
			button: { padding: '4px 10px', borderRadius: 6, border: '1px solid var(--dsh-border, #30363d)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 },
			saveBar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--dsh-border, #30363d)', paddingTop: 10 },
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

		/** Status badge with a literal label (eco / default / supported…). */
		function tagBadge(label, ok) {
			return jsx.jsx('span', { style: styles.badge(ok !== false), children: label }, 'tag:' + label);
		}

		/** Uniform Section: title + one-line desc + optional right action + content. */
		function Section({ id, title, desc, action, children }) {
			return jsx.jsxs('div', { 'data-section': id, style: styles.section, children: [
				jsx.jsxs('div', { style: styles.sectionHead, children: [
					jsx.jsxs('div', { children: [
						jsx.jsx('div', { style: styles.title, children: title }),
						jsx.jsx('div', { style: styles.desc, children: desc }),
					] }),
					action ?? null,
				] }),
				children,
			] }, 'section:' + id);
		}

		/** Uniform Row: name + mono meta line + status badges + right actions. */
		function Row({ k, name, meta, badges, actions, disabled }) {
			return jsx.jsxs('div', { style: { ...styles.rowItem, ...(disabled ? styles.grey : {}) }, children: [
				jsx.jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }, children: [
					jsx.jsxs('div', { style: styles.row, children: [name, ...(badges ?? [])] }),
					meta != null && meta !== '' ? jsx.jsx('div', { style: styles.meta, children: meta }) : null,
				] }),
				...(actions ?? []),
			] }, k);
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

		/** Lenient parse of the JSON-array-of-strings volatile fields
		 * (providerOrder / enabledDshResources / enabledTools). Mirrors
		 * src/page/priority.ts parseStringArray — degrade, never throw. */
		function parseListLocal(raw) {
			if (typeof raw !== 'string' || raw.trim() === '') return { list: [], error: null };
			try {
				const parsed = JSON.parse(raw);
				if (!Array.isArray(parsed)) return { list: [], error: '必须是 JSON 数组' };
				return { list: parsed.filter((x) => typeof x === 'string' && x.trim() !== ''), error: null };
			} catch (e) {
				return { list: [], error: '不是合法 JSON：' + e.message };
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

		/** Coarse ecosystem of a profile: 'h3' | 'seedance' | 'other'
		 * (mirrors src/page/ecosystems.ts profileGate — id first, the
		 * minimax-video-compatible protocol as the only tie-breaker). */
		function mediaEcoOf(p) {
			const first = (p.models ?? [''])[0] ?? '';
			const eco = ecosystemOfModel(first);
			if (eco && SUPPORTED_ECO_KEYS[eco.key] !== undefined) return SUPPORTED_ECO_KEYS[eco.key];
			if (p.protocol === 'minimax-video-compatible') return 'h3';
			return 'other';
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

		/** Client-side install hint (server ToolStatus.installHint wins when a
		 * tools snapshot is available). Displayed only — never executed. */
		function installHintLocal(tool) {
			const pkg = tool === 'imagemagick' ? 'imagemagick' : tool;
			const p = (typeof navigator !== 'undefined' && typeof navigator.platform === 'string' ? navigator.platform : '').toLowerCase();
			if (p.includes('mac')) return 'brew install ' + pkg;
			if (p.includes('win')) return 'winget install ' + (tool === 'gimp' ? 'GIMP.GIMP' : tool === 'blender' ? 'BlenderFoundation.Blender' : pkg);
			if (p.includes('linux')) return 'sudo apt-get install ' + pkg;
			return pkg;
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
		 * The write model (phase two): every interaction only mutates a local
		 * DRAFT (per-field overrides over the config snapshot); the single
		 *「保存并生效」button commits ONLY the dirty fields as ONE mutate
		 * batch — host mutate first, directMutate fallback when no ConfigForm.
		 */
		const NO_FORM_SNAP = { status: 'unavailable' };
		const noopSubscribe = () => () => {};
		// Config fields the unified draft/save model owns.
		const DRAFT_FIELDS = ['customProfiles', 'providerOrder', 'enabledDshResources', 'enabledTools', 'outputDir', 'dataDir', 'providersPatchPath', 'defaultTimeoutMs'];
		function SettingsCard(props) {
			const { directMutate, t } = props;
			const view = props.view === 'summary' ? 'summary' : 'page';
			// Baked page data: must be defined BEFORE any hook/useEffect reads it
			// (TDZ fix — the providersRef init below runs at first render, ahead
			// of the old definitions further down).
			const builtins = Array.isArray(PAGE_DATA.builtins) ? PAGE_DATA.builtins : [];
			const providers = Array.isArray(PAGE_DATA.providers) ? PAGE_DATA.providers : [];
			const bakedTools = Array.isArray(PAGE_DATA.tools) ? PAGE_DATA.tools : null;
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
			const [saving, setSaving] = react.useState(false); // legacy tri-state mirror of saveState
			const [failed, setFailed] = react.useState(false);
			const [note, setNote] = react.useState(null);
			// Unified draft: per-field overrides over cfg (undefined = untouched).
			const [draft, setDraft] = react.useState({});
			const setField = (key, value) => setDraft({ ...draft, [key]: value });
			const cfgVal = (key) => (draft[key] !== undefined ? draft[key] : cfg[key]);
			const dirtyKeys = DRAFT_FIELDS.filter((k) => draft[k] !== undefined && draft[k] !== (cfg[k] ?? (k === 'defaultTimeoutMs' ? '' : '')));
			// Live /v1/models pull state per provider: { ids, error } | undefined.
			// Fetched once per provider when the detail page mounts; failure keeps
			// the preset fallback (fetchProviderModels resolves null → error note).
			const [remoteModels, setRemoteModels] = react.useState({});
			const [importToken, setImportToken] = react.useState('');
			const [importAuthEnv, setImportAuthEnv] = react.useState('');
			const [manualModels, setManualModels] = react.useState({});
			const [editor, setEditor] = react.useState(null); // custom-editor draft (object) or null
			const [confirmDelete, setConfirmDelete] = react.useState(null);
			const [testState, setTestState] = react.useState({});
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
			// Write path (directMutate fix kept): when the ConfigForm channel is
			// missing (ready=false) the plugin's own remote.settings.mutate is
			// an INDEPENDENT, fully usable write path — it must stay reachable.
			const canDirect = typeof directMutate === 'function';
			const commit = (ops) => {
				setSaving(true); setFailed(false); setNote(null);
				const guard = setTimeout(() => { setSaving(false); setFailed(true); }, 15000);
				const finish = (ok) => {
					clearTimeout(guard); setSaving(false);
					if (ok) setDraft({});
					else setFailed(true);
				};
				const viaDirect = () => {
					if (!canDirect) { finish(false); return; }
					Promise.resolve(directMutate(ops))
						.then((answer) => { finish(!(answer && typeof answer === 'object' && answer.ok === false)); })
						.catch(() => { finish(false); });
				};
				if (!ready) { viaDirect(); return; }
				Promise.resolve(mutateForm(ops, snap.revision))
					.then((accepted) => { if (accepted !== false) finish(true); else viaDirect(); })
					.catch(() => { finish(false); });
			};
			// Unified save: ONE batch of set-ops, dirty fields only.
			const save = () => {
				const ops = dirtyKeys.map((k) => ({ op: 'set', path: [k], value: draft[k] }));
				if (ops.length === 0) { setNote({ ok: true, text: t('settings.saved') }); return; }
				commit(ops);
			};

			// ---- parsed config views (draft-aware) -------------------------------
			const customRaw = typeof cfgVal('customProfiles') === 'string' ? cfgVal('customProfiles') : '[]';
			const custom = parseCustomLocal(customRaw);
			const orderParse = parseListLocal(typeof cfgVal('providerOrder') === 'string' ? cfgVal('providerOrder') : '[]');
			const resParse = parseListLocal(typeof cfgVal('enabledDshResources') === 'string' ? cfgVal('enabledDshResources') : '[]');
			const toolParse = parseListLocal(typeof cfgVal('enabledTools') === 'string' ? cfgVal('enabledTools') : '[]');
			const resList = resParse.list;
			const toolList = toolParse.list;

			const profilesAll = [...builtins, ...custom.list];
			const byId = {};
			for (const p of profilesAll) byId[p.id] = p;
			const orderList = orderParse.list;
			const allIds = [...orderList, ...profilesAll.map((p) => p.id).filter((id) => byId[id] !== undefined && !orderList.includes(id))];
			// Default profile per modality, client mirror of resolveDefaultProfile:
			// walk allIds, first profile serving the modality, not blocked, and
			// in a SUPPORTED ecosystem ('other' never defaults).
			const defaultIds = (() => {
				const modalities = new Set();
				for (const p of profilesAll) for (const m of p.modalities ?? []) modalities.add(m);
				const out = new Set();
				for (const m of modalities) {
					for (const id of allIds) {
						const p = byId[id];
						if (!p || !(p.modalities ?? []).includes(m)) continue;
						if (p.blockRealSubmit === true) continue;
						if (mediaEcoOf(p) === 'other') continue;
						out.add(id);
						break;
					}
				}
				return out;
			})();
			const writeCustomList = (list) => setField('customProfiles', JSON.stringify(list, null, 2));

			if (view === 'summary') {
				// Folded「内置插件配置」row: one line — profile count, or the
				// unavailable hint while the channel is not served.
				const n = builtins.length + custom.list.length;
				return jsx.jsx('span', { children: ready ? t('settings.summaryReady', { n: String(n) }) : t('settings.unavailable') });
			}

			// ---- Sources a) DSH subscription resources ---------------------------
			// Supported suggestions only: provider-declared / preset-matched /
			// manual ids whose ecosystem ∈ {h3, seedance}; remote /v1/models ids
			// classified STRICTLY by id pattern. Everything else (LLM ids AND
			// classified-but-unsupported ecosystems like wan/imagen/veo) lands in
			// the greyed unsupported block, not checkable.
			const suggestionsFor = (prov) => {
				const base = suggestionsForProvider(prov, builtins, manualModels[prov.id] ?? []);
				const seen = new Set(base.map((s) => s.id));
				const out = base.filter((s) => SUPPORTED_ECO_KEYS[s.eco.key] !== undefined);
				const remoteState = remoteModels[prov.id];
				for (const id of remoteState && remoteState.ids || []) {
					if (seen.has(id)) continue;
					const eco = ecosystemOfModel(id);
					if (!eco) continue;
					seen.add(id);
					if (SUPPORTED_ECO_KEYS[eco.key] !== undefined) out.push({ id, eco, source: 'remote' });
				}
				return out;
			};
			const unsupportedFor = (prov) => {
				const supported = new Set(suggestionsFor(prov).map((s) => s.id));
				const declared = (prov.models ?? []).map((m) => (typeof m === 'string' ? m : m.id));
				const seen = new Set();
				const out = [];
				for (const id of [...(remoteModels[prov.id] && remoteModels[prov.id].ids || []), ...(manualModels[prov.id] ?? []), ...declared]) {
					if (supported.has(id) || seen.has(id)) continue;
					seen.add(id);
					out.push({ id, eco: ecosystemOfModel(id) });
				}
				return out;
			};
			const resChecked = (provId, modelId) => resList.includes(provId + '::' + modelId);
			const toggleResource = (provId, modelId, on) => {
				const key = provId + '::' + modelId;
				const next = on ? [...new Set([...resList, key])] : resList.filter((x) => x !== key);
				setField('enabledDshResources', JSON.stringify(next));
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
			//「应用勾选」: generate custom-profile drafts from the CHECKED
			// resources (enabledDshResources is the single source of truth for
			// checkbox state), grouped per provider+ecosystem. Writes into the
			// draft; committed by the unified save.
			const applyImport = () => {
				const picked = [];
				const authEnvFor = (eco) => (importAuthEnv.trim() !== '' ? importAuthEnv.trim() : DEFAULT_AUTH_ENV[eco]);
				for (const prov of providers) {
					const byEco = {};
					for (const s of suggestionsFor(prov)) {
						if (!resChecked(prov.id, s.id)) continue;
						const ecoKey = SUPPORTED_ECO_KEYS[s.eco.key];
						(byEco[ecoKey] = byEco[ecoKey] || []).push({ id: s.id, modality: s.eco.modality });
					}
					for (const [eco, list] of Object.entries(byEco)) {
						const modalities = [...new Set(list.map((m) => m.modality))];
						// h3/seedance both map 1:1 to their wire protocol here.
						const protocol = ECOSYSTEM_PROTOCOL[Object.keys(ECOSYSTEM_PROTOCOL).find((k) => SUPPORTED_ECO_KEYS[k] === eco) ?? 'minimax-h3'];
						picked.push({
							id: ('dsh-' + prov.id + '-' + eco.replace(/^[a-z]+-/, '')).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''),
							protocol,
							baseUrl: prov.baseURL ?? '',
							authEnv: authEnvFor(eco === 'seedance' ? 'volcengine-seedance' : 'minimax-h3'),
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
				writeCustomList([...custom.list.filter((p) => !picked.some((q) => q.id === p.id)), ...picked]);
				setNote({ ok: true, text: t('import.appliedDraft', { n: String(picked.length) }) });
			};

			// ---- Sources b) self-built providers (draft writes) -------------------
			const submitEditor = (mode) => {
				const d = editor;
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
				writeCustomList(list);
				setNote({ ok: true, text: mode === 'delete' ? t('custom.deleted', { id: entry.id }) : t('custom.savedDraft', { id: entry.id }) });
				setEditor(null);
			};
			// Danger op: delete needs a SECOND click on the confirm button.
			const deleteCustom = (id) => {
				if (confirmDelete !== id) { setConfirmDelete(id); return; }
				setConfirmDelete(null);
				writeCustomList(custom.list.filter((p) => p.id !== id));
				setNote({ ok: true, text: t('custom.deleted', { id }) });
			};
			const runConnectionTest = async (p) => {
				setTestState((prev) => ({ ...prev, [p.id]: { loading: true } }));
				const ids = await fetchProviderModels(p.baseUrl ?? p.baseURL, '');
				setTestState((prev) => ({ ...prev, [p.id]: ids === null ? { fail: true } : { ok: ids.length } }));
			};

			const editorField = (label, key, opts = {}) => jsx.jsxs('div', { style: styles.row, children: [
				jsx.jsx('span', { style: { ...styles.desc, minWidth: 130 }, children: label }),
				opts.choices
					? jsx.jsx('select', { style: styles.input, value: editor[key] ?? '', onChange: (e) => setEditor({ ...editor, [key]: e.target.value }), children: opts.choices.map((c) => jsx.jsx('option', { value: c, children: c }, c)) })
					: jsx.jsx('input', { style: { ...styles.input, minWidth: 260 }, type: opts.bool ? 'checkbox' : 'text', ...(opts.bool ? { checked: editor[key] !== false } : { value: editor[key] ?? '' }), onChange: (e) => setEditor({ ...editor, [key]: opts.bool ? e.target.checked : e.target.value }) }),
			] }, key);

			const priorityRow = (id, i) => {
				const p = byId[id];
				const eco = p ? mediaEcoOf(p) : 'other';
				return Row({
					k: 'prio:' + id,
					name: jsx.jsx('code', { children: id }),
					meta: p ? [p.protocol, p.baseUrl ?? p.baseURL, 'models=[' + (p.models ?? []).join(', ') + ']'].filter(Boolean).join(' · ') : '',
					badges: [
						eco !== 'other' ? tagBadge(t('badge.supported') + ' · ' + eco, true) : tagBadge(t('badge.unsupported'), false),
						...(orderList.includes(id) ? [jsx.jsx('span', { style: styles.meta, children: t('priority.rank', { n: String(orderList.indexOf(id) + 1) }) })] : []),
						...(defaultIds.has(id) ? [tagBadge(t('priority.default'), true)] : []),
						...(p && p.blockRealSubmit === true ? [badge('blocked', false, t)] : []),
					],
					actions: [
						jsx.jsx('button', { type: 'button', style: styles.button, disabled: i === 0, onClick: () => movePriority(id, 0), children: t('priority.top') }),
						jsx.jsx('button', { type: 'button', style: styles.button, disabled: i === 0, onClick: () => movePriority(id, i - 1), children: t('priority.up') }),
						jsx.jsx('button', { type: 'button', style: styles.button, disabled: i === allIds.length - 1, onClick: () => movePriority(id, i + 1), children: t('priority.down') }),
					],
				});
			};
			const movePriority = (id, toIndex) => {
				const arr = [...allIds];
				const i = arr.indexOf(id);
				if (i < 0) return;
				arr.splice(i, 1);
				arr.splice(Math.max(0, Math.min(arr.length, toIndex)), 0, id);
				setField('providerOrder', JSON.stringify(arr));
			};

			// ---- overview data -----------------------------------------------------
			const modalitiesAll = [...new Set(profilesAll.flatMap((p) => p.modalities ?? []))];
			const defaultsText = modalitiesAll.length === 0 ? t('overview.noDefault')
				: modalitiesAll.map((m) => {
					const hit = [...allIds].find((id) => defaultIds.has(id) && byId[id] && (byId[id].modalities ?? []).includes(m));
					return m + ' → ' + (hit ?? t('overview.noDefault'));
				}).join('\n');
			const warningsAll = [
				...(Array.isArray(PAGE_DATA.configWarnings) ? PAGE_DATA.configWarnings : []),
				...(custom.error ? [custom.error] : []),
				...(orderParse.error ? ['providerOrder：' + orderParse.error] : []),
				...(resParse.error ? ['enabledDshResources：' + resParse.error] : []),
				...(toolParse.error ? ['enabledTools：' + toolParse.error] : []),
			];
			const installedEnabled = bakedTools
				? toolList.filter((name) => (bakedTools.find((x) => x.name === name) ?? {}).installed === true).length
				: null;
			const h3Verdict = typeof PAGE_DATA.h3Verdict === 'string' && PAGE_DATA.h3Verdict !== '' ? PAGE_DATA.h3Verdict : null;

			const canSave = (ready || canDirect) && !saving && dirtyKeys.length > 0;
			const saveBar = jsx.jsxs('div', { style: styles.saveBar, children: [
				dirtyKeys.length > 0 ? jsx.jsx('span', { style: styles.note, children: t('settings.saveDirty', { n: String(dirtyKeys.length) }) }) : null,
				saving ? jsx.jsx('span', { style: styles.muted, children: t('settings.saving') }) : null,
				failed ? jsx.jsx('span', { style: styles.note, children: t('settings.saveFailed') }) : null,
				jsx.jsx('button', { type: 'button', style: { ...styles.button, fontWeight: 600 }, disabled: !canSave, onClick: save, children: t('settings.save') }),
			] });

			return jsx.jsxs('div', { style: styles.card, children: [
				jsx.jsxs('div', { style: styles.section, children: [
					jsx.jsx('div', { style: styles.title, children: t('settings.title') }),
					jsx.jsx('div', { style: styles.desc, children: t('settings.description') }),
					!ready ? jsx.jsx('div', { style: styles.muted, children: t('settings.unavailable') }) : null,
				] }),

				// ① Overview — pure status, no actions.
				Section({
					id: 'overview', title: t('section.overview'), desc: t('section.overviewDesc'),
					children: jsx.jsxs('div', { style: styles.rowItem, children: [
						jsx.jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }, children: [
							jsx.jsx('div', { style: styles.desc, children: t('overview.profiles') + ': ' + profilesAll.length }),
							jsx.jsx('div', { style: styles.pre, children: t('overview.defaults') + ': ' + defaultsText }),
							jsx.jsx('div', { style: styles.desc, children: t('overview.h3') + ': ' + (h3Verdict ?? t('overview.h3Unknown')) }),
							jsx.jsx('div', { style: styles.desc, children: t('overview.toolsReady') + ': ' + (installedEnabled !== null
								? installedEnabled + ' / ' + toolList.length
								: toolList.length + (toolList.length > 0 ? '（' + t('tool.notProbed') + '）' : '')) }),
						] }),
					] }),
					action: null,
				}),
				warningsAll.length > 0 ? jsx.jsx('div', { style: styles.note, children: warningsAll.map((w) => t('overview.warnings') + '：' + w).join('\n') }) : null,

				// ② Sources — a) DSH subscription checkboxes, b) self-built providers.
				Section({
					id: 'sources', title: t('section.sources'), desc: t('section.sourcesDesc'),
					children: jsx.jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 }, children: [
						jsx.jsxs('div', { style: styles.section, children: [
							jsx.jsx('div', { style: styles.title, children: t('sources.dsh') }),
							jsx.jsx('div', { style: styles.desc, children: t('sources.dshDesc') }),
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
													const key = prov.id + '::' + s.id;
													return jsx.jsxs('label', { style: styles.row, children: [
														jsx.jsx('input', { type: 'checkbox', checked: resChecked(prov.id, s.id), onChange: (e) => toggleResource(prov.id, s.id, e.target.checked) }),
														jsx.jsx('code', { children: s.id }),
														tagBadge(s.eco.tag, true),
														s.source === 'provider' ? null : tagBadge(s.source === 'preset' ? 'preset' : (remoteState && remoteState.ids.includes(s.id) ? 'remote' : 'manual'), s.source === 'preset'),
													] }, key);
												}) }),
											unsupported.length > 0 ? jsx.jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, marginLeft: 8 }, children: [
												jsx.jsx('div', { style: { ...styles.desc, color: '#8b949e' }, children: t('import.unsupportedHeader') + '（' + unsupported.length + '）' }),
												jsx.jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 }, children: unsupported.map((u) => Row({
													k: 'unsupported:' + prov.id + ':' + u.id,
													disabled: true,
													name: jsx.jsxs('span', { style: styles.row, children: [
														jsx.jsx('input', { type: 'checkbox', disabled: true, checked: false, readOnly: true }),
														jsx.jsx('code', { children: u.id }),
													] }),
													badges: u.eco ? [tagBadge(u.eco.tag, false), tagBadge(t('import.unsupported'), false)] : [tagBadge(t('import.unsupported'), false)],
													actions: [],
												}) ) }),
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
									jsx.jsxs('div', { style: styles.row, children: [
										jsx.jsx('span', { style: styles.desc, children: t('import.authEnv') }),
										jsx.jsx('input', { style: { ...styles.input, minWidth: 220 }, value: importAuthEnv, onChange: (e) => setImportAuthEnv(e.target.value), placeholder: DEFAULT_AUTH_ENV['volcengine-seedance'] + ' / ' + DEFAULT_AUTH_ENV['minimax-h3'] }),
										jsx.jsx('button', { type: 'button', style: styles.button, disabled: (!ready && !canDirect) || saving, onClick: applyImport, children: t('import.apply') }),
									] }),
								] }),
						] }),
						jsx.jsxs('div', { style: styles.section, children: [
							jsx.jsx('div', { style: styles.title, children: t('sources.custom') }),
							jsx.jsx('div', { style: styles.desc, children: t('sources.customDesc') }),
							editor === null
								? jsx.jsx('button', { type: 'button', style: styles.button, disabled: (!ready && !canDirect), onClick: () => setEditor({ id: '', protocol: 'openai-video-compatible', baseUrl: '', authEnv: '', modelsInput: '', modalitiesInput: 'video', online: false }), children: t('custom.add') })
								: jsx.jsxs('div', { style: { ...styles.card, borderStyle: 'dashed' }, children: [
									editorField(t('custom.field.id'), 'id'),
									editorField(t('custom.field.protocol'), 'protocol', { choices: PROTOCOL_OPTIONS }),
									editorField(t('custom.field.baseUrl'), 'baseUrl'),
									editorField(t('custom.field.authEnv'), 'authEnv'),
									editorField(t('custom.field.models'), 'modelsInput'),
									editorField(t('custom.field.modalities'), 'modalitiesInput'),
									editorField(t('custom.field.online'), 'online', { bool: true }),
									jsx.jsxs('div', { style: styles.row, children: [
										editor.__editing
											? jsx.jsx('button', { type: 'button', style: styles.button, onClick: () => submitEditor('update'), children: t('custom.update') })
											: jsx.jsx('button', { type: 'button', style: styles.button, onClick: () => submitEditor('add'), children: t('custom.add') }),
										editor.__editing ? jsx.jsx('button', { type: 'button', style: { ...styles.button, color: '#f85149' }, onClick: () => submitEditor('delete'), children: t('custom.delete') }) : null,
										jsx.jsx('button', { type: 'button', style: styles.button, onClick: () => setEditor(null), children: '×' }),
									] }),
								] }),
							custom.list.length === 0 ? jsx.jsx('div', { style: styles.muted, children: t('custom.empty') }) : jsx.jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 }, children: custom.list.map((p) => {
								const st = testState[p.id];
								return Row({
									k: 'custom:' + p.id,
									name: jsx.jsxs('span', { style: styles.row, children: [
										jsx.jsx('code', { children: p.id }),
										tagBadge('custom', true),
										p.online !== false ? badge('online', true, t) : badge('online', false, t),
										p.blockRealSubmit === true ? badge('blocked', false, t) : null,
									] }),
									meta: [p.protocol, p.baseUrl, 'models=[' + (p.models ?? []).join(', ') + ']', 'modalities=[' + (p.modalities ?? []).join(', ') + ']', p.authEnv ? 'authEnv=' + p.authEnv : ''].filter(Boolean).join(' · '),
									badges: [badge('protocol', p.protocolVerified === true, t), badge('live', p.liveVerified === true, t)],
									actions: [
										jsx.jsx('button', { type: 'button', style: styles.button, onClick: () => void runConnectionTest(p), children: st && st.loading ? t('custom.testing') : t('custom.test') }),
										st && st.ok !== undefined ? jsx.jsx('span', { style: styles.good, children: t('custom.testOk', { n: String(st.ok) }) }) : null,
										st && st.fail ? jsx.jsx('span', { style: styles.note, children: t('custom.testFail') }) : null,
										jsx.jsx('button', { type: 'button', style: styles.button, onClick: () => setEditor({ ...p, __editing: true, modelsInput: (p.models ?? []).join(','), modalitiesInput: (p.modalities ?? []).join(',') }), children: t('custom.edit') }),
										jsx.jsx('button', { type: 'button', style: { ...styles.button, ...(confirmDelete === p.id ? { color: '#f85149', fontWeight: 600 } : { color: '#f85149' }) }, onClick: () => deleteCustom(p.id), children: confirmDelete === p.id ? t('custom.confirmDelete') : t('custom.delete') }),
									],
								});
							}) }),
						] }),
					] }),
				}),

				// ③ Priority — one global ordered list (chosen over per-modality
				// grouping: simpler, and providerOrder IS a single flat array, so
				// one column directly expresses「按顺序来」; the meta line + default
				// badge still exposes which profile each modality resolves to).
				Section({
					id: 'priority', title: t('section.priority'), desc: t('section.priorityDesc'),
					children: jsx.jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 }, children:
						allIds.length === 0 ? jsx.jsx('div', { style: styles.muted, children: t('priority.empty') }) : allIds.map((id, i) => priorityRow(id, i)),
					} ),
				}),

				// ④ Ecosystems — display-only cards for h3 + seedance, others collapsed.
				Section({
					id: 'ecosystems', title: t('section.ecosystems'), desc: t('section.ecosystemsDesc'),
					children: jsx.jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 }, children: [
						['h3', 'seedance'].map((eco) => {
							const members = profilesAll.filter((p) => mediaEcoOf(p) === eco);
							const hit = members.some((p) => defaultIds.has(p.id));
							return jsx.jsxs('div', { style: { ...styles.rowItem, flexDirection: 'column', alignItems: 'stretch' }, children: [
								jsx.jsxs('div', { style: styles.row, children: [
									jsx.jsx('span', { style: styles.title, children: eco === 'h3' ? t('eco.h3') : t('eco.seedance') }),
									tagBadge(t('badge.supported'), true),
								] }),
								jsx.jsx('div', { style: styles.meta, children: eco === 'h3' ? t('eco.families.h3') : t('eco.families.seedance') }),
								jsx.jsx('div', { style: styles.desc, children: t('eco.profiles') + ': ' + members.length }),
								jsx.jsx('div', { style: styles.desc, children: hit ? t('eco.defaultHit') : t('eco.defaultMiss') }),
							] }, 'eco:' + eco);
						}),
						jsx.jsx('details', { children: [
							jsx.jsx('summary', { style: styles.desc, children: t('eco.unsupportedHeader') + '（' + profilesAll.filter((p) => mediaEcoOf(p) === 'other').length + '）' }),
							jsx.jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }, children: profilesAll.filter((p) => mediaEcoOf(p) === 'other').map((p) => Row({
								k: 'ecooth:' + p.id,
								disabled: true,
								name: jsx.jsx('code', { children: p.id }),
								meta: [p.protocol, 'models=[' + (p.models ?? []).join(', ') + ']'].join(' · '),
								badges: [tagBadge(t('badge.unsupported'), false)],
								actions: [],
							}) ) }),
						] }),
					] }),
				}),

				// ⑤ Toolchain — four checkboxes; probe status from the baked tools
				// snapshot when present, install hint always (display only).
				Section({
					id: 'toolchain', title: t('section.toolchain'), desc: t('section.toolchainDesc'),
					children: jsx.jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 }, children: TOOL_NAMES.map((name) => {
						const on = toolList.includes(name);
						const baked = bakedTools ? bakedTools.find((x) => x.name === name) : null;
						const installed = baked ? baked.installed === true : null;
						const hint = baked && baked.installHint ? baked.installHint : installHintLocal(name);
						return Row({
							k: 'tool:' + name,
							name: jsx.jsxs('span', { style: styles.row, children: [
								jsx.jsx('input', { type: 'checkbox', checked: on, onChange: (e) => {
									const next = e.target.checked ? [...new Set([...toolList, name])] : toolList.filter((x) => x !== name);
									setField('enabledTools', JSON.stringify(next));
								} }),
								jsx.jsx('code', { children: name }),
							] }),
							meta: jsx.jsxs('span', { children: [
								installed === true ? '✓ ' + t('tool.installed') + (baked.path ? ' · ' + baked.path : '') + (baked.version ? ' · ' + baked.version : '')
									: installed === false ? '✗ ' + t('tool.missing')
									: t('tool.notProbed'),
								' · install: ',
								jsx.jsx('code', { children: hint }),
							] }),
							badges: installed === true ? [tagBadge(t('tool.installed'), true)] : installed === false ? [tagBadge(t('tool.missing'), false)] : [],
							actions: [],
						});
					}) }),
				}),

				// ⑥ Advanced — collapsed, kept out of the main flow.
				Section({
					id: 'advanced', title: t('section.advanced'), desc: t('section.advancedDesc'),
					children: jsx.jsx('details', { children: [
						jsx.jsx('summary', { style: styles.desc, children: t('section.advanced') }),
						jsx.jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }, children: [
							jsx.jsxs('div', { style: styles.row, children: [
								jsx.jsx('span', { style: { ...styles.desc, minWidth: 180 }, children: t('advanced.outputDir') }),
								jsx.jsx('input', { style: { ...styles.input, minWidth: 260 }, value: String(cfgVal('outputDir') ?? ''), onChange: (e) => setField('outputDir', e.target.value) }),
							] }, 'adv:outputDir'),
							jsx.jsxs('div', { style: styles.row, children: [
								jsx.jsx('span', { style: { ...styles.desc, minWidth: 180 }, children: t('advanced.dataDir') }),
								jsx.jsx('input', { style: { ...styles.input, minWidth: 260 }, value: String(cfgVal('dataDir') ?? ''), onChange: (e) => setField('dataDir', e.target.value) }),
							] }, 'adv:dataDir'),
							jsx.jsxs('div', { style: styles.row, children: [
								jsx.jsx('span', { style: { ...styles.desc, minWidth: 180 }, children: t('advanced.providersPatchPath') }),
								jsx.jsx('input', { style: { ...styles.input, minWidth: 260 }, value: String(cfgVal('providersPatchPath') ?? ''), onChange: (e) => setField('providersPatchPath', e.target.value) }),
							] }, 'adv:providersPatchPath'),
							jsx.jsxs('div', { style: styles.row, children: [
								jsx.jsx('span', { style: { ...styles.desc, minWidth: 180 }, children: t('advanced.defaultTimeoutMs') }),
								jsx.jsx('input', { style: { ...styles.input, minWidth: 260 }, value: String(cfgVal('defaultTimeoutMs') ?? ''), onChange: (e) => {
									const n = Number(e.target.value);
									if (e.target.value.trim() !== '' && Number.isFinite(n) && n > 0) setField('defaultTimeoutMs', n);
								} }),
							] }, 'adv:defaultTimeoutMs'),
						] }),
					] }),
				}),

				// Unified save bar: ONE button commits all dirty fields in one batch.
				saveBar,
				note !== null ? jsx.jsx('div', { style: note.ok ? styles.good : styles.note, children: note.text }) : null,
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
