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
import { JobManager, type HostJobRegistry } from './jobs.js';
import { buildSynthMediaTools } from './tools.js';
import { envCredentialResolver, type CredentialResolver } from './http.js';
import { parseCustomProfiles } from './page/custom.js';
import { mergeCustomBackends } from './page/custom.js';
import {
  createPageServices,
  runPageCommand,
  effectiveConfig,
  type PageServices,
} from './page/snapshot.js';
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
  defaultTimeoutMs: z.number().default(1_800_000).description('默认任务超时（毫秒）。'),
}).description('SynthMedia 配置');

/** Structural subset of the DSH credential provider (`ctx.credentials`). */
export interface HostCredentials {
  resolve(ref: string): Promise<{ value: string; source?: string } | undefined>;
}

interface SynthMediaContext {
  tools?: { register: (d: unknown) => unknown };
  jobs?: unknown;
  credentials?: HostCredentials;
  logger?: { warn?: (m: string) => void };
  on?: (ev: string, listener: (...args: unknown[]) => void) => void;
  /** Cordis service read: `ctx.get('jobs')` is undefined until provided. */
  get?: (name: string) => unknown;
  /** Cordis optional dependency: run the callback once the services exist. */
  inject?: (deps: string[], callback: (ctx: SynthMediaContext) => unknown) => unknown;
}

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
function readService<T>(ctx: SynthMediaContext, service: string): T | undefined {
  if (typeof ctx.get === 'function') {
    try {
      return ctx.get(service) as T | undefined;
    } catch {
      return undefined;
    }
  }
  try {
    return (ctx as unknown as Record<string, unknown>)[service] as T | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve credentials per call: the host credential provider first (stored
 * reference, then ambient layers), process.env as fallback. Values are never
 * cached here.
 */
function credentialResolver(ctx: SynthMediaContext): CredentialResolver {
  const credentials = readService<HostCredentials>(ctx, 'credentials');
  if (!credentials || typeof credentials.resolve !== 'function') return envCredentialResolver;
  return async (ref: string) => {
    try {
      const resolved = await credentials.resolve(ref);
      if (resolved?.value) return resolved.value;
    } catch {
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
function volatileField(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get: () => unknown }).get();
  }
  return value;
}

/**
 * Reactive read view over the plugin config: every key read unwraps volatile
 * live references AT READ TIME, so `live['customProfiles']` always returns
 * the latest GUI save without a plugin remount. Spreads (`{...live}`) still
 * produce plain snapshots for the pure config resolvers.
 */
function liveConfigView(config: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(config, {
    get: (target, key) => (typeof key === 'string' ? volatileField(Reflect.get(target, key)) : Reflect.get(target, key)),
  });
}

export function apply(ctx: SynthMediaContext, config: Record<string, unknown> = {}): void {
  const live = liveConfigView(config);
  const warn = (message: string) => readService<{ warn?: (m: string) => void }>(ctx, 'logger')?.warn?.(message);
  // Runtime factory: invoked once at apply time and again on every
  // `customProfiles` volatile update (loader/volatile-update), so GUI profile
  // saves reach the JobManager registry without a plugin remount.
  const buildRuntime = (): JobManager | null => {
    // Custom profiles (config-page persistence) merge on top of the built-in
    // presets + profile-patch overrides; corrupt JSON degrades to a warning,
    // never a failed boot.
    const custom = parseCustomProfiles(live['customProfiles']);
    if (custom.error) warn(`[dsh-synthmedia] ${custom.error}`);
    const merged = { ...live, backends: mergeCustomBackends({ ...defaultConfig(live).backends }, custom.profiles) };
    let resolved;
    try {
      resolved = resolveConfig(merged);
    } catch (err) {
      warn(`[dsh-synthmedia] 配置无效：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    const registry = createBackendRegistry(resolved, credentialResolver(ctx));
    return new JobManager(resolved, registry);
  };
  const initial = buildRuntime();
  if (!initial) return;
  const jobsRef = { current: initial };
  // Stable tool face over the CURRENT JobManager: the registered agent tools
  // close over this forwarder, so a volatile rebuild swaps the instance under
  // them without re-registering anything.
  const jobsForward = new Proxy({}, {
    get: (_target, prop) => Reflect.get(jobsRef.current as object, prop),
  }) as unknown as JobManager;
  const hostJobsRef = { current: undefined as HostJobRegistry | undefined };
  // Real host integration: the DSH jobs service is `ctx.jobs` (JobRegistry from
  // @deepseek-ai/dsh-jobs). It is OPTIONAL — a deployment may load no registry,
  // and it may be loaded after this plugin — so it is read through the
  // documented service seam `ctx.get('jobs')` (undefined until provided) and
  // late-bound with `ctx.inject(['jobs'], …)`, exactly as the shipped
  // producers do (e.g. dsh-tool-bash: `ctx.get("jobs")` + `ctx.inject(["jobs"])`).
  // Every job is then registered with an `owner` (the initiating agent session
  // id) so the host can fence access by session.
  // --- Config-page services (system detection, downloads) ------------------
  const disposers: Array<() => void> = [];
  const pageOptions = {
    dataDir: String(live['dataDir'] ?? '') !== '' ? String(live['dataDir']) : 'synthmedia-data',
    ...(typeof live['providersPatchPath'] === 'string' && live['providersPatchPath'] !== ''
      ? { providersPatchPath: live['providersPatchPath'] }
      : {}),
  };
  // The page services keep the LIVE config view: buildSnapshot/renderText
  // parse customProfiles per call, so a volatile GUI save is reflected in
  // /synthmedia json + providers output immediately (no rebuild needed).
  const page: PageServices = createPageServices(live, pageOptions, readService<HostJobRegistry>(ctx, 'jobs'), credentialResolver(ctx));
  disposers.push(() => page.manager.dispose());
  const adopt = (candidate: unknown): void => {
    hostJobsRef.current = (candidate as HostJobRegistry | undefined) ?? undefined;
    jobsRef.current.attachHostJobs(candidate as HostJobRegistry | undefined);
    page.manager.attachHostJobs(candidate as HostJobRegistry | undefined);
  };
  const atLoad = readService<HostJobRegistry>(ctx, 'jobs');
  adopt(atLoad);
  if (!atLoad && typeof ctx.inject === 'function') {
    ctx.inject(['jobs'], (jobCtx) => {
      adopt(readService<HostJobRegistry>(jobCtx, 'jobs'));
    });
  }

  for (const definition of buildSynthMediaTools(jobsForward)) {
    ctx.tools?.register(definition);
  }

  // Volatile hot reload: a GUI save of `customProfiles` rebuilds the
  // JobManager + backend registry in place (the running fiber keeps its live
  // `{get}` reference; in-flight jobs of the old instance are dropped by
  // design — the profile SET changed). Other volatile paths never exist, so
  // any other update is ignored here.
  if (typeof ctx.on === 'function') {
    ctx.on('loader/volatile-update', (paths: unknown) => {
      if (!Array.isArray(paths) || !paths.some((p) => Array.isArray(p) && p[0] === 'customProfiles')) return;
      const next = buildRuntime();
      if (!next) return;
      const old = jobsRef.current;
      jobsRef.current = next;
      next.attachHostJobs(hostJobsRef.current);
      try { old.dispose(); } catch { /* idempotent teardown */ }
    });
  }

  // --- /synthmedia command (config-page session transport) -----------------
  // Same registration shape as dsh-cybernetics /cybernetics: a child-scope
  // commands registration executed directly, no model round-trip. The client
  // tab calls it via ctx.remote.commands.execute(sessionId, '/synthmedia …').
  ctx.inject?.(['commands'], (commandCtx: unknown) => {
    const registry = (commandCtx as { commands?: { register: (d: unknown) => () => void } })?.commands;
    if (!registry || typeof registry.register !== 'function') return;
    let commandDisposer: (() => void) | undefined;
    const handler = (invocation: { rawInput?: string }) => {
      const rawInput = typeof invocation?.rawInput === 'string' ? invocation.rawInput : '';
      // Promise result: the command contract serializes the awaited value.
      return runPageCommand(page, rawInput).then((answer) => {
        if (answer.kind === 'error') return { kind: 'error' as const, text: answer.text };
        return { kind: 'success' as const, text: answer.text, ...(answer.json !== undefined ? { json: answer.json } : {}) };
      });
    };
    try {
      commandDisposer = registry.register({
        name: 'synthmedia',
        description: 'SynthMedia 配置页：profiles 一览 / DSH providers 导入数据 / 系统检测 / 离线模型下载',
        input: { hint: '[status|json|providers|detect|fetch-models <baseURL>|dl list|dl start <id>|dl cancel <id>]' },
        handler,
      });
    } catch {
      commandDisposer = undefined;
    }
    disposers.push(() => {
      try { if (typeof commandDisposer === 'function') commandDisposer(); } catch { /* idempotent teardown */ }
    });
  });

  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      jobsRef.current.dispose();
      for (const d of disposers) d();
    });
  }
}

export { resolveConfig, defaultConfig, ENV_DOC, OUTPUT_DIR_ENV, normalizeProtocol } from './config.js';
export { createBackendRegistry, createBackend } from './backends/index.js';
export { createTaskApiBackend, mapTaskStatus } from './backends/task-api.js';
export { createArkBackend, mapArkStatus, mapTtsTaskStatus, mapArkVideoSize, ARK_VIDEO_RESOLUTIONS, ARK_VIDEO_RATIOS } from './backends/ark.js';
export {
  createMinimaxBackend,
  mapMinimaxStatus,
  mapMinimaxVideoSize,
  MINIMAX_VIDEO_RESOLUTIONS,
  MINIMAX_VIDEO_RATIOS,
} from './backends/minimax.js';
export { createOpenAICompatibleBackend } from './backends/openai-compatible.js';
export { JobManager } from './jobs.js';
export type { HostJobRegistry, HostJobHandle, HostJobHooks, HostJobOwner, HostJobSpec } from './jobs.js';
export { buildSynthMediaTools } from './tools.js';
export { SynthError, sanitizeText, sanitizeUnknown, OfflineUnavailableError, maybeOffline } from './errors.js';
export {
  MODEL_PRESETS,
  PRESET_MODEL_IDS,
  PROTOCOLS,
  PROTOCOL_ARK,
  PROTOCOL_OPENAI_VIDEO,
  PROTOCOL_VIDEOGEN,
  PROTOCOL_OPENAI_CHAT,
  PROTOCOL_MINIMAX_VIDEO,
  preset,
  presetModels,
  modelCapabilitiesFor,
} from './presets.js';
export type * from './types.js';
export type { SynthMediaConfig, BackendConfig, TtsProfile } from './config.js';
export type { CredentialResolver } from './http.js';
// Config-page surface (server half): snapshot, detection, downloads.
export {
  effectiveConfig, buildSnapshot, createPageServices, runPageCommand, pageDetect,
} from './page/snapshot.js';
export type { PageSnapshot, ProfileView, PageServices, PageOptions } from './page/snapshot.js';
export { parseCustomProfiles, backendOf, mergeCustomBackends } from './page/custom.js';
export type { CustomProfileInput, CustomProfilesResult } from './page/custom.js';
export { classifyModel, parseDshProviders, readDshProviders } from './page/providers.js';
export type { DshProviderEntry, DshModelEntry, Ecosystem } from './page/providers.js';
export {
  remoteModelsUrl, isPrivateHost, guardModelListUrl, fetchRemoteModels, presetBaseUrls, normBase,
} from './page/fetch-models.js';
export type {
  GuardedModelListUrl, RemoteModelsResult, GuardOptions, HostAddress, HostLookup,
} from './page/fetch-models.js';
export { collectSystemReport, assessH3, assessDimension, DEFAULT_H3_THRESHOLDS } from './page/system.js';
export type { SystemReport, H3Assessment, H3Thresholds, DimensionAssessment, Verdict } from './page/system.js';
export { DownloadManager, defaultManifest, validateManifest, httpByteSource } from './page/downloads.js';
export type { DownloadEntry, DownloadProgress, DownloadManifest, ByteSource } from './page/downloads.js';
