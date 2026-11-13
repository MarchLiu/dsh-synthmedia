/**
 * SynthMedia shared types: generation requests, jobs, artifacts, backends.
 * @module
 */
/** Generation modality. */
export type Modality = 'video' | 'text' | 'image' | 'audio';
/** A normalized generation request handed to a backend. */
export interface GenerationRequest {
    readonly backend: string;
    readonly model: string;
    readonly modality: Modality;
    readonly prompt: string;
    readonly negativePrompt?: string;
    /** Seconds (video) clamped by the backend to its supported range. */
    readonly durationSeconds?: number;
    /** "WxH" or "W*H"; backends map to their supported sizes. */
    readonly size?: string;
    readonly seed?: number;
    /** Extra backend-specific options; never carries credentials. */
    readonly options?: Record<string, unknown>;
}
/** Immutable artifact produced by a finished job. */
export interface Artifact {
    readonly path: string;
    readonly kind: 'video' | 'text' | 'image' | 'audio' | 'json';
    readonly bytes?: number;
    readonly mimeType?: string;
}
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timeout';
/** Unified async job record. */
export interface JobRecord {
    readonly id: string;
    readonly backend: string;
    readonly model: string;
    readonly modality: Modality;
    readonly promptPreview: string;
    status: JobStatus;
    progress: number;
    createdAt: string;
    updatedAt: string;
    /** LOCAL clock: this job finished (after any artifact download completed). */
    finishedAt?: string;
    /**
     * REMOTE clock: when the provider says the task reached a terminal state
     * (`completed_at`, or the `updated_at` of a terminal status). Never set from
     * local time and never used in place of `finishedAt`; undefined when the
     * provider reports no timestamp.
     */
    remoteCompletedAt?: string;
    /**
     * LOCAL clock: the artifact bytes finished downloading/writing. Set only for
     * fetched (async task) artifacts, never for inline responses.
     */
    downloadedAt?: string;
    remoteId?: string;
    artifacts: Artifact[];
    error?: SanitizedError;
}
/** Structured, secret-free error payload. */
export interface SanitizedError {
    readonly code: string;
    readonly message: string;
    readonly backend: string;
    readonly retriable: boolean;
}
/** Progress update emitted by a backend poll. */
export interface BackendPoll {
    status: 'running' | 'succeeded' | 'failed' | 'cancelled';
    progress: number;
    error?: {
        code: string;
        message: string;
    };
    /**
     * Provider-reported terminal instant (ISO), when the wire response carries
     * one. Distinct from the local download/finish time kept by the job manager.
     */
    remoteCompletedAt?: string;
}
/**
 * Architecture layers (three-way decoupling), named explicitly per contract:
 * - ProtocolAdapter = GenerationBackend: one implementation per WIRE PROTOCOL
 *   only (`volcengine-ark-compatible`, `openai-video-compatible`,
 *   `minimax-video-compatible`, plus the extra `videogen-task-api` /
 *   `openai-chat-compatible`); it never mentions any provider id.
 * - ProviderProfile = BackendConfig (config.ts): id + protocol + baseURL +
 *   apiKeyEnv / DSH credential reference + path mapping + timeouts +
 *   non-sensitive defaults + verification state.
 * - ModelCapability = ModelCapabilitySpec (presets.ts): modality, duration /
 *   size / format limits, the protocol a model speaks. No URL, no credential,
 *   no provider id.
 */
export type ProtocolAdapter = GenerationBackend;
/** Wire protocol ids. Adapters are selected by protocol, never by provider. */
export type ProtocolKind = 'volcengine-ark-compatible' | 'openai-video-compatible' | 'videogen-task-api' | 'openai-chat-compatible' | 'minimax-video-compatible' | 'dashscope-wan-compatible' | 'google-genmedia-compatible' | 'openai-images-compatible';
/** Capability of ONE model — limits only, no provider/connection data. */
export interface ModelCapabilitySpec {
    readonly id: string;
    readonly protocol: ProtocolKind;
    readonly modality: Modality;
    readonly minDurationSeconds?: number;
    readonly maxDurationSeconds?: number;
    /** Exact discrete duration values (s) when the model only allows a set. */
    readonly durations?: readonly number[];
    readonly sizes?: readonly string[];
    /** Aspect ratios the wire protocol accepts, when the protocol names them. */
    readonly ratios?: readonly string[];
    readonly formats?: readonly string[];
    readonly notes?: string;
}
/** Capabilities a backend advertises for routing/validation. */
export interface ModelCapability {
    modalities: Modality[];
    models: string[];
    online: boolean;
    /**
     * The WIRE SHAPE is confirmed (official docs and/or a verified harness).
     * This is what gates real submission.
     */
    protocolVerified: boolean;
    /**
     * A REAL call against THIS deployment has succeeded. Independent of
     * `protocolVerified`: a documented-but-never-called profile is
     * protocolVerified=true / liveVerified=false (mock-only).
     */
    liveVerified: boolean;
    realSubmitAllowed: boolean;
    protocol?: ProtocolKind;
    /** Per-model limits (see presets.ts); capability data only. */
    modelCapabilities?: Record<string, ModelCapabilitySpec>;
}
/** One generation backend. All methods must honor `signal` and settle safely. */
export interface GenerationBackend {
    readonly id: string;
    /** Modality + model ids this backend claims to serve (advertised, not probed). */
    capabilities(): ModelCapability;
    /** Submit a generation; returns a remote task id (or an immediately-completed inline result). */
    create(req: GenerationRequest, signal: AbortSignal): Promise<{
        remoteId: string;
        inline?: {
            text?: string;
            bytes?: Buffer;
            mimeType?: string;
        };
    }>;
    /** Poll one remote task. */
    poll(remoteId: string, signal: AbortSignal): Promise<BackendPoll>;
    /** Download the finished artifact bytes (video/image) — unused for inline text. */
    fetch(remoteId: string, signal: AbortSignal): Promise<{
        bytes: Buffer;
        mimeType: string;
    }>;
    /** Best-effort remote cancellation. */
    cancel?(remoteId: string, signal: AbortSignal): Promise<void>;
}
