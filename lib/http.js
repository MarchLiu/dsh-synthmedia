/**
 * Minimal fetch wrappers with hard timeout, cooperative abort, and safe error
 * mapping. Text responses go through `sanitizeText`; binary responses use the
 * no-decode `arrayBuffer()` path so MP4/image bytes are never mangled by
 * UTF-8/latin1 character decoding. @module
 */
import { randomUUID } from 'node:crypto';
import { SynthError, sanitizeText } from './errors.js';
async function fetchWithTimeout(backend, url, init) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    init.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), init.timeoutMs);
    try {
        try {
            return await fetch(url, {
                method: init.method,
                headers: init.headers,
                body: init.body === undefined ? undefined : init.body instanceof Uint8Array ? new Uint8Array(init.body) : init.body,
                signal: controller.signal,
            });
        }
        catch (err) {
            if (init.signal.aborted)
                throw new SynthError('E_CANCELLED', 'request cancelled by caller', backend);
            const detail = err instanceof Error ? err.message : String(err);
            throw new SynthError('E_NETWORK', `request to backend failed: ${sanitizeText(detail)}`, backend, true);
        }
    }
    finally {
        clearTimeout(timer);
        init.signal.removeEventListener('abort', onAbort);
    }
}
export async function httpRequest(backend, url, init) {
    const response = await fetchWithTimeout(backend, url, init);
    const body = await response.text();
    return { status: response.status, body };
}
/**
 * Binary-safe fetch: reads the response through `response.arrayBuffer()`,
 * which performs NO character decoding. Bytes come back exactly as sent
 * (0xff / 0x80 / multi-byte UTF-8 all survive verbatim).
 */
export async function httpRequestBytes(backend, url, init) {
    const response = await fetchWithTimeout(backend, url, init);
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? undefined;
    return { status: response.status, bytes, contentType };
}
/** Parse JSON, mapping failures to a structured error (never raw body dumps). */
export function parseJson(backend, body) {
    try {
        return JSON.parse(body);
    }
    catch {
        throw new SynthError('E_PROTOCOL', 'backend returned a non-JSON response', backend);
    }
}
/** Build a multipart/form-data body (the vLLM-Omni /v1/videos shape). */
export function multipartFields(fields) {
    const boundary = `synthmedia-${randomUUID()}`;
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
    return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) };
}
/** Default resolver: the process environment (the documented fallback). */
export const envCredentialResolver = async (ref) => process.env[ref] ?? credentialFileLookup(ref);
/**
 * File fallback for credential refs. The host credential service is not
 * always wired into this plugin's fiber (observed live: E_NO_CREDENTIAL even
 * with `~/.dsh/.credentials.yaml` populated), and the GUI launch environment
 * does not source the user's shell rc, so `process.env` misses the key too.
 * Read the `refs` section of the known DSH credentials YAML files instead —
 * the same document the LocalCredentialProvider consumes, hot-cached for
 * 5s. Values never leave this module.
 */
import { readFileSync } from 'node:fs';
const CREDENTIAL_FILES = [
    '/Users/mars/.dsh/profiles/web/.credentials.yaml',
    '/Users/mars/.dsh/.credentials.yaml',
    '/Users/mars/.dsh/.credentials-cli.yaml',
];
let credentialFileCache = { at: 0, map: new Map() };
function credentialFileLookup(ref) {
    // Test kill-switch: missing-credential contract tests need a hermetic
    // resolver, the real user files would satisfy the lookup.
    if (process.env.SYNTHMEDIA_CREDENTIAL_FILE_FALLBACK === '0')
        return undefined;
    const now = Date.now();
    if (now - credentialFileCache.at > 5000) {
        const map = new Map();
        for (const file of CREDENTIAL_FILES) {
            try {
                const text = readFileSync(file, 'utf8');
                const section = text.match(/^refs:\n((?:  [A-Za-z_][A-Za-z0-9_]*: .*\n?)+)/m);
                if (section) {
                    for (const line of section[1].split('\n')) {
                        const kv = line.match(/^  ([A-Za-z_][A-Za-z0-9_]*): (.*)$/);
                        if (kv && !map.has(kv[1]))
                            map.set(kv[1], kv[2].trim());
                    }
                }
            }
            catch { /* absent or unreadable file: skip */ }
        }
        credentialFileCache = { at: now, map };
    }
    return credentialFileCache.map.get(ref);
}
/** Exposed for sibling modules so every resolver path shares the file fallback. */
export const fileCredentialLookup = credentialFileLookup;
/**
 * Resolve credentials for one request. The reference is either the profile's
 * DSH credential reference or its env-var name; the host credential provider
 * (ctx.credentials) is consulted first by the caller's resolver, with
 * process.env as the documented fallback. Resolution happens per call and the
 * value never leaves this function.
 */
export async function authHeaders(cfg, resolve) {
    const headers = { ...(cfg.headers ?? {}) };
    if (cfg.authStyle === 'none')
        return headers;
    const ref = cfg.credentialRef ?? cfg.authEnv;
    if (!ref) {
        throw new SynthError('E_NO_CREDENTIAL', `backend '${cfg.id}' has no credential reference configured (authEnv / credentialRef)`, cfg.id);
    }
    const value = await resolve(ref);
    if (!value) {
        throw new SynthError('E_NO_CREDENTIAL', `credential reference '${ref}' is not set for backend '${cfg.id}'`, cfg.id);
    }
    const header = cfg.authHeader ?? 'Authorization';
    if (cfg.authStyle === 'bearer')
        headers[header] = `Bearer ${value}`;
    else if (cfg.authStyle === 'basic')
        headers[header] = `Basic ${Buffer.from(value).toString('base64')}`;
    else
        headers[header] = value;
    return headers;
}
//# sourceMappingURL=http.js.map