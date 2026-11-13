import type { SynthMediaConfig } from '../config.js';
import { type DshProviderEntry } from './providers.js';
import { type SystemReport, type H3Assessment } from './system.js';
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
}): PageSnapshot;
/** Read providers from the configured patch path (safe: read-only, one file). */
export declare function loadProviders(patchPath?: string): {
    providers: readonly DshProviderEntry[];
    error?: string;
};
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
}
export declare function createPageServices(config: Record<string, unknown>, options: PageOptions, hostJobs?: unknown, resolveCredential?: (name: string) => Promise<string | undefined>): PageServices;
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
export declare function runPageCommand(services: PageServices, rawInput: string): Promise<{
    kind: 'success' | 'error';
    text: string;
    json?: unknown;
}>;
export { readOptionalText };
