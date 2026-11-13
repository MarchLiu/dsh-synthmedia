/** Normalized (trim, strip trailing slashes, lowercase) URL/baseUrl form. */
export declare function normBase(url: unknown): string;
/**
 * OpenAI-compatible model-list URL for a base: a /v1-style base already
 * carries the version segment (…/v1, …/plan/v3) and only needs /models;
 * anything else gets /v1/models appended. Returns null for empty input.
 */
export declare function remoteModelsUrl(baseURL: unknown): string | null;
/** IPv4/IPv6 loopback, private (RFC1918), link-local or unspecified host. */
export declare function isPrivateHost(hostname: string): boolean;
/** One DNS answer (family is advisory; the address is what gets checked). */
export interface HostAddress {
    readonly address: string;
    readonly family?: number;
}
/** Async hostname → addresses resolver; injectable so tests never hit DNS. */
export type HostLookup = (hostname: string) => Promise<readonly HostAddress[]>;
export type GuardedModelListUrl = {
    readonly ok: true;
    readonly url: string;
} | {
    readonly ok: false;
    readonly reason: string;
};
/** Guard knobs: the DNS resolver is injectable so tests stay offline. */
export interface GuardOptions {
    readonly lookup?: HostLookup;
}
/**
 * SSRF guard for one model-list URL: http/https only, no embedded
 * credentials, and loopback/private/link-local hosts refused unless the base
 * URL exactly matches one of the allowed preset baseUrls (normalized — an
 * operator-configured preset is an explicit allowlist entry). The hostname is
 * then resolved and EVERY answer must be public; that catches names such as
 * 127.0.0.1.nip.io whose literal host is public but whose DNS answer is not.
 * Async because resolution is async; a preset match skips resolution.
 */
export declare function guardModelListUrl(baseURL: unknown, allowedPresetBases?: readonly string[], opts?: GuardOptions): Promise<GuardedModelListUrl>;
export type RemoteModelsResult = {
    readonly ok: true;
    readonly models: ReadonlyArray<{
        readonly id: string;
        readonly name?: string;
    }>;
} | {
    readonly ok: false;
    readonly reason: string;
};
/**
 * Fetch the live model list for one base URL. `token` (user-pasted) and
 * `resolveCredential` (host credential resolver by env NAME) feed the single
 * request's Authorization header in memory only; neither ever reaches the
 * returned value. Any failure resolves {ok:false, reason} — no throw.
 */
export declare function fetchRemoteModels(baseURL: unknown, opts?: {
    readonly allowedPresetBases?: readonly string[];
    readonly token?: string | undefined;
    readonly resolveCredential?: ((name: string) => Promise<string | undefined>) | undefined;
    readonly authEnv?: string | undefined;
    readonly fetchImpl?: typeof fetch;
    readonly lookup?: HostLookup;
    readonly timeoutMs?: number;
}): Promise<RemoteModelsResult>;
/** Preset baseUrls of the effective config (the explicit allowlist). */
export declare function presetBaseUrls(config: Record<string, unknown>): string[];
