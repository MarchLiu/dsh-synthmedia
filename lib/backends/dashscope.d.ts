/**
 * `dashscope-wan-compatible` protocol adapter — Aliyun Model Studio (百炼 /
 * DashScope) async task surface used by the Tongyi Wanxiang (万相) family,
 * covering BOTH wan2.x VIDEO and wanx2.1 IMAGE models.
 *
 * This file implements a WIRE PROTOCOL only: no provider id, no base URL, no
 * credential name. Any deployment speaking the same shape (the official
 * `dashscope.aliyuncs.com` endpoints, a workspace domain
 * `{WorkspaceId}.{region}.maas.aliyuncs.com`, or a third-party compatible
 * gateway) is a ProviderProfile in config.ts.
 *
 * Official shape (docs fetched 2026-11):
 * - submit (video): https://help.aliyun.com/zh/model-studio/legacy-wan-text-to-video-api-reference
 *   POST {base}/api/v1/services/aigc/video-generation/video-synthesis,
 *   headers `X-DashScope-Async: enable` (mandatory — sync calls are rejected)
 *   + bearer auth; body {model, input:{prompt, negative_prompt?}, parameters:{size?, duration?, seed?}}
 *   → {output:{task_id, task_status}, request_id}
 * - submit (image, wanx2.1 t2i V2): https://help.aliyun.com/zh/model-studio/text-to-image-v2-api-reference
 *   POST {base}/api/v1/services/aigc/text2image/image-synthesis, same async
 *   header semantics, body {model, input:{prompt, negative_prompt?}, parameters:{size, n, seed}}
 * - query (generic, all task types): https://help.aliyun.com/zh/model-studio/manage-asynchronous-tasks
 *   GET {base}/api/v1/tasks/{task_id} → {output:{task_id, task_status:
 *   PENDING|RUNNING|SUCCEEDED|FAILED|CANCELED|UNKNOWN, results?:[{url}],
 *   video_url?, code?, message?, end_time?}}
 * - cancel: POST {base}/api/v1/tasks/{task_id}/cancel — only PENDING tasks;
 *   other states return `UnsupportedOperation`.
 * - artifacts: signed OSS URLs (`output.results[].url` for image batches,
 *   `output.video_url` for wan video) — downloaded binary-safe with NO
 *   credential header attached.
 *
 * Guard: real submission requires the PROFILE to be marked
 * `protocolVerified: true` and not `blockRealSubmit`; otherwise create()
 * throws E_PROTOCOL_UNVERIFIED before any network I/O.
 * @module
 */
import type { BackendPoll, GenerationBackend } from '../types.js';
import type { BackendConfig } from '../config.js';
import { type CredentialResolver } from '../http.js';
/** Map an official DashScope task_status onto the unified poll vocabulary. */
export declare function mapDashScopeStatus(status: string, err?: {
    code?: string;
    message?: string;
}): BackendPoll;
export declare function createDashScopeBackend(cfg: BackendConfig, resolve?: CredentialResolver): GenerationBackend;
