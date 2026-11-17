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
/** Global property name the served page reads the token from. */
export declare const JOBS_TOKEN_GLOBAL = "__SYNTHMEDIA_JOBS_TOKEN__";
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
/**
 * The `GET /synthmedia/api/jobs` route. Registered by the host half only when
 * `ctx.webServer` exists; absent, the client falls back to the command
 * transport (slower, but no page injection is available either).
 */
export declare function createJobsEndpointRoute(deps: JobsEndpointDeps): {
    kind: 'exact';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
};
/** The `webserver/index-inject` row that hands the token to the served page. */
export declare function jobsTokenInjection(token: string): {
    kind: 'global';
    name: string;
    value: string;
};
