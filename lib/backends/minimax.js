import { SynthError, sanitizeText } from '../errors.js';
import { authHeaders, envCredentialResolver, httpRequest, httpRequestBytes, parseJson, } from '../http.js';
import { modelCapabilitiesFor, preset, PROTOCOL_MINIMAX_VIDEO } from '../presets.js';
import { remoteCompletedAtOf } from '../time.js';
/** Official MiniMax video `resolution` tiers (note the uppercase P). */
export const MINIMAX_VIDEO_RESOLUTIONS = ['480P', '768P', '2K'];
/** Official MiniMax video `ratio` values. */
export const MINIMAX_VIDEO_RATIOS = ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
/** Short side in pixels for the two pixel-addressable resolution tiers. */
const RESOLUTION_MIN_SIDE = { '480P': 480, '768P': 768 };
function gcd(a, b) {
    return b === 0 ? a : gcd(b, a % b);
}
/**
 * Match a pixel aspect ratio against the documented ratio strings by VALUE
 * (cross-multiplication), so `1792x768` resolves to the documented `21:9`
 * instead of the equivalent-but-unspellable `7:3`.
 */
function documentedRatio(width, height) {
    for (const ratio of MINIMAX_VIDEO_RATIOS) {
        if (ratio === 'adaptive')
            continue;
        const [w, h] = ratio.split(':').map(Number);
        if (width * h === height * w)
            return ratio;
    }
    return undefined;
}
function canonicalResolution(token) {
    const lower = token.trim().toLowerCase();
    return MINIMAX_VIDEO_RESOLUTIONS.find((tier) => tier.toLowerCase() === lower);
}
/**
 * Translate a tool-level `size` into MiniMax V2 `resolution` (+ `ratio`).
 *
 * Accepted inputs:
 * - a resolution token, case-insensitive: `480p` / `768p` / `2k`
 *   (normalised to the official `480P` / `768P` / `2K`);
 * - a pixel size `WxH` whose short side is exactly 480 or 768 and whose
 *   reduced aspect ratio is one of the documented concrete ratios, e.g.
 *   `768x432` → `768P` + `16:9`.
 *
 * `2K` is a quality tier, not a pixel short side: pixel sizes such as
 * `1920x1080` or `2560x1440` cannot be expressed exactly, so they are an
 * explicit `E_SIZE` rejection BEFORE any network I/O — never a silent
 * downgrade. Model presets also enforce their own resolution/ratio limits.
 */
export function mapMinimaxVideoSize(size, modelId, backendId) {
    const raw = size.trim();
    const pixel = /^(\d{2,4})\s*[x*×]\s*(\d{2,4})$/i.exec(raw);
    let resolution;
    let ratio;
    if (pixel) {
        const width = Number(pixel[1]);
        const height = Number(pixel[2]);
        const minSide = Math.min(width, height);
        resolution = Object.keys(RESOLUTION_MIN_SIDE).find((tier) => RESOLUTION_MIN_SIDE[tier] === minSide);
        if (!resolution) {
            throw new SynthError('E_SIZE', `backend '${backendId}': size '${raw}' has a ${minSide}px short side, which the MiniMax video protocol cannot express; send resolution ${MINIMAX_VIDEO_RESOLUTIONS.join('/')} (or WxH with a 480/768 short side). '2K' is a quality tier, not a pixel size`, backendId);
        }
        const divisor = gcd(width, height);
        ratio = documentedRatio(width, height);
        if (!ratio) {
            const reduced = `${width / divisor}:${height / divisor}`;
            throw new SynthError('E_SIZE', `backend '${backendId}': size '${raw}' has aspect ratio ${reduced}; supported ratios: ${MINIMAX_VIDEO_RATIOS.join(', ')}`, backendId);
        }
    }
    else {
        resolution = canonicalResolution(raw);
        if (!resolution) {
            throw new SynthError('E_SIZE', `backend '${backendId}': unsupported video size '${raw}'; send resolution ${MINIMAX_VIDEO_RESOLUTIONS.join('/')} or WxH (e.g. 768x432)`, backendId);
        }
    }
    const capability = preset(modelId);
    if (capability && capability.protocol === PROTOCOL_MINIMAX_VIDEO && capability.modality === 'video') {
        const sizes = capability.sizes ?? [];
        if (sizes.length > 0 && !sizes.includes(resolution)) {
            throw new SynthError('E_SIZE', `backend '${backendId}': model '${modelId}' supports resolution ${sizes.join('/')}, not '${resolution}'`, backendId);
        }
        const ratios = capability.ratios ?? [];
        if (ratio && ratios.length > 0 && !ratios.includes(ratio)) {
            throw new SynthError('E_SIZE', `backend '${backendId}': model '${modelId}' supports ratios ${ratios.join(', ')}, not '${ratio}'`, backendId);
        }
    }
    return ratio ? { resolution, ratio } : { resolution };
}
/** Append static query parameters (profile-level, provider-neutral). */
function withQuery(url, params) {
    const entries = Object.entries(params ?? {}).filter(([, v]) => typeof v === 'string' && v.length > 0);
    if (entries.length === 0)
        return url;
    const qs = entries
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
    return `${url}${url.includes('?') ? '&' : '?'}${qs}`;
}
/** Map an official MiniMax task status onto the unified poll vocabulary. */
export function mapMinimaxStatus(status, error) {
    const norm = status.trim().toLowerCase();
    if (norm === 'succeeded' || norm === 'success' || norm === 'completed')
        return { status: 'succeeded', progress: 100 };
    if (norm === 'failed' || norm === 'fail') {
        return {
            status: 'failed',
            progress: 0,
            error: {
                code: error?.code !== undefined ? String(error.code) : 'E_REMOTE',
                message: sanitizeText(error?.message ?? 'video task failed'),
            },
        };
    }
    if (norm === 'cancelled' || norm === 'canceled')
        return { status: 'cancelled', progress: 0 };
    // The V2 query surface has no numeric progress: derive a coarse estimate.
    if (norm === 'queued')
        return { status: 'running', progress: 5 };
    return { status: 'running', progress: 50 };
}
/** Map an HTTP failure carrying the OpenAI-style error envelope. */
function remoteFailure(status, body, backendId) {
    let message = body.slice(0, 300);
    let innerCode = '';
    try {
        const parsed = JSON.parse(body);
        if (parsed?.error) {
            if (parsed.error.message)
                message = parsed.error.message;
            if (parsed.error.http_code)
                innerCode = `, code ${parsed.error.http_code}`;
        }
    }
    catch {
        // Non-JSON error body: keep the sanitized text snippet.
    }
    const code = status === 401 || status === 403
        ? 'E_AUTH'
        : status === 402
            ? 'E_BALANCE'
            : status === 429
                ? 'E_RATE_LIMIT'
                : status === 400 || status === 404 || status === 422
                    ? 'E_REQUEST'
                    : 'E_REMOTE';
    return new SynthError(code, `minimax request failed (http ${status}${innerCode}): ${sanitizeText(message)}`, backendId, status >= 500 || status === 429);
}
export function createMinimaxBackend(cfg, resolve = envCredentialResolver) {
    const models = cfg.models && cfg.models.length > 0 ? [...cfg.models] : [cfg.model];
    const paths = cfg.paths;
    const withId = (tpl, id) => tpl.replace('{id}', encodeURIComponent(id));
    const extra = cfg.extraBody ?? {};
    /** Capability preset for one model id (protocol-scoped; never a provider branch). */
    const capabilityFor = (modelId) => {
        const p = preset(modelId);
        return p && p.protocol === PROTOCOL_MINIMAX_VIDEO && p.modality === 'video' ? p : undefined;
    };
    const realSubmitAllowed = cfg.protocolVerified === true && cfg.blockRealSubmit !== true;
    // content.url cache, filled by poll() and consumed by fetch().
    const contentUrls = new Map();
    const url = (tpl, id) => withQuery(`${cfg.baseUrl}${id === undefined ? tpl : withId(tpl, id)}`, cfg.queryParams);
    const headers = async () => ({
        'Content-Type': 'application/json',
        ...(await authHeaders(cfg, resolve)),
    });
    /** Resolution comes from the request size, then the profile default, then the model preset. */
    function resolveResolution(size, modelId) {
        if (typeof size === 'string' && size.trim().length > 0)
            return mapMinimaxVideoSize(size, modelId, cfg.id);
        const knownModel = capabilityFor(modelId);
        const configured = extra['resolution'];
        if (typeof configured === 'string' && configured.trim().length > 0) {
            const fromProfile = canonicalResolution(configured);
            if (!fromProfile) {
                // A configured default must never be silently replaced by a preset.
                throw new SynthError('E_SIZE', `backend '${cfg.id}': profile extraBody.resolution '${configured}' is not a documented MiniMax resolution; use ${MINIMAX_VIDEO_RESOLUTIONS.join('/')}`, cfg.id);
            }
            if (knownModel?.sizes && knownModel.sizes.length > 0 && !knownModel.sizes.includes(fromProfile)) {
                throw new SynthError('E_SIZE', `backend '${cfg.id}': model '${modelId}' supports resolution ${knownModel.sizes.join('/')}, not '${fromProfile}'`, cfg.id);
            }
            return { resolution: fromProfile };
        }
        const fallback = knownModel?.sizes?.[0] ?? capabilityFor(cfg.model)?.sizes?.[0];
        if (!fallback) {
            throw new SynthError('E_SIZE', `backend '${cfg.id}': the MiniMax video protocol requires a resolution; pass size (480P/768P/2K or WxH) or set profile extraBody.resolution`, cfg.id);
        }
        return { resolution: fallback };
    }
    function resolveDuration(req, modelId) {
        const known = capabilityFor(modelId) ?? capabilityFor(cfg.model);
        const requested = typeof req.durationSeconds === 'number' ? req.durationSeconds : cfg.defaultDurationSeconds;
        const d = requested ?? known?.minDurationSeconds;
        if (typeof d !== 'number' || !Number.isFinite(d)) {
            throw new SynthError('E_DURATION', `backend '${cfg.id}': the MiniMax video protocol requires an integer duration; pass durationSeconds or set profile defaultDurationSeconds`, cfg.id);
        }
        if (!Number.isInteger(d) || d <= 0) {
            throw new SynthError('E_DURATION', `backend '${cfg.id}': duration must be a positive integer of seconds, got ${d}`, cfg.id);
        }
        if (known && ((known.minDurationSeconds !== undefined && d < known.minDurationSeconds) || (known.maxDurationSeconds !== undefined && d > known.maxDurationSeconds))) {
            throw new SynthError('E_DURATION', `backend '${cfg.id}': model '${modelId}' supports duration ${known.minDurationSeconds ?? '?'}–${known.maxDurationSeconds ?? '?'} s, got ${d}`, cfg.id);
        }
        return d;
    }
    /** The official t2v path requires a concrete ratio (never `adaptive`). */
    function resolveRatio(req) {
        const fromProfile = typeof extra['ratio'] === 'string' ? extra['ratio'] : undefined;
        const ratio = fromProfile ?? '16:9';
        if (!MINIMAX_VIDEO_RATIOS.includes(ratio)) {
            throw new SynthError('E_RATIO', `backend '${cfg.id}': unsupported ratio '${ratio}'; supported: ${MINIMAX_VIDEO_RATIOS.join(', ')}`, cfg.id);
        }
        if (ratio === 'adaptive') {
            throw new SynthError('E_RATIO', `backend '${cfg.id}': a text-only request requires a concrete ratio (adaptive is only valid with image/reference input)`, cfg.id);
        }
        return ratio;
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
                protocol: PROTOCOL_MINIMAX_VIDEO,
                modelCapabilities: modelCapabilitiesFor(PROTOCOL_MINIMAX_VIDEO, cfg.modalities, models),
            };
        },
        async create(req, signal) {
            if (!cfg.modalities.includes(req.modality)) {
                throw new SynthError('E_MODALITY', `backend '${cfg.id}' does not serve modality '${req.modality}'`, cfg.id);
            }
            if (!realSubmitAllowed) {
                throw new SynthError('E_PROTOCOL_UNVERIFIED', `backend '${cfg.id}': minimax-video-compatible is not verified for this deployment (protocolVerified=false / blockRealSubmit); real submission is disabled — mock/contract tests only`, cfg.id);
            }
            if (req.prompt.trim().length === 0) {
                throw new SynthError('E_REQUEST', `backend '${cfg.id}': the MiniMax video protocol requires a non-empty text prompt`, cfg.id);
            }
            const { resolution, ratio: sizeRatio } = resolveResolution(req.size, req.model);
            const duration = resolveDuration(req, req.model);
            const ratio = sizeRatio ?? resolveRatio(req);
            // Documented V2 body: multimodal `content` array + resolution/duration/ratio.
            // Frame conditioning (additive): `role:first_frame|last_frame` images ride
            // the same content array; with images present `ratio` must be omitted —
            // the API derives the output ratio from the first frame (observed on
            // seedance; MiniMax V2 documents the same image-led behavior).
            const frameImages = (req.images ?? []).filter((img) => typeof img?.dataUri === 'string' && img.dataUri.startsWith('data:image/')
                || (typeof img?.dataUri === 'string' && img.dataUri.startsWith('https://')));
            const content = [{ type: 'text', text: req.prompt }];
            for (const img of frameImages) {
                content.push({ type: 'image_url', image_url: { url: img.dataUri }, role: img.role });
            }
            const payload = {
                ...extra,
                model: req.model,
                content,
                resolution,
                duration,
                ...(frameImages.length > 0 ? {} : { ratio }),
            };
            // Only DOCUMENTED V2 fields are set here. `seed` / `negative_prompt` are
            // not part of the V2 create schema, so they are never invented on the
            // wire; a relay that supports them is configured through extraBody.
            const { status, body } = await httpRequest(cfg.id, url(paths.submit), {
                method: 'POST',
                headers: await headers(),
                body: JSON.stringify(payload),
                signal,
                timeoutMs: Math.min(cfg.timeoutMs, 120_000),
            });
            if (status !== 200 && status !== 201)
                throw remoteFailure(status, body, cfg.id);
            const data = parseJson(cfg.id, body);
            const taskId = data.task_id ?? data.id ?? data.task?.id;
            if (!taskId) {
                throw new SynthError('E_PROTOCOL', 'MiniMax create response carried no task_id', cfg.id);
            }
            return { remoteId: taskId };
        },
        async poll(remoteId, signal) {
            const { status, body } = await httpRequest(cfg.id, url(paths.status, remoteId), {
                method: 'GET',
                headers: await headers(),
                signal,
                timeoutMs: 60_000,
            });
            if (status !== 200)
                throw remoteFailure(status, body, cfg.id);
            const data = parseJson(cfg.id, body);
            const task = data.task;
            if (!task || typeof task.status !== 'string') {
                throw new SynthError('E_PROTOCOL', 'MiniMax query response carried no task.status', cfg.id);
            }
            if (task.status.toLowerCase() === 'succeeded' && task.content?.url) {
                contentUrls.set(remoteId, task.content.url);
            }
            const poll = mapMinimaxStatus(task.status, task.error);
            // Official V2 has no explicit `completed_at`; for a terminal task its
            // `updated_at` (unix seconds) is the completion instant. Kept separate
            // from the local poll/download finish time in the job record.
            const remoteCompletedAt = remoteCompletedAtOf(task, poll.status);
            if (remoteCompletedAt)
                poll.remoteCompletedAt = remoteCompletedAt;
            return poll;
        },
        async fetch(remoteId, signal) {
            const contentUrl = contentUrls.get(remoteId);
            if (!contentUrl) {
                throw new SynthError('E_PROTOCOL', `no content URL cached for task '${sanitizeText(remoteId)}' — poll must run first`, cfg.id);
            }
            // Signed CDN URL: no credential header is attached.
            const dl = await httpRequestBytes(cfg.id, contentUrl, { method: 'GET', signal, timeoutMs: 300_000 });
            if (dl.status !== 200)
                throw new SynthError('E_REMOTE', `video download failed (http ${dl.status})`, cfg.id, dl.status >= 500);
            const rawType = (dl.contentType ?? '').split(';')[0].trim().toLowerCase();
            const mimeType = rawType.startsWith('video/') || rawType === 'application/octet-stream'
                ? rawType === 'application/octet-stream'
                    ? 'video/mp4'
                    : rawType
                : 'video/mp4';
            return { bytes: dl.bytes, mimeType };
        },
        async cancel(remoteId, signal) {
            if (!paths.cancel)
                return; // remote cancel unsupported: caller-side cancellation only
            try {
                await httpRequest(cfg.id, url(paths.cancel, remoteId), {
                    method: 'DELETE',
                    headers: await headers(),
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
//# sourceMappingURL=minimax.js.map