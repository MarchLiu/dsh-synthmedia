/**
 * `minimax-video-compatible` protocol adapter — MiniMax official video V2
 * (MiniMax-H3 family) async task surface.
 *
 * This file implements a WIRE PROTOCOL only; it never mentions a provider id,
 * base URL or credential name. Which deployment (the official
 * `api.minimax.io` endpoint or any relay speaking the same shape) is spoken to
 * is a ProviderProfile concern in config.ts.
 *
 * Official shape (docs fetched 2026-11):
 * - https://platform.minimax.io/docs/api-reference/video-generation-v2-create
 * - https://platform.minimax.io/docs/api-reference/video-generation-v2-query
 * - https://platform.minimax.io/docs/api-reference/video-generation-v2-delete
 * - https://platform.minimax.io/docs/guides/video-generation
 * Base URL `https://api.minimax.io`, bearer auth, models `MiniMax-H3`,
 * `MiniMax-H3-Highspeed`, `MiniMax-H3-Lite`, `MiniMax-H3-Max`.
 *
 * 1. Create — `POST /v2/video_generation`
 *    body {model, content:[{type:'text',text} | {type:'image_url',image_url:{url},role} |
 *          {type:'video_url',...} | {type:'audio_url',...}],
 *          resolution:'480P'|'768P'|'2K', duration:4..15, ratio?, extra?, callback_url?}
 *    → {task_id}. Every request needs one non-empty text item. There is NO
 *    pixel `size` field: a tool-level size is mapped onto `resolution` (+
 *    `ratio`) or rejected with E_SIZE before any network I/O.
 * 2. Query — `GET /v2/query/video_generation/{task_id}`
 *    → {task:{id, model, status:'queued'|'running'|'succeeded'|'failed'|
 *       'cancelled', created_at, updated_at, content:{url?|prompt?},
 *       error?:{code,message}, resolution, duration, usage, ratio, task_type,
 *       modality}}. No numeric progress field exists; progress is a coarse
 *       estimate derived from the status.
 * 3. Cancel / delete — `DELETE /v2/video_generation/{task_id}`
 *    → {task_id, action:'cancelled'|'deleted', status}. Only a `queued` task
 *    can be cancelled; the call is best-effort from the job manager's side.
 * 4. Artifact — `task.content.url` is a time-limited signed CDN URL; it is
 *    downloaded binary-safe with NO credential header attached.
 *
 * Errors use the OpenAI-style envelope
 * `{type:'error', error:{type,message,http_code}, request_id}` with the real
 * HTTP status; failed TASKS instead carry `task.error:{code,message}`.
 *
 * Guard: real submission requires the PROFILE to be marked
 * `protocolVerified: true` and not `blockRealSubmit`; otherwise create()
 * throws E_PROTOCOL_UNVERIFIED before any network I/O. `liveVerified` is
 * separate metadata and never gates anything by itself.
 * @module
 */
import type { BackendPoll, GenerationBackend } from '../types.js';
import type { BackendConfig } from '../config.js';
import { type CredentialResolver } from '../http.js';
/** Official MiniMax video `resolution` tiers (note the uppercase P). */
export declare const MINIMAX_VIDEO_RESOLUTIONS: readonly ["480P", "768P", "2K"];
/** Official MiniMax video `ratio` values. */
export declare const MINIMAX_VIDEO_RATIOS: readonly ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
/** One MiniMax video request size expressed in the protocol's vocabulary. */
export interface MinimaxVideoSpec {
    resolution: string;
    ratio?: string;
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
export declare function mapMinimaxVideoSize(size: string, modelId: string, backendId: string): MinimaxVideoSpec;
/** Map an official MiniMax task status onto the unified poll vocabulary. */
export declare function mapMinimaxStatus(status: string, error?: {
    code?: string | number;
    message?: string;
}): BackendPoll;
export declare function createMinimaxBackend(cfg: BackendConfig, resolve?: CredentialResolver): GenerationBackend;
