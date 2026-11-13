import { classifyModel } from './providers.js';
export const SUPPORTED_ECOSYSTEMS = ['h3', 'seedance'];
const SUPPORTED_SET = new Set(SUPPORTED_ECOSYSTEMS);
/**
 * Normalise one model id (+ optional wire protocol) to a media ecosystem.
 * Model-id classification wins (via the shared classifyModel); the protocol
 * is only a tie-breaker for profiles whose model ids are opaque.
 *  - ark protocol without a seed* id stays 'other' (never guess).
 *  - minimax-video-compatible maps to 'h3' (the protocol IS the MiniMax H3
 *    video surface).
 */
export function modelEcosystem(modelId, protocol) {
    const byId = classifyModel(modelId);
    if (byId.ecosystem === 'volcengine-seedance')
        return 'seedance';
    if (byId.ecosystem === 'minimax-h3')
        return 'h3';
    if (protocol === 'minimax-video-compatible')
        return 'h3';
    return 'other';
}
/** Gate one model: supported ⇔ ecosystem ∈ SUPPORTED_ECOSYSTEMS. */
export function modelGate(modelId, protocol) {
    const ecosystem = modelEcosystem(modelId, protocol);
    if (SUPPORTED_SET.has(ecosystem))
        return { ecosystem, supported: true };
    return {
        ecosystem,
        supported: false,
        reason: `生态 '${ecosystem}' 暂不在支持列表 [${SUPPORTED_ECOSYSTEMS.join(', ')}]，不参与默认路由；仍可通过显式 backend id 调用`,
    };
}
/**
 * Gate one profile by its DEFAULT model (profiles are single-ecosystem by
 * construction — one protocol, one model family). Works on the structural
 * shape a resolved BackendConfig (or a snapshot ProfileView) presents.
 */
export function profileGate(p) {
    const model = p.model ?? (p.models && p.models.length > 0 ? p.models[0] : '');
    return modelGate(model, p.protocol);
}
/** Convenience over a whole resolved backends map. */
export function gateBackends(backends) {
    const out = {};
    for (const [id, b] of Object.entries(backends))
        out[id] = profileGate(b);
    return out;
}
//# sourceMappingURL=ecosystems.js.map