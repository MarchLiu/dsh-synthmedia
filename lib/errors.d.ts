/**
 * Structured errors + secret sanitization. No credential value may ever reach
 * a job record, a tool output, or a log line produced by this plugin.
 * @module
 */
import type { SanitizedError } from './types.js';
/** Base class: `sanitize()` strips anything credential-shaped. */
export declare class SynthError extends Error {
    readonly code: string;
    readonly backend: string;
    readonly retriable: boolean;
    constructor(code: string, message: string, backend: string, retriable?: boolean);
    toSanitized(): SanitizedError;
}
/** Redact credential-shaped substrings from any free-form text. */
export declare function sanitizeText(text: string): string;
/** Redact an unknown thrown value into a SanitizedError. */
export declare function sanitizeUnknown(error: unknown, backend: string): SanitizedError;
/** Error thrown when an offline/local backend cannot be reached. */
export declare class OfflineUnavailableError extends SynthError {
    constructor(backend: string, detail: string);
}
/**
 * Map a raw network failure on an offline backend to OfflineUnavailableError
 * (E_OFFLINE_UNAVAILABLE); pass everything else through untouched. Online
 * backends keep E_NETWORK.
 */
export declare function maybeOffline(backend: string, online: boolean, error: unknown): unknown;
