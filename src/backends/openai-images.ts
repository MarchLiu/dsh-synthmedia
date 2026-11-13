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
import type { GenerationBackend, GenerationRequest } from '../types.js';
import type { BackendConfig } from '../config.js';
import { SynthError, sanitizeText } from '../errors.js';
import {
  authHeaders,
  envCredentialResolver,
  httpRequestBytes,
  parseJson,
  type CredentialResolver,
} from '../http.js';
import { modelCapabilitiesFor, preset, PROTOCOL_OPENAI_IMAGES } from '../presets.js';

interface ImagesResponse {
  created?: number;
  data?: Array<{ b64_json?: string; url?: string }>;
}

export function openaiImagesFailure(status: number, body: string, backendId: string): SynthError {
  let message = body.slice(0, 300);
  let inner = '';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; code?: string; type?: string } };
    if (parsed.error?.message) message = parsed.error.message;
    if (parsed.error?.code) inner = `, code ${parsed.error.code}`;
    else if (parsed.error?.type) inner = `, type ${parsed.error.type}`;
  } catch {
    // keep snippet
  }
  const code =
    status === 401 || status === 403
      ? 'E_AUTH'
      : status === 429
        ? 'E_RATE_LIMIT'
        : status === 400 || status === 404
          ? 'E_REQUEST'
          : 'E_REMOTE';
  return new SynthError(
    code,
    `openai-images request failed (http ${status}${inner}): ${sanitizeText(message)}`,
    backendId,
    status >= 500 || status === 429,
  );
}

export function createOpenAIImagesBackend(cfg: BackendConfig, resolve: CredentialResolver = envCredentialResolver): GenerationBackend {
  const models = cfg.models && cfg.models.length > 0 ? [...cfg.models] : [cfg.model];
  const paths = cfg.paths!;
  const extra = cfg.extraBody ?? {};
  const realSubmitAllowed = cfg.protocolVerified === true && cfg.blockRealSubmit !== true;

  const capabilityFor = (modelId: string) => {
    const p = preset(modelId);
    return p && p.protocol === PROTOCOL_OPENAI_IMAGES ? p : undefined;
  };

  /** Normalise a tool-level size onto the API's `WIDTHxHEIGHT` vocabulary. */
  function resolveSize(size: string | undefined, modelId: string): string | undefined {
    if (typeof size !== 'string' || size.trim().length === 0) return undefined;
    const token = size.trim().replace('*', 'x').toLowerCase();
    const known = capabilityFor(modelId);
    const sizes = known?.sizes ?? [];
    if (sizes.length > 0 && !sizes.includes(token)) {
      throw new SynthError(
        'E_SIZE',
        `backend '${cfg.id}': model '${modelId}' supports sizes ${sizes.join('/')}, not '${token}'`,
        cfg.id,
      );
    }
    return token === 'auto' ? 'auto' : token;
  }

  return {
    id: cfg.id,
    capabilities() {
      return {
        modalities: [...cfg.modalities],
        models,
        online: cfg.online,
        protocolVerified: cfg.protocolVerified === true,
        liveVerified: cfg.liveVerified === true,
        realSubmitAllowed,
        protocol: PROTOCOL_OPENAI_IMAGES,
        modelCapabilities: modelCapabilitiesFor(PROTOCOL_OPENAI_IMAGES, cfg.modalities, models),
      };
    },
    async create(req, signal) {
      if (!cfg.modalities.includes(req.modality)) {
        throw new SynthError('E_MODALITY', `backend '${cfg.id}' does not serve modality '${req.modality}'`, cfg.id);
      }
      if (!realSubmitAllowed) {
        throw new SynthError(
          'E_PROTOCOL_UNVERIFIED',
          `backend '${cfg.id}': openai-images-compatible is not verified for this deployment (protocolVerified=false / blockRealSubmit); real submission is disabled — mock/contract tests only`,
          cfg.id,
        );
      }
      if (req.prompt.trim().length === 0) {
        throw new SynthError('E_REQUEST', `backend '${cfg.id}': the images API requires a non-empty prompt`, cfg.id);
      }
      const size = resolveSize(req.size, req.model);
      const payload: Record<string, unknown> = {
        ...extra,
        model: req.model,
        prompt: req.negativePrompt ? `${req.prompt}. Avoid: ${req.negativePrompt}` : req.prompt,
        n: 1,
      };
      if (size) payload['size'] = size;
      if (typeof req.seed === 'number') payload['seed'] = req.seed;

      const headers = { 'Content-Type': 'application/json', ...(await authHeaders(cfg, resolve)) };
      const { status, body } = await httpRequestBytes(cfg.id, `${cfg.baseUrl}${paths.submit}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal,
        timeoutMs: Math.min(cfg.timeoutMs, 300_000),
      }).then((r) => ({ status: r.status, body: r.bytes.toString('utf8') }));
      if (status !== 200) throw openaiImagesFailure(status, body, cfg.id);
      const data = parseJson<ImagesResponse>(cfg.id, body);
      const item = data.data?.[0];

      // Preferred shape: base64 (GPT image models return it by default).
      if (typeof item?.b64_json === 'string' && item.b64_json.length > 0) {
        const bytes = Buffer.from(item.b64_json, 'base64');
        const mimeType = typeof extra['output_format'] === 'string' ? `image/${extra['output_format']}` : 'image/png';
        return { remoteId: 'inline', inline: { bytes, mimeType } };
      }
      // Legacy shape: a hosted URL — download binary-safe, no credential header.
      if (typeof item?.url === 'string' && item.url.length > 0) {
        const dl = await httpRequestBytes(cfg.id, item.url, { method: 'GET', signal, timeoutMs: 300_000 });
        if (dl.status !== 200) {
          throw new SynthError('E_REMOTE', `image download failed (http ${dl.status})`, cfg.id, dl.status >= 500);
        }
        const rawType = (dl.contentType ?? '').split(';')[0]!.trim().toLowerCase();
        const mimeType = rawType.startsWith('image/') ? rawType : 'image/png';
        return { remoteId: 'inline', inline: { bytes: dl.bytes, mimeType } };
      }
      throw new SynthError('E_PROTOCOL', 'images response carried neither data[0].b64_json nor data[0].url', cfg.id);
    },
    async poll() {
      // Synchronous surface: the job never enters the polling phase.
      return { status: 'succeeded', progress: 100 };
    },
    async fetch() {
      throw new SynthError(
        'E_PROTOCOL',
        `backend '${cfg.id}': the images API is synchronous — artifacts are returned inline by create()`,
        cfg.id,
      );
    },
  };
}
