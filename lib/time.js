/**
 * Normalise a remote timestamp to ISO-8601.
 *
 * Accepts unix seconds (10-digit number or numeric string, e.g. `1785125946`),
 * unix milliseconds (13-digit), or an ISO/RFC-3339 string. Anything else —
 * including `0`, booleans, malformed text — is `undefined`, never a guessed
 * time.
 */
export function toIsoTimestamp(value) {
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value <= 0)
            return undefined;
        const ms = value < 1e12 ? value * 1000 : value;
        const date = new Date(ms);
        return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.length === 0)
            return undefined;
        if (/^\d{10,13}$/.test(trimmed))
            return toIsoTimestamp(Number(trimmed));
        const date = new Date(trimmed);
        return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }
    return undefined;
}
/**
 * Extract the REMOTE terminal timestamp from one task object.
 *
 * Only used once the poll has already reported a terminal status: `completed_at`
 * / `finished_at` when the provider documents them, otherwise `updated_at`
 * (which is the last status change — i.e. the completion instant — for a task
 * that has just reached a terminal state). Returns undefined when the provider
 * reports no timestamp, so local completion time is never mislabelled as remote.
 */
export function remoteCompletedAtOf(task, status) {
    if (!task || status === 'running')
        return undefined;
    for (const key of ['completed_at', 'finished_at', 'updated_at']) {
        const iso = toIsoTimestamp(task[key]);
        if (iso)
            return iso;
    }
    return undefined;
}
//# sourceMappingURL=time.js.map