/** Base class: `sanitize()` strips anything credential-shaped. */
export class SynthError extends Error {
    code;
    backend;
    retriable;
    constructor(code, message, backend, retriable = false) {
        super(message);
        this.name = 'SynthError';
        this.code = code;
        this.backend = backend;
        this.retriable = retriable;
    }
    toSanitized() {
        return {
            code: this.code,
            message: sanitizeText(this.message),
            backend: this.backend,
            retriable: this.retriable,
        };
    }
}
const SECRET_PATTERNS = [
    [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>'],
    [/Basic\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Basic <redacted>'],
    [/sk-[A-Za-z0-9._-]{6,}/g, 'sk-<redacted>'],
    [/(api[_-]?key|token|secret|password|authorization|credential)s?["'=:\s]+[^\s"',;}{]{6,}/gi, '$1=<redacted>'],
];
/** Redact credential-shaped substrings from any free-form text. */
export function sanitizeText(text) {
    let out = text;
    for (const [pattern, replacement] of SECRET_PATTERNS) {
        out = out.replace(pattern, replacement);
    }
    return out;
}
/** Redact an unknown thrown value into a SanitizedError. */
export function sanitizeUnknown(error, backend) {
    if (error instanceof SynthError)
        return error.toSanitized();
    const raw = error instanceof Error ? error.message : String(error);
    return {
        code: 'E_BACKEND',
        message: sanitizeText(raw),
        backend,
        retriable: false,
    };
}
/** Error thrown when an offline/local backend cannot be reached. */
export class OfflineUnavailableError extends SynthError {
    constructor(backend, detail) {
        super('E_OFFLINE_UNAVAILABLE', `local backend '${backend}' is unavailable and requests are never silently forwarded to a cloud provider: ${sanitizeText(detail)}`, backend, true);
        this.name = 'OfflineUnavailableError';
    }
}
/**
 * Map a raw network failure on an offline backend to OfflineUnavailableError
 * (E_OFFLINE_UNAVAILABLE); pass everything else through untouched. Online
 * backends keep E_NETWORK.
 */
export function maybeOffline(backend, online, error) {
    if (!online && error instanceof SynthError && error.code === 'E_NETWORK') {
        return new OfflineUnavailableError(backend, error.message);
    }
    return error;
}
//# sourceMappingURL=errors.js.map