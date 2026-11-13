import z from '@deepseek-ai/schemastery';
export declare const inject: string[];
export declare const name = "dsh-synthmedia";
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
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    outputDir: z<string, string, "defined">;
    dataDir: z<string, string, "defined">;
    providersPatchPath: z<string, string, "defined">;
    customProfiles: z<string, string, "volatile-defined">;
    defaultTimeoutMs: z<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    outputDir: z<string, string, "defined">;
    dataDir: z<string, string, "defined">;
    providersPatchPath: z<string, string, "defined">;
    customProfiles: z<string, string, "volatile-defined">;
    defaultTimeoutMs: z<number, number, "defined">;
}>>, "plain">;
/** Structural subset of the DSH credential provider (`ctx.credentials`). */
export interface HostCredentials {
    resolve(ref: string): Promise<{
        value: string;
        source?: string;
    } | undefined>;
}
interface SynthMediaContext {
    tools?: {
        register: (d: unknown) => unknown;
    };
    jobs?: unknown;
    credentials?: HostCredentials;
    logger?: {
        warn?: (m: string) => void;
    };
    on?: (ev: string, listener: (...args: unknown[]) => void) => void;
    /** Cordis service read: `ctx.get('jobs')` is undefined until provided. */
    get?: (name: string) => unknown;
    /** Cordis optional dependency: run the callback once the services exist. */
    inject?: (deps: string[], callback: (ctx: SynthMediaContext) => unknown) => unknown;
}
export declare function apply(ctx: SynthMediaContext, config?: Record<string, unknown>): void;
export { resolveConfig, defaultConfig, ENV_DOC, OUTPUT_DIR_ENV, normalizeProtocol } from './config.js';
export { createBackendRegistry, createBackend } from './backends/index.js';
export { createTaskApiBackend, mapTaskStatus } from './backends/task-api.js';
export { createArkBackend, mapArkStatus, mapTtsTaskStatus, mapArkVideoSize, ARK_VIDEO_RESOLUTIONS, ARK_VIDEO_RATIOS } from './backends/ark.js';
export { createMinimaxBackend, mapMinimaxStatus, mapMinimaxVideoSize, MINIMAX_VIDEO_RESOLUTIONS, MINIMAX_VIDEO_RATIOS, } from './backends/minimax.js';
export { createOpenAICompatibleBackend } from './backends/openai-compatible.js';
export { JobManager } from './jobs.js';
export type { HostJobRegistry, HostJobHandle, HostJobHooks, HostJobOwner, HostJobSpec } from './jobs.js';
export { buildSynthMediaTools } from './tools.js';
export { SynthError, sanitizeText, sanitizeUnknown, OfflineUnavailableError, maybeOffline } from './errors.js';
export { MODEL_PRESETS, PRESET_MODEL_IDS, PROTOCOLS, PROTOCOL_ARK, PROTOCOL_OPENAI_VIDEO, PROTOCOL_VIDEOGEN, PROTOCOL_OPENAI_CHAT, PROTOCOL_MINIMAX_VIDEO, preset, presetModels, modelCapabilitiesFor, } from './presets.js';
export type * from './types.js';
export type { SynthMediaConfig, BackendConfig, TtsProfile } from './config.js';
export type { CredentialResolver } from './http.js';
export { effectiveConfig, buildSnapshot, createPageServices, runPageCommand, pageDetect, } from './page/snapshot.js';
export type { PageSnapshot, ProfileView, PageServices, PageOptions } from './page/snapshot.js';
export { parseCustomProfiles, backendOf, mergeCustomBackends } from './page/custom.js';
export type { CustomProfileInput, CustomProfilesResult } from './page/custom.js';
export { classifyModel, parseDshProviders, readDshProviders } from './page/providers.js';
export type { DshProviderEntry, DshModelEntry, Ecosystem } from './page/providers.js';
export { remoteModelsUrl, isPrivateHost, guardModelListUrl, fetchRemoteModels, presetBaseUrls, normBase, } from './page/fetch-models.js';
export type { GuardedModelListUrl, RemoteModelsResult, GuardOptions, HostAddress, HostLookup, } from './page/fetch-models.js';
export { collectSystemReport, assessH3, assessDimension, DEFAULT_H3_THRESHOLDS } from './page/system.js';
export type { SystemReport, H3Assessment, H3Thresholds, DimensionAssessment, Verdict } from './page/system.js';
export { DownloadManager, defaultManifest, validateManifest, httpByteSource } from './page/downloads.js';
export type { DownloadEntry, DownloadProgress, DownloadManifest, ByteSource } from './page/downloads.js';
