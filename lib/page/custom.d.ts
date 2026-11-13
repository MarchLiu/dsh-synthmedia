import type { BackendConfig } from '../config.js';
export interface CustomProfileInput {
    readonly id: string;
    readonly protocol: string;
    readonly baseUrl: string;
    readonly authEnv?: string;
    readonly authStyle?: 'bearer' | 'basic' | 'raw' | 'none';
    /** Custom header that carries the credential (e.g. Ark TTS `X-Api-Key`). */
    readonly authHeader?: string;
    readonly models: readonly string[];
    readonly modalities: ReadonlyArray<'video' | 'image' | 'audio'>;
    /** Optional path overrides; per-protocol defaults apply when omitted. */
    readonly paths?: {
        readonly submit: string;
        readonly status?: string;
        readonly content?: string;
        readonly cancel?: string;
    };
    /** Ark TTS tunables (required for `audio` modality: voice id). */
    readonly tts?: {
        readonly speaker: string;
        readonly uid?: string;
        readonly format?: string;
        readonly sampleRate?: number;
        /** X-Api-Resource-Id header value, e.g. `seed-tts-2.0`. */
        readonly resourceId?: string;
    };
    readonly protocolVerified?: boolean;
    readonly liveVerified?: boolean;
    readonly online?: boolean;
}
export interface CustomProfilesResult {
    readonly profiles: readonly CustomProfileInput[];
    /** Present when the stored JSON was corrupt / invalid (UI shows it). */
    readonly error?: string;
}
/**
 * Parse and validate the stored customProfiles JSON. Never throws: problems
 * are reported through `error` and the valid prefix of entries is kept.
 */
export declare function parseCustomProfiles(raw: unknown): CustomProfilesResult;
/** Materialize one custom profile as a BackendConfig for validation/merge. */
export declare function backendOf(p: CustomProfileInput): BackendConfig;
/**
 * Merge custom profiles into a base backends map (custom wins over built-ins
 * with the same id so users can effectively replace a preset).
 */
export declare function mergeCustomBackends(base: Record<string, BackendConfig>, custom: readonly CustomProfileInput[]): Record<string, BackendConfig>;
