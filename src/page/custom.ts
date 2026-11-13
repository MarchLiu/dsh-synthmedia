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
import type { BackendConfig } from '../config.js';
import { PROTOCOLS } from '../presets.js';

export interface CustomProfileInput {
  readonly id: string;
  readonly protocol: string;
  readonly baseUrl: string;
  readonly authEnv?: string;
  readonly authStyle?: 'bearer' | 'basic' | 'raw' | 'none';
  readonly models: readonly string[];
  readonly modalities: ReadonlyArray<'video' | 'image' | 'audio'>;
  readonly protocolVerified?: boolean;
  readonly liveVerified?: boolean;
  readonly online?: boolean;
}

export interface CustomProfilesResult {
  readonly profiles: readonly CustomProfileInput[];
  /** Present when the stored JSON was corrupt / invalid (UI shows it). */
  readonly error?: string;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const MODALITIES: ReadonlyArray<CustomProfileInput['modalities'][number]> = ['video', 'image', 'audio'];

/**
 * Parse and validate the stored customProfiles JSON. Never throws: problems
 * are reported through `error` and the valid prefix of entries is kept.
 */
export function parseCustomProfiles(raw: unknown): CustomProfilesResult {
  if (raw === undefined || raw === null || raw === '') return { profiles: [] };
  let parsed: unknown;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { profiles: [], error: 'customProfiles 不是合法 JSON，已忽略（可在配置页重新保存）' };
    }
  } else {
    parsed = raw;
  }
  if (!Array.isArray(parsed)) {
    return { profiles: [], error: 'customProfiles 必须是数组，已忽略' };
  }
  const profiles: CustomProfileInput[] = [];
  const problems: string[] = [];
  for (const [i, item] of parsed.entries()) {
    const check = validateOne(item, i);
    if (typeof check === 'string') problems.push(check);
    else profiles.push(check);
  }
  return { profiles, ...(problems.length > 0 ? { error: problems.join('；') } : {}) };
}

function validateOne(item: unknown, index: number): CustomProfileInput | string {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return `条目 ${index + 1}：不是对象`;
  const rec = item as Record<string, unknown>;
  // Guard against secret VALUES: any key that smells like a credential value
  // makes the entry invalid instead of silently storing it.
  for (const key of Object.keys(rec)) {
    if (/apikey$|apikeyvalue|secret|token|password/i.test(key)) {
      return `条目 ${index + 1}：不允许存储凭据值字段 '${key}'（只允许环境变量名 authEnv）`;
    }
  }
  const id = rec['id'];
  if (typeof id !== 'string' || !ID_RE.test(id)) return `条目 ${index + 1}：id 必须是 [a-z0-9-] 开头的短横线串`;
  let protocol: string;
  try {
    protocol = normalizeProtocol(rec['protocol'], id);
  } catch {
    return `条目 '${id}'：protocol 必须是 ${PROTOCOLS.join(' / ')} 之一`;
  }
  const baseUrl = rec['baseUrl'] ?? rec['baseURL'];
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) return `条目 '${id}'：baseUrl 必须是 http(s) URL`;
  const rawModels = rec['models'];
  const models = Array.isArray(rawModels) ? rawModels.filter((m): m is string => typeof m === 'string' && m.length > 0) : [];
  if (models.length === 0) return `条目 '${id}'：至少需要一个模型 id`;
  const rawModalities = rec['modalities'];
  const modalities = Array.isArray(rawModalities)
    ? rawModalities.filter((m): m is 'video' | 'image' | 'audio' => typeof m === 'string' && (MODALITIES as readonly string[]).includes(m))
    : [];
  if (modalities.length === 0) return `条目 '${id}'：modalities 至少一项（video/image/audio）`;
  const authEnv = typeof rec['authEnv'] === 'string' && rec['authEnv'] !== '' ? rec['authEnv'] : undefined;
  const authStyle = (typeof rec['authStyle'] === 'string' && ['bearer', 'basic', 'raw', 'none'].includes(rec['authStyle'])
    ? rec['authStyle']
    : authEnv ? 'bearer' : 'none') as 'bearer' | 'basic' | 'raw' | 'none';
  if (authStyle !== 'none' && !authEnv) return `条目 '${id}'：authStyle '${authStyle}' 需要提供凭据环境变量名 authEnv`;
  const profile: CustomProfileInput = {
    id,
    protocol,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    models,
    modalities,
    ...(authEnv ? { authEnv } : {}),
    authStyle,
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
  } catch (err) {
    return `条目 '${id}'：${err instanceof Error ? err.message : String(err)}`;
  }
  return profile;
}

/** Materialize one custom profile as a BackendConfig for validation/merge. */
export function backendOf(p: CustomProfileInput): BackendConfig {
  const protocolPaths: Record<string, { submit: string; status: string; content?: string; cancel?: string }> = {
    'openai-video-compatible': { submit: '/v1/videos', status: '/v1/videos/{id}', content: '/v1/videos/{id}/content', cancel: '/v1/videos/{id}' },
    'videogen-task-api': { submit: '/v1/videogen', status: '/v1/videogen/{id}', content: '/v1/videogen/{id}/content', cancel: '/v1/videogen/{id}/cancel' },
    'minimax-video-compatible': { submit: '/v2/video_generation', status: '/v2/query/video_generation/{id}', cancel: '/v2/video_generation/{id}' },
    'volcengine-ark-compatible': { submit: '/contents/generations/tasks', status: '/contents/generations/tasks/{id}', cancel: '/contents/generations/tasks/{id}' },
    'openai-chat-compatible': { submit: '/chat/completions', status: '' },
  } as unknown as Record<string, { submit: string; status: string; content?: string; cancel?: string }>;
  return {
    id: p.id,
    protocol: p.protocol as BackendConfig['protocol'],
    model: p.models[0]!,
    models: [...p.models],
    modalities: [...p.modalities],
    baseUrl: p.baseUrl,
    ...(p.authEnv ? { authEnv: p.authEnv } : {}),
    authStyle: p.authStyle ?? (p.authEnv ? 'bearer' : 'none'),
    online: p.online !== false,
    timeoutMs: 600_000,
    ...(protocolPaths[p.protocol] ? { paths: protocolPaths[p.protocol] } : {}),
    protocolVerified: p.protocolVerified === true,
    liveVerified: p.liveVerified === true,
  };
}

/**
 * Merge custom profiles into a base backends map (custom wins over built-ins
 * with the same id so users can effectively replace a preset).
 */
export function mergeCustomBackends(
  base: Record<string, BackendConfig>,
  custom: readonly CustomProfileInput[],
): Record<string, BackendConfig> {
  const out: Record<string, BackendConfig> = { ...base };
  for (const p of custom) out[p.id] = backendOf(p);
  return out;
}
