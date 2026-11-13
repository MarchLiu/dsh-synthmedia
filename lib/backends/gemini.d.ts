/**
 * `google-genmedia-compatible` protocol adapter — Google GenAI media surface on
 * `generativelanguage.googleapis.com`: Imagen image `:predict` (synchronous,
 * base64 predictions) and Veo video `:predictLongRunning` (async LRO
 * operation).
 *
 * This file implements a WIRE PROTOCOL only: no provider id, no base URL, no
 * credential name. The api version (`v1beta`) lives in the configured paths,
 * never hard-coded, so a compatible gateway only needs a ProviderProfile.
 *
 * Official shape (docs fetched 2026-11):
 * - Imagen: https://ai.google.dev/gemini-api/docs/imagen and the official
 *   REST quickstart (google-gemini/cookbook Get_started_imagen_rest.ipynb)
 *   POST {base}/v1beta/models/{model}:predict  header `x-goog-api-key`
 *   body {instances:[{prompt}], parameters:{sampleCount, personGeneration?, aspectRatio?}}
 *   → {predictions:[{bytesBase64Encoded, mimeType}]} — synchronous, no task.
 * - Veo: https://ai.google.dev/gemini-api/docs/video
 *   POST {base}/v1beta/models/{model}:predictLongRunning
 *   body {instances:[{prompt}], parameters:{...}} → {name: "models/<model>/operations/<op>"}
 *   Poll GET {base}/v1beta/{name} until `done:true`;
 *   success → response.generateVideoResponse.generatedSamples[].video.uri
 *   failure → error (google.rpc.Status {code,message}) — safety-filtered
 *   generations also surface through response.raiMediaFilteredReasons.
 *   Cancel POST {base}/v1beta/{name}:cancel.
 * - The Veo file URI is downloaded WITH the credential header (Google file
 *   downloads require the API key).
 *
 * Guard: real submission requires the PROFILE to be marked
 * `protocolVerified: true` and not `blockRealSubmit`; otherwise create()
 * throws E_PROTOCOL_UNVERIFIED before any network I/O.
 * @module
 */
import type { GenerationBackend } from '../types.js';
import type { BackendConfig } from '../config.js';
import { type CredentialResolver } from '../http.js';
export declare function createGeminiBackend(cfg: BackendConfig, resolve?: CredentialResolver): GenerationBackend;
