/**
 * Remote-vs-local time helpers.
 *
 * A provider may report when a REMOTE task reached its terminal state
 * (`completed_at`, or the `updated_at` of a terminal status). That instant is
 * not the moment this plugin finished polling and downloading the artifact:
 * the latter is local wall-clock time written only after `fetch()` returned.
 * Job records keep them in separate fields (`remoteCompletedAt` vs
 * `downloadedAt` / `finishedAt`) and neither is ever used to label the other.
 * @module
 */
import type { BackendPoll } from './types.js';
/**
 * Normalise a remote timestamp to ISO-8601.
 *
 * Accepts unix seconds (10-digit number or numeric string, e.g. `1785125946`),
 * unix milliseconds (13-digit), or an ISO/RFC-3339 string. Anything else —
 * including `0`, booleans, malformed text — is `undefined`, never a guessed
 * time.
 */
export declare function toIsoTimestamp(value: unknown): string | undefined;
/**
 * Extract the REMOTE terminal timestamp from one task object.
 *
 * Only used once the poll has already reported a terminal status: `completed_at`
 * / `finished_at` when the provider documents them, otherwise `updated_at`
 * (which is the last status change — i.e. the completion instant — for a task
 * that has just reached a terminal state). Returns undefined when the provider
 * reports no timestamp, so local completion time is never mislabelled as remote.
 */
export declare function remoteCompletedAtOf(task: Record<string, unknown> | undefined, status: BackendPoll['status']): string | undefined;
