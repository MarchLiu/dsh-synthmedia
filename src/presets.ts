/**
 * Model-capability presets — the THIRD decoupling layer.
 *
 * A preset describes ONLY what a model can do (modality, duration/size/format
 * limits, protocol it speaks). It carries no provider id, no URL, no
 * credential, no verification state: those belong to the ProviderProfile in
 * `config.ts`. Any preset can be overridden per deployment through the
 * profile's `model` / `models` fields or the documented environment variable,
 * so a user can point the same protocol at a different model id without
 * touching source.
 *
 * Sources (official docs, fetched 2026-11):
 * - MiniMax video V2 (H3) task API: https://platform.minimax.io/docs/api-reference/video-generation-v2-create
 *   (POST /v2/video_generation → {task_id}; GET /v2/query/video_generation/{task_id};
 *   DELETE /v2/video_generation/{task_id}; models MiniMax-H3 / -Highspeed /
 *   -Lite / -Max; resolution 480P/768P/2K, duration 4–15 s, ratio set, content
 *   array inputs, `content.url` output — there is NO pixel `size` field)
 * - Ark video task API: https://ark.volcengine.com/region:cn-beijing/docs/create-video-generation-task-api
 *   (Seedance 2.0 / 2.5: duration, `resolution` 480p/720p/1080p, `ratio`
 *   16:9/4:3/1:1/3:4/9:16/21:9/adaptive, seed, 10-bit H.265 for 1080p+; the
 *   API has NO pixel `size` field)
 * - Ark image API: https://ark.volcengine.com/region:cn-beijing/docs/image-generation-api
 *   (Seedream 5.0 pro/flash: size tiers, output_format png/jpeg, url|b64_json)
 * - Doubao voice async TTS: https://docs.volcengine.com/docs/doubao-voice/task-sub-mission?lang=zh
 *   (seed-tts-2.0 resource id, audio_params format mp3/pcm/ogg_opus, sample rates)
 * @module
 */
import type { ModelCapabilitySpec, ProtocolKind } from './types.js';

/** Protocol id for the Volcengine Ark content-generation surface. */
export const PROTOCOL_ARK: ProtocolKind = 'volcengine-ark-compatible';
/** Protocol id for the OpenAI-style `/v1/videos` task surface (third-party compatible gateways). */
export const PROTOCOL_OPENAI_VIDEO: ProtocolKind = 'openai-video-compatible';
/** Protocol id for PhotoStory's intranet videogen task API (extra, not OpenAI). */
export const PROTOCOL_VIDEOGEN: ProtocolKind = 'videogen-task-api';
/** Protocol id for OpenAI chat-completions (text only; extra). */
export const PROTOCOL_OPENAI_CHAT: ProtocolKind = 'openai-chat-compatible';
/**
 * Protocol id for the MiniMax video V2 (H3) async task surface. Distinct from
 * `openai-video-compatible`: the task lives under `{task:{...}}`, there is a
 * dedicated DELETE cancel path, output is a signed `task.content.url`, and
 * video is addressed by `resolution`/`ratio`/`duration` — not a pixel `size`.
 */
export const PROTOCOL_MINIMAX_VIDEO: ProtocolKind = 'minimax-video-compatible';
/**
 * Protocol id for the Aliyun DashScope / Model Studio async task surface used
 * by the Tongyi Wanxiang (万相) family — wan2.x video AND wanx2.1 image.
 * Submit carries the mandatory `X-DashScope-Async: enable` header and returns
 * `{output:{task_id,task_status}}`; status is polled on the GENERIC task
 * endpoint `GET /api/v1/tasks/{task_id}` (`output.task_status`:
 * PENDING/RUNNING/SUCCEEDED/FAILED/CANCELED/UNKNOWN, artifacts under
 * `output.results[].url` or `output.video_url`); cancel is
 * `POST /api/v1/tasks/{task_id}/cancel` (PENDING tasks only).
 */
export const PROTOCOL_DASHSCOPE_WAN: ProtocolKind = 'dashscope-wan-compatible';
/**
 * Protocol id for the Google GenAI media surface (generativelanguage.googleapis.com):
 * Imagen `:predict` (synchronous base64 predictions) and Veo
 * `:predictLongRunning` (async LRO operation polling/cancel). Auth is the
 * `x-goog-api-key` header; api version `v1beta` is part of the configured
 * paths, never hard-coded.
 */
export const PROTOCOL_GOOGLE_GENMEDIA: ProtocolKind = 'google-genmedia-compatible';
/**
 * Protocol id for the OpenAI synchronous images API (`POST /v1/images/generations`
 * → `{created, data:[{b64_json|url}]}`; GPT image models return `b64_json`).
 */
export const PROTOCOL_OPENAI_IMAGES: ProtocolKind = 'openai-images-compatible';

/** All protocol ids this plugin understands. */
export const PROTOCOLS: readonly ProtocolKind[] = [
  PROTOCOL_ARK,
  PROTOCOL_OPENAI_VIDEO,
  PROTOCOL_VIDEOGEN,
  PROTOCOL_OPENAI_CHAT,
  PROTOCOL_MINIMAX_VIDEO,
  PROTOCOL_DASHSCOPE_WAN,
  PROTOCOL_GOOGLE_GENMEDIA,
  PROTOCOL_OPENAI_IMAGES,
];

/** Legacy `kind` spellings accepted from configuration (never required). */
export const LEGACY_PROTOCOL_ALIASES: Readonly<Record<string, ProtocolKind>> = {
  ark: PROTOCOL_ARK,
  'task-api': PROTOCOL_OPENAI_VIDEO,
  'openai-compatible': PROTOCOL_OPENAI_CHAT,
};

export const MODEL_PRESETS: Readonly<Record<string, ModelCapabilitySpec>> = {
  'doubao-seedance-2.0': {
    id: 'doubao-seedance-2.0',
    protocol: PROTOCOL_ARK,
    modality: 'video',
    maxDurationSeconds: 15,
    // Ark's video task API has no `size` field: it takes `resolution` plus
    // `ratio` (documented values). The adapter maps WxH inputs onto these.
    sizes: ['720p', '1080p'],
    ratios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
    notes: 'Seedance 2.0 text/image-to-video; resolution tiers 720p/1080p here (1080p+ is 10-bit H.265).',
  },
  'doubao-seedance-2.0-fast': {
    id: 'doubao-seedance-2.0-fast',
    protocol: PROTOCOL_ARK,
    modality: 'video',
    maxDurationSeconds: 15,
    sizes: ['720p'],
    ratios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
    notes: 'Latency-optimised Seedance 2.0 variant.',
  },
  'doubao-seedance-2.0-mini': {
    id: 'doubao-seedance-2.0-mini',
    protocol: PROTOCOL_ARK,
    modality: 'video',
    maxDurationSeconds: 10,
    sizes: ['720p'],
    ratios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
    notes: 'Cost-optimised Seedance 2.0 variant.',
  },
  'doubao-seedance-2.5': {
    id: 'doubao-seedance-2.5',
    protocol: PROTOCOL_ARK,
    modality: 'video',
    maxDurationSeconds: 30,
    sizes: ['480p', '720p', '1080p'],
    ratios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
    notes: 'Seedance 2.5: 2–30 s clips, optional audio track, H.265.',
  },
  'doubao-seedream-5.0-flash': {
    id: 'doubao-seedream-5.0-flash',
    protocol: PROTOCOL_ARK,
    modality: 'image',
    sizes: ['2K'],
    formats: ['png', 'jpeg'],
    notes: 'Seedream 5.0 flash: fast text-to-image, url or b64_json output.',
  },
  'doubao-seedream-5.0-pro': {
    id: 'doubao-seedream-5.0-pro',
    protocol: PROTOCOL_ARK,
    modality: 'image',
    sizes: ['2K', '4K'],
    formats: ['png', 'jpeg'],
    notes: 'Seedream 5.0 pro: higher fidelity / layer splitting.',
  },
  'doubao-seed-tts-2.0': {
    id: 'doubao-seed-tts-2.0',
    protocol: PROTOCOL_ARK,
    modality: 'audio',
    formats: ['mp3', 'pcm', 'ogg_opus'],
    notes: 'seed-tts-2.0 async long-text TTS (Doubao voice API shape).',
  },

  // ---- MiniMax official video V2 (H3) models. Ids and limits are the
  // OFFICIAL ones from platform.minimax.io (not the zgci relay's `minimax-h3`
  // spelling, which is a third-party gateway alias).
  'MiniMax-H3': {
    id: 'MiniMax-H3',
    protocol: PROTOCOL_MINIMAX_VIDEO,
    modality: 'video',
    minDurationSeconds: 4,
    maxDurationSeconds: 15,
    sizes: ['768P', '2K'],
    ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
    notes: 'Official MiniMax H3: text/image/reference-to-video, 768P or 2K, 4–15 s.',
  },
  'MiniMax-H3-Highspeed': {
    id: 'MiniMax-H3-Highspeed',
    protocol: PROTOCOL_MINIMAX_VIDEO,
    modality: 'video',
    minDurationSeconds: 4,
    maxDurationSeconds: 15,
    sizes: ['480P', '768P'],
    ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
    notes: 'Official MiniMax H3 Highspeed: 480P/768P only (2K unsupported), 4–15 s.',
  },
  'MiniMax-H3-Lite': {
    id: 'MiniMax-H3-Lite',
    protocol: PROTOCOL_MINIMAX_VIDEO,
    modality: 'video',
    minDurationSeconds: 4,
    maxDurationSeconds: 15,
    sizes: ['480P', '768P'],
    ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    notes: 'Official MiniMax H3 Lite: 480P/768P, 4–15 s, no `adaptive` ratio.',
  },
  'MiniMax-H3-Max': {
    id: 'MiniMax-H3-Max',
    protocol: PROTOCOL_MINIMAX_VIDEO,
    modality: 'video',
    minDurationSeconds: 5,
    maxDurationSeconds: 15,
    sizes: ['480P', '768P'],
    ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
    notes: 'Official MiniMax H3 Max: 480P/768P, 5–15 s (4 s unsupported), prompt expansion via `extra`.',
  },

  // ---- Aliyun Wanxiang (万相) — DashScope async task protocol. Ids and limits
  // are the OFFICIAL Model Studio values (help.aliyun.com, fetched 2026-11):
  // video https://help.aliyun.com/zh/model-studio/legacy-wan-text-to-video-api-reference
  // image https://help.aliyun.com/zh/model-studio/text-to-image-v2-api-reference
  'wan2.6-t2v': {
    id: 'wan2.6-t2v',
    protocol: PROTOCOL_DASHSCOPE_WAN,
    modality: 'video',
    minDurationSeconds: 2,
    maxDurationSeconds: 15,
    sizes: ['832*480', '480*832', '624*624', '1280*720', '720*1280', '960*960', '1088*832', '832*1088', '1920*1080', '1080*1920', '1440*1440', '1632*1248', '1248*1632'],
    notes: 'wan2.6-t2v: 2–15 s (default 5), 720P/1080P tiers, optional audio_url / auto audio.',
  },
  'wan2.5-t2v-preview': {
    id: 'wan2.5-t2v-preview',
    protocol: PROTOCOL_DASHSCOPE_WAN,
    modality: 'video',
    sizes: ['832*480', '480*832', '624*624', '1280*720', '720*1280', '960*960', '1088*832', '832*1088', '1920*1080', '1080*1920', '1440*1440', '1632*1248', '1248*1632'],
    durations: [5, 10],
    notes: 'wan2.5-t2v-preview: duration 5 or 10 s (default 5), 480P/720P/1080P tiers, audio.',
  },
  'wan2.2-t2v-plus': {
    id: 'wan2.2-t2v-plus',
    protocol: PROTOCOL_DASHSCOPE_WAN,
    modality: 'video',
    durations: [5],
    sizes: ['832*480', '480*832', '624*624', '1920*1080', '1080*1920', '1440*1440', '1632*1248', '1248*1632'],
    notes: 'wan2.2-t2v-plus: duration fixed 5 s, 480P/1080P tiers, silent video (no audio support).',
  },
  'wanx2.1-t2v-turbo': {
    id: 'wanx2.1-t2v-turbo',
    protocol: PROTOCOL_DASHSCOPE_WAN,
    modality: 'video',
    durations: [5],
    sizes: ['832*480', '480*832', '624*624', '1280*720', '720*1280', '960*960', '1088*832', '832*1088'],
    notes: 'wanx2.1-t2v-turbo: duration fixed 5 s, 480P/720P tiers, silent video.',
  },
  'wanx2.1-t2v-plus': {
    id: 'wanx2.1-t2v-plus',
    protocol: PROTOCOL_DASHSCOPE_WAN,
    modality: 'video',
    durations: [5],
    sizes: ['1280*720', '720*1280', '960*960', '1088*832', '832*1088'],
    notes: 'wanx2.1-t2v-plus: duration fixed 5 s, 720P tier only, silent video.',
  },
  'wanx2.1-t2i-turbo': {
    id: 'wanx2.1-t2i-turbo',
    protocol: PROTOCOL_DASHSCOPE_WAN,
    modality: 'image',
    sizes: ['1024*1024', '720*1280', '1280*720'],
    notes: 'wanx2.1-t2i-turbo: async text-to-image task, url output under output.results.',
  },
  'wanx2.1-t2i-plus': {
    id: 'wanx2.1-t2i-plus',
    protocol: PROTOCOL_DASHSCOPE_WAN,
    modality: 'image',
    sizes: ['1024*1024', '720*1280', '1280*720'],
    notes: 'wanx2.1-t2i-plus: higher-fidelity async text-to-image task.',
  },

  // ---- Google GenAI (Gemini API). Ids are the official current values
  // (ai.google.dev/gemini-api/docs/video and /docs/imagen, fetched 2026-11):
  // Imagen 4.0 `:predict` (sync base64) and Veo `:predictLongRunning` (LRO).
  'imagen-4.0-generate-001': {
    id: 'imagen-4.0-generate-001',
    protocol: PROTOCOL_GOOGLE_GENMEDIA,
    modality: 'image',
    sizes: ['1024x1024', '1024x1408', '1408x1024'],
    formats: ['png', 'jpeg'],
    notes: 'Imagen 4.0 (Gemini API :predict): sync base64 predictions, aspect-ratio sizes.',
  },
  'imagen-4.0-fast-generate-001': {
    id: 'imagen-4.0-fast-generate-001',
    protocol: PROTOCOL_GOOGLE_GENMEDIA,
    modality: 'image',
    sizes: ['1024x1024', '1024x1408', '1408x1024'],
    formats: ['png', 'jpeg'],
    notes: 'Imagen 4.0 fast (Gemini API :predict): lower latency, sync base64.',
  },
  'veo-3.1-generate-preview': {
    id: 'veo-3.1-generate-preview',
    protocol: PROTOCOL_GOOGLE_GENMEDIA,
    modality: 'video',
    durations: [8],
    sizes: ['1280x720', '1920x1080'],
    notes: 'Veo 3.1 (Gemini API :predictLongRunning): 8 s clips with audio, 720p/1080p; poll the LRO operation.',
  },
  'veo-3.1-fast-generate-preview': {
    id: 'veo-3.1-fast-generate-preview',
    protocol: PROTOCOL_GOOGLE_GENMEDIA,
    modality: 'video',
    durations: [8],
    sizes: ['1280x720', '1920x1080'],
    notes: 'Veo 3.1 fast (Gemini API :predictLongRunning): latency-optimised 8 s clips.',
  },

  // ---- OpenAI media. Image ids per platform.openai.com/docs (gpt-image-1
  // returns b64_json by default; sizes per the images API reference).
  'gpt-image-1': {
    id: 'gpt-image-1',
    protocol: PROTOCOL_OPENAI_IMAGES,
    modality: 'image',
    sizes: ['1024x1024', '1024x1536', '1536x1024', 'auto'],
    formats: ['png', 'jpeg', 'webp'],
    notes: 'gpt-image-1 (POST /v1/images/generations): sync, b64_json by default.',
  },
  'gpt-image-1-mini': {
    id: 'gpt-image-1-mini',
    protocol: PROTOCOL_OPENAI_IMAGES,
    modality: 'image',
    sizes: ['1024x1024', '1024x1536', '1536x1024', 'auto'],
    formats: ['png', 'jpeg', 'webp'],
    notes: 'gpt-image-1-mini: cost-optimised sync image generation.',
  },
};

/** Preset ids in declared order. */
export const PRESET_MODEL_IDS: readonly string[] = Object.keys(MODEL_PRESETS);

/** Model ids for one protocol+modality, in declared order (config defaults). */
export function presetModels(protocol: ProtocolKind, modality: ModelCapabilitySpec['modality']): string[] {
  return Object.values(MODEL_PRESETS)
    .filter((p) => p.protocol === protocol && p.modality === modality)
    .map((p) => p.id);
}

/** Look up one preset; unknown ids return undefined (callers decide the policy). */
export function preset(modelId: string): ModelCapabilitySpec | undefined {
  return MODEL_PRESETS[modelId];
}

/**
 * Per-model capability map for an arbitrary list of ids. Unknown ids are kept
 * with their modality only (they are explicit configuration, not silently
 * dropped); this never changes routing.
 */
export function modelCapabilitiesFor(
  protocol: ProtocolKind,
  modalities: ReadonlyArray<ModelCapabilitySpec['modality']>,
  ids: readonly string[],
): Record<string, ModelCapabilitySpec> {
  const out: Record<string, ModelCapabilitySpec> = {};
  for (const id of ids) {
    const p = MODEL_PRESETS[id];
    const modality = p && p.protocol === protocol && modalities.includes(p.modality)
      ? p.modality
      : modalities[0];
    out[id] = p && p.protocol === protocol && p.modality === modality ? p : { id, protocol, modality: modality as ModelCapabilitySpec['modality'] };
  }
  return out;
}
