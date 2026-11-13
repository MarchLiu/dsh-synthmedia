import { SynthError, maybeOffline } from '../errors.js';
import { envCredentialResolver } from '../http.js';
import { createOpenAICompatibleBackend } from './openai-compatible.js';
import { createTaskApiBackend } from './task-api.js';
import { createArkBackend } from './ark.js';
import { createMinimaxBackend } from './minimax.js';
import { createDashScopeBackend } from './dashscope.js';
import { createGeminiBackend } from './gemini.js';
import { createOpenAIImagesBackend } from './openai-images.js';
export function createBackend(cfg, resolve = envCredentialResolver) {
    let backend;
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
            const never = cfg.protocol;
            throw new SynthError('E_CONFIG', `unknown protocol: ${String(never)}`, cfg.id);
        }
    }
    if (cfg.online)
        return backend;
    // Offline: wrap network-layer failures as OfflineUnavailableError.
    const wrap = (fn) => fn
        ? async (...a) => {
            try {
                return await fn(...a);
            }
            catch (err) {
                throw maybeOffline(cfg.id, false, err);
            }
        }
        : undefined;
    return {
        ...backend,
        create: wrap(backend.create),
        poll: wrap(backend.poll),
        fetch: wrap(backend.fetch),
        cancel: backend.cancel ? wrap(backend.cancel) : undefined,
    };
}
export function createBackendRegistry(config, resolve = envCredentialResolver) {
    const registry = new Map();
    for (const cfg of Object.values(config.backends)) {
        registry.set(cfg.id, createBackend(cfg, resolve));
    }
    return registry;
}
//# sourceMappingURL=index.js.map