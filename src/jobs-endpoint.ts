/**
 * Token-gated JSON endpoint for the sidebar tab's job list.
 *
 * Why this exists: the tab used to poll `ctx.remote.commands.execute(
 * '/synthmedia jobs')` every 2 s. The host command service appends a
 * `command/run` + `command/done` pair to the session log for EVERY execution
 * (see `@deepseek-ai/dsh-commands` `execute()`), so a once-per-2 s poll wrote a
 * visible `>_ synthmedia · 当前没有生成任务。` line into the conversation
 * twice per second-interval and grew the session log without bound.
 *
 * The read now goes over a plain GET instead:
 * - the route answers the SAME code path as the page command
 *   (`runPageCommand(page, '/synthmedia jobs', { caller })`), so the JSON
 *   shape, session-tree scoping and the `downloadBase` field cannot drift;
 * - it is gated by a per-activation random token that the host injects into the
 *   served page (`globalThis.__SYNTHMEDIA_JOBS_TOKEN__`) through the
 *   `webserver/index-inject` seat, so a local process that can reach the port
 *   cannot enumerate sessions' jobs;
 * - it is read-only: no reveal/cancel here (those stay explicit user actions,
 *   one command event per click is expected).
 *
 * @module
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

/** Global property name the served page reads the token from. */
export const JOBS_TOKEN_GLOBAL = '__SYNTHMEDIA_JOBS_TOKEN__';

/** Answer shape of the page command this endpoint mirrors. */
export interface JobsCommandAnswer {
  readonly kind: 'success' | 'error';
  readonly text: string;
  readonly json?: unknown;
}

export interface JobsEndpointDeps {
  /** Per-activation random token; never logged. */
  readonly token: string;
  /** Runs the page command for one caller session id (and page size). */
  readonly run: (session: string, limit?: number) => Promise<JobsCommandAnswer>;
  /** Answer with this instead of the command when the token is missing. */
  readonly onUnauthorized?: (res: ServerResponse) => void;
}

const MAX_TOKEN_CHARS = 256;
const MAX_SESSION_CHARS = 256;

/** Constant-time comparison that tolerates length mismatch. */
function tokenMatches(expected: string, given: string | null): boolean {
  if (typeof given !== 'string' || given.length === 0 || given.length > MAX_TOKEN_CHARS) return false;
  if (given.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(given, 'utf8'));
  } catch {
    return false;
  }
}

function replyJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(text);
  } catch { /* response already gone */ }
}

/**
 * The `GET /synthmedia/api/jobs` route. Registered by the host half only when
 * `ctx.webServer` exists; absent, the client falls back to the command
 * transport (slower, but no page injection is available either).
 */
export function createJobsEndpointRoute(deps: JobsEndpointDeps): {
  kind: 'exact';
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
} {
  return {
    kind: 'exact',
    path: '/synthmedia/api/jobs',
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('method not allowed');
          return;
        }
        const url = new URL(req.url ?? '/', 'http://local');
        if (!tokenMatches(deps.token, url.searchParams.get('token'))) {
          if (deps.onUnauthorized) {
            deps.onUnauthorized(res);
            return;
          }
          replyJson(res, 403, { error: { code: 'E_UNAUTHORIZED', message: 'token required' } });
          return;
        }
        const session = url.searchParams.get('session');
        if (typeof session !== 'string' || session.length === 0 || session.length > MAX_SESSION_CHARS) {
          replyJson(res, 400, { error: { code: 'E_SESSION', message: 'session query parameter required' } });
          return;
        }
        // `limit` pages through the never-pruned history; the command clamps it.
        const rawLimit = Number(url.searchParams.get('limit'));
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : undefined;
        const answer = await deps.run(session, limit);
        // DEBUG: trace panel requests to pinpoint the empty-list bug.
        try {
          const { appendFileSync } = await import('node:fs');
          const jobsJson = answer.json as { jobs?: unknown[] } | undefined;
          const count = answer.kind === 'success' && jobsJson && Array.isArray(jobsJson.jobs) ? jobsJson.jobs.length : -1;
          appendFileSync('/Users/mars/jobs/dsh-synthmedia/jobs-endpoint-debug.log',
            `[${new Date().toISOString()}] session=${session} limit=${limit} kind=${answer.kind} jobs=${count}${answer.kind !== 'success' ? ' text=' + answer.text : ''}\n`);
        } catch { /* debug logging must never break the endpoint */ }
        if (answer.kind !== 'success') {
          replyJson(res, 500, { error: { code: 'E_JOBS', message: answer.text } });
          return;
        }
        replyJson(res, 200, answer.json ?? { jobs: [] });
      } catch {
        try {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('bad request');
        } catch { /* response already gone */ }
      }
    },
  };
}

/** The `webserver/index-inject` row that hands the token to the served page. */
export function jobsTokenInjection(token: string): { kind: 'global'; name: string; value: string } {
  return { kind: 'global', name: JOBS_TOKEN_GLOBAL, value: token };
}
