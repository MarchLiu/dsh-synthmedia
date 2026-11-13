/**
 * `openai-images-compatible` protocol adapter — the OpenAI synchronous images
 * API (`POST /v1/images/generations`). No provider branch: any gateway that
 * speaks the same shape is a ProviderProfile in config.ts.
 *
 * Official shape (docs fetched 2026-11):
 * - https://developers.openai.com/api/docs/guides/image-generation
 * - https://developers.openai.com/api/reference/resources/images/methods/generate
 *   POST {base}/v1/images/generations, bearer auth,
 *   body {model, prompt, n?, size?, output_format?, output_compression?, quality?}
 *   → {created, data:[{b64_json?, url?, revised_prompt?}]}
 *   GPT image models (gpt-image-1*) return `b64_json` by default and do NOT
 *   support `response_format`; `url` is only returned by models that support
 *   it, so both shapes are handled.
 * - Errors: `{error:{message, type, code}}` with a real HTTP status.
 *
 * The adapter always requests/accepts the base64 form; a `url` payload is
 * downloaded binary-safe in create() and returned inline (no task exists —
 * this surface is synchronous). No credential header ever touches an
 * artifact URL download.
 *
 * Guard: real submission requires the PROFILE to be marked
 * `protocolVerified: true` and not `blockRealSubmit`; otherwise create()
 * throws E_PROTOCOL_UNVERIFIED before any network I/O.
 * @module
 */
import type { GenerationBackend } from '../types.js';
import type { BackendConfig } from '../config.js';
import { SynthError } from '../errors.js';
import { type CredentialResolver } from '../http.js';
export declare function openaiImagesFailure(status: number, body: string, backendId: string): SynthError;
export declare function createOpenAIImagesBackend(cfg: BackendConfig, resolve?: CredentialResolver): GenerationBackend;
