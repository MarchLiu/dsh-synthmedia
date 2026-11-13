/**
 * Minimal fetch wrappers with hard timeout, cooperative abort, and safe error
 * mapping. Text responses go through `sanitizeText`; binary responses use the
 * no-decode `arrayBuffer()` path so MP4/image bytes are never mangled by
 * UTF-8/latin1 character decoding. @module
 */
import { randomUUID } from 'node:crypto';
import { SynthError, sanitizeText } from './errors.js';

export interface HttpResult {
  status: number;
  body: string;
}

export interface HttpBytesResult {
  status: number;
  bytes: Buffer;
  /** Raw Content-Type header (may be undefined); charset suffix stripped by callers as needed. */
  contentType?: string;
}

async function fetchWithTimeout(
  backend: string,
  url: string,
  init: {
    method: 'GET' | 'POST' | 'DELETE';
    headers?: Record<string, string>;
    body?: string | Buffer;
    signal: AbortSignal;
    timeoutMs: number;
  },
): Promise<Response> {
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
    } catch (err) {
      if (init.signal.aborted) throw new SynthError('E_CANCELLED', 'request cancelled by caller', backend);
      const detail = err instanceof Error ? err.message : String(err);
      throw new SynthError('E_NETWORK', `request to backend failed: ${sanitizeText(detail)}`, backend, true);
    }
  } finally {
    clearTimeout(timer);
    init.signal.removeEventListener('abort', onAbort);
  }
}

export async function httpRequest(
  backend: string,
  url: string,
  init: {
    method: 'GET' | 'POST' | 'DELETE';
    headers?: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    timeoutMs: number;
  },
): Promise<HttpResult> {
  const response = await fetchWithTimeout(backend, url, init);
  const body = await response.text();
  return { status: response.status, body };
}

/**
 * Binary-safe fetch: reads the response through `response.arrayBuffer()`,
 * which performs NO character decoding. Bytes come back exactly as sent
 * (0xff / 0x80 / multi-byte UTF-8 all survive verbatim).
 */
export async function httpRequestBytes(
  backend: string,
  url: string,
  init: {
    method: 'GET' | 'POST' | 'DELETE';
    headers?: Record<string, string>;
    body?: string | Buffer;
    signal: AbortSignal;
    timeoutMs: number;
  },
): Promise<HttpBytesResult> {
  const response = await fetchWithTimeout(backend, url, init);
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') ?? undefined;
  return { status: response.status, bytes, contentType };
}

/** Parse JSON, mapping failures to a structured error (never raw body dumps). */
export function parseJson<T>(backend: string, body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new SynthError('E_PROTOCOL', 'backend returned a non-JSON response', backend);
  }
}

/** Build a multipart/form-data body (the vLLM-Omni /v1/videos shape). */
export function multipartFields(fields: Record<string, string>): { contentType: string; body: Buffer } {
  const boundary = `synthmedia-${randomUUID()}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) };
}

/** Build the auth header value from an env-var NAME; never logs the value. */
/** Resolves a credential reference NAME to its value (never cached). */
export type CredentialResolver = (ref: string) => Promise<string | undefined>;

/** Default resolver: the process environment (the documented fallback). */
export const envCredentialResolver: CredentialResolver = async (ref) => process.env[ref];

export interface AuthConfig {
  readonly id: string;
  readonly authStyle: 'bearer' | 'basic' | 'raw' | 'none';
  readonly authHeader?: string;
  readonly authEnv?: string;
  readonly credentialRef?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Resolve credentials for one request. The reference is either the profile's
 * DSH credential reference or its env-var name; the host credential provider
 * (ctx.credentials) is consulted first by the caller's resolver, with
 * process.env as the documented fallback. Resolution happens per call and the
 * value never leaves this function.
 */
export async function authHeaders(cfg: AuthConfig, resolve: CredentialResolver): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...(cfg.headers ?? {}) };
  if (cfg.authStyle === 'none') return headers;
  const ref = cfg.credentialRef ?? cfg.authEnv;
  if (!ref) {
    throw new SynthError(
      'E_NO_CREDENTIAL',
      `backend '${cfg.id}' has no credential reference configured (authEnv / credentialRef)`,
      cfg.id,
    );
  }
  const value = await resolve(ref);
  if (!value) {
    throw new SynthError(
      'E_NO_CREDENTIAL',
      `credential reference '${ref}' is not set for backend '${cfg.id}'`,
      cfg.id,
    );
  }
  const header = cfg.authHeader ?? 'Authorization';
  if (cfg.authStyle === 'bearer') headers[header] = `Bearer ${value}`;
  else if (cfg.authStyle === 'basic') headers[header] = `Basic ${Buffer.from(value).toString('base64')}`;
  else headers[header] = value;
  return headers;
}
