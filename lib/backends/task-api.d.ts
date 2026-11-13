/**
 * Generic async task-api backend: submit → poll status → fetch content.
 *
 * Two verified protocol shapes share this implementation (paths are config):
 * 1. PhotoStory self-hosted videogen (`utils/videogen.py`):
 *    POST /v1/videogen → {task_id}; GET .../{id} → {status,progress};
 *    GET .../{id}/content → binary.
 * 2. hub.zgci.org minimax-h3 video (OpenAI Sora protocol, VERIFIED against
 *    PhotoStory `backend/scripts/verify_ai_models.py` L184-235 and by ONE
 *    authorized live run): JSON POST /v1/videos (accepts HTTP 200 OR 201) →
 *    {id, status: queued|in_progress}; GET /v1/videos/{id} → {status:
 *    queued|in_progress|completed|failed, progress}; GET
 *    /v1/videos/{id}/content returns the finished video bytes — verified in
 *    that live run (HTTP 200, `video/mp4`, a complete 1,426,282-byte MP4
 *    downloaded binary-safe, see the README live record).
 * 3. Offline vLLM-Omni / SGLang diffusion sidecar (official videos_api.md):
 *    multipart POST /v1/videos → {id,status:"queued"}; GET /v1/videos/{id}
 *    (queued/in_progress/completed); GET /v1/videos/{id}/content; DELETE
 *    /v1/videos/{id} cancels. Optional /v1/videos/sync returns raw video
 *    bytes synchronously (enabled with SYNTHMEDIA_SIDECAR_SYNC=1).
 *
 * Statuses mapped: completed|succeeded|success → succeeded; failed → failed;
 * cancelled|canceled → cancelled; anything else (incl. queued/in_progress) → running.
 * @module
 */
import type { GenerationBackend, BackendPoll } from '../types.js';
import type { BackendConfig } from '../config.js';
import { type CredentialResolver } from '../http.js';
/** Map an Sora/videogen-style status string onto the unified poll vocabulary. */
export declare function mapTaskStatus(s: string, progress: number, errMsg?: string): BackendPoll;
export declare function createTaskApiBackend(cfg: BackendConfig, resolve?: CredentialResolver): GenerationBackend;
