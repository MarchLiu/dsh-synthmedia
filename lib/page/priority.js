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
export const TOOL_NAMES = ['ffmpeg', 'imagemagick', 'gimp', 'blender'];
const TOOL_SET = new Set(TOOL_NAMES);
/**
 * Parse a JSON array-of-strings config field. Non-array JSON, non-string
 * elements, empty strings and non-JSON garbage all degrade to items=[] with
 * a warning (never a throw). `allowed`, when given, silently drops unknown
 * values (each drop is reported).
 */
function parseStringArray(raw, label, allowed) {
    if (raw === undefined || raw === null || raw === '')
        return { items: [], warnings: [] };
    if (typeof raw !== 'string') {
        return { items: [], warnings: [`${label}：配置必须是 JSON 数组字符串，已忽略（得到 ${typeof raw}）`] };
    }
    const text = raw.trim();
    if (text === '')
        return { items: [], warnings: [] };
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return { items: [], warnings: [`${label}：JSON 解析失败，已降级为空列表`] };
    }
    if (!Array.isArray(parsed)) {
        return { items: [], warnings: [`${label}：不是 JSON 数组，已降级为空列表`] };
    }
    const items = [];
    const warnings = [];
    for (const el of parsed) {
        if (typeof el !== 'string' || el.trim() === '') {
            warnings.push(`${label}：忽略非字符串元素 ${JSON.stringify(el)}`);
            continue;
        }
        const v = el.trim();
        if (allowed && !allowed.has(v)) {
            warnings.push(`${label}：忽略未知值 '${v}'`);
            continue;
        }
        if (!items.includes(v))
            items.push(v);
    }
    return { items, warnings };
}
/** Parse `providerOrder` (profile id order = priority, earlier wins). */
export function parseOrder(raw) {
    const r = parseStringArray(raw, 'providerOrder');
    return { order: r.items, warnings: r.warnings };
}
/**
 * Parse `enabledDshResources`: elements shaped `"providerId::modelId"`.
 * Malformed elements (no `::` separator) are dropped with a warning.
 */
export function parseEnabledResources(raw) {
    const r = parseStringArray(raw, 'enabledDshResources');
    const resources = [];
    const warnings = [...r.warnings];
    for (const v of r.items) {
        const idx = v.indexOf('::');
        if (idx <= 0 || idx === v.length - 2) {
            warnings.push(`enabledDshResources：元素 '${v}' 不符合 "providerId::modelId" 形状，已忽略`);
            continue;
        }
        resources.push(v);
    }
    return { resources, warnings };
}
/** Parse `enabledTools`; unknown tool names are dropped with a warning. */
export function parseEnabledTools(raw) {
    const r = parseStringArray(raw, 'enabledTools', TOOL_SET);
    return { tools: r.items, warnings: r.warnings };
}
/**
 * STABLE priority sort: profiles listed in `order` come first, in `order`
 * sequence; unlisted profiles follow in their input (existing) order.
 * Duplicates in `order` use the first occurrence. Array.prototype.sort is
 * stable per spec, and the comparator returns 0 for same-rank pairs, so the
 * existing preset order is preserved exactly.
 */
export function orderProfiles(profiles, order) {
    const rank = new Map();
    order.forEach((id, i) => {
        if (!rank.has(id))
            rank.set(id, i);
    });
    return [...profiles].sort((a, b) => (rank.get(a.id) ?? Number.POSITIVE_INFINITY) - (rank.get(b.id) ?? Number.POSITIVE_INFINITY));
}
/**
 * Default-profile resolution: walk `orderProfiles(profiles, order)` and return
 * the FIRST profile that serves `modality`, is not `blockRealSubmit`, and
 * passes the optional `isEligible` gate (the ecosystem gate passes
 * `supported === true` here so 'other' ecosystems never become the default).
 * Returns undefined when nothing qualifies — callers fall back to the old
 * "first matching backend" behaviour only in display code, never silently
 * rerouting a real submit.
 */
export function resolveDefaultProfile(profiles, modality, order = [], isEligible) {
    for (const p of orderProfiles(profiles, order)) {
        if (!p.modalities.includes(modality))
            continue;
        if (p.blockRealSubmit === true)
            continue;
        if (isEligible && !isEligible(p))
            continue;
        return p;
    }
    return undefined;
}
//# sourceMappingURL=priority.js.map