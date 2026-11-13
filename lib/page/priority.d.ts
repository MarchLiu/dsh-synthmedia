/**
 * Priority parsing + routing helpers (pure, injectable, no I/O).
 *
 * Three config fields arrive as JSON-array strings (GUI volatile string
 * fields): `providerOrder` (profile ids, first = highest priority),
 * `enabledDshResources` (`"providerId::modelId"` entries checked from the DSH
 * subscription providers) and `enabledTools` (ffmpeg/imagemagick/gimp/blender).
 * Corrupt JSON ALWAYS degrades to an empty list plus a warning string — it
 * must never throw, never fail a boot, never break the config page.
 *
 * BACKWARD COMPATIBILITY: all three fields are new. Empty (default) means
 * exactly the pre-phase-one behaviour: no explicit order → existing preset
 * order; no enabled tools → none reported.
 * @module
 */
/** Local tool names the toolchain detector knows. */
export declare const TOOL_NAMES: readonly ["ffmpeg", "imagemagick", "gimp", "blender"];
export type ToolName = (typeof TOOL_NAMES)[number];
/** Minimal profile shape the router needs (structural, test-friendly). */
export interface PriorityProfile {
    readonly id: string;
    readonly modalities: ReadonlyArray<string>;
    readonly blockRealSubmit?: boolean;
}
/** Parse `providerOrder` (profile id order = priority, earlier wins). */
export declare function parseOrder(raw: unknown): {
    order: readonly string[];
    warnings: readonly string[];
};
/**
 * Parse `enabledDshResources`: elements shaped `"providerId::modelId"`.
 * Malformed elements (no `::` separator) are dropped with a warning.
 */
export declare function parseEnabledResources(raw: unknown): {
    resources: readonly string[];
    warnings: readonly string[];
};
/** Parse `enabledTools`; unknown tool names are dropped with a warning. */
export declare function parseEnabledTools(raw: unknown): {
    tools: readonly ToolName[];
    warnings: readonly string[];
};
/**
 * STABLE priority sort: profiles listed in `order` come first, in `order`
 * sequence; unlisted profiles follow in their input (existing) order.
 * Duplicates in `order` use the first occurrence. Array.prototype.sort is
 * stable per spec, and the comparator returns 0 for same-rank pairs, so the
 * existing preset order is preserved exactly.
 */
export declare function orderProfiles<T extends {
    readonly id: string;
}>(profiles: readonly T[], order: readonly string[]): T[];
/**
 * Default-profile resolution: walk `orderProfiles(profiles, order)` and return
 * the FIRST profile that serves `modality`, is not `blockRealSubmit`, and
 * passes the optional `isEligible` gate (the ecosystem gate passes
 * `supported === true` here so 'other' ecosystems never become the default).
 * Returns undefined when nothing qualifies — callers fall back to the old
 * "first matching backend" behaviour only in display code, never silently
 * rerouting a real submit.
 */
export declare function resolveDefaultProfile<T extends PriorityProfile>(profiles: readonly T[], modality: string, order?: readonly string[], isEligible?: (p: T) => boolean): T | undefined;
