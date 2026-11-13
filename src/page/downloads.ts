/**
 * Offline H3 model-file download manager for the config page.
 *
 * Design (documented in README「离线模型下载」):
 *  - The download LIST lives in a user-editable manifest at
 *    `<dataDir>/downloads.json`. The shipped default lists the real, official
 *    MiniMax H3 files on Hugging Face (MiniMaxAI/MiniMax-H3) — every url is a
 *    plain https resolve URL the operator can swap (e.g. for the ModelScope
 *    mirror) before starting.
 *  - Each download is one background task: in-memory record + registration
 *    with the host Jobs registry (kind `synthmedia-download`) so progress and
 *    cancel also appear in the host Jobs UI — the same structural contract
 *    src/jobs.ts uses.
 *  - Resume: bytes land in `<downloadsDir>/<id>.part`; on (re)start a valid
 *    partial file is continued with an HTTP Range request; on completion the
 *    file is renamed to the final name atomically.
 *  - No path input ever comes from the network or the UI: target paths are
 *    derived from the manifest id (validated `[a-z0-9][a-z0-9._-]*`) inside
 *    the configured downloads directory only.
 * @module
 */
import { createWriteStream, createReadStream, existsSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { HostJobRegistry, HostJobHandle } from '../jobs.js';

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

export interface DownloadEntry {
  readonly id: string;
  readonly name: string;
  /** Operator-filled http(s) URL; empty in the shipped placeholder manifest. */
  readonly url: string;
  /** Advertised size in bytes when known (0/absent = unknown until headers). */
  readonly bytes?: number;
  /** Free-form operator note (NOT a provenance claim). */
  readonly notes?: string;
}

/** Mutable working shape of one progress record (internal). */
interface MutableProgress {
  id: string;
  name: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
  speedBps?: number;
  etaSeconds?: number;
  error?: string;
  file?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** Public, immutable view of one download record. */
export type DownloadProgress = Readonly<MutableProgress>;

export interface DownloadManifest {
  readonly entries: readonly DownloadEntry[];
  readonly downloadsDir: string;
}

/**
 * Official MiniMax H3 download sources (open-sourced 2026-08-03):
 *  - Hugging Face: https://huggingface.co/MiniMaxAI/MiniMax-H3
 *    (file URL: .../resolve/main/<path>)
 *  - ModelScope mirror: https://modelscope.cn/models/MiniMax/MiniMax-H3
 *    (file URL: .../resolve/master/<path>)
 * Default variant: the repo ROOT pipeline (H3-Base weights, Diffusers
 * layout). H3-Context-IR / H3-Regenerate-2K are inference-time variants of
 * the SAME weights (selected via the repo's scripts/readme/*.sh recipes),
 * not separate weight repos, so one file set covers all variants.
 * The list below mirrors the root pipeline's full file set (per the HF
 * tree, verified 2026-11-13): transformer (14 shards), transformer_ref
 * (14 shards, reference pipeline), text_encoder (14 shards), vae (3
 * shards), audio_vae, tokenizer/processor configs. FL2VA/Ref2VA subtrees
 * duplicate the same components and are intentionally NOT listed; add them
 * in your downloads.json if you need those sub-pipelines.
 */
const H3_HF_BASE = 'https://huggingface.co/MiniMaxAI/MiniMax-H3/resolve/main';
const H3_MS_BASE = 'https://modelscope.cn/models/MiniMax/MiniMax-H3/resolve/master';

/** Root-pipeline file paths, relative to the repo root. */
const H3_FILES: readonly string[] = [
  'model_index.json',
  'modular_model_index.json',
  'LICENSE',
  'README.md',
  'scheduler/scheduler_config.json',
  'audio_scheduler/scheduler_config.json',
  'processor/chat_template.json',
  'processor/merges.txt',
  'processor/preprocessor_config.json',
  'processor/tokenizer.json',
  'processor/tokenizer_config.json',
  'processor/video_preprocessor_config.json',
  'processor/vocab.json',
  'tokenizer/merges.txt',
  'tokenizer/tokenizer.json',
  'tokenizer/tokenizer_config.json',
  'tokenizer/vocab.json',
  'audio_vae/config.json',
  'audio_vae/diffusion_pytorch_model.safetensors',
  ...Array.from({ length: 14 }, (_, i) => `text_encoder/model-${String(i + 1).padStart(5, '0')}-of-00014.safetensors`),
  'text_encoder/model.safetensors.index.json',
  'text_encoder/config.json',
  'text_encoder/chat_template.json',
  'text_encoder/merges.txt',
  'text_encoder/preprocessor_config.json',
  'text_encoder/tokenizer.json',
  'text_encoder/tokenizer_config.json',
  'text_encoder/video_preprocessor_config.json',
  'text_encoder/vocab.json',
  ...Array.from({ length: 14 }, (_, i) => `transformer/diffusion_pytorch_model-${String(i + 1).padStart(5, '0')}-of-00014.safetensors`),
  'transformer/diffusion_pytorch_model.safetensors.index.json',
  'transformer/config.json',
  ...Array.from({ length: 14 }, (_, i) => `transformer_ref/diffusion_pytorch_model-${String(i + 1).padStart(5, '0')}-of-00014.safetensors`),
  'transformer_ref/diffusion_pytorch_model.safetensors.index.json',
  'transformer_ref/config.json',
  ...Array.from({ length: 3 }, (_, i) => `vae/diffusion_pytorch_model-${String(i + 1).padStart(5, '0')}-of-00003.safetensors`),
  'vae/diffusion_pytorch_model.safetensors.index.json',
  'vae/config.json',
];

/** Shipped default manifest: real official H3 urls (operator-editable). */
export function defaultManifest(downloadsDir: string): DownloadManifest {
  return {
    downloadsDir,
    entries: H3_FILES.map((rel) => {
      const id = `minimax-h3.${rel.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`.replace(/\.+$/, '');
      return {
        id,
        name: `MiniMax H3: ${rel}`,
        url: `${H3_HF_BASE}/${rel}`,
        notes: `官方 HF 源；备选 ModelScope 镜像：${H3_MS_BASE}/${rel}。文件落在 <downloadsDir>/<id>.bin（默认变体 H3-Base；Context-IR / Regenerate-2K 为同权重的推理期变体，见 scripts/readme 配方）。`,
      };
    }),
  };
}

/** Schema-validate a manifest read from disk; any malformed entry is dropped. */
export function validateManifest(raw: unknown, downloadsDir: string): DownloadManifest {
  const dir = typeof (raw as Record<string, unknown> | null)?.['downloadsDir'] === 'string' && (raw as Record<string, unknown>)['downloadsDir'] !== ''
    ? String((raw as Record<string, unknown>)['downloadsDir'])
    : downloadsDir;
  const entriesRaw = (raw as Record<string, unknown> | null)?.['entries'];
  const entries: DownloadEntry[] = [];
  if (Array.isArray(entriesRaw)) {
    for (const e of entriesRaw) {
      if (e === null || typeof e !== 'object' || Array.isArray(e)) continue;
      const rec = e as Record<string, unknown>;
      const id = rec['id'];
      if (typeof id !== 'string' || !ID_RE.test(id)) continue;
      const url = typeof rec['url'] === 'string' ? rec['url'] : '';
      const entry: DownloadEntry = {
        id,
        name: typeof rec['name'] === 'string' ? rec['name'] : id,
        url,
        ...(typeof rec['notes'] === 'string' ? { notes: rec['notes'] } : {}),
        ...(typeof rec['bytes'] === 'number' && rec['bytes'] > 0 ? { bytes: rec['bytes'] } : {}),
      };
      entries.push(entry);
    }
  }
  return { downloadsDir: dir, entries };
}

/** A tiny stream-source abstraction so tests can mock the wire. */
export interface ByteSource {
  /** Status + optional total size from headers. */
  respond(url: string, rangeStart?: number): Promise<{ status: number; totalBytes?: number; stream: AsyncIterable<Uint8Array> }>;
}

/** Default ByteSource over node:http(s) GET with a Range header on resume. */
export const httpByteSource: ByteSource = {
  respond(url, rangeStart) {
    return new Promise((res, rej) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        rej(new Error(`invalid download URL: ${url}`));
        return;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        rej(new Error(`download URL must be http(s): ${url}`));
        return;
      }
      const req = (parsed.protocol === 'https:' ? httpsRequest : httpRequest)(
        parsed,
        { ...(rangeStart && rangeStart > 0 ? { headers: { Range: `bytes=${rangeStart}-` } } : {}) },
        (resp) => {
          const lenHeader = resp.headers['content-length'];
          const rangeHeader = resp.headers['content-range'];
          let totalBytes: number | undefined;
          if (typeof rangeHeader === 'string') {
            const m = /\/(\d+)$/.exec(rangeHeader);
            if (m) totalBytes = Number(m[1]);
          } else if (typeof lenHeader === 'string') {
            totalBytes = Number(lenHeader) + (rangeStart ?? 0);
          }
          res({
            status: resp.statusCode ?? 0,
            ...(totalBytes !== undefined && Number.isFinite(totalBytes) ? { totalBytes } : {}),
            stream: resp,
          });
        },
      );
      req.on('error', rej);
    });
  },
};

interface RunningState {
  readonly record: MutableProgress;
  controller: AbortController;
}

/**
 * Download manager. All state is in-memory (a restarted host restarts
 * nothing automatically — an operator re-clicks, and the .part file makes
 * that cheap).
 */
export class DownloadManager {
  private readonly running = new Map<string, RunningState>();
  private readonly finished = new Map<string, DownloadProgress>();
  private hostJobs?: HostJobRegistry;
  private manifest: DownloadManifest;

  constructor(
    manifest: DownloadManifest,
    private readonly source: ByteSource = httpByteSource,
    hostJobs?: HostJobRegistry,
  ) {
    this.manifest = manifest;
    this.hostJobs = hostJobs && typeof hostJobs.start === 'function' ? hostJobs : undefined;
  }

  attachHostJobs(hostJobs?: HostJobRegistry): void {
    this.hostJobs = hostJobs && typeof hostJobs.start === 'function' ? hostJobs : undefined;
  }

  setManifest(manifest: DownloadManifest): void {
    this.manifest = manifest;
  }

  manifestNow(): DownloadManifest {
    return this.manifest;
  }

  list(): DownloadProgress[] {
    const done: DownloadProgress[] = [...this.finished.values()];
    const run: DownloadProgress[] = [...this.running.values()].map((s) => s.record);
    return [...run, ...done].sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  }

  /** Load manifest from disk (with corrupt-file fallback to defaults). */
  async loadManifest(path: string): Promise<DownloadManifest> {
    let loaded: DownloadManifest;
    try {
      const text = await readFile(path, 'utf8');
      loaded = validateManifest(JSON.parse(text), this.manifest.downloadsDir);
      if (loaded.entries.length === 0) loaded = this.manifest;
    } catch {
      loaded = this.manifest; // missing or corrupt → shipped defaults
      await this.saveManifest(path).catch(() => undefined);
    }
    this.setManifest(loaded);
    return loaded;
  }

  async saveManifest(path: string): Promise<void> {
    await writeFile(path, JSON.stringify(this.manifest, null, 2), 'utf8');
  }

  /**
   * Start (or resume) one manifest entry. Refuses: unknown id, empty/non-http
   * url, already running. Returns the initial progress record.
   */
  async start(id: string): Promise<DownloadProgress> {
    const entry = this.manifest.entries.find((e) => e.id === id);
    if (!entry) throw new Error(`download: unknown model id '${id}'`);
    if (!/^https?:\/\/.+/.test(entry.url)) throw new Error(`download '${id}': downloads.json 中该条目缺少有效 http(s) URL`);
    if (this.running.has(id)) throw new Error(`download '${id}' already running`);

    const targetPath = join(resolve(this.manifest.downloadsDir), `${id}.bin`);
    const partPath = `${targetPath}.part`;
    let resumeFrom = 0;
    if (existsSync(partPath)) {
      const size = statSync(partPath).size;
      if (Number.isFinite(size) && size > 0) resumeFrom = size;
    }

    const controller = new AbortController();
    const startedAt = new Date().toISOString();
    const record: RunningState['record'] = {
      id,
      name: entry.name,
      status: 'running',
      downloadedBytes: resumeFrom,
      ...(entry.bytes ? { totalBytes: entry.bytes } : {}),
      startedAt,
    };
    this.running.set(id, { record, controller });

    // Host Jobs UI face (best-effort, same contract as generation jobs).
    let hostHandle: HostJobHandle | undefined;
    if (this.hostJobs) {
      try {
        this.hostJobs.start({
          kind: 'synthmedia-download',
          label: `下载 ${entry.name}`,
          run: (job) => {
            hostHandle = job;
            return {
              cancel: () => this.cancel(id).catch(() => undefined),
              done: new Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string }>((res) => {
                const check = () => {
                  const r = this.running.get(id) ?? undefined;
                  const f = this.finished.get(id);
                  if (f) {
                    res(f.status === 'completed' ? { status: 'completed' } : f.status === 'cancelled' ? { status: 'killed', detail: f.error } : { status: 'failed', detail: f.error });
                  } else if (!r) {
                    res({ status: 'failed', detail: 'download vanished' });
                  } else {
                    setTimeout(check, 500);
                  }
                };
                check();
              }),
            };
          },
        });
      } catch {
        hostHandle = undefined;
      }
    }

    void this.run(entry, record, controller, partPath, targetPath, resumeFrom, hostHandle).catch(() => undefined);
    return record;
  }

  private async run(
    entry: DownloadEntry,
    record: RunningState['record'],
    controller: AbortController,
    partPath: string,
    targetPath: string,
    resumeFrom: number,
    hostHandle?: HostJobHandle,
  ): Promise<void> {
    let lastTick = Date.now();
    let lastBytes = resumeFrom;
    let sink: import('node:fs').WriteStream | undefined;
    let abortListener: (() => void) | undefined;
    const onProgress = (bytes: number, total?: number): void => {
      const now = Date.now();
      record.downloadedBytes = bytes;
      if (total !== undefined && Number.isFinite(total) && total > 0) {
        record.totalBytes = total;
        record.percent = Math.min(100, Math.round((bytes / total) * 1000) / 10);
        if (bytes > lastBytes) {
          const dt = (now - lastTick) / 1000;
          if (dt >= 0.5) {
            record.speedBps = Math.round((bytes - lastBytes) / dt);
            record.etaSeconds = record.speedBps && record.speedBps > 0 ? Math.max(0, Math.round((total - bytes) / record.speedBps)) : undefined;
            lastTick = now;
            lastBytes = bytes;
          }
        }
      }
      hostHandle?.updateProgress(this.progressLine(record));
    };
    try {
      const resp = await this.source.respond(entry.url, resumeFrom > 0 ? resumeFrom : undefined);
      if (resp.status !== 200 && resp.status !== 206) {
        throw new Error(`download '${entry.id}': HTTP ${resp.status}`);
      }
      await mkdir(resolve(this.manifest.downloadsDir), { recursive: true });
      if (resumeFrom === 0 || resp.status !== 206) {
        // Server ignored Range → start over.
        record.downloadedBytes = 0;
        resumeFrom = 0;
      }
      const flags = resumeFrom > 0 ? 'a' : 'w';
      const out = createWriteStream(partPath, { flags });
      sink = out;
      let written = resumeFrom;
      const done = new Promise<void>((res, rej) => {
        out.on('error', rej);
        out.on('finish', () => res());
      });
      // Manual iteration raced against the abort signal: a cancel must stop
      // the copy loop immediately even when the source is a slow/mock stream
      // that does not react to destruction.
      const iterator = (resp.stream as AsyncIterableIterator<Uint8Array>)[Symbol.asyncIterator]();
      const aborted = new Promise<never>((_, rej) => {
        const onAbort = (): void => rej(new Error('cancelled'));
        if (controller.signal.aborted) onAbort();
        else {
          controller.signal.addEventListener('abort', onAbort, { once: true });
          abortListener = () => controller.signal.removeEventListener('abort', onAbort);
        }
      });
      try {
        for (;;) {
          const next = await Promise.race([iterator.next(), aborted]);
          if (next.done) break;
          out.write(Buffer.from(next.value));
          written += next.value.byteLength;
          onProgress(written, record.totalBytes ?? resp.totalBytes);
        }
      } finally {
        abortListener?.();
        void (iterator as { return?: () => Promise<unknown> }).return?.();
      }
      out.end();
      await done;
      renameSync(partPath, targetPath);
      record.status = 'completed';
      record.percent = 100;
      record.file = targetPath;
      record.finishedAt = new Date().toISOString();
    } catch (err) {
      const message = controller.signal.aborted || String((err as Error)?.message ?? '').includes('cancelled')
        ? 'download cancelled'
        : String((err as Error)?.message ?? err);
      record.status = controller.signal.aborted ? 'cancelled' : 'failed';
      record.error = message;
      record.finishedAt = new Date().toISOString();
    } finally {
      abortListener?.();
      // Flush whatever is still buffered so a later resume sees ALL bytes the
      // copy loop already wrote (write streams buffer silently).
      if (sink && !sink.writableFinished) {
        const flushed = sink;
        await new Promise<void>((res) => { flushed.end(() => res()); });
      }
      this.running.delete(record.id);
      const snapshot: DownloadProgress = { ...record };
      this.finished.set(record.id, snapshot);
      // Cancel/failure keeps the .part file so a later start resumes where it
      // left off; only a completed download renames it to the final name.
    }
  }

  private progressLine(r: DownloadProgress): string {
    const pct = r.percent !== undefined ? `${r.percent}%` : '…';
    const speed = r.speedBps ? `, ${(r.speedBps / 1024 / 1024).toFixed(1)} MiB/s` : '';
    return `${pct} (${Math.round(r.downloadedBytes / 1024 / 1024)} MiB${speed})`;
  }

  /** Cooperative cancel; a running download keeps its .part for resume. */
  async cancel(id: string): Promise<void> {
    const state = this.running.get(id);
    if (!state) throw new Error(`download '${id}' is not running`);
    state.controller.abort();
  }

  /** Remove a finished record from the list view. */
  dismiss(id: string): void {
    this.finished.delete(id);
  }

  /** Abort everything (dispose). */
  dispose(): void {
    for (const [, s] of this.running) s.controller.abort();
    this.running.clear();
  }
}

/** Read a text file if present; otherwise undefined (never throws). */
export async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

export { join as joinPath, unlinkSync, createReadStream };
