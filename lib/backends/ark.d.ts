import type { GenerationBackend, BackendPoll } from '../types.js';
import type { BackendConfig } from '../config.js';
import { type CredentialResolver } from '../http.js';
/**
 * Ark video `resolution` tiers documented for the task API. The API has no
 * pixel `size` field (unlike the synchronous image API), so a tool-level
 * `size` MUST be translated instead of silently dropped.
 */
export declare const ARK_VIDEO_RESOLUTIONS: readonly ["480p", "720p", "1080p"];
/** Ark video `ratio` values documented for the task API. */
export declare const ARK_VIDEO_RATIOS: readonly ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"];
/** One Ark video request size in the protocol's own vocabulary. */
export interface ArkVideoSpec {
    resolution: string;
    ratio?: string;
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
export declare function mapArkVideoSize(size: string, modelId: string, backendId: string): ArkVideoSpec;
/** Map an official Ark task status onto the unified poll vocabulary. */
export declare function mapArkStatus(s: string): BackendPoll;
/**
 * Map the Doubao TTS `data.task_status` numbers: 1 running, 2 succeeded,
 * 3 failed (official async result-query doc).
 */
export declare function mapTtsTaskStatus(status: number | undefined): BackendPoll;
export declare function createArkBackend(cfg: BackendConfig, resolve?: CredentialResolver): GenerationBackend;
