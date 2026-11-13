import { SynthError, sanitizeText } from '../errors.js';
import { authHeaders, envCredentialResolver, httpRequest, httpRequestBytes, parseJson, } from '../http.js';
import { modelCapabilitiesFor, preset, PROTOCOL_DASHSCOPE_WAN } from '../presets.js';
import { remoteCompletedAtOf } from '../time.js';
/** Map an official DashScope task_status onto the unified poll vocabulary. */
export function mapDashScopeStatus(status, err) {
    const norm = String(status).trim().toUpperCase();
    if (norm === 'SUCCEEDED')
        return { status: 'succeeded', progress: 100 };
    if (norm === 'FAILED') {
        return {
            status: 'failed',
            progress: 0,
            error: {
                code: err?.code ? sanitizeText(err.code) : 'E_REMOTE',
                message: sanitizeText(err?.message ?? 'task failed'),
            },
        };
    }
    if (norm === 'CANCELED' || norm === 'CANCELLED')
        return { status: 'cancelled', progress: 0 };
    if (norm === 'UNKNOWN') {
        return {
            status: 'failed',
            progress: 0,
            error: { code: 'E_PROTOCOL', message: 'remote task is UNKNOWN (expired or never existed)' },
        };
    }
    if (norm === 'PENDING')
        return { status: 'running', progress: 5 };
    return { status: 'running', progress: 50 };
}
/** HTTP failure carrying the DashScope error envelope `{code,message,request_id}`. */
function remoteFailure(status, body, backendId) {
    let codeText = '';
    let message = body.slice(0, 300);
    try {
        const parsed = JSON.parse(body);
        if (parsed.message)
            message = parsed.message;
        if (parsed.code)
            codeText = parsed.code;
    }
    catch {
        // Non-JSON error body: keep the sanitized snippet.
    }
    const code = status === 401 || status === 403
        ? 'E_AUTH'
        : status === 429
            ? 'E_RATE_LIMIT'
            : status === 400 || status === 404
                ? 'E_REQUEST'
                : 'E_REMOTE';
    return new SynthError(code, `dashscope request failed (http ${status}${codeText ? `, ${codeText}` : ''}): ${sanitizeText(message)}`, backendId, status >= 500 || status === 429);
}
export function createDashScopeBackend(cfg, resolve = envCredentialResolver) {
    const models = cfg.models && cfg.models.length > 0 ? [...cfg.models] : [cfg.model];
    const paths = cfg.paths;
    const withId = (tpl, id) => tpl.replace('{id}', encodeURIComponent(id));
    const extra = cfg.extraBody ?? {};
    const realSubmitAllowed = cfg.protocolVerified === true && cfg.blockRealSubmit !== true;
    // Artifact URLs cached by poll() and consumed by fetch().
    const contentUrls = new Map();
    const capabilityFor = (modelId) => {
        const p = preset(modelId);
        return p && p.protocol === PROTOCOL_DASHSCOPE_WAN ? p : undefined;
    };
    const headers = async () => ({
        // Mandatory on the submit surface: HTTP calls are async-only.
        'X-DashScope-Async': 'enable',
        'Content-Type': 'application/json',
        ...(await authHeaders(cfg, resolve)),
    });
    const pollHeaders = async () => ({
        'Content-Type': 'application/json',
        ...(await authHeaders(cfg, resolve)),
    });
    /** `size` → official `W*H` token (WxH pixel inputs are normalised). */
    function resolveSize(size, modelId) {
        if (typeof size !== 'string' || size.trim().length === 0)
            return undefined;
        const token = size.trim().replace(/[x×]/i, '*');
        const known = capabilityFor(modelId);
        const sizes = known?.sizes ?? [];
        if (sizes.length > 0 && !sizes.includes(token)) {
            throw new SynthError('E_SIZE', `backend '${cfg.id}': model '${modelId}' supports sizes ${sizes.join('/')}, not '${token}'`, cfg.id);
        }
        return token;
    }
    function resolveDuration(req, modelId) {
        const known = capabilityFor(modelId);
        const requested = typeof req.durationSeconds === 'number' ? req.durationSeconds : cfg.defaultDurationSeconds;
        if (typeof requested !== 'number')
            return undefined; // image models / omit → provider default
        const d = Math.round(requested);
        if (d <= 0) {
            throw new SynthError('E_DURATION', `backend '${cfg.id}': duration must be a positive integer, got ${requested}`, cfg.id);
        }
        const allowed = known?.durations;
        if (allowed && allowed.length > 0 && !allowed.includes(d)) {
            throw new SynthError('E_DURATION', `backend '${cfg.id}': model '${modelId}' supports durations ${allowed.join('/')} s, got ${d}`, cfg.id);
        }
        const max = known?.maxDurationSeconds;
        if (max !== undefined && d > max) {
            throw new SynthError('E_DURATION', `backend '${cfg.id}': model '${modelId}' supports up to ${max} s, got ${d}`, cfg.id);
        }
        return d;
    }
    return {
        id: cfg.id,
        capabilities() {
            return {
                modalities: [...cfg.modalities],
                models,
                online: cfg.online,
                protocolVerified: cfg.protocolVerified === true,
                liveVerified: cfg.liveVerified === true,
                realSubmitAllowed,
                protocol: PROTOCOL_DASHSCOPE_WAN,
                modelCapabilities: modelCapabilitiesFor(PROTOCOL_DASHSCOPE_WAN, cfg.modalities, models),
            };
        },
        async create(req, signal) {
            if (!cfg.modalities.includes(req.modality)) {
                throw new SynthError('E_MODALITY', `backend '${cfg.id}' does not serve modality '${req.modality}'`, cfg.id);
            }
            if (!realSubmitAllowed) {
                throw new SynthError('E_PROTOCOL_UNVERIFIED', `backend '${cfg.id}': dashscope-wan-compatible is not verified for this deployment (protocolVerified=false / blockRealSubmit); real submission is disabled — mock/contract tests only`, cfg.id);
            }
            if (req.prompt.trim().length === 0) {
                throw new SynthError('E_REQUEST', `backend '${cfg.id}': the DashScope protocol requires a non-empty prompt`, cfg.id);
            }
            const size = resolveSize(req.size, req.model);
            const duration = resolveDuration(req, req.model);
            const input = { prompt: req.prompt };
            if (req.negativePrompt)
                input['negative_prompt'] = req.negativePrompt;
            const parameters = { ...extra };
            if (size)
                parameters['size'] = size;
            if (duration !== undefined)
                parameters['duration'] = duration;
            if (typeof req.seed === 'number')
                parameters['seed'] = req.seed;
            const payload = { model: req.model, input, parameters };
            const { status, body } = await httpRequest(cfg.id, `${cfg.baseUrl}${paths.submit}`, {
                method: 'POST',
                headers: await headers(),
                body: JSON.stringify(payload),
                signal,
                timeoutMs: Math.min(cfg.timeoutMs, 120_000),
            });
            if (status !== 200 && status !== 201)
                throw remoteFailure(status, body, cfg.id);
            const data = parseJson(cfg.id, body);
            const taskId = data.output?.task_id;
            if (!taskId) {
                throw new SynthError('E_PROTOCOL', 'DashScope create response carried no output.task_id', cfg.id);
            }
            return { remoteId: taskId };
        },
        async poll(remoteId, signal) {
            const { status, body } = await httpRequest(cfg.id, `${cfg.baseUrl}${withId(paths.status, remoteId)}`, {
                method: 'GET',
                headers: await pollHeaders(),
                signal,
                timeoutMs: 60_000,
            });
            if (status !== 200)
                throw remoteFailure(status, body, cfg.id);
            const data = parseJson(cfg.id, body);
            const output = data.output;
            if (!output || typeof output.task_status !== 'string') {
                throw new SynthError('E_PROTOCOL', 'DashScope query response carried no output.task_status', cfg.id);
            }
            // Success artifacts: image batches under output.results[].url, wan
            // video under output.video_url. Cache the first usable URL for fetch().
            if (output.task_status.toUpperCase() === 'SUCCEEDED') {
                const url = output.video_url ?? output.results?.map((r) => r?.url).find((u) => typeof u === 'string' && u.length > 0);
                if (url)
                    contentUrls.set(remoteId, url);
            }
            const poll = mapDashScopeStatus(output.task_status, { code: output.code, message: output.message });
            const remoteCompletedAt = remoteCompletedAtOf(output, poll.status);
            if (remoteCompletedAt)
                poll.remoteCompletedAt = remoteCompletedAt;
            return poll;
        },
        async fetch(remoteId, signal) {
            const url = contentUrls.get(remoteId);
            if (!url) {
                throw new SynthError('E_PROTOCOL', `no artifact URL cached for task '${sanitizeText(remoteId)}' — poll must run first`, cfg.id);
            }
            // Signed OSS URL: no credential header is attached.
            const dl = await httpRequestBytes(cfg.id, url, { method: 'GET', signal, timeoutMs: 300_000 });
            if (dl.status !== 200) {
                throw new SynthError('E_REMOTE', `artifact download failed (http ${dl.status})`, cfg.id, dl.status >= 500);
            }
            const rawType = (dl.contentType ?? '').split(';')[0].trim().toLowerCase();
            const mimeType = rawType.startsWith('video/') || rawType.startsWith('image/') ? rawType : 'application/octet-stream';
            return { bytes: dl.bytes, mimeType };
        },
        async cancel(remoteId, signal) {
            if (!paths.cancel)
                return; // remote cancel unsupported: caller-side cancellation only
            try {
                await httpRequest(cfg.id, `${cfg.baseUrl}${withId(paths.cancel, remoteId)}`, {
                    method: cfg.cancelMethod ?? 'POST',
                    headers: await pollHeaders(),
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
//# sourceMappingURL=dashscope.js.map