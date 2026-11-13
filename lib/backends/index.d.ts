/**
 * Protocol-adapter registry: maps a profile's PROTOCOL id to an adapter
 * implementation. There is no provider branch here — a new gateway with the
 * same protocol reuses the same adapter unchanged.
 *
 * Offline profiles get network-layer failures mapped to E_OFFLINE_UNAVAILABLE
 * so a dead local service can never look like a generic transport error (and is
 * never forwarded to a cloud profile).
 * @module
 */
import type { GenerationBackend } from '../types.js';
import type { BackendConfig, SynthMediaConfig } from '../config.js';
import { type CredentialResolver } from '../http.js';
export declare function createBackend(cfg: BackendConfig, resolve?: CredentialResolver): GenerationBackend;
export declare function createBackendRegistry(config: SynthMediaConfig, resolve?: CredentialResolver): Map<string, GenerationBackend>;
