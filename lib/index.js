/**
 * dsh-synthmedia — provider-agnostic media generation for DSH agents.
 *
 * Registers five agent tools (capabilities / generate / status / wait / cancel)
 * over a unified async JobManager. Three layers are decoupled:
 *   ProtocolAdapter (backends/, one per wire protocol)
 *   ProviderProfile (config.ts: URL, credential reference, paths, timeouts)
 *   ModelCapability  (presets.ts: modality + duration/size/format limits)
 * so any compatible gateway / H3 service can be added by configuration.
 *
 * Credentials resolve per call through the host credential provider
 * (ctx.credentials) with process.env as the documented fallback; no value is
 * ever persisted, logged or returned.
 *
 * @module dsh-synthmedia
 */
import { resolveConfig, defaultConfig } from './config.js';
import { createBackendRegistry } from './backends/index.js';
import { JobManager } from './jobs.js';
import { buildSynthMediaTools } from './tools.js';
import { envCredentialResolver } from './http.js';
import { parseCustomProfiles } from './page/custom.js';
import { mergeCustomBackends } from './page/custom.js';
import { parseOrder, parseEnabledTools, resolveDefaultProfile } from './page/priority.js';
import { gateBackends } from './page/ecosystems.js';
import { detectToolchain } from './page/toolchain.js';
import { createPageServices, runPageCommand, effectiveConfig, } from './page/snapshot.js';
import z from '@deepseek-ai/schemastery';
export const inject = ['tools'];
export const name = 'dsh-synthmedia';
/**
 * Config-page settings schema — the host Plugins page derives the plugin's
 * settings form (and the `synthmedia` ConfigForm namespace the client
 * settings card binds) from this exported schemastery Config, exactly the
 * mechanism dsh-cybernetics uses.
 *
 * NOTE (settings-channel fix): the host settings service (@deepseek-ai/
 * dsh-settings `volatileForm`) serves a plugin's ConfigForm ONLY when at
 * least one field is `.volatile()` — a schema with no volatile field is
 * dropped from `settings.describe()` entirely, and `settings.mutate` refuses
 * every write path that is not volatile. `customProfiles` (the field the
 * settings card writes) is therefore volatile: GUI saves commit into the
 * running fiber as a live `{get}` reference (announced via
 * `loader/volatile-update`) and apply() re-merges the profile set live. The
 * remaining fields stay ordinary config: changing them remounts the plugin
 * through the normal lifecycle.
 */
export const Config = z.object({
    outputDir: z.string().default('synthmedia-output').description('生成产物输出目录（相对工作区）。'),
    dataDir: z.string().default('synthmedia-data').description('插件数据目录：自定义下载清单 downloads.json 与模型文件存放处。'),
    providersPatchPath: z.string().default('').description('「从 DSH providers 导入」数据源：profile cordis.patch.yml 的绝对路径（只读）。留空则导入面板不可用。'),
    customProfiles: z.string().default('[]').volatile().description('用户自定义 ProviderProfile（JSON 数组字符串，含 schema 校验；损坏自动忽略并提示）。配置页保存后热生效，无需重载。'),
    providerOrder: z.string().default('[]').volatile().description('ProviderProfile 优先级（JSON 数组字符串，profile id 顺序 = 优先级，靠前优先；未列入的保持既有顺序排在其后）。热生效。'),
    enabledDshResources: z.string().default('[]').volatile().description('从 DSH 订阅账户勾选、允许 SynthMedia 使用的媒体模型（JSON 数组字符串，元素形如 "providerId::modelId"）。热生效。'),
    enabledTools: z.string().default('[]').volatile().description('启用的本地工具链（JSON 数组字符串，取值 ffmpeg|imagemagick|gimp|blender），capabilities 输出 tools 段。热生效。'),
    defaultTimeoutMs: z.number().default(1_800_000).description('默认任务超时（毫秒）。'),
}).description('SynthMedia 配置');
/**
 * Read an OPTIONAL cordis service without requiring it in `inject`.
 *
 * Cordis's context proxy throws `cannot get property "<name>" without inject`
 * for a service the fiber did not declare or that no active provider supplies,
 * so optional services MUST be read through `ctx.get(name)` (undefined until
 * provided — the pattern used by the shipped producers such as dsh-tool-bash)
 * and never by dereferencing `ctx[name]`. A plain-object mock (no `get`) keeps
 * working through a guarded property read.
 */
function readService(ctx, service) {
    if (typeof ctx.get === 'function') {
        try {
            return ctx.get(service);
        }
        catch {
            return undefined;
        }
    }
    try {
        return ctx[service];
    }
    catch {
        return undefined;
    }
}
/**
 * Resolve credentials per call: the host credential provider first (stored
 * reference, then ambient layers), process.env as fallback. Values are never
 * cached here.
 */
function credentialResolver(ctx) {
    const credentials = readService(ctx, 'credentials');
    if (!credentials || typeof credentials.resolve !== 'function')
        return envCredentialResolver;
    return async (ref) => {
        try {
            const resolved = await credentials.resolve(ref);
            if (resolved?.value)
                return resolved.value;
        }
        catch {
            // Provider failures fall through to the environment, never to silence.
        }
        return process.env[ref];
    };
}
/**
 * Unwrap one config field: a volatile live reference (`{get}`, committed by
 * the loader into the running fiber) reads through its getter at CALL time;
 * a plain value passes through unchanged.
 */
function volatileField(value) {
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
        return value.get();
    }
    return value;
}
/**
 * Reactive read view over the plugin config: every key read unwraps volatile
 * live references AT READ TIME, so `live['customProfiles']` always returns
 * the latest GUI save without a plugin remount. Spreads (`{...live}`) still
 * produce plain snapshots for the pure config resolvers.
 */
function liveConfigView(config) {
    return new Proxy(config, {
        get: (target, key) => (typeof key === 'string' ? volatileField(Reflect.get(target, key)) : Reflect.get(target, key)),
    });
}
export function apply(ctx, config = {}) {
    const live = liveConfigView(config);
    const warn = (message) => readService(ctx, 'logger')?.warn?.(message);
    // Runtime factory: invoked once at apply time and again on every volatile
    // update (loader/volatile-update), so GUI profile/routing saves reach the
    // JobManager registry without a plugin remount.
    const buildRuntime = () => {
        // Custom profiles (config-page persistence) merge on top of the built-in
        // presets + profile-patch overrides; corrupt JSON degrades to a warning,
        // never a failed boot.
        const custom = parseCustomProfiles(live['customProfiles']);
        if (custom.error)
            warn(`[dsh-synthmedia] ${custom.error}`);
        const merged = { ...live, backends: mergeCustomBackends({ ...defaultConfig(live).backends }, custom.profiles) };
        let resolved;
        try {
            resolved = resolveConfig(merged);
        }
        catch (err) {
            warn(`[dsh-synthmedia] 配置无效：${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
        const registry = createBackendRegistry(resolved, credentialResolver(ctx));
        return new JobManager(resolved, registry);
    };
    const initial = buildRuntime();
    if (!initial)
        return;
    const jobsRef = { current: initial };
    // Stable tool face over the CURRENT JobManager: the registered agent tools
    // close over this forwarder, so a volatile rebuild swaps the instance under
    // them without re-registering anything.
    const jobsForward = new Proxy({}, {
        get: (_target, prop) => Reflect.get(jobsRef.current, prop),
    });
    const hostJobsRef = { current: undefined };
    // Real host integration: the DSH jobs service is `ctx.jobs` (JobRegistry from
    // @deepseek-ai/dsh-jobs). It is OPTIONAL — a deployment may load no registry,
    // and it may be loaded after this plugin — so it is read through the
    // documented service seam `ctx.get('jobs')` (undefined until provided) and
    // late-bound with `ctx.inject(['jobs'], …)`, exactly as the shipped
    // producers do (e.g. dsh-tool-bash: `ctx.get("jobs")` + `ctx.inject(["jobs"])`).
    // Every job is then registered with an `owner` (the initiating agent session
    // id) so the host can fence access by session.
    // --- Config-page services (system detection, downloads) ------------------
    const disposers = [];
    const pageOptions = {
        dataDir: String(live['dataDir'] ?? '') !== '' ? String(live['dataDir']) : 'synthmedia-data',
        ...(typeof live['providersPatchPath'] === 'string' && live['providersPatchPath'] !== ''
            ? { providersPatchPath: live['providersPatchPath'] }
            : {}),
    };
    // The page services keep the LIVE config view: buildSnapshot/renderText
    // parse customProfiles per call, so a volatile GUI save is reflected in
    // /synthmedia json + providers output immediately (no rebuild needed).
    const page = createPageServices(live, pageOptions, readService(ctx, 'jobs'), credentialResolver(ctx));
    disposers.push(() => page.manager.dispose());
    const adopt = (candidate) => {
        hostJobsRef.current = candidate ?? undefined;
        jobsRef.current.attachHostJobs(candidate);
        page.manager.attachHostJobs(candidate);
    };
    const atLoad = readService(ctx, 'jobs');
    adopt(atLoad);
    if (!atLoad && typeof ctx.inject === 'function') {
        ctx.inject(['jobs'], (jobCtx) => {
            adopt(readService(jobCtx, 'jobs'));
        });
    }
    // Capabilities enrichment (phase one): priority ranks, effective-default
    // marks and ecosystem gates are recomputed from the live config whenever it
    // can change — at apply time and on every volatile update — while the
    // `tools` section probes lazily per call. The extras object identity stays
    // stable, so the already-registered tool definitions observe each refresh
    // (tool registration happens once and is never repeated).
    const capsExtras = {
        tools: async () => {
            const { tools: enabled } = parseEnabledTools(live['enabledTools']);
            return detectToolchain(enabled);
        },
    };
    const refreshCapabilitiesExtras = () => {
        const { order } = parseOrder(live['providerOrder']);
        const priority = {};
        const effectiveDefault = new Set();
        let ecosystem = {};
        let resolved;
        try {
            resolved = effectiveConfig({ ...live }).config;
        }
        catch {
            resolved = undefined;
        }
        if (resolved) {
            const gates = gateBackends(resolved.backends);
            ecosystem = gates;
            order.forEach((id, i) => {
                if (resolved.backends[id])
                    priority[id] = i + 1;
            });
            const modalities = new Set();
            for (const b of Object.values(resolved.backends))
                for (const m of b.modalities)
                    modalities.add(m);
            for (const m of modalities) {
                const d = resolveDefaultProfile(Object.values(resolved.backends), m, order, (p) => gates[p.id]?.supported === true);
                if (d)
                    effectiveDefault.add(d.id);
            }
        }
        capsExtras.priority = priority;
        capsExtras.effectiveDefault = effectiveDefault;
        capsExtras.ecosystem = ecosystem;
    };
    refreshCapabilitiesExtras();
    for (const definition of buildSynthMediaTools(jobsForward, capsExtras)) {
        ctx.tools?.register(definition);
    }
    // Volatile hot reload: a GUI save of any volatile field rebuilds the
    // JobManager + backend registry in place (the running fiber keeps its live
    // `{get}` reference; in-flight jobs of the old instance are dropped by
    // design — the profile SET or routing changed). All four keys are volatile
    // in the Config schema above; other updates are ignored here.
    const VOLATILE_REBUILD_KEYS = new Set(['customProfiles', 'providerOrder', 'enabledDshResources', 'enabledTools']);
    if (typeof ctx.on === 'function') {
        ctx.on('loader/volatile-update', (paths) => {
            if (!Array.isArray(paths) || !paths.some((p) => Array.isArray(p) && typeof p[0] === 'string' && VOLATILE_REBUILD_KEYS.has(p[0])))
                return;
            const next = buildRuntime();
            if (!next)
                return;
            refreshCapabilitiesExtras();
            const old = jobsRef.current;
            jobsRef.current = next;
            next.attachHostJobs(hostJobsRef.current);
            try {
                old.dispose();
            }
            catch { /* idempotent teardown */ }
        });
    }
    // --- /synthmedia command (config-page session transport) -----------------
    // Same registration shape as dsh-cybernetics /cybernetics: a child-scope
    // commands registration executed directly, no model round-trip. The client
    // tab calls it via ctx.remote.commands.execute(sessionId, '/synthmedia …').
    ctx.inject?.(['commands'], (commandCtx) => {
        const registry = commandCtx?.commands;
        if (!registry || typeof registry.register !== 'function')
            return;
        let commandDisposer;
        const handler = (invocation) => {
            const rawInput = typeof invocation?.rawInput === 'string' ? invocation.rawInput : '';
            // Promise result: the command contract serializes the awaited value.
            return runPageCommand(page, rawInput).then((answer) => {
                if (answer.kind === 'error')
                    return { kind: 'error', text: answer.text };
                return { kind: 'success', text: answer.text, ...(answer.json !== undefined ? { json: answer.json } : {}) };
            });
        };
        try {
            commandDisposer = registry.register({
                name: 'synthmedia',
                description: 'SynthMedia 配置页：profiles 一览 / DSH providers 导入数据 / 系统检测 / 离线模型下载',
                input: { hint: '[status|json|providers|detect|fetch-models <baseURL>|dl list|dl start <id>|dl cancel <id>]' },
                handler,
            });
        }
        catch {
            commandDisposer = undefined;
        }
        disposers.push(() => {
            try {
                if (typeof commandDisposer === 'function')
                    commandDisposer();
            }
            catch { /* idempotent teardown */ }
        });
    });
    if (typeof ctx.on === 'function') {
        ctx.on('dispose', () => {
            jobsRef.current.dispose();
            for (const d of disposers)
                d();
        });
    }
}
export { resolveConfig, defaultConfig, ENV_DOC, OUTPUT_DIR_ENV, normalizeProtocol } from './config.js';
export { createBackendRegistry, createBackend } from './backends/index.js';
export { createTaskApiBackend, mapTaskStatus } from './backends/task-api.js';
export { createArkBackend, mapArkStatus, mapTtsTaskStatus, mapArkVideoSize, ARK_VIDEO_RESOLUTIONS, ARK_VIDEO_RATIOS } from './backends/ark.js';
export { createMinimaxBackend, mapMinimaxStatus, mapMinimaxVideoSize, MINIMAX_VIDEO_RESOLUTIONS, MINIMAX_VIDEO_RATIOS, } from './backends/minimax.js';
export { createOpenAICompatibleBackend } from './backends/openai-compatible.js';
export { JobManager } from './jobs.js';
export { buildSynthMediaTools } from './tools.js';
export { SynthError, sanitizeText, sanitizeUnknown, OfflineUnavailableError, maybeOffline } from './errors.js';
export { MODEL_PRESETS, PRESET_MODEL_IDS, PROTOCOLS, PROTOCOL_ARK, PROTOCOL_OPENAI_VIDEO, PROTOCOL_VIDEOGEN, PROTOCOL_OPENAI_CHAT, PROTOCOL_MINIMAX_VIDEO, preset, presetModels, modelCapabilitiesFor, } from './presets.js';
// Config-page surface (server half): snapshot, detection, downloads.
export { effectiveConfig, buildSnapshot, createPageServices, runPageCommand, pageDetect, } from './page/snapshot.js';
export { parseCustomProfiles, backendOf, mergeCustomBackends } from './page/custom.js';
export { classifyModel, parseDshProviders, readDshProviders } from './page/providers.js';
export { remoteModelsUrl, isPrivateHost, guardModelListUrl, fetchRemoteModels, presetBaseUrls, normBase, } from './page/fetch-models.js';
export { collectSystemReport, assessH3, assessDimension, DEFAULT_H3_THRESHOLDS } from './page/system.js';
export { DownloadManager, defaultManifest, validateManifest, httpByteSource } from './page/downloads.js';
export { parseOrder, parseEnabledResources, parseEnabledTools, orderProfiles, resolveDefaultProfile, TOOL_NAMES, } from './page/priority.js';
export { SUPPORTED_ECOSYSTEMS, modelEcosystem, modelGate, profileGate, gateBackends } from './page/ecosystems.js';
export { detectToolchain } from './page/toolchain.js';
//# sourceMappingURL=index.js.map