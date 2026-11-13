import { SynthError, sanitizeText } from '../errors.js';
import { httpRequest, parseJson, authHeaders, envCredentialResolver } from '../http.js';
import { modelCapabilitiesFor, PROTOCOL_OPENAI_CHAT } from '../presets.js';
export function createOpenAICompatibleBackend(cfg, resolve = envCredentialResolver) {
    return {
        id: cfg.id,
        capabilities() {
            const models = cfg.models && cfg.models.length > 0 ? [...cfg.models] : [cfg.model];
            return {
                modalities: [...cfg.modalities],
                models,
                online: cfg.online,
                protocolVerified: cfg.protocolVerified === true,
                liveVerified: cfg.liveVerified === true,
                realSubmitAllowed: cfg.protocolVerified === true && cfg.blockRealSubmit !== true,
                protocol: PROTOCOL_OPENAI_CHAT,
                modelCapabilities: modelCapabilitiesFor(PROTOCOL_OPENAI_CHAT, cfg.modalities, models),
            };
        },
        async create(req, signal) {
            if (!cfg.modalities.includes(req.modality)) {
                throw new SynthError('E_MODALITY', `backend '${cfg.id}' does not serve modality '${req.modality}'`, cfg.id);
            }
            if (cfg.protocolVerified !== true || cfg.blockRealSubmit === true) {
                throw new SynthError('E_PROTOCOL_UNVERIFIED', `backend '${cfg.id}': chat protocol is not verified for this deployment; real submission is disabled`, cfg.id);
            }
            const headers = { 'Content-Type': 'application/json', ...(await authHeaders(cfg, resolve)) };
            const payload = {
                model: req.model,
                messages: [{ role: 'user', content: req.prompt }],
            };
            if (typeof req.seed === 'number')
                payload['seed'] = req.seed;
            for (const [k, v] of Object.entries(cfg.extraBody ?? {}))
                payload[k] = v;
            const { status, body } = await httpRequest(cfg.id, `${cfg.baseUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal,
                timeoutMs: cfg.timeoutMs,
            });
            const data = parseJson(cfg.id, body);
            if (status !== 200) {
                const msg = sanitizeText(data.error?.message ?? `http ${status}`);
                throw new SynthError('E_REMOTE', `chat/completions failed: ${msg}`, cfg.id, status >= 500);
            }
            const text = data.choices?.[0]?.message?.content;
            if (typeof text !== 'string') {
                throw new SynthError('E_PROTOCOL', 'response missing choices[0].message.content', cfg.id);
            }
            // Inline completion: the whole artifact is available at create() time.
            return { remoteId: 'inline', inline: { text, mimeType: 'text/plain' } };
        },
        async poll() {
            // OpenAI completions are synchronous; once created (non-inline path never
            // happens here) there is nothing to poll.
            const poll = { status: 'succeeded', progress: 100 };
            return poll;
        },
        async fetch() {
            throw new SynthError('E_PROTOCOL', 'openai-compatible backend produces inline text artifacts', cfg.id);
        },
    };
}
//# sourceMappingURL=openai-compatible.js.map