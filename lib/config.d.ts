import type { Modality, ProtocolKind } from './types.js';
/** Canonical wire-protocol id (legacy `kind` spellings are normalised). */
export type BackendKind = ProtocolKind;
/** Official Doubao async TTS request/response tunables (all overridable). */
export interface TtsProfile {
    /** Value of the resource-id header, e.g. `seed-tts-2.0`. */
    readonly resourceId?: string;
    /** Credit-card style speaker id; required by the official submit body. */
    readonly speaker?: string;
    /** Audio container: mp3 | pcm | ogg_opus (official default mp3). */
    readonly format?: 'mp3' | 'pcm' | 'ogg_opus';
    /** Sample rate in Hz (official default 24000). */
    readonly sampleRate?: number;
    /** Body `user.uid` (non-secret account label). */
    readonly uid?: string;
    /** Header carrying the API key (official: X-Api-Key). */
    readonly apiKeyHeader?: string;
    /** Header carrying the resource id (official: X-Api-Resource-Id). */
    readonly resourceHeader?: string;
    /** Header carrying the request id (official: X-Api-Request-Id). */
    readonly requestIdHeader?: string;
}
export interface BackendConfig {
    readonly id: string;
    /** Wire protocol; selects the adapter. */
    readonly protocol: ProtocolKind;
    /** Default model id (must be in `models`). */
    readonly model: string;
    /** Every model id routable on this profile (default `[model]`). */
    readonly models?: readonly string[];
    readonly modalities: ReadonlyArray<Modality>;
    /** Base URL, no trailing slash. */
    readonly baseUrl: string;
    /**
     * Environment variable NAME holding the credential. Read at request time
     * (through the DSH credential provider when present) and never persisted.
     */
    readonly authEnv?: string;
    /** DSH credential reference; defaults to `authEnv`. Also just a name. */
    readonly credentialRef?: string;
    readonly authStyle: 'bearer' | 'basic' | 'raw' | 'none';
    /** Header that carries the credential (default `Authorization`). */
    readonly authHeader?: string;
    /** Static, non-secret headers merged into every request. */
    readonly headers?: Readonly<Record<string, string>>;
    /**
     * Static query parameters appended to every request URL. A generic protocol
     * knob, not a provider branch: gateways that require e.g. a `GroupId` or an
     * `api-version` query parameter are configured here.
     */
    readonly queryParams?: Readonly<Record<string, string>>;
    /**
     * Default video duration when a request omits `durationSeconds` and the
     * model has no capability preset (protocols that require a duration).
     */
    readonly defaultDurationSeconds?: number;
    readonly online: boolean;
    readonly timeoutMs: number;
    /** Async-task profiles: paths relative to baseUrl. */
    readonly paths?: {
        readonly submit: string;
        /** May contain {id} for task APIs; TTS query takes the id in the body. */
        readonly status: string;
        readonly content?: string;
        readonly cancel?: string;
    };
    readonly pollIntervalMs?: number;
    /** Submit body encoding: 'json' (default) or 'multipart' (vLLM-Omni form). */
    readonly submitEncoding?: 'json' | 'multipart';
    /** HTTP method for the cancel path (vLLM-Omni uses DELETE). Default POST. */
    readonly cancelMethod?: 'POST' | 'DELETE';
    /** Send `seconds` as a JSON string (hub /v1/videos verifies with "4"). */
    readonly secondsAsString?: boolean;
    /** Optional synchronous endpoint returning raw video bytes (/v1/videos/sync). */
    readonly syncEndpoint?: string;
    /** Extra static JSON body fields merged into submit payloads. */
    readonly extraBody?: Record<string, unknown>;
    /** Wire-shape verification (official docs / harness). Gates real submission. */
    readonly protocolVerified?: boolean;
    /**
     * A REAL call against THIS deployment has succeeded. Independent of
     * `protocolVerified`; false means "documented or mocked, never called live".
     */
    readonly liveVerified?: boolean;
    /** When true create() refuses to submit anything (guard). */
    readonly blockRealSubmit?: boolean;
    /** Volcengine Ark TTS tunables (voice async API). */
    readonly tts?: TtsProfile;
}
export interface SynthMediaConfig {
    readonly outputDir: string;
    readonly backends: Readonly<Record<string, BackendConfig>>;
    readonly defaultTimeoutMs: number;
}
export declare const OUTPUT_DIR_ENV = "SYNTHMEDIA_OUTPUT_DIR";
/** Environment variable names documented in the README (names only). */
export declare const ENV_DOC: {
    readonly zgciApiKey: "SYNTHMEDIA_ZGCI_API_KEY";
    readonly bzaApiKey: "SYNTHMEDIA_BZA_API_KEY";
    readonly bzaBaseUrl: "SYNTHMEDIA_BZA_BASE_URL";
    readonly minimaxApiKey: "MINIMAX_API_KEY";
    readonly minimaxApiKeyEnv: "SYNTHMEDIA_MINIMAX_API_KEY_ENV";
    readonly minimaxBaseUrl: "SYNTHMEDIA_MINIMAX_BASE_URL";
    readonly minimaxModels: "SYNTHMEDIA_MINIMAX_MODELS";
    readonly minimaxModel: "SYNTHMEDIA_MINIMAX_MODEL";
    readonly minimaxRelayApiKey: "SYNTHMEDIA_MINIMAX_RELAY_API_KEY";
    readonly minimaxRelayBaseUrl: "SYNTHMEDIA_MINIMAX_RELAY_BASE_URL";
    readonly dashscopeApiKey: "SYNTHMEDIA_DASHSCOPE_API_KEY";
    readonly dashscopeApiKeyEnv: "SYNTHMEDIA_DASHSCOPE_API_KEY_ENV";
    readonly dashscopeBaseUrl: "SYNTHMEDIA_DASHSCOPE_BASE_URL";
    readonly dashscopeVideoModels: "SYNTHMEDIA_DASHSCOPE_VIDEO_MODELS";
    readonly dashscopeVideoModel: "SYNTHMEDIA_DASHSCOPE_VIDEO_MODEL";
    readonly dashscopeImageModels: "SYNTHMEDIA_DASHSCOPE_IMAGE_MODELS";
    readonly dashscopeImageModel: "SYNTHMEDIA_DASHSCOPE_IMAGE_MODEL";
    readonly geminiApiKey: "SYNTHMEDIA_GEMINI_API_KEY";
    readonly geminiApiKeyEnv: "SYNTHMEDIA_GEMINI_API_KEY_ENV";
    readonly geminiBaseUrl: "SYNTHMEDIA_GEMINI_BASE_URL";
    readonly geminiImageModels: "SYNTHMEDIA_GEMINI_IMAGE_MODELS";
    readonly geminiImageModel: "SYNTHMEDIA_GEMINI_IMAGE_MODEL";
    readonly geminiVideoModels: "SYNTHMEDIA_GEMINI_VIDEO_MODELS";
    readonly geminiVideoModel: "SYNTHMEDIA_GEMINI_VIDEO_MODEL";
    readonly openaiApiKey: "SYNTHMEDIA_OPENAI_API_KEY";
    readonly openaiApiKeyEnv: "SYNTHMEDIA_OPENAI_API_KEY_ENV";
    readonly openaiBaseUrl: "SYNTHMEDIA_OPENAI_BASE_URL";
    readonly openaiImageModels: "SYNTHMEDIA_OPENAI_IMAGE_MODELS";
    readonly openaiImageModel: "SYNTHMEDIA_OPENAI_IMAGE_MODEL";
    readonly localH3Auth: "SYNTHMEDIA_LOCAL_H3_AUTH";
    readonly localH3BaseUrl: "SYNTHMEDIA_LOCAL_H3_BASE_URL";
    readonly localH3SidecarBaseUrl: "SYNTHMEDIA_LOCAL_H3_SIDECAR_BASE_URL";
    readonly outputDir: "SYNTHMEDIA_OUTPUT_DIR";
};
/**
 * Normalise a configured protocol id. Accepts the canonical ids plus the
 * legacy spellings used by earlier versions (`ark`, `task-api`,
 * `openai-compatible`). Unknown ids are a hard configuration error — never a
 * silent guess.
 */
export declare function normalizeProtocol(value: unknown, id?: string): ProtocolKind;
/**
 * Default ProviderProfiles. Every value is an example that a user overrides
 * through config/env — nothing here is required by the protocol adapters.
 */
export declare function defaultConfig(overrides?: Record<string, unknown>): SynthMediaConfig;
/** Validate one profile; throws SynthError('E_CONFIG') on problems. */
export declare function validateBackend(b: BackendConfig): void;
/** Resolve config with overrides; used by apply() and tests. */
export declare function resolveConfig(config?: Record<string, unknown>): SynthMediaConfig;
