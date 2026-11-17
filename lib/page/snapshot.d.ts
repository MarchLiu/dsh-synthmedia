import type { SynthMediaConfig } from '../config.js';
import { type DshProviderEntry } from './providers.js';
import { type SystemReport, type H3Assessment } from './system.js';
import { type ToolName } from './priority.js';
import { type EcosystemGate } from './ecosystems.js';
import { type ToolStatus } from './toolchain.js';
import { DownloadManager, readOptionalText, type DownloadProgress } from './downloads.js';
import { type HostLookup } from './fetch-models.js';
/** Page-scoped knobs (subset of the plugin Config schema). */
export interface PageOptions {
    readonly dataDir: string;
    readonly providersPatchPath?: string;
}
export interface ProfileView {
    readonly id: string;
    readonly protocol: string;
    readonly baseUrl: string;
    readonly models: readonly string[];
    readonly modalities: readonly string[];
    /** Environment-variable NAME only — never a value. */
    readonly authEnv?: string;
    readonly online: boolean;
    readonly protocolVerified: boolean;
    readonly liveVerified: boolean;
    readonly blockRealSubmit: boolean;
    readonly source: 'preset' | 'custom' | 'custom-override';
    /** 1-based position in providerOrder (phase one; absent = unranked). */
    readonly priority?: number;
    /** True when this profile is the effective default for one of its modalities. */
    readonly effectiveDefault?: boolean;
    /** Ecosystem gate (phase one): h3 | seedance | other + supported flag. */
    readonly ecosystem?: string;
    readonly supported?: boolean;
    readonly ecosystemReason?: string;
}
export interface PageSnapshot {
    readonly profiles: readonly ProfileView[];
    readonly providers: readonly DshProviderEntry[];
    readonly providersError?: string;
    readonly downloads: readonly DownloadProgress[];
    readonly downloadManifest: {
        readonly downloadsDir: string;
        readonly entries: readonly unknown[];
    };
    readonly customProfilesError?: string;
    readonly dataDir: string;
    /** Phase-one additions (back-compat: extra fields only). */
    readonly order: readonly string[];
    readonly enabledDshResources: readonly string[];
    readonly enabledTools: readonly string[];
    readonly ecosystems: Readonly<Record<string, EcosystemGate>>;
    readonly tools?: readonly ToolStatus[];
    /** Parse warnings from the new JSON-array config fields (never thrown). */
    readonly configWarnings?: readonly string[];
}
/**
 * Effective configuration = built-in presets + config backends overrides +
 * parsed customProfiles (validated; corrupt → ignored with diagnostics).
 */
export declare function effectiveConfig(config: Record<string, unknown>): {
    config: SynthMediaConfig;
    customError?: string;
};
/** Everything the config page (settings card + session tab) renders. */
export declare function buildSnapshot(config: Record<string, unknown>, options: PageOptions, extras?: {
    readonly providers?: readonly DshProviderEntry[];
    readonly providersError?: string;
    readonly downloads?: readonly DownloadProgress[];
    readonly downloadManifest?: {
        downloadsDir: string;
        entries: readonly unknown[];
    };
    readonly tools?: readonly ToolStatus[];
}): PageSnapshot;
/** Read providers from the configured patch path (safe: read-only, one file). */
export declare function loadProviders(patchPath?: string): {
    providers: readonly DshProviderEntry[];
    error?: string;
};
/** Minimal structural face of the JobManager the page commands use. */
export interface PageJobs {
    get(id: string): Promise<{
        id: string;
        artifacts: ReadonlyArray<{
            path: string;
        }>;
        owner?: string;
        ancestors?: readonly string[];
    } | undefined>;
    list(filter?: {
        owner?: string;
        session?: string;
        limit?: number;
    }): Promise<Array<Record<string, unknown>>>;
    cancel(id: string): Promise<Record<string, unknown>>;
}
/** Services the page command handlers run against. */
export interface PageServices {
    readonly manager: DownloadManager;
    readonly options: PageOptions;
    /** Live config captured from apply(); customProfiles parsed per call. */
    readonly config: Record<string, unknown>;
    /** Optional host credential resolver (env NAME → value, in memory only). */
    readonly resolveCredential?: (name: string) => Promise<string | undefined>;
    /** Optional DNS resolver for the fetch-models SSRF guard (tests inject it). */
    readonly lookup?: HostLookup;
    /** Optional toolchain probe (tests inject a scripted one; no process spawn). */
    readonly detectTools?: (enabled: readonly ToolName[]) => Promise<readonly ToolStatus[]>;
    /** Optional system-report collector (tests inject a stub; defaults to real probes). */
    readonly collectReport?: (dir: string) => Promise<SystemReport>;
    /** Optional JobManager face for `/synthmedia jobs` + `reveal`. */
    readonly jobs?: PageJobs;
    /** Absolute output root for the reveal fence (resolve(outputDir)). */
    readonly outputRoot?: () => string;
    /**
     * Reveal implementation (defaults to task-agent.revealArtifact with
     * process.platform). Tests inject a spy — never spawn in tests.
     */
    readonly reveal?: (filePath: string) => Promise<void>;
    /** Origin-absolute download route base when the host webserver is present. */
    downloadBase?: string;
}
export declare function createPageServices(config: Record<string, unknown>, options: PageOptions, hostJobs?: unknown, resolveCredential?: (name: string) => Promise<string | undefined>, jobs?: PageJobs, outputRoot?: () => string): PageServices;
export declare function pageDetect(services: PageServices): Promise<{
    report: SystemReport;
    assessment: H3Assessment;
}>;
/** Human text for the /synthmedia command. */
export declare function renderText(services: PageServices, providers: readonly DshProviderEntry[], providersError?: string): string;
/**
 * `/synthmedia` subcommand execution. Returns { kind, text, json? } where
 * `json` carries the machine-readable payload the client tab renders.
 */
export declare function runPageCommand(services: PageServices, rawInput: string, opts?: {
    caller?: string;
}): Promise<{
    kind: 'success' | 'error';
    text: string;
    json?: unknown;
}>;
export { readOptionalText };
