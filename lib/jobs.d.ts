import type { GenerationRequest, JobRecord, GenerationBackend } from './types.js';
import type { SynthMediaConfig } from './config.js';
/** Structural subset of the DSH `ctx.jobs` JobRegistry contract (@deepseek-ai/dsh-jobs). */
export interface HostJobHandle {
    readonly id: string;
    append(text: string, options?: {
        channel?: string;
    }): void;
    updateProgress(line: string): void;
}
/** Structural subset of JobHooks + JobOutcome. */
export interface HostJobHooks {
    cancel(reason?: string): void;
    done: Promise<{
        status: 'completed' | 'killed' | 'failed';
        detail?: string;
    }>;
}
/** Structural subset of JobSpec: only what this plugin supplies. */
export interface HostJobSpec {
    kind: string;
    label: string;
    /** Owning agent session id — the host fences read/kill access by it. */
    owner?: string;
    /** Creating tool invocation (durable lifecycle record in the host). */
    toolCall?: {
        callId: string;
        rootCallId: string;
    };
    run(job: HostJobHandle): HostJobHooks;
}
/** Structural subset of JobRegistry: only what this plugin calls. */
export interface HostJobRegistry {
    start(spec: HostJobSpec): string;
}
/** Identity the host needs to fence and record one owned job. */
export interface HostJobOwner {
    readonly owner?: string;
    readonly toolCall?: {
        callId: string;
        rootCallId: string;
    };
}
export declare class JobManager {
    private readonly backends;
    private readonly config;
    private readonly running;
    private hostJobs?;
    /** Per-job host face + the resolver that settles the host `done` promise. */
    private readonly hostHandles;
    private readonly hostSettlers;
    constructor(config: SynthMediaConfig, backends: Map<string, GenerationBackend>, hostJobs?: HostJobRegistry);
    /**
     * Bind (or replace) the host Jobs registry. Optional in the DSH contract:
     * the service may be loaded after this plugin (`ctx.get('jobs')` is
     * undefined until then), so apply() also binds it through `ctx.inject`.
     * Binding is idempotent; jobs started before a late binding simply have no
     * host UI face.
     */
    attachHostJobs(hostJobs?: HostJobRegistry): void;
    outputRoot(): string;
    jobDir(id: string): string;
    listBackends(): Array<{
        id: string;
        protocol?: string;
        modalities: string[];
        models: string[];
        modelCapabilities?: Record<string, unknown>;
        online: boolean;
        protocolVerified: boolean;
        liveVerified: boolean;
        realSubmitAllowed: boolean;
    }>;
    /**
     * Create a job for an exact backend id. Unknown backend or unsupported
     * modality/model ⇒ immediate structured failure. No fallback exists.
     *
     * `hostOwner` carries the initiating agent session id (and tool call) so the
     * host jobs registry can fence access and record the durable owner. It is
     * optional: without it the host job stays unowned and every caller can read
     * or kill it.
     */
    start(req: GenerationRequest, hostOwner?: HostJobOwner): Promise<JobRecord>;
    private hostSettle;
    private runJob;
    private onAborted;
    private finish;
    private materializeInline;
    private materializeBytes;
    private persist;
    /** In-memory first, then on-disk (survives restarts of the plugin process). */
    get(id: string): Promise<JobRecord | undefined>;
    wait(id: string, signal?: AbortSignal): Promise<JobRecord>;
    /**
     * Cancel one job. `signal` (e.g. the calling tool's exec.signal) bounds only
     * how long THIS call waits for the job to settle — the cancellation itself
     * proceeds in the background if the caller goes away. Remote cancellation is
     * best-effort and honors the signal.
     */
    cancel(id: string, signal?: AbortSignal): Promise<JobRecord>;
    dispose(): void;
}
