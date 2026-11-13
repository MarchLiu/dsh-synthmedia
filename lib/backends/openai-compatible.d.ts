/**
 * OpenAI-compatible backend: POST {baseUrl}/chat/completions with
 * `{model, messages:[{role:'user',content:prompt}]}` — TEXT generation only.
 * NOTE: this is NOT a video protocol; neither the zgci hub minimax-h3 nor any
 * offline H3 video runtime is served through this backend anymore (both use
 * the task-api /v1/videos shape — see config.ts). It remains available for
 * explicitly configured text backends.
 * @module
 */
import type { GenerationBackend } from '../types.js';
import type { BackendConfig } from '../config.js';
import { type CredentialResolver } from '../http.js';
export declare function createOpenAICompatibleBackend(cfg: BackendConfig, resolve?: CredentialResolver): GenerationBackend;
