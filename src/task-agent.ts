/**
 * Sub-task ("task agent") bridge for synthmedia generation jobs.
 *
 * Requirement one of the sidebar/sub-task round: every synthmedia_generate
 * must be observable as a child task of the calling agent — stable id, state,
 * progress, owning session/agent, cancellable, artifact list — WITHOUT
 * blocking the parent and WITHOUT fake subagent events.
 *
 * Seam decision (evidence-based): the public `ctx.subagents` service
 * (@deepseek-ai/dsh-subagent, SubagentProvider / startActivation) models
 * *LLM child agents* — its SubagentStartRequest requires a live `parent:
 * Agent` object, a `prompt: ContentBlock[]` and a registered backend, and its
 * lifecycle is published through `subagent/start` / `subagent/end` host
 * events. A media generation job is not an LLM conversation; spoofing a
 * provider activation here would both fail structurally (no Agent object is
 * reachable from a tool execute()) and violate the no-fake-events rule, so
 * the seam is NOT used.
 *
 * The compliant representation chosen instead:
 *  - the host Jobs registry record (kind 'synthmedia', owner = the calling
 *    agent session id, toolCall = the durable create call) — already wired in
 *    src/jobs.ts — stays the UI face;
 *  - the JobRecord itself carries `owner` + `ancestors` + `toolCall`
 *    (additive fields), so parent/child attribution survives restarts via
 *    job.json and the parent session's listing covers its task agents;
 *  - this module provides the read face (`JobManager.list`, session filtering)
 *    and the operations the sidebar tab needs: fenced artifact paths, the
 *    download HTTP route and the reveal (open-in-folder) command.
 *
 * Nothing here emits subagent/workflow events and nothing here patches
 * dsh-cybernetics: a task agent that calls synthmedia_generate already owns
 * the job (owner = its own session id) with zero extra wiring.
 * @module
 */
import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve, sep, dirname, basename } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Job ids are plugin-generated UUIDs; artifact names are plugin-generated. */
const ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Fenced absolute path of one artifact: job id and file name are validated
 * against strict patterns (rejecting `..`, separators and absolute-path
 * injection), the joined path must stay inside the output root, and the
 * REAL path (symlinks resolved) must still be inside the REAL output root —
 * a symlink planted inside the job directory pointing outside is refused.
 * Returns undefined for any fence violation (never throws on user input).
 */
export async function fenceArtifactPath(outputRoot: string, jobId: string, fileName: string): Promise<string | undefined> {
  if (!ID_RE.test(jobId) || !FILE_RE.test(fileName) || fileName.includes('..')) return undefined;
  const root = resolve(outputRoot);
  const candidate = resolve(root, jobId, fileName);
  if (candidate !== join(root, jobId, fileName)) return undefined;
  if (!candidate.startsWith(root + sep)) return undefined;
  try {
    const realRoot = await realpath(root);
    const realPath = await realpath(candidate);
    if (realPath !== realRoot && !realPath.startsWith(realRoot + sep)) return undefined;
    const st = await lstat(realPath);
    return st.isFile() ? realPath : undefined;
  } catch {
    return undefined;
  }
}

/** Absolute directory of one job (fenced the same way as its artifacts). */
export async function fenceJobDir(outputRoot: string, jobId: string): Promise<string | undefined> {
  if (!ID_RE.test(jobId)) return undefined;
  const root = resolve(outputRoot);
  const candidate = resolve(root, jobId);
  if (!candidate.startsWith(root + sep)) return undefined;
  try {
    const realRoot = await realpath(root);
    const realPath = await realpath(candidate);
    if (!realPath.startsWith(realRoot + sep)) return undefined;
    const st = await lstat(realPath);
    return st.isDirectory() ? realPath : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pure planner for the "open containing folder" action. Platform dispatch
 * only; no shell string is ever built (spawn without `shell`, argv array).
 * Only artifact paths that passed {@link fenceArtifactPath} reach this.
 */
export function planReveal(platform: string, filePath: string): { cmd: string; args: string[] } | undefined {
  if (typeof filePath !== 'string' || filePath === '') return undefined;
  if (platform === 'darwin') return { cmd: 'open', args: ['-R', filePath] };
  if (platform === 'win32') return { cmd: 'explorer', args: ['/select,' + filePath] };
  if (platform === 'linux') return { cmd: 'xdg-open', args: [dirname(filePath)] };
  return undefined;
}

/**
 * Reveal one fenced artifact in the OS file manager. Spawned detached, no
 * shell; resolves when the child exits (revealers exit immediately) and
 * rejects only on spawn failure or fence violation.
 */
export function revealArtifact(outputRoot: string, jobId: string, fileName: string, platform: string = process.platform): Promise<void> {
  return fenceArtifactPath(outputRoot, jobId, fileName).then((path) => {
    const plan = path ? planReveal(platform, path) : undefined;
    if (!plan) return Promise.reject(new Error('artifact not found inside the output directory (fence refused)'));
    return new Promise<void>((res, rej) => {
      try {
        const child = spawn(plan.cmd, plan.args, { stdio: 'ignore', detached: true, shell: false });
        child.on('error', rej);
        child.on('exit', () => res());
        child.unref();
      } catch (err) {
        rej(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

/** Content-Type for the artifact extensions the plugin writes. */
export function artifactContentType(fileName: string): string {
  const lower = basename(fileName).toLowerCase();
  const table: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/opus',
    '.weba': 'audio/webm',
    '.pcm': 'audio/pcm',
    '.txt': 'text/plain; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };
  for (const [ext, type] of Object.entries(table)) {
    if (lower.endsWith(ext)) return type;
  }
  return 'application/octet-stream';
}

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
export function createArtifactRoute(deps: ArtifactRouteDeps): {
  kind: 'prefix';
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
} {
  return {
    kind: 'prefix',
    path: '/synthmedia/api',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://local');
        const pathname = decodeURIComponent(url.pathname);
        const m = /^\/synthmedia\/api\/artifact\/([^/]+)\/([^/]+)$/.exec(pathname);
        if (!m) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('not found');
          return;
        }
        const path = await fenceArtifactPath(deps.outputRoot, m[1]!, m[2]!);
        if (!path) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('not found');
          return;
        }
        const contentType = artifactContentType(m[2]!);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${m[2]}"`,
          'Cache-Control': 'no-store',
        });
        const stream = createReadStream(path);
        stream.on('error', () => { try { res.destroy(); } catch { /* already gone */ } });
        stream.pipe(res);
      } catch {
        try {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('bad request');
        } catch { /* response already gone */ }
      }
    },
  };
}
