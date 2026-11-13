/**
 * Custom provider profiles: the persisted, user-authored part of the config
 * page. Storage = the plugin's OWN config field `customProfiles` (a JSON
 * string), written through the host settings/config API — the same face
 * dsh-cybernetics uses for its volatile fields — never into the
 * cordis.patch.yml registration row by hand.
 *
 * The schema here is narrow and validated on EVERY read; a corrupt payload
 * degrades to an empty list plus a diagnostic string (损坏兜底), never a
 * crash. Secrets: only environment-variable NAMES are ever stored
 * (`authEnv`); no field accepts a key value.
 * @module
 */
import { normalizeProtocol, validateBackend } from '../config.js';
import { PROTOCOLS } from '../presets.js';
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const MODALITIES = ['video', 'image', 'audio'];
/**
 * Parse and validate the stored customProfiles JSON. Never throws: problems
 * are reported through `error` and the valid prefix of entries is kept.
 */
export function parseCustomProfiles(raw) {
    if (raw === undefined || raw === null || raw === '')
        return { profiles: [] };
    let parsed;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return { profiles: [], error: 'customProfiles 不是合法 JSON，已忽略（可在配置页重新保存）' };
        }
    }
    else {
        parsed = raw;
    }
    if (!Array.isArray(parsed)) {
        return { profiles: [], error: 'customProfiles 必须是数组，已忽略' };
    }
    const profiles = [];
    const problems = [];
    for (const [i, item] of parsed.entries()) {
        const check = validateOne(item, i);
        if (typeof check === 'string')
            problems.push(check);
        else
            profiles.push(check);
    }
    return { profiles, ...(problems.length > 0 ? { error: problems.join('；') } : {}) };
}
function validateOne(item, index) {
    if (item === null || typeof item !== 'object' || Array.isArray(item))
        return `条目 ${index + 1}：不是对象`;
    const rec = item;
    // Guard against secret VALUES: any key that smells like a credential value
    // makes the entry invalid instead of silently storing it.
    for (const key of Object.keys(rec)) {
        if (/apikey$|apikeyvalue|secret|token|password/i.test(key)) {
            return `条目 ${index + 1}：不允许存储凭据值字段 '${key}'（只允许环境变量名 authEnv）`;
        }
    }
    const id = rec['id'];
    if (typeof id !== 'string' || !ID_RE.test(id))
        return `条目 ${index + 1}：id 必须是 [a-z0-9-] 开头的短横线串`;
    let protocol;
    try {
        protocol = normalizeProtocol(rec['protocol'], id);
    }
    catch {
        return `条目 '${id}'：protocol 必须是 ${PROTOCOLS.join(' / ')} 之一`;
    }
    const baseUrl = rec['baseUrl'] ?? rec['baseURL'];
    if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl))
        return `条目 '${id}'：baseUrl 必须是 http(s) URL`;
    const rawModels = rec['models'];
    const models = Array.isArray(rawModels) ? rawModels.filter((m) => typeof m === 'string' && m.length > 0) : [];
    if (models.length === 0)
        return `条目 '${id}'：至少需要一个模型 id`;
    const rawModalities = rec['modalities'];
    const modalities = Array.isArray(rawModalities)
        ? rawModalities.filter((m) => typeof m === 'string' && MODALITIES.includes(m))
        : [];
    if (modalities.length === 0)
        return `条目 '${id}'：modalities 至少一项（video/image/audio）`;
    const authEnv = typeof rec['authEnv'] === 'string' && rec['authEnv'] !== '' ? rec['authEnv'] : undefined;
    const authStyle = (typeof rec['authStyle'] === 'string' && ['bearer', 'basic', 'raw', 'none'].includes(rec['authStyle'])
        ? rec['authStyle']
        : authEnv ? 'bearer' : 'none');
    if (authStyle !== 'none' && !authEnv)
        return `条目 '${id}'：authStyle '${authStyle}' 需要提供凭据环境变量名 authEnv`;
    const authHeader = typeof rec['authHeader'] === 'string' && rec['authHeader'] !== '' ? rec['authHeader'] : undefined;
    // Optional path overrides: absolute-path strings only; the secret-value
    // guard above already rejects any key that smells like a credential.
    let paths;
    if (rec['paths'] !== undefined) {
        const rawPaths = rec['paths'];
        if (rawPaths === null || typeof rawPaths !== 'object' || Array.isArray(rawPaths)) {
            return `条目 '${id}'：paths 必须是对象`;
        }
        const rp = rawPaths;
        const submit = rp['submit'];
        if (typeof submit !== 'string' || !submit.startsWith('/'))
            return `条目 '${id}'：paths.submit 必须是以 / 开头的路径`;
        const parsed = { submit };
        for (const key of ['status', 'content', 'cancel']) {
            const v = rp[key];
            if (v === undefined)
                continue;
            if (typeof v !== 'string' || !v.startsWith('/'))
                return `条目 '${id}'：paths.${key} 必须是以 / 开头的路径`;
            parsed[key] = v;
        }
        paths = parsed;
    }
    // Optional Ark TTS tunables: names only carry no secret; `speaker` is a
    // voice id required by the Ark audio surface.
    let tts;
    if (rec['tts'] !== undefined) {
        const rawTts = rec['tts'];
        if (rawTts === null || typeof rawTts !== 'object' || Array.isArray(rawTts)) {
            return `条目 '${id}'：tts 必须是对象`;
        }
        const rt = rawTts;
        if (typeof rt['speaker'] !== 'string' || rt['speaker'] === '')
            return `条目 '${id}'：tts.speaker（音色 id）必填`;
        if (rt['sampleRate'] !== undefined && (typeof rt['sampleRate'] !== 'number' || !Number.isFinite(rt['sampleRate']))) {
            return `条目 '${id}'：tts.sampleRate 必须是数字`;
        }
        if (rt['format'] !== undefined && rt['format'] !== '' && !['mp3', 'pcm', 'ogg_opus'].includes(rt['format'])) {
            return `条目 '${id}'：tts.format 必须是 mp3 / pcm / ogg_opus`;
        }
        tts = {
            speaker: rt['speaker'],
            ...(typeof rt['uid'] === 'string' && rt['uid'] !== '' ? { uid: rt['uid'] } : {}),
            ...(typeof rt['format'] === 'string' && rt['format'] !== '' ? { format: rt['format'] } : {}),
            ...(typeof rt['sampleRate'] === 'number' ? { sampleRate: rt['sampleRate'] } : {}),
        };
    }
    const profile = {
        id,
        protocol,
        baseUrl: baseUrl.replace(/\/+$/, ''),
        models,
        modalities,
        ...(authEnv ? { authEnv } : {}),
        authStyle,
        ...(authHeader ? { authHeader } : {}),
        ...(paths ? { paths } : {}),
        ...(tts ? { tts } : {}),
        ...(rec['protocolVerified'] === true ? { protocolVerified: true } : {}),
        ...(rec['liveVerified'] === true ? { liveVerified: true } : {}),
        ...(rec['online'] === false ? { online: false } : {}),
    };
    // Full ProviderProfile validation via the existing contract (paths etc.).
    // task-protocol profiles (openai-video-compatible / videogen / minimax)
    // need paths — auto-fill the canonical shapes for those protocols when the
    // user omits them so
    // the form stays simple while validation stays strict.
    try {
        validateBackend(backendOf(profile));
    }
    catch (err) {
        return `条目 '${id}'：${err instanceof Error ? err.message : String(err)}`;
    }
    return profile;
}
/** Materialize one custom profile as a BackendConfig for validation/merge. */
export function backendOf(p) {
    const protocolPaths = {
        'openai-video-compatible': { submit: '/v1/videos', status: '/v1/videos/{id}', content: '/v1/videos/{id}/content', cancel: '/v1/videos/{id}' },
        'videogen-task-api': { submit: '/v1/videogen', status: '/v1/videogen/{id}', content: '/v1/videogen/{id}/content', cancel: '/v1/videogen/{id}/cancel' },
        'minimax-video-compatible': { submit: '/v2/video_generation', status: '/v2/query/video_generation/{id}', cancel: '/v2/video_generation/{id}' },
        'volcengine-ark-compatible': { submit: '/contents/generations/tasks', status: '/contents/generations/tasks/{id}', cancel: '/contents/generations/tasks/{id}' },
        'openai-chat-compatible': { submit: '/chat/completions', status: '' },
    };
    return {
        id: p.id,
        protocol: p.protocol,
        model: p.models[0],
        models: [...p.models],
        modalities: [...p.modalities],
        baseUrl: p.baseUrl,
        ...(p.authEnv ? { authEnv: p.authEnv } : {}),
        authStyle: p.authStyle ?? (p.authEnv ? 'bearer' : 'none'),
        ...(p.authHeader ? { authHeader: p.authHeader } : {}),
        online: p.online !== false,
        timeoutMs: 600_000,
        ...(p.paths ? { paths: { submit: p.paths.submit, status: p.paths.status ?? '', content: p.paths.content, cancel: p.paths.cancel } } : {}),
        ...(p.tts
            ? {
                tts: {
                    speaker: p.tts.speaker,
                    uid: p.tts.uid,
                    format: p.tts.format,
                    sampleRate: p.tts.sampleRate,
                    resourceId: p.tts.resourceId,
                },
            }
            : {}),
        ...(protocolPaths[p.protocol] && !p.paths ? { paths: protocolPaths[p.protocol] } : {}),
        protocolVerified: p.protocolVerified === true,
        liveVerified: p.liveVerified === true,
    };
}
/**
 * Merge custom profiles into a base backends map (custom wins over built-ins
 * with the same id so users can effectively replace a preset).
 */
export function mergeCustomBackends(base, custom) {
    const out = { ...base };
    for (const p of custom)
        out[p.id] = backendOf(p);
    return out;
}
//# sourceMappingURL=custom.js.map