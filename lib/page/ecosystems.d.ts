/**
 * Ecosystem gate: every profile/model is normalised to 'h3' | 'seedance' |
 * 'other'. Supported ecosystems participate in default routing and are
 * reported as supported:true; 'other' NEVER participates in default routing
 * and is reported supported:false with a reason — but nothing is ever
 * deleted: existing presets keep working through explicit backend ids, and
 * the preset-set assertions in the existing tests must stay green.
 *
 * seedance covers the three Ark faces: seedance (video) / seedream (image) /
 * seed-tts (audio). h3 covers MiniMax H3 over any of the video protocols.
 * @module
 */
import type { BackendConfig } from '../config.js';
export declare const SUPPORTED_ECOSYSTEMS: readonly ["h3", "seedance"];
export type MediaEcosystem = (typeof SUPPORTED_ECOSYSTEMS)[number] | 'other';
export interface EcosystemGate {
    readonly ecosystem: MediaEcosystem;
    readonly supported: boolean;
    readonly reason?: string;
}
/**
 * Normalise one model id (+ optional wire protocol) to a media ecosystem.
 * Model-id classification wins (via the shared classifyModel); the protocol
 * is only a tie-breaker for profiles whose model ids are opaque.
 *  - ark protocol without a seed* id stays 'other' (never guess).
 *  - minimax-video-compatible maps to 'h3' (the protocol IS the MiniMax H3
 *    video surface).
 */
export declare function modelEcosystem(modelId: string, protocol?: string): MediaEcosystem;
/** Gate one model: supported ⇔ ecosystem ∈ SUPPORTED_ECOSYSTEMS. */
export declare function modelGate(modelId: string, protocol?: string): EcosystemGate;
/**
 * Gate one profile by its DEFAULT model (profiles are single-ecosystem by
 * construction — one protocol, one model family). Works on the structural
 * shape a resolved BackendConfig (or a snapshot ProfileView) presents.
 */
export declare function profileGate(p: {
    readonly model?: string;
    readonly models?: readonly string[];
    readonly protocol?: string;
}): EcosystemGate;
/** Convenience over a whole resolved backends map. */
export declare function gateBackends(backends: Readonly<Record<string, BackendConfig>>): Record<string, EcosystemGate>;
