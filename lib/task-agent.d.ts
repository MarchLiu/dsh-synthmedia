import type { IncomingMessage, ServerResponse } from 'node:http';
/**
 * Fenced absolute path of one artifact: job id and file name are validated
 * against strict patterns (rejecting `..`, separators and absolute-path
 * injection), the joined path must stay inside the output root, and the
 * REAL path (symlinks resolved) must still be inside the REAL output root —
 * a symlink planted inside the job directory pointing outside is refused.
 * Returns undefined for any fence violation (never throws on user input).
 */
export declare function fenceArtifactPath(outputRoot: string, jobId: string, fileName: string): Promise<string | undefined>;
/** Absolute directory of one job (fenced the same way as its artifacts). */
export declare function fenceJobDir(outputRoot: string, jobId: string): Promise<string | undefined>;
/**
 * Pure planner for the "open containing folder" action. Platform dispatch
 * only; no shell string is ever built (spawn without `shell`, argv array).
 * Only artifact paths that passed {@link fenceArtifactPath} reach this.
 */
export declare function planReveal(platform: string, filePath: string): {
    cmd: string;
    args: string[];
} | undefined;
/**
 * Reveal one fenced artifact in the OS file manager. Spawned detached, no
 * shell; resolves when the child exits (revealers exit immediately) and
 * rejects only on spawn failure or fence violation.
 */
export declare function revealArtifact(outputRoot: string, jobId: string, fileName: string, platform?: string): Promise<void>;
/** Content-Type for the artifact extensions the plugin writes. */
export declare function artifactContentType(fileName: string): string;
export interface ArtifactRouteDeps {
    /** Absolute output root the fence applies (resolve(config.outputDir)). */
    outputRoot: string;
}
/**
 * Build the `/synthmedia/api` prefix route body:
 *   GET /synthmedia/api/artifact/<jobId>/<file> → the bytes (attachment)
 * Every artifact byte leaves only through the fence; a violated fence is a
 * 404 (never an error page that leaks paths). This returns the plain
 * WebRoute shape consumed by ctx.webServer.register().
 *
 * There is deliberately NO unauthenticated job-LIST endpoint: this route has
 * no session identity, so a list here would expose every conversation's
 * jobs. The sidebar list goes through the session-scoped command transport
 * (/synthmedia jobs), and this route only serves bytes behind an unguessable
 * job UUID + fenced file name.
 */
export declare function createArtifactRoute(deps: ArtifactRouteDeps): {
    kind: 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
};
