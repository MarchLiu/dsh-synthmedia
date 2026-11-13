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
import { classifyModel } from './providers.js';

export const SUPPORTED_ECOSYSTEMS = ['h3', 'seedance'] as const;
export type MediaEcosystem = (typeof SUPPORTED_ECOSYSTEMS)[number] | 'other';

export interface EcosystemGate {
  readonly ecosystem: MediaEcosystem;
  readonly supported: boolean;
  readonly reason?: string;
}

const SUPPORTED_SET: ReadonlySet<string> = new Set(SUPPORTED_ECOSYSTEMS);

/**
 * Normalise one model id (+ optional wire protocol) to a media ecosystem.
 * Model-id classification wins (via the shared classifyModel); the protocol
 * is only a tie-breaker for profiles whose model ids are opaque.
 *  - ark protocol without a seed* id stays 'other' (never guess).
 *  - minimax-video-compatible maps to 'h3' (the protocol IS the MiniMax H3
 *    video surface).
 */
export function modelEcosystem(modelId: string, protocol?: string): MediaEcosystem {
  const byId = classifyModel(modelId);
  if (byId.ecosystem === 'volcengine-seedance') return 'seedance';
  if (byId.ecosystem === 'minimax-h3') return 'h3';
  if (protocol === 'minimax-video-compatible') return 'h3';
  return 'other';
}

/** Gate one model: supported ⇔ ecosystem ∈ SUPPORTED_ECOSYSTEMS. */
export function modelGate(modelId: string, protocol?: string): EcosystemGate {
  const ecosystem = modelEcosystem(modelId, protocol);
  if (SUPPORTED_SET.has(ecosystem)) return { ecosystem, supported: true };
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
export function profileGate(p: {
  readonly model?: string;
  readonly models?: readonly string[];
  readonly protocol?: string;
}): EcosystemGate {
  const model = p.model ?? (p.models && p.models.length > 0 ? p.models[0]! : '');
  return modelGate(model, p.protocol);
}

/** Convenience over a whole resolved backends map. */
export function gateBackends(backends: Readonly<Record<string, BackendConfig>>): Record<string, EcosystemGate> {
  const out: Record<string, EcosystemGate> = {};
  for (const [id, b] of Object.entries(backends)) out[id] = profileGate(b);
  return out;
}
