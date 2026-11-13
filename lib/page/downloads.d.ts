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
import { createReadStream, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { HostJobRegistry } from '../jobs.js';
export interface DownloadEntry {
    readonly id: string;
    readonly name: string;
    /** Operator-filled http(s) URL (HF/ModelScope `resolve` urls redirect to the CDN); empty disables the entry. */
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
/** Shipped default manifest: real official H3 urls (operator-editable). */
export declare function defaultManifest(downloadsDir: string): DownloadManifest;
/** Schema-validate a manifest read from disk; any malformed entry is dropped. */
export declare function validateManifest(raw: unknown, downloadsDir: string): DownloadManifest;
/** A tiny stream-source abstraction so tests can mock the wire. */
export interface ByteSource {
    /** Status + optional total size from headers. */
    respond(url: string, rangeStart?: number): Promise<{
        status: number;
        totalBytes?: number;
        stream: AsyncIterable<Uint8Array>;
    }>;
}
/**
 * Build the default ByteSource over node:http(s) GET with a Range header on
 * resume. Follows up to MAX_REDIRECTS 301/302/307/308 hops (HF/ModelScope
 * resolve URLs 302 to their CDN), re-sending the Range header on every hop.
 * Each redirect Location is SSRF-guarded (loopback/private/link-local refused
 * via the shared isPrivateHost check) so a public URL cannot bounce the
 * downloader at an internal address; `allowRedirectHost` can only WIDEN that
 * guard (tests use it to point at a local mock origin); the final response
 * must still be 200/206 (enforced by DownloadManager.run).
 */
export declare function createHttpByteSource(opts?: {
    allowRedirectHost?: (hostname: string) => boolean;
}): ByteSource;
/** Production byte source: strict SSRF guard on every redirect hop. */
export declare const httpByteSource: ByteSource;
/**
 * Download manager. All state is in-memory (a restarted host restarts
 * nothing automatically — an operator re-clicks, and the .part file makes
 * that cheap).
 */
export declare class DownloadManager {
    private readonly source;
    private readonly running;
    private readonly finished;
    private hostJobs?;
    private manifest;
    constructor(manifest: DownloadManifest, source?: ByteSource, hostJobs?: HostJobRegistry);
    attachHostJobs(hostJobs?: HostJobRegistry): void;
    setManifest(manifest: DownloadManifest): void;
    manifestNow(): DownloadManifest;
    list(): DownloadProgress[];
    /** Load manifest from disk (with corrupt-file fallback to defaults). */
    loadManifest(path: string): Promise<DownloadManifest>;
    saveManifest(path: string): Promise<void>;
    /**
     * Start (or resume) one manifest entry. Refuses: unknown id, empty/non-http
     * url, already running. Returns the initial progress record.
     */
    start(id: string): Promise<DownloadProgress>;
    private run;
    private progressLine;
    /** Cooperative cancel; a running download keeps its .part for resume. */
    cancel(id: string): Promise<void>;
    /** Remove a finished record from the list view. */
    dismiss(id: string): void;
    /** Abort everything (dispose). */
    dispose(): void;
}
/** Read a text file if present; otherwise undefined (never throws). */
export declare function readOptionalText(path: string): Promise<string | undefined>;
export { join as joinPath, unlinkSync, createReadStream };
