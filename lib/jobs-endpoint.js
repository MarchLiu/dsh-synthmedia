import { timingSafeEqual } from 'node:crypto';
/** Global property name the served page reads the token from. */
export const JOBS_TOKEN_GLOBAL = '__SYNTHMEDIA_JOBS_TOKEN__';
const MAX_TOKEN_CHARS = 256;
const MAX_SESSION_CHARS = 256;
/** Constant-time comparison that tolerates length mismatch. */
function tokenMatches(expected, given) {
    if (typeof given !== 'string' || given.length === 0 || given.length > MAX_TOKEN_CHARS)
        return false;
    if (given.length !== expected.length)
        return false;
    try {
        return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(given, 'utf8'));
    }
    catch {
        return false;
    }
}
function replyJson(res, status, body) {
    const text = JSON.stringify(body);
    try {
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        });
        res.end(text);
    }
    catch { /* response already gone */ }
}
/**
 * The `GET /synthmedia/api/jobs` route. Registered by the host half only when
 * `ctx.webServer` exists; absent, the client falls back to the command
 * transport (slower, but no page injection is available either).
 */
export function createJobsEndpointRoute(deps) {
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
                    const count = answer.kind === 'success' && answer.json && Array.isArray(answer.json.jobs) ? answer.json.jobs.length : -1;
                    appendFileSync('/Users/mars/jobs/dsh-synthmedia/jobs-endpoint-debug.log',
                        `[${new Date().toISOString()}] session=${session} limit=${limit} kind=${answer.kind} jobs=${count}${answer.kind !== 'success' ? ' text=' + answer.text : ''}\n`);
                }
                catch { /* debug logging must never break the endpoint */ }
                if (answer.kind !== 'success') {
                    replyJson(res, 500, { error: { code: 'E_JOBS', message: answer.text } });
                    return;
                }
                replyJson(res, 200, answer.json ?? { jobs: [] });
            }
            catch {
                try {
                    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('bad request');
                }
                catch { /* response already gone */ }
            }
        },
    };
}
/** The `webserver/index-inject` row that hands the token to the served page. */
export function jobsTokenInjection(token) {
    return { kind: 'global', name: JOBS_TOKEN_GLOBAL, value: token };
}
//# sourceMappingURL=jobs-endpoint.js.map