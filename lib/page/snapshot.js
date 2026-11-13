/**
 * Config-page server brain: effective-profile snapshot, provider import data,
 * system detection, download wiring and the `/synthmedia` command grammar.
 *
 * Kept free of cordis types so unit tests drive it with plain inputs; the
 * apply() wiring in src/index.ts only adapts ctx ↔ this module.
 * @module
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from '../config.js';
import { parseCustomProfiles, mergeCustomBackends } from './custom.js';
import { readDshProviders } from './providers.js';
import { collectSystemReport, assessH3, DEFAULT_H3_THRESHOLDS } from './system.js';
import { DownloadManager, defaultManifest, readOptionalText, } from './downloads.js';
import { fetchRemoteModels, presetBaseUrls } from './fetch-models.js';
import { classifyModel } from './providers.js';
/** Base backends map with the built-in defaults resolved. */
function baseBackends(options) {
    const resolved = resolveConfig(options);
    return { ...resolved.backends };
}
/**
 * Effective configuration = built-in presets + config backends overrides +
 * parsed customProfiles (validated; corrupt → ignored with diagnostics).
 */
export function effectiveConfig(config) {
    const customRaw = config['customProfiles'];
    const { profiles, error } = parseCustomProfiles(customRaw);
    const base = baseBackends(config);
    // Profile-level config overrides (backends map) win over defaults; custom
    // profiles win over built-ins with the same id.
    const backends = mergeCustomBackends(base, profiles);
    const resolved = resolveConfig({ ...config, backends });
    return { config: resolved, ...(error ? { customError: error } : {}) };
}
function profileView(b, customIds) {
    return {
        id: b.id,
        protocol: b.protocol,
        baseUrl: b.baseUrl,
        models: [...(b.models ?? [b.model])],
        modalities: [...b.modalities],
        ...(b.authEnv ? { authEnv: b.authEnv } : {}),
        online: b.online,
        protocolVerified: b.protocolVerified === true,
        liveVerified: b.liveVerified === true,
        blockRealSubmit: b.blockRealSubmit === true,
        source: customIds.has(b.id) ? 'custom' : 'preset',
    };
}
/** Everything the config page (settings card + session tab) renders. */
export function buildSnapshot(config, options, extras = {}) {
    const { config: resolved, customError } = effectiveConfig(config);
    const customIds = new Set(parseCustomProfiles(config['customProfiles']).profiles.map((p) => p.id));
    const profiles = Object.values(resolved.backends).map((b) => profileView(b, customIds));
    return {
        profiles,
        providers: extras.providers ?? [],
        ...(extras.providersError ? { providersError: extras.providersError } : {}),
        downloads: extras.downloads ?? [],
        downloadManifest: extras.downloadManifest ?? { downloadsDir: join(options.dataDir, 'downloads'), entries: [] },
        ...(customError ? { customProfilesError: customError } : {}),
        dataDir: options.dataDir,
    };
}
/** Read providers from the configured patch path (safe: read-only, one file). */
export function loadProviders(patchPath) {
    if (!patchPath) {
        return { providers: [], error: '未配置 providersPatchPath（指向 profile 的 cordis.patch.yml），无法枚举 DSH providers' };
    }
    try {
        return { providers: readDshProviders(patchPath) };
    }
    catch (err) {
        return { providers: [], error: `读取 providers 配置失败：${err instanceof Error ? err.message : String(err)}` };
    }
}
export function createPageServices(config, options, hostJobs, resolveCredential) {
    mkdirSync(options.dataDir, { recursive: true });
    const downloadsDir = join(options.dataDir, 'downloads');
    const { config: resolved } = effectiveConfig(config);
    const manifest = defaultManifest(downloadsDir);
    const manager = new DownloadManager(manifest, undefined, hostJobs);
    // Load the operator-edited manifest (falls back to defaults, never throws).
    void manager.loadManifest(join(options.dataDir, 'downloads.json'));
    void resolved;
    return { manager, options, config, ...(resolveCredential ? { resolveCredential } : {}) };
}
export async function pageDetect(services) {
    // statfs needs an existing path: probe the data dir (downloads live below
    // it and share the same volume, so free-disk is identical).
    const targetDir = services.options.dataDir;
    const report = await collectSystemReport(targetDir);
    return { report, assessment: assessH3(report, DEFAULT_H3_THRESHOLDS) };
}
function fmtBytes(n) {
    if (n >= 1024 ** 3)
        return `${(n / 1024 ** 3).toFixed(1)} GiB`;
    if (n >= 1024 ** 2)
        return `${(n / 1024 ** 2).toFixed(0)} MiB`;
    return `${n} B`;
}
/** Human text for the /synthmedia command. */
export function renderText(services, providers, providersError) {
    const { config: resolved, customError } = effectiveConfig(services.config);
    const customIds = new Set(parseCustomProfiles(services.config['customProfiles']).profiles.map((p) => p.id));
    const lines = ['SynthMedia ProviderProfile 一览（密钥仅显示环境变量名，永不显示值）：'];
    for (const b of Object.values(resolved.backends)) {
        const v = profileView(b, customIds);
        lines.push(`- ${v.id} [${v.source}] protocol=${v.protocol} baseURL=${v.baseUrl} models=[${v.models.join(', ')}]` +
            ` authEnv=${v.authEnv ?? '（无需凭据）'} verified=${v.protocolVerified ? '协议✓' : '协议✗'}/${v.liveVerified ? '实测✓' : '实测✗'}` +
            (v.blockRealSubmit ? '（已封锁真实提交）' : ''));
    }
    if (customError)
        lines.push(`注意：${customError}`);
    if (providersError) {
        lines.push(`DSH providers 导入：${providersError}`);
    }
    else {
        lines.push(`DSH providers（${providers.length} 个）：火山 Seedance / MiniMax H3 / 阿里万相 / Gemini / OpenAI 生态可导入，其余暂不支持。`);
    }
    lines.push(`子命令：/synthmedia json | providers | detect | fetch-models <baseURL> | dl list|start <id>|cancel <id>`);
    return lines.join('\n');
}
/**
 * `/synthmedia` subcommand execution. Returns { kind, text, json? } where
 * `json` carries the machine-readable payload the client tab renders.
 */
export async function runPageCommand(services, rawInput) {
    const input = rawInput.trim();
    const arg = input.toLowerCase();
    const providers = loadProviders(services.options.providersPatchPath);
    if (arg === '' || arg === 'status') {
        return { kind: 'success', text: renderText(services, providers.providers, providers.error) };
    }
    if (arg === 'json') {
        const providersData = loadProviders(services.options.providersPatchPath);
        const snapshot = buildSnapshot(services.config, services.options, {
            providers: providersData.providers,
            ...(providersData.error ? { providersError: providersData.error } : {}),
            downloads: services.manager.list(),
            downloadManifest: {
                downloadsDir: services.manager.manifestNow().downloadsDir,
                entries: services.manager.manifestNow().entries,
            },
        });
        return { kind: 'success', text: 'synthmedia 配置页快照已生成', json: snapshot };
    }
    if (arg === 'providers') {
        if (providers.error)
            return { kind: 'success', text: `DSH providers：${providers.error}` };
        const lines = providers.providers.map((p) => {
            const models = p.models.map((m) => `${m.id}${m.ecosystem === 'unsupported' ? '（暂不支持）' : `（${m.ecosystem}）`}`).join(', ');
            return `- ${p.displayName ?? p.id} ${p.baseURL ?? ''}: ${models}`;
        });
        return { kind: 'success', text: lines.length > 0 ? lines.join('\n') : '未在 providers 配置中发现任何 provider' };
    }
    if (arg === 'detect') {
        try {
            const { report, assessment } = await pageDetect(services);
            const lines = [
                `平台 ${report.platform}/${report.arch} · CPU ${report.cpuCount} 核 ${report.cpuModel ?? ''}`,
                report.totalMemBytes !== undefined ? `内存 ${fmtBytes(report.totalMemBytes)}` : '内存未知',
                report.freeDiskBytes !== undefined ? `目标目录可用磁盘 ${fmtBytes(report.freeDiskBytes)}` : '磁盘未知',
                report.gpuInfo ?? 'GPU 信息不可用',
                `运行时：python=${report.runtimes.python ?? '未找到'} uv=${report.runtimes.uv ?? '未找到'} node=${report.runtimes.node ?? '未找到'}`,
                '',
                `离线 H3 可行性：${assessment.overall}`,
                ...assessment.dimensions.map((d) => `- ${d.dimension}：${d.value} → ${d.verdict}（${d.basis}）`),
            ];
            return {
                kind: 'success',
                text: lines.join('\n'),
                json: { report, assessment },
            };
        }
        catch (err) {
            return { kind: 'error', text: `检测失败：${err instanceof Error ? err.message : String(err)}` };
        }
    }
    if (arg.startsWith('dl')) {
        const [, verb, id] = arg.split(/\s+/);
        try {
            if (!verb || verb === 'list') {
                const items = services.manager.list();
                if (items.length === 0) {
                    const manifest = services.manager.manifestNow();
                    return {
                        kind: 'success',
                        text: `下载清单（${manifest.downloadsDir}）：\n` + manifest.entries.map((e) => {
                            const entry = e;
                            return `- ${entry.id} ${entry.name}${entry.url ? '' : '（URL 待填）'}`;
                        }).join('\n'),
                    };
                }
                return {
                    kind: 'success',
                    text: items.map((d) => {
                        const pct = d.percent !== undefined ? `${d.percent}%` : '';
                        const speed = d.speedBps !== undefined ? ` ${(d.speedBps / 1024 / 1024).toFixed(1)} MiB/s` : '';
                        const eta = d.etaSeconds !== undefined ? ` 剩余 ${d.etaSeconds}s` : '';
                        return `- ${d.id} [${d.status}] ${pct}${speed}${eta}${d.error ? ` — ${d.error}` : ''}`;
                    }).join('\n'),
                    json: items,
                };
            }
            if (verb === 'start') {
                if (!id)
                    return { kind: 'error', text: '用法：/synthmedia dl start <清单id>' };
                const rec = await services.manager.start(id);
                return { kind: 'success', text: `下载已启动：${id}（宿主 Jobs UI 同步可见，kind=synthmedia-download）`, json: rec };
            }
            if (verb === 'cancel') {
                if (!id)
                    return { kind: 'error', text: '用法：/synthmedia dl cancel <id>' };
                await services.manager.cancel(id);
                return { kind: 'success', text: `已请求取消：${id}` };
            }
            return { kind: 'error', text: '用法：/synthmedia dl list | start <id> | cancel <id>' };
        }
        catch (err) {
            return { kind: 'error', text: err instanceof Error ? err.message : String(err) };
        }
    }
    if (arg === 'fetch-models' || arg.startsWith('fetch-models ')) {
        // Server-side read-only model-list fetch (CORS bypass). Grammar:
        //   /synthmedia fetch-models <baseURL> [--token <pasted>] [--auth-env <NAME>]
        // Parse the ORIGINAL input: URLs, env-var names and Bearer tokens are
        // case-sensitive; only the command verb is case-insensitive.
        // The token/env VALUE is used in-memory for the single request only and
        // never appears in the response; the response carries model ids (+ names).
        const parts = input.split(/\s+/);
        const positional = parts.filter((p) => !p.startsWith('--')).slice(1);
        const flag = (name) => {
            const i = parts.indexOf('--' + name);
            return i >= 0 && parts[i + 1] !== undefined ? parts[i + 1] : undefined;
        };
        const baseURL = positional[0];
        if (!baseURL)
            return { kind: 'error', text: '用法：/synthmedia fetch-models <providerBaseURL> [--token <值>] [--auth-env <环境变量名>]' };
        const answer = await fetchRemoteModels(baseURL, {
            allowedPresetBases: presetBaseUrls(services.config),
            token: flag('token'),
            authEnv: flag('auth-env'),
            resolveCredential: services.resolveCredential,
            ...(services.lookup ? { lookup: services.lookup } : {}),
        });
        if (!answer.ok)
            return { kind: 'error', text: `模型拉取失败：${answer.reason}` };
        const lines = answer.models.map((m) => {
            const { ecosystem, modality } = classifyModel(m.id);
            const tag = ecosystem === 'unsupported' ? '（暂不支持）' : `（${ecosystem}${modality ? ' · ' + modality : ''}）`;
            return `- ${m.id}${m.name !== undefined ? ` — ${m.name}` : ''} ${tag}`;
        });
        return {
            kind: 'success',
            text: `已拉取 ${answer.models.length} 个模型（${baseURL}）：\n${lines.join('\n')}\n凭据值不回显，仅本次请求在内存中使用。`,
            json: { models: answer.models.map((m) => m.id) },
        };
    }
    return {
        kind: 'error',
        text: '未知子命令。可用：/synthmedia [status] | json | providers | detect | fetch-models <baseURL> | dl list|start <id>|cancel <id>',
    };
}
export { readOptionalText };
//# sourceMappingURL=snapshot.js.map