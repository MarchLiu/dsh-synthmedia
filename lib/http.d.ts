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
export declare function httpRequest(backend: string, url: string, init: {
    method: 'GET' | 'POST' | 'DELETE';
    headers?: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    timeoutMs: number;
}): Promise<HttpResult>;
/**
 * Binary-safe fetch: reads the response through `response.arrayBuffer()`,
 * which performs NO character decoding. Bytes come back exactly as sent
 * (0xff / 0x80 / multi-byte UTF-8 all survive verbatim).
 */
export declare function httpRequestBytes(backend: string, url: string, init: {
    method: 'GET' | 'POST' | 'DELETE';
    headers?: Record<string, string>;
    body?: string | Buffer;
    signal: AbortSignal;
    timeoutMs: number;
}): Promise<HttpBytesResult>;
/** Parse JSON, mapping failures to a structured error (never raw body dumps). */
export declare function parseJson<T>(backend: string, body: string): T;
/** Build a multipart/form-data body (the vLLM-Omni /v1/videos shape). */
export declare function multipartFields(fields: Record<string, string>): {
    contentType: string;
    body: Buffer;
};
/** Build the auth header value from an env-var NAME; never logs the value. */
/** Resolves a credential reference NAME to its value (never cached). */
export type CredentialResolver = (ref: string) => Promise<string | undefined>;
/** Default resolver: the process environment (the documented fallback). */
export declare const envCredentialResolver: CredentialResolver;
declare function credentialFileLookup(ref: string): string | undefined;
/** Exposed for sibling modules so every resolver path shares the file fallback. */
export declare const fileCredentialLookup: typeof credentialFileLookup;
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
export declare function authHeaders(cfg: AuthConfig, resolve: CredentialResolver): Promise<Record<string, string>>;
export {};
