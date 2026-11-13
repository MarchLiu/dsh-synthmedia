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
export declare const PROTOCOL_ARK: ProtocolKind;
/** Protocol id for the OpenAI-style `/v1/videos` task surface (third-party compatible gateways). */
export declare const PROTOCOL_OPENAI_VIDEO: ProtocolKind;
/** Protocol id for PhotoStory's intranet videogen task API (extra, not OpenAI). */
export declare const PROTOCOL_VIDEOGEN: ProtocolKind;
/** Protocol id for OpenAI chat-completions (text only; extra). */
export declare const PROTOCOL_OPENAI_CHAT: ProtocolKind;
/**
 * Protocol id for the MiniMax video V2 (H3) async task surface. Distinct from
 * `openai-video-compatible`: the task lives under `{task:{...}}`, there is a
 * dedicated DELETE cancel path, output is a signed `task.content.url`, and
 * video is addressed by `resolution`/`ratio`/`duration` — not a pixel `size`.
 */
export declare const PROTOCOL_MINIMAX_VIDEO: ProtocolKind;
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
export declare const PROTOCOL_DASHSCOPE_WAN: ProtocolKind;
/**
 * Protocol id for the Google GenAI media surface (generativelanguage.googleapis.com):
 * Imagen `:predict` (synchronous base64 predictions) and Veo
 * `:predictLongRunning` (async LRO operation polling/cancel). Auth is the
 * `x-goog-api-key` header; api version `v1beta` is part of the configured
 * paths, never hard-coded.
 */
export declare const PROTOCOL_GOOGLE_GENMEDIA: ProtocolKind;
/**
 * Protocol id for the OpenAI synchronous images API (`POST /v1/images/generations`
 * → `{created, data:[{b64_json|url}]}`; GPT image models return `b64_json`).
 */
export declare const PROTOCOL_OPENAI_IMAGES: ProtocolKind;
/** All protocol ids this plugin understands. */
export declare const PROTOCOLS: readonly ProtocolKind[];
/** Legacy `kind` spellings accepted from configuration (never required). */
export declare const LEGACY_PROTOCOL_ALIASES: Readonly<Record<string, ProtocolKind>>;
export declare const MODEL_PRESETS: Readonly<Record<string, ModelCapabilitySpec>>;
/** Preset ids in declared order. */
export declare const PRESET_MODEL_IDS: readonly string[];
/** Model ids for one protocol+modality, in declared order (config defaults). */
export declare function presetModels(protocol: ProtocolKind, modality: ModelCapabilitySpec['modality']): string[];
/** Look up one preset; unknown ids return undefined (callers decide the policy). */
export declare function preset(modelId: string): ModelCapabilitySpec | undefined;
/**
 * Per-model capability map for an arbitrary list of ids. Unknown ids are kept
 * with their modality only (they are explicit configuration, not silently
 * dropped); this never changes routing.
 */
export declare function modelCapabilitiesFor(protocol: ProtocolKind, modalities: ReadonlyArray<ModelCapabilitySpec['modality']>, ids: readonly string[]): Record<string, ModelCapabilitySpec>;
