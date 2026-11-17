/**
 * Unified async job manager: persistent job records, artifacts on disk,
 * progress, cooperative cancellation, timeouts, sanitized structured errors.
 *
 * Host integration: when the DSH host provides `ctx.jobs` (JobRegistry), every
 * job is ALSO registered there via `start({kind:'synthmedia', ...})` so it
 * appears in the host Jobs UI with progress (`updateProgress`) and a proper
 * terminal outcome (`done`). The private JobManager remains the source of
 * truth for records/artifacts; the host registry is the UI face.
 *
 * Routing invariant: each job is pinned to exactly one backend. There is no
 * fallback path in this file — if the pinned (e.g. offline) backend fails, the
 * job fails; nothing is silently forwarded to an online provider.
 * @module
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Artifact, GenerationRequest, JobRecord, GenerationBackend, JobStatus } from './types.js';
import type { SynthMediaConfig } from './config.js';
import { SynthError, sanitizeUnknown, sanitizeText } from './errors.js';

/** Structural subset of the DSH `ctx.jobs` JobRegistry contract (@deepseek-ai/dsh-jobs). */
export interface HostJobHandle {
  readonly id: string;
  append(text: string, options?: { channel?: string }): void;
  updateProgress(line: string): void;
}

/** Structural subset of JobHooks + JobOutcome. */
export interface HostJobHooks {
  cancel(reason?: string): void;
  done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string }>;
}

/** Structural subset of JobSpec: only what this plugin supplies. */
export interface HostJobSpec {
  kind: string;
  label: string;
  /** Owning agent session id — the host fences read/kill access by it. */
  owner?: string;
  /** Creating tool invocation (durable lifecycle record in the host). */
  toolCall?: { callId: string; rootCallId: string };
  run(job: HostJobHandle): HostJobHooks;
}

/** Structural subset of JobRegistry: only what this plugin calls. */
export interface HostJobRegistry {
  start(spec: HostJobSpec): string;
}

/** Identity the host needs to fence and record one owned job. */
export interface HostJobOwner {
  readonly owner?: string;
  /** Ancestor session ids of the owner (nearest parent first). */
  readonly ancestors?: readonly string[];
  readonly toolCall?: { callId: string; rootCallId: string };
}

interface RunningJob {
  record: JobRecord;
  controller: AbortController;
  promise: Promise<void>;
}

export class JobManager {
  private readonly backends: Map<string, GenerationBackend>;
  private readonly config: SynthMediaConfig;
  private readonly running = new Map<string, RunningJob>();
  private hostJobs?: HostJobRegistry;
  /** Per-job host face + the resolver that settles the host `done` promise. */
  private readonly hostHandles = new Map<string, HostJobHandle>();
  private readonly hostSettlers = new Map<string, (outcome: { status: 'completed' | 'killed' | 'failed'; detail?: string }) => void>();

  constructor(config: SynthMediaConfig, backends: Map<string, GenerationBackend>, hostJobs?: HostJobRegistry) {
    this.config = config;
    this.backends = backends;
    this.attachHostJobs(hostJobs);
  }

  /**
   * Bind (or replace) the host Jobs registry. Optional in the DSH contract:
   * the service may be loaded after this plugin (`ctx.get('jobs')` is
   * undefined until then), so apply() also binds it through `ctx.inject`.
   * Binding is idempotent; jobs started before a late binding simply have no
   * host UI face.
   */
  attachHostJobs(hostJobs?: HostJobRegistry): void {
    this.hostJobs = hostJobs && typeof hostJobs.start === 'function' ? hostJobs : undefined;
  }

  outputRoot(): string {
    return resolve(this.config.outputDir);
  }

  jobDir(id: string): string {
    // id is plugin-generated (uuid) — never caller-supplied path input.
    return join(this.outputRoot(), id);
  }

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
  }> {
    return [...this.backends.values()].map((b) => {
      const caps = b.capabilities();
      return {
        id: b.id,
        protocol: caps.protocol,
        modalities: caps.modalities,
        models: caps.models,
        modelCapabilities: caps.modelCapabilities,
        online: caps.online,
        protocolVerified: caps.protocolVerified,
        liveVerified: caps.liveVerified,
        realSubmitAllowed: caps.realSubmitAllowed,
      };
    });
  }

  /**
   * Create a job for an exact backend id. Unknown backend or unsupported
   * modality/model ⇒ immediate structured failure. No fallback exists.
   *
   * `hostOwner` carries the initiating agent session id (and tool call) so the
   * host jobs registry can fence access and record the durable owner. It is
   * optional: without it the host job stays unowned and every caller can read
   * or kill it.
   */
  async start(req: GenerationRequest, hostOwner?: HostJobOwner): Promise<JobRecord> {
    const backend = this.backends.get(req.backend);
    if (!backend) {
      throw new SynthError(
        'E_NO_BACKEND',
        `unknown backend '${sanitizeText(req.backend)}'; use synthmedia_capabilities to list configured backends`,
        'router',
      );
    }
    const caps = backend.capabilities();
    if (!caps.modalities.includes(req.modality)) {
      throw new SynthError('E_MODALITY', `backend '${req.backend}' does not serve '${req.modality}'`, req.backend);
    }
    if (!caps.models.includes(req.model)) {
      // Unknown model ⇒ explicit error. No silent remap to another model.
      throw new SynthError('E_MODEL', `backend '${req.backend}' serves models [${caps.models.join(', ')}], not '${sanitizeText(req.model)}'`, req.backend);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const record: JobRecord = {
      id,
      backend: req.backend,
      model: req.model,
      modality: req.modality,
      promptPreview: req.prompt.slice(0, 120),
      ...(Array.isArray(req.images) && req.images.length > 0 ? { frameImages: req.images.map((img) => img.role) } : {}),
      status: 'running',
      progress: 0,
      createdAt: now,
      updatedAt: now,
      artifacts: [],
      // Sub-task attribution (additive): persisted so the owner survives a
      // restart and the sidebar can group jobs per agent session.
      ...(hostOwner?.owner ? { owner: hostOwner.owner } : {}),
      ...(hostOwner?.ancestors && hostOwner.ancestors.length > 0 ? { ancestors: [...hostOwner.ancestors] } : {}),
      ...(hostOwner?.toolCall ? { toolCall: hostOwner.toolCall } : {}),
    };
    await mkdir(this.jobDir(id), { recursive: true });
    await this.persist(record);

    const controller = new AbortController();
    const promise = this.runJob(record, req, backend, controller).catch(() => undefined);
    this.running.set(id, { record, controller, promise });

    // Register with the host Jobs UI (structural contract; best-effort).
    if (this.hostJobs) {
      try {
        const done = new Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string }>((res) => {
          this.hostSettlers.set(id, res);
        });
        this.hostJobs.start({
          kind: 'synthmedia',
          label: `${req.backend}/${req.model}: ${record.promptPreview.slice(0, 60)}`,
          ...(hostOwner?.owner ? { owner: hostOwner.owner } : {}),
          ...(hostOwner?.toolCall ? { toolCall: hostOwner.toolCall } : {}),
          run: (job: HostJobHandle) => {
            this.hostHandles.set(id, job);
            return {
              cancel: (reason?: string) => {
                void this.cancel(id).catch(() => undefined);
                if (reason) job.append(`cancel requested: ${sanitizeText(reason)}\n`, { channel: 'log' });
              },
              done,
            };
          },
        });
      } catch {
        // Host refused registration (e.g. no controller attached): the private
        // manager still runs the job; only the UI face is lost.
        this.hostSettlers.delete(id);
      }
    }
    return record;
  }

  private hostSettle(record: JobRecord): void {
    const resolve = this.hostSettlers.get(record.id);
    if (!resolve) return;
    this.hostSettlers.delete(record.id);
    this.hostHandles.delete(record.id);
    if (record.status === 'succeeded') resolve({ status: 'completed', detail: 'generation succeeded' });
    else if (record.status === 'cancelled') resolve({ status: 'killed', detail: record.error?.message ?? 'job cancelled' });
    else resolve({ status: 'failed', detail: record.error?.message ?? `job ended as ${record.status}` });
  }

  private async runJob(record: JobRecord, req: GenerationRequest, backend: GenerationBackend, controller: AbortController): Promise<void> {
    const timeoutMs = this.config.backends[req.backend]?.timeoutMs ?? this.config.defaultTimeoutMs;
    const timeoutErr = new SynthError('E_TIMEOUT', `job timed out after ${timeoutMs}ms`, req.backend);
    const timer = setTimeout(() => { record.error = timeoutErr.toSanitized(); controller.abort(timeoutErr); }, timeoutMs);
    try {
      const submitted = await backend.create(req, controller.signal);
      record.remoteId = submitted.remoteId;
      record.progress = 10;
      record.updatedAt = new Date().toISOString();
      await this.persist(record);
      this.hostHandles.get(record.id)?.updateProgress('submitted (10%)');

      if (submitted.inline) {
        // Inline artifact (text, or sync binary like /v1/videos/sync).
        const artifact = submitted.inline.bytes
          ? await this.materializeBytes(record, submitted.inline.bytes, submitted.inline.mimeType ?? 'video/mp4')
          : await this.materializeInline(record, submitted.inline.text ?? '', submitted.inline.mimeType ?? 'text/plain');
        await this.finish(record, 'succeeded', 100, [artifact]);
        return;
      }

      // Poll loop with per-backend cadence.
      const interval = this.config.backends[req.backend]?.pollIntervalMs ?? 10_000;
      for (;;) {
        await sleep(interval, controller.signal);
        if (controller.signal.aborted) return this.onAborted(record);
        const poll = await backend.poll(submitted.remoteId, controller.signal);
        record.progress = poll.progress;
        record.updatedAt = new Date().toISOString();
        if (poll.remoteCompletedAt) record.remoteCompletedAt = poll.remoteCompletedAt;
        await this.persist(record);
        this.hostHandles.get(record.id)?.updateProgress(`${poll.progress}% (${poll.status})`);
        if (poll.status === 'succeeded') {
          const dl = await backend.fetch(submitted.remoteId, controller.signal);
          const artifact = await this.materializeBytes(record, dl.bytes, dl.mimeType);
          // LOCAL clock: only now have the bytes finished downloading/writing.
          // `record.remoteCompletedAt` (if any) came from the provider instead.
          record.downloadedAt = new Date().toISOString();
          await this.finish(record, 'succeeded', 100, [artifact]);
          return;
        }
        if (poll.status === 'failed') {
          record.error = { code: poll.error?.code ?? 'E_REMOTE', message: poll.error?.message ?? 'backend reported failure', backend: req.backend, retriable: false };
          await this.finish(record, 'failed', poll.progress, []);
          return;
        }
        if (poll.status === 'cancelled') {
          await this.finish(record, 'cancelled', poll.progress, []);
          return;
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return this.onAborted(record);
      record.error = sanitizeUnknown(err, req.backend);
      await this.finish(record, 'failed', record.progress, []);
    } finally {
      clearTimeout(timer);
      this.running.delete(record.id);
    }
  }

  private async onAborted(record: JobRecord): Promise<void> {
    const abortError = new SynthError('E_CANCELLED', 'job cancelled', record.backend);
    if (record.error?.code === 'E_TIMEOUT') {
      await this.finish(record, 'timeout', record.progress, []);
    } else {
      record.error = abortError.toSanitized();
      await this.finish(record, 'cancelled', record.progress, []);
    }
  }

  private async finish(record: JobRecord, status: JobStatus, progress: number, artifacts: Artifact[]): Promise<void> {
    record.status = status;
    record.progress = progress;
    record.artifacts = artifacts;
    record.finishedAt = new Date().toISOString();
    record.updatedAt = record.finishedAt;
    await this.persist(record);
    this.hostSettle(record);
  }

  private async materializeInline(record: JobRecord, text: string, mimeType: string): Promise<Artifact> {
    const path = join(this.jobDir(record.id), 'result.txt');
    await writeFile(path, text, 'utf8');
    return { path, kind: record.modality === 'video' ? 'video' : 'text', mimeType, bytes: Buffer.byteLength(text, 'utf8') };
  }

  private async materializeBytes(record: JobRecord, bytes: Buffer, mimeType: string): Promise<Artifact> {
    const extMap: Record<string, string> = {
      'video/mp4': 'mp4',
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/ogg': 'ogg',
      'audio/opus': 'opus',
      'audio/webm': 'weba',
      'audio/pcm': 'pcm',
    };
    const ext = extMap[mimeType] ?? 'bin';
    const path = join(this.jobDir(record.id), `result.${ext}`);
    await writeFile(path, bytes);
    return { path, kind: record.modality, mimeType, bytes: bytes.byteLength };
  }

  private async persist(record: JobRecord): Promise<void> {
    try {
      await mkdir(this.jobDir(record.id), { recursive: true });
      await writeFile(join(this.jobDir(record.id), 'job.json'), JSON.stringify(record, null, 2), 'utf8');
    } catch {
      // persistence is best-effort; in-memory state remains authoritative
    }
  }

  /** In-memory first, then on-disk (survives restarts of the plugin process). */
  async get(id: string): Promise<JobRecord | undefined> {
    const running = this.running.get(id);
    if (running) return running.record;
    try {
      const raw = await readFile(join(this.outputRoot(), id, 'job.json'), 'utf8');
      return JSON.parse(raw) as JobRecord;
    } catch {
      return undefined;
    }
  }

  /**
   * Sub-task listing for the sidebar tab and /synthmedia jobs: every job
   * under the output root (in-memory running records first-class, the rest
   * read from the persisted job.json), running/queued first, then newest
   * first.
   *
   * Two filters exist:
   * - `owner` — exactly one agent session's jobs (a cybernetics task agent
   *   passes its own session id and sees exactly its own jobs);
   * - `session` — the SESSION TREE rooted at that session: jobs it owns plus
   *   jobs owned by agents it spawned (their `ancestors` contain it). This is
   *   what the parent conversation's sidebar tab asks for, so a round's task
   *   agent generation is visible from the conversation that started the
   *   round. Unowned legacy records never appear under a session filter.
   */
  async list(filter?: { owner?: string; session?: string; limit?: number }): Promise<JobRecord[]> {
    const limit = typeof filter?.limit === 'number' && filter.limit > 0 ? Math.min(filter.limit, 200) : 50;
    const owner = filter?.owner;
    const session = filter?.session;
    const records = new Map<string, JobRecord>();
    // In-memory running records win over the (possibly staler) disk copies.
    for (const r of this.running.values()) records.set(r.record.id, r.record);
    try {
      const entries = await readdir(this.outputRoot(), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || records.has(entry.name)) continue;
        try {
          const raw = await readFile(join(this.outputRoot(), entry.name, 'job.json'), 'utf8');
          const parsed = JSON.parse(raw) as JobRecord;
          if (parsed && typeof parsed.id === 'string' && parsed.id === entry.name) records.set(parsed.id, parsed);
        } catch { /* unreadable stray directory: skip, never fail the list */ }
      }
    } catch { /* output root missing yet: empty list */ }
    const inSessionTree = (r: JobRecord): boolean => {
      if (typeof r.owner !== 'string' || r.owner.length === 0) return false;
      if (r.owner === session) return true;
      return Array.isArray(r.ancestors) && r.ancestors.includes(session!);
    };
    const filtered = [...records.values()]
      .filter((r) => {
        if (session !== undefined) return inSessionTree(r);
        return owner === undefined ? true : r.owner === owner;
      })
      .sort((a, b) => {
        const active = (r: JobRecord) => (r.status === 'running' || r.status === 'queued' ? 0 : 1);
        if (active(a) !== active(b)) return active(a) - active(b);
        return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
      });
    return filtered.slice(0, limit);
  }

  async wait(id: string, signal?: AbortSignal): Promise<JobRecord> {
    const running = this.running.get(id);
    if (running) {
      const onAbort = () => this.cancel(id);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        await running.promise;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    }
    const record = await this.get(id);
    if (!record) throw new SynthError('E_NO_JOB', `unknown job id '${sanitizeText(id)}'`, 'router');
    return record;
  }

  /**
   * Cancel one job. `signal` (e.g. the calling tool's exec.signal) bounds only
   * how long THIS call waits for the job to settle — the cancellation itself
   * proceeds in the background if the caller goes away. Remote cancellation is
   * best-effort and honors the signal.
   */
  async cancel(id: string, signal?: AbortSignal): Promise<JobRecord> {
    const running = this.running.get(id);
    if (!running) {
      const record = await this.get(id);
      if (!record) throw new SynthError('E_NO_JOB', `unknown job id '${sanitizeText(id)}'`, 'router');
      return record;
    }
    running.controller.abort();
    if (running.record.remoteId) {
      const backend = this.backends.get(running.record.backend);
      if (backend?.cancel) {
        await backend.cancel(running.record.remoteId, signal ?? new AbortController().signal);
      }
    }
    await (signal
      ? Promise.race([
          running.promise,
          new Promise<void>((res) => {
            if (signal.aborted) res();
            else signal.addEventListener('abort', () => res(), { once: true });
          }),
        ])
      : running.promise);
    return (await this.get(id))!;
  }

  dispose(): void {
    for (const running of this.running.values()) running.controller.abort();
    this.running.clear();
  }
}

/**
 * Abort-responsive sleep: returns IMMEDIATELY when the signal is already
 * aborted, wakes on abort mid-wait, and always removes its listener.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((res) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      res();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
