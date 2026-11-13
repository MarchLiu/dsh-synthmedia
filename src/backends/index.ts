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
import { SynthError, maybeOffline } from '../errors.js';
import { envCredentialResolver, type CredentialResolver } from '../http.js';
import { createOpenAICompatibleBackend } from './openai-compatible.js';
import { createTaskApiBackend } from './task-api.js';
import { createArkBackend } from './ark.js';
import { createMinimaxBackend } from './minimax.js';
import { createDashScopeBackend } from './dashscope.js';
import { createGeminiBackend } from './gemini.js';
import { createOpenAIImagesBackend } from './openai-images.js';

export function createBackend(cfg: BackendConfig, resolve: CredentialResolver = envCredentialResolver): GenerationBackend {
  let backend: GenerationBackend;
  switch (cfg.protocol) {
    case 'openai-chat-compatible':
      backend = createOpenAICompatibleBackend(cfg, resolve);
      break;
    case 'openai-video-compatible':
    case 'videogen-task-api':
      backend = createTaskApiBackend(cfg, resolve);
      break;
    case 'volcengine-ark-compatible':
      backend = createArkBackend(cfg, resolve);
      break;
    case 'minimax-video-compatible':
      backend = createMinimaxBackend(cfg, resolve);
      break;
    case 'dashscope-wan-compatible':
      backend = createDashScopeBackend(cfg, resolve);
      break;
    case 'google-genmedia-compatible':
      backend = createGeminiBackend(cfg, resolve);
      break;
    case 'openai-images-compatible':
      backend = createOpenAIImagesBackend(cfg, resolve);
      break;
    default: {
      const never: never = cfg.protocol;
      throw new SynthError('E_CONFIG', `unknown protocol: ${String(never)}`, cfg.id);
    }
  }
  if (cfg.online) return backend;

  // Offline: wrap network-layer failures as OfflineUnavailableError.
  const wrap = <A extends unknown[]>(fn: ((...a: A) => Promise<unknown>) | undefined) =>
    fn
      ? async (...a: A) => {
          try {
            return await fn(...a);
          } catch (err) {
            throw maybeOffline(cfg.id, false, err);
          }
        }
      : undefined;
  return {
    ...backend,
    create: wrap(backend.create) as GenerationBackend['create'],
    poll: wrap(backend.poll) as GenerationBackend['poll'],
    fetch: wrap(backend.fetch) as GenerationBackend['fetch'],
    cancel: backend.cancel ? (wrap(backend.cancel) as NonNullable<GenerationBackend['cancel']>) : undefined,
  };
}

export function createBackendRegistry(
  config: SynthMediaConfig,
  resolve: CredentialResolver = envCredentialResolver,
): Map<string, GenerationBackend> {
  const registry = new Map<string, GenerationBackend>();
  for (const cfg of Object.values(config.backends)) {
    registry.set(cfg.id, createBackend(cfg, resolve));
  }
  return registry;
}
