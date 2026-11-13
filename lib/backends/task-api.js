import { SynthError, sanitizeText } from '../errors.js';
import { httpRequest, httpRequestBytes, parseJson, authHeaders, multipartFields, envCredentialResolver } from '../http.js';
import { modelCapabilitiesFor } from '../presets.js';
import { remoteCompletedAtOf } from '../time.js';
/** Map an Sora/videogen-style status string onto the unified poll vocabulary. */
export function mapTaskStatus(s, progress, errMsg) {
    const norm = s.toLowerCase();
    if (norm === 'completed' || norm === 'succeeded' || norm === 'success')
        return { status: 'succeeded', progress: 100 };
    if (norm === 'failed')
        return { status: 'failed', progress, error: { code: 'E_REMOTE', message: sanitizeText(errMsg ?? 'task failed') } };
    if (norm === 'cancelled' || norm === 'canceled')
        return { status: 'cancelled', progress };
    // queued / in_progress / running / anything unknown: still in flight
    return { status: 'running', progress };
}
export function createTaskApiBackend(cfg, resolve = envCredentialResolver) {
    const paths = cfg.paths;
    const withId = (tpl, id) => tpl.replace('{id}', encodeURIComponent(id));
    /** Build the submit body honoring submitEncoding (JSON default, multipart for sidecars). */
    async function buildSubmit(req) {
        const auth = await authHeaders(cfg, resolve);
        const fields = { prompt: req.prompt, model: req.model };
        if (typeof req.durationSeconds === 'number')
            fields['seconds'] = cfg.secondsAsString ? String(req.durationSeconds) : String(req.durationSeconds);
        if (typeof req.seed === 'number')
            fields['seed'] = String(req.seed);
        if (req.size)
            fields['size'] = req.size.replace('*', 'x');
        if (req.negativePrompt)
            fields['negative_prompt'] = req.negativePrompt;
        if (req.options && typeof req.options['image_base64'] === 'string')
            fields['image_base64'] = req.options['image_base64'];
        for (const [k, v] of Object.entries(cfg.extraBody ?? {}))
            fields[k] = typeof v === 'string' ? v : JSON.stringify(v);
        if (cfg.submitEncoding === 'multipart') {
            const multipart = multipartFields(fields);
            return { headers: { ...auth, 'Content-Type': multipart.contentType }, body: multipart.body };
        }
        // JSON path: numeric seconds stay numeric (videogen.py sends int); string
        // seconds when cfg.secondsAsString (hub verify script sends "4").
        const payload = { prompt: req.prompt, model: req.model };
        if (typeof req.durationSeconds === 'number')
            payload['seconds'] = cfg.secondsAsString ? String(req.durationSeconds) : req.durationSeconds;
        if (typeof req.seed === 'number')
            payload['seed'] = req.seed;
        if (req.size)
            payload['size'] = req.size.replace('*', 'x');
        if (req.negativePrompt)
            payload['negative_prompt'] = req.negativePrompt;
        if (req.options && typeof req.options['image_base64'] === 'string')
            payload['image_base64'] = req.options['image_base64'];
        for (const [k, v] of Object.entries(cfg.extraBody ?? {}))
            payload[k] = v;
        return { headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify(payload) };
    }
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
                protocol: cfg.protocol,
                modelCapabilities: modelCapabilitiesFor(cfg.protocol, cfg.modalities, models),
            };
        },
        async create(req, signal) {
            if (!cfg.modalities.includes(req.modality)) {
                throw new SynthError('E_MODALITY', `backend '${cfg.id}' does not serve modality '${req.modality}'`, cfg.id);
            }
            if (cfg.protocolVerified !== true || cfg.blockRealSubmit === true) {
                throw new SynthError('E_PROTOCOL_UNVERIFIED', `backend '${cfg.id}': ${cfg.protocol} is not verified for this deployment; real submission is disabled`, cfg.id);
            }
            // Synchronous sidecar mode (vLLM-Omni /v1/videos/sync returns raw bytes).
            if (cfg.syncEndpoint && process.env['SYNTHMEDIA_SIDECAR_SYNC'] === '1') {
                const { headers: h, body } = await buildSubmit(req);
                const r = await httpRequestBytes(cfg.id, `${cfg.baseUrl}${cfg.syncEndpoint}`, {
                    method: 'POST', headers: h, body, signal, timeoutMs: cfg.timeoutMs,
                });
                if (r.status !== 200) {
                    throw new SynthError('E_REMOTE', `sync video generation failed (http ${r.status}): ${sanitizeText(r.bytes.toString('utf8').slice(0, 200))}`, cfg.id, r.status >= 500);
                }
                const mime = (r.contentType ?? 'video/mp4').split(';')[0].trim();
                return { remoteId: 'inline-sync', inline: { bytes: r.bytes, mimeType: mime } };
            }
            const { headers: h, body } = await buildSubmit(req);
            const { status, body: respBody } = await httpRequestBytes(cfg.id, `${cfg.baseUrl}${paths.submit}`, {
                method: 'POST',
                headers: h,
                body,
                signal,
                timeoutMs: Math.min(cfg.timeoutMs, 120_000),
            }).then((r) => ({ status: r.status, body: r.bytes.toString('utf8') }));
            const data = parseJson(cfg.id, respBody);
            const id = data.task_id ?? data.id;
            if (status === 503) {
                throw new SynthError('E_BUSY', `backend busy (in-flight limit): ${sanitizeText(respBody.slice(0, 200))}`, cfg.id, true);
            }
            // Sora protocol hub accepts both 200 and 201 on submit (verify_ai_models.py L214).
            if ((status !== 200 && status !== 201) || !id) {
                const msg = sanitizeText(data.error?.message ?? respBody.slice(0, 200));
                throw new SynthError('E_REMOTE', `submit failed (http ${status}): ${msg}`, cfg.id, status >= 500);
            }
            return { remoteId: id };
        },
        async poll(remoteId, signal) {
            const { status, body } = await httpRequest(cfg.id, `${cfg.baseUrl}${withId(paths.status, remoteId)}`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json', ...(await authHeaders(cfg, resolve)) },
                signal,
                timeoutMs: 60_000,
            });
            const data = parseJson(cfg.id, body);
            if (status !== 200) {
                const msg = sanitizeText(data.error?.message ?? body.slice(0, 200));
                throw new SynthError('E_REMOTE', `status poll failed (http ${status}): ${msg}`, cfg.id, status >= 500);
            }
            const s = data.status ?? 'running';
            const progress = typeof data.progress === 'number' ? Math.max(0, Math.min(100, data.progress)) : 0;
            const poll = mapTaskStatus(s, progress, data.error?.message ?? data.message);
            // REMOTE completion time (never the local download time). The Sora-style
            // hub shape may report `completed_at`; other task APIs only `updated_at`.
            const remoteCompletedAt = remoteCompletedAtOf(data, poll.status);
            if (remoteCompletedAt)
                poll.remoteCompletedAt = remoteCompletedAt;
            return poll;
        },
        async fetch(remoteId, signal) {
            // Binary-safe: arrayBuffer() performs no character decoding, so MP4 /
            // image bytes (0xff, 0x80, multi-byte UTF-8) survive verbatim and the
            // server Content-Type is preserved.
            const r = await httpRequestBytes(cfg.id, `${cfg.baseUrl}${withId(paths.content, remoteId)}`, {
                method: 'GET',
                headers: await authHeaders(cfg, resolve),
                signal,
                timeoutMs: 300_000,
            });
            if (r.status !== 200) {
                throw new SynthError('E_REMOTE', `content fetch failed (http ${r.status})`, cfg.id, r.status >= 500);
            }
            const rawType = (r.contentType ?? '').split(';')[0].trim().toLowerCase();
            const mimeType = rawType.startsWith('video/') || rawType.startsWith('image/') || rawType === 'application/octet-stream'
                ? (rawType === 'application/octet-stream' ? 'video/mp4' : rawType)
                : 'video/mp4';
            return { bytes: r.bytes, mimeType };
        },
        async cancel(remoteId, signal) {
            if (!paths.cancel)
                return; // remote cancel unsupported: caller-side cancellation only
            try {
                await httpRequest(cfg.id, `${cfg.baseUrl}${withId(paths.cancel, remoteId)}`, {
                    method: cfg.cancelMethod ?? 'POST',
                    headers: await authHeaders(cfg, resolve),
                    body: (cfg.cancelMethod ?? 'POST') === 'POST' ? JSON.stringify({}) : undefined,
                    signal,
                    timeoutMs: 30_000,
                });
            }
            catch {
                // best-effort: never mask the caller's cancellation outcome
            }
        },
    };
}
//# sourceMappingURL=task-api.js.map