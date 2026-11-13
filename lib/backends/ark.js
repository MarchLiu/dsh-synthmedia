/**
 * `volcengine-ark-compatible` protocol adapter.
 *
 * This file implements WIRE PROTOCOLS only; it never mentions a provider id,
 * base URL or credential name. Which deployment (bza Coding Plan gateway, the
 * public Ark endpoint, or any compatible relay) is spoken to is entirely a
 * ProviderProfile concern in config.ts.
 *
 * Protocol shapes per OFFICIAL Volcengine docs (fetched 2026-11; URLs in the
 * README):
 *
 * 1. Video (Seedance) — async task API:
 *    POST   {base}{submit}  body {model, content:[{type:'text',text}],
 *           duration?, resolution?, ratio?, seed?} → {id}
 *    The task API has NO pixel `size` field: a tool-level size is mapped onto
 *    `resolution` (480p/720p/1080p) + `ratio` and rejected (E_SIZE) when it
 *    cannot be expressed, so it is never silently ignored.
 *    GET    {base}{status}  → {status: queued|running|succeeded|failed|expired|
 *           cancelled, content?:{video_url}}
 *    DELETE {base}{cancel}  cancels/deletes the task.
 *    The finished video arrives as a signed `content.video_url`, downloaded
 *    binary-safe (no auth header attached to the signed URL).
 *
 * 2. Image (Seedream) — synchronous:
 *    POST {base}{submit} {model, prompt, response_format:'url'|'b64_json',
 *    size, watermark} → {data:[{url?|b64_json?, output_format?}]}. Both shapes
 *    are handled; bytes never pass through a text decoder.
 *
 * 3. Audio (Seed TTS / seed-tts-2.0) — official Doubao voice async protocol:
 *    POST {base}{submit}  headers X-Api-Key, X-Api-Resource-Id,
 *      X-Api-Request-Id; body {user:{uid}, unique_id, req_params:{text,
 *      speaker, audio_params:{format,sample_rate}}} → {code:20000000,
 *      data:{task_id}}
 *    POST {base}{status}  body {task_id} → {code, data:{task_status:
 *      1 running|2 succeeded|3 failed, audio_url?}}
 *    Audio is fetched from `audio_url` binary-safe.
 *
 * Guard: real submission requires the PROFILE to be marked
 * `protocolVerified: true`; otherwise create() throws E_PROTOCOL_UNVERIFIED
 * before any network I/O. There is no fallback to another provider.
 * @module
 */
import { randomUUID } from 'node:crypto';
import { SynthError, sanitizeText } from '../errors.js';
import { httpRequest, httpRequestBytes, parseJson, authHeaders, envCredentialResolver, } from '../http.js';
import { modelCapabilitiesFor, preset, PROTOCOL_ARK } from '../presets.js';
/**
 * Ark video `resolution` tiers documented for the task API. The API has no
 * pixel `size` field (unlike the synchronous image API), so a tool-level
 * `size` MUST be translated instead of silently dropped.
 */
export const ARK_VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'];
/** Ark video `ratio` values documented for the task API. */
export const ARK_VIDEO_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'];
/** Resolution tier → its short side in pixels. */
const RESOLUTION_MIN_SIDE = { '480p': 480, '720p': 720, '1080p': 1080 };
function gcdForMessage(a, b) {
    return b === 0 ? a : gcdForMessage(b, a % b);
}
/**
 * Match a pixel aspect ratio against the documented ratio strings by VALUE
 * (cross-multiplication) instead of by reduced fraction: the official list
 * names `21:9`, whose reduced form is `7:3`, so e.g. `2520x1080` must resolve
 * to the documented `21:9` rather than being rejected.
 */
function documentedRatio(width, height) {
    for (const ratio of ARK_VIDEO_RATIOS) {
        if (ratio === 'adaptive')
            continue;
        const [w, h] = ratio.split(':').map(Number);
        if (width * h === height * w)
            return ratio;
    }
    return undefined;
}
/**
 * Translate tool-level `size` into the Ark video protocol's `resolution` +
 * `ratio` pair (official create-video-generation-task-api fields).
 *
 * Accepted inputs:
 * - a resolution token: `480p` / `720p` / `1080p`;
 * - a pixel size `WxH` whose short side is exactly 480/720/1080 and whose
 *   aspect ratio matches a documented ratio BY VALUE — e.g. `1280x720` →
 *   `720p` + `16:9`, and `2520x1080` → `1080p` + `21:9` (whose reduced
 *   fraction `7:3` is not itself a documented string).
 *
 * Anything else is an explicit `E_SIZE` rejection BEFORE any network I/O —
 * never a silent no-op. When the model id exists in the capability presets,
 * its declared resolution/ratio limits are enforced too.
 */
export function mapArkVideoSize(size, modelId, backendId) {
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
            throw new SynthError('E_SIZE', `backend '${backendId}': size '${raw}' has a ${minSide}px short side; the Ark video protocol takes resolution ${ARK_VIDEO_RESOLUTIONS.join('/')} (or WxH with a 480/720/1080 short side)`, backendId);
        }
        const divisor = gcdForMessage(width, height);
        ratio = documentedRatio(width, height);
        if (!ratio) {
            const reduced = `${width / divisor}:${height / divisor}`;
            throw new SynthError('E_SIZE', `backend '${backendId}': size '${raw}' has aspect ratio ${reduced}; supported ratios: ${ARK_VIDEO_RATIOS.join(', ')}`, backendId);
        }
    }
    else {
        resolution = ARK_VIDEO_RESOLUTIONS.find((tier) => tier === raw.toLowerCase());
        if (!resolution) {
            throw new SynthError('E_SIZE', `backend '${backendId}': unsupported video size '${raw}'; send resolution ${ARK_VIDEO_RESOLUTIONS.join('/')} or WxH (e.g. 1280x720)`, backendId);
        }
    }
    const capability = preset(modelId);
    if (capability && capability.protocol === PROTOCOL_ARK && capability.modality === 'video') {
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
/** Map an official Ark task status onto the unified poll vocabulary. */
export function mapArkStatus(s) {
    const norm = s.toLowerCase();
    if (norm === 'succeeded')
        return { status: 'succeeded', progress: 100 };
    if (norm === 'failed')
        return { status: 'failed', progress: 0, error: { code: 'E_REMOTE', message: 'task failed' } };
    if (norm === 'expired')
        return { status: 'failed', progress: 0, error: { code: 'E_REMOTE_EXPIRED', message: 'task expired before completion' } };
    if (norm === 'cancelled' || norm === 'canceled')
        return { status: 'cancelled', progress: 0 };
    // queued | running | anything unknown: still in flight
    return { status: 'running', progress: norm === 'queued' ? 20 : 60 };
}
/**
 * Map the Doubao TTS `data.task_status` numbers: 1 running, 2 succeeded,
 * 3 failed (official async result-query doc).
 */
export function mapTtsTaskStatus(status) {
    if (status === 2)
        return { status: 'succeeded', progress: 100 };
    if (status === 3)
        return { status: 'failed', progress: 0, error: { code: 'E_REMOTE', message: 'tts task failed' } };
    return { status: 'running', progress: status === 1 ? 50 : 10 };
}
const TTS_SUCCESS_CODE = 20000000;
const AUDIO_MIME = {
    mp3: 'audio/mpeg',
    pcm: 'audio/wav',
    ogg_opus: 'audio/ogg',
};
export function createArkBackend(cfg, resolve = envCredentialResolver) {
    const models = cfg.models && cfg.models.length > 0 ? cfg.models : [modelOf(cfg)];
    const paths = cfg.paths;
    const withId = (tpl, id) => tpl.replace('{id}', encodeURIComponent(id));
    const tts = cfg.tts ?? {};
    const ttsFormat = tts.format ?? 'mp3';
    const realSubmitAllowed = cfg.blockRealSubmit !== true && cfg.protocolVerified === true;
    // video_url (video) / audio_url (tts) cache, filled by poll(), used by fetch().
    const contentUrls = new Map();
    const jsonHeaders = async () => ({
        'Content-Type': 'application/json',
        ...(await authHeaders(cfg, resolve)),
    });
    const ttsHeaders = async () => {
        const headers = await jsonHeaders();
        if (tts.apiKeyHeader && tts.apiKeyHeader !== (cfg.authHeader ?? 'Authorization')) {
            // The credential value itself is never re-read here: authHeaders already
            // placed it under cfg.authHeader; move it to the provider-named header.
            const value = headers[cfg.authHeader ?? 'Authorization'];
            if (value !== undefined) {
                delete headers[cfg.authHeader ?? 'Authorization'];
                headers[tts.apiKeyHeader] = value;
            }
        }
        if (tts.resourceHeader)
            headers[tts.resourceHeader] = tts.resourceId ?? 'seed-tts-2.0';
        if (tts.requestIdHeader)
            headers[tts.requestIdHeader] = randomUUID();
        return headers;
    };
    const parseTtsEnvelope = (status, body) => {
        const parsed = parseJson(cfg.id, body);
        if (status !== 200) {
            const msg = sanitizeText(parsed.message ?? parsed.error?.message ?? `http ${status}`);
            throw new SynthError('E_REMOTE', `tts http ${status}: ${msg}`, cfg.id, status >= 500);
        }
        if (typeof parsed.code === 'number' && parsed.code !== TTS_SUCCESS_CODE) {
            throw new SynthError('E_REMOTE', `tts rejected (code ${parsed.code}): ${sanitizeText(parsed.message ?? 'unknown error')}`, cfg.id, false);
        }
        return parsed;
    };
    return {
        id: cfg.id,
        capabilities() {
            return {
                modalities: [...cfg.modalities],
                models: [...models],
                online: cfg.online,
                protocolVerified: cfg.protocolVerified === true,
                liveVerified: cfg.liveVerified === true,
                realSubmitAllowed,
                protocol: PROTOCOL_ARK,
                modelCapabilities: modelCapabilitiesFor(PROTOCOL_ARK, cfg.modalities, models),
            };
        },
        async create(req, signal) {
            if (!cfg.modalities.includes(req.modality)) {
                throw new SynthError('E_MODALITY', `backend '${cfg.id}' does not serve modality '${req.modality}'`, cfg.id);
            }
            if (!realSubmitAllowed) {
                // Guard: never fabricate an unverified protocol on the wire.
                throw new SynthError('E_PROTOCOL_UNVERIFIED', `backend '${cfg.id}': ${req.modality} protocol is not verified for this deployment (protocolVerified=false / blockRealSubmit); real submission is disabled — mock/contract tests only`, cfg.id);
            }
            if (req.modality === 'video') {
                const payload = {
                    model: req.model,
                    content: [{ type: 'text', text: req.prompt }],
                };
                // The video task API has no pixel `size` field: translate (or reject)
                // before the request so a tool-level size can never be silently lost.
                if (typeof req.size === 'string' && req.size.trim().length > 0) {
                    const spec = mapArkVideoSize(req.size, req.model, cfg.id);
                    payload['resolution'] = spec.resolution;
                    if (spec.ratio)
                        payload['ratio'] = spec.ratio;
                }
                if (typeof req.durationSeconds === 'number')
                    payload['duration'] = req.durationSeconds;
                if (typeof req.seed === 'number')
                    payload['seed'] = req.seed;
                for (const [k, v] of Object.entries(cfg.extraBody ?? {}))
                    payload[k] = v;
                const { status, body } = await httpRequestBytes(cfg.id, `${cfg.baseUrl}${paths.submit}`, {
                    method: 'POST', headers: await jsonHeaders(), body: JSON.stringify(payload), signal, timeoutMs: Math.min(cfg.timeoutMs, 120_000),
                }).then((r) => ({ status: r.status, body: r.bytes.toString('utf8') }));
                const data = parseJson(cfg.id, body);
                if (status === 503)
                    throw new SynthError('E_BUSY', `backend busy: ${sanitizeText(body.slice(0, 200))}`, cfg.id, true);
                if ((status !== 200 && status !== 201) || !data.id) {
                    const msg = sanitizeText(data.error?.message ?? body.slice(0, 200));
                    throw new SynthError('E_REMOTE', `ark video submit failed (http ${status}): ${msg}`, cfg.id, status >= 500);
                }
                return { remoteId: data.id };
            }
            if (req.modality === 'image') {
                const payload = {
                    model: req.model,
                    prompt: req.prompt,
                    response_format: 'url',
                    watermark: false,
                };
                if (req.size)
                    payload['size'] = req.size.replace('*', 'x');
                for (const [k, v] of Object.entries(cfg.extraBody ?? {}))
                    payload[k] = v;
                const { status, body } = await httpRequestBytes(cfg.id, `${cfg.baseUrl}${paths.submit}`, {
                    method: 'POST', headers: await jsonHeaders(), body: JSON.stringify(payload), signal, timeoutMs: cfg.timeoutMs,
                }).then((r) => ({ status: r.status, body: r.bytes.toString('utf8') }));
                const data = parseJson(cfg.id, body);
                const first = data.data?.[0];
                if (status !== 200 || !first) {
                    const msg = sanitizeText(data.error?.message ?? first?.error?.message ?? body.slice(0, 200));
                    throw new SynthError('E_REMOTE', `ark image submit failed (http ${status}): ${msg}`, cfg.id, status >= 500);
                }
                const mime = first.output_format === 'png' ? 'image/png' : 'image/jpeg';
                if (first.b64_json) {
                    return { remoteId: 'inline-image', inline: { bytes: Buffer.from(first.b64_json, 'base64'), mimeType: mime } };
                }
                if (first.url) {
                    // Signed URL: download binary-safe, no Authorization header attached.
                    const dl = await httpRequestBytes(cfg.id, first.url, { method: 'GET', signal, timeoutMs: 300_000 });
                    if (dl.status !== 200)
                        throw new SynthError('E_REMOTE', `image download failed (http ${dl.status})`, cfg.id, dl.status >= 500);
                    const dlMime = (dl.contentType ?? mime).split(';')[0].trim().toLowerCase();
                    return { remoteId: 'inline-image', inline: { bytes: dl.bytes, mimeType: dlMime.startsWith('image/') ? dlMime : mime } };
                }
                throw new SynthError('E_PROTOCOL', 'ark image response carried neither url nor b64_json', cfg.id);
            }
            if (req.modality === 'audio') {
                if (!tts.speaker) {
                    throw new SynthError('E_CONFIG', `backend '${cfg.id}': audio requires tts.speaker (voice id)`, cfg.id);
                }
                const reqParams = {
                    text: req.prompt,
                    speaker: tts.speaker,
                    audio_params: {
                        format: ttsFormat,
                        sample_rate: tts.sampleRate ?? 24000,
                    },
                };
                for (const [k, v] of Object.entries(cfg.extraBody ?? {}))
                    reqParams[k] = v;
                const uniqueId = randomUUID();
                const payload = {
                    user: { uid: tts.uid ?? 'synthmedia' },
                    unique_id: uniqueId,
                    req_params: reqParams,
                };
                const { status, body } = await httpRequestBytes(cfg.id, `${cfg.baseUrl}${paths.submit}`, {
                    method: 'POST', headers: await ttsHeaders(), body: JSON.stringify(payload), signal, timeoutMs: Math.min(cfg.timeoutMs, 120_000),
                }).then((r) => ({ status: r.status, body: r.bytes.toString('utf8') }));
                const data = parseTtsEnvelope(status, body);
                const taskId = data.data?.task_id ?? uniqueId;
                if (!taskId)
                    throw new SynthError('E_PROTOCOL', 'tts submit response carried no task id', cfg.id);
                return { remoteId: taskId };
            }
            throw new SynthError('E_MODALITY', `backend '${cfg.id}': unsupported modality '${req.modality}'`, cfg.id);
        },
        async poll(remoteId, signal) {
            if (cfg.modalities.includes('audio')) {
                const { status, body } = await httpRequest(cfg.id, `${cfg.baseUrl}${paths.status}`, {
                    method: 'POST', headers: await ttsHeaders(), body: JSON.stringify({ task_id: remoteId }), signal, timeoutMs: 60_000,
                });
                const data = parseTtsEnvelope(status, body);
                if (data.data?.audio_url)
                    contentUrls.set(remoteId, data.data.audio_url);
                const poll = mapTtsTaskStatus(data.data?.task_status);
                if (poll.status === 'failed' && data.message) {
                    poll.error = { code: 'E_REMOTE', message: sanitizeText(data.message) };
                }
                return poll;
            }
            const { status, body } = await httpRequest(cfg.id, `${cfg.baseUrl}${withId(paths.status, remoteId)}`, {
                method: 'GET', headers: await jsonHeaders(), signal, timeoutMs: 60_000,
            });
            const data = parseJson(cfg.id, body);
            if (status !== 200) {
                const msg = sanitizeText(data.error?.message ?? body.slice(0, 200));
                throw new SynthError('E_REMOTE', `ark status poll failed (http ${status}): ${msg}`, cfg.id, status >= 500);
            }
            if (data.content?.video_url)
                contentUrls.set(remoteId, data.content.video_url);
            const poll = mapArkStatus(data.status ?? 'running');
            if (poll.status === 'failed' && data.error?.message) {
                poll.error = { code: data.error.code ?? 'E_REMOTE', message: sanitizeText(data.error.message) };
            }
            return poll;
        },
        async fetch(remoteId, signal) {
            const url = contentUrls.get(remoteId);
            if (!url) {
                throw new SynthError('E_PROTOCOL', `no content URL cached for task '${sanitizeText(remoteId)}' — poll must run first`, cfg.id);
            }
            const dl = await httpRequestBytes(cfg.id, url, { method: 'GET', signal, timeoutMs: 300_000 });
            if (dl.status !== 200)
                throw new SynthError('E_REMOTE', `content download failed (http ${dl.status})`, cfg.id, dl.status >= 500);
            const rawType = (dl.contentType ?? '').split(';')[0].trim().toLowerCase();
            if (cfg.modalities.includes('audio') && !cfg.modalities.includes('video')) {
                const mimeType = rawType.startsWith('audio/') ? rawType : (AUDIO_MIME[ttsFormat] ?? 'audio/mpeg');
                return { bytes: dl.bytes, mimeType };
            }
            const mimeType = rawType.startsWith('video/') || rawType === 'application/octet-stream'
                ? (rawType === 'application/octet-stream' ? 'video/mp4' : rawType)
                : 'video/mp4';
            return { bytes: dl.bytes, mimeType };
        },
        async cancel(remoteId, signal) {
            // TTS has no documented cancel endpoint; video has DELETE. Best-effort.
            if (!paths.cancel || cfg.modalities.includes('audio'))
                return;
            try {
                await httpRequest(cfg.id, `${cfg.baseUrl}${withId(paths.cancel, remoteId)}`, {
                    method: 'DELETE', headers: await jsonHeaders(), signal, timeoutMs: 30_000,
                });
            }
            catch {
                // best-effort: never mask the caller's cancellation outcome
            }
        },
    };
}
function modelOf(cfg) {
    return cfg.model;
}
//# sourceMappingURL=ark.js.map