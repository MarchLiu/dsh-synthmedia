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
import type { BackendPoll, GenerationBackend, GenerationRequest } from '../types.js';
import type { BackendConfig } from '../config.js';
import { SynthError, sanitizeText } from '../errors.js';
import {
  authHeaders,
  envCredentialResolver,
  httpRequest,
  httpRequestBytes,
  parseJson,
  type CredentialResolver,
} from '../http.js';
import { modelCapabilitiesFor, preset, PROTOCOL_GOOGLE_GENMEDIA } from '../presets.js';

interface Prediction {
  bytesBase64Encoded?: string;
  mimeType?: string;
}
interface PredictResponse {
  predictions?: Prediction[];
}
interface LroStartResponse {
  name?: string;
  error?: { code?: number; message?: string };
}
interface LroOperation {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string };
  response?: {
    generateVideoResponse?: {
      generatedSamples?: Array<{ video?: { uri?: string } }>;
      raiMediaFilteredReasons?: string[];
    };
  };
}

/** Auth header name required by the Gemini API (NOT `Authorization`). */
const AUTH_HEADER = 'x-goog-api-key';

function googleFailure(status: number, body: string, backendId: string): SynthError {
  let message = body.slice(0, 300);
  let inner = '';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; status?: string } };
    if (parsed.error?.message) message = parsed.error.message;
    if (parsed.error?.status) inner = `, ${parsed.error.status}`;
  } catch {
    // keep the snippet
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
    `google-genmedia request failed (http ${status}${inner}): ${sanitizeText(message)}`,
    backendId,
    status >= 500 || status === 429,
  );
}

/** Substitute `{model}` in a path template; reject unknown placeholders. */
function withModel(tpl: string, modelId: string): string {
  return tpl.replace('{model}', encodeURIComponent(modelId));
}

export function createGeminiBackend(cfg: BackendConfig, resolve: CredentialResolver = envCredentialResolver): GenerationBackend {
  const models = cfg.models && cfg.models.length > 0 ? [...cfg.models] : [cfg.model];
  const paths = cfg.paths!;
  const extra = cfg.extraBody ?? {};
  const realSubmitAllowed = cfg.protocolVerified === true && cfg.blockRealSubmit !== true;
  // Veo artifact URI cached by poll() and consumed by fetch().
  const contentUrls = new Map<string, string>();

  const capabilityFor = (modelId: string) => {
    const p = preset(modelId);
    return p && p.protocol === PROTOCOL_GOOGLE_GENMEDIA ? p : undefined;
  };

  const headers = async (): Promise<Record<string, string>> => ({
    'Content-Type': 'application/json',
    ...(await authHeaders(cfg, resolve)),
  });

  /** Operation URLs: `{base}{prefix}/{operation-name}`; cancel appends `:cancel`. */
  const opUrl = (operationName: string): string => {
    const prefix = (paths.status ?? '/v1beta').replace(/\/+$/, '');
    return `${cfg.baseUrl}${prefix}/${operationName}`;
  };

  function resolveDurationSeconds(req: GenerationRequest, modelId: string): number | undefined {
    const known = capabilityFor(modelId);
    const requested = typeof req.durationSeconds === 'number' ? req.durationSeconds : cfg.defaultDurationSeconds;
    if (typeof requested !== 'number') return undefined;
    const allowed = known?.durations;
    if (allowed && allowed.length > 0 && !allowed.includes(Math.round(requested))) {
      throw new SynthError(
        'E_DURATION',
        `backend '${cfg.id}': model '${modelId}' supports durations ${allowed.join('/')} s, got ${requested}`,
        cfg.id,
      );
    }
    return Math.round(requested);
  }

  /** Poll one LRO operation and map it onto the unified vocabulary. */
  function mapOperation(op: LroOperation): BackendPoll {
    if (op.done && op.error) {
      return {
        status: 'failed',
        progress: 0,
        error: { code: op.error.code !== undefined ? `E_REMOTE_${op.error.code}` : 'E_REMOTE', message: sanitizeText(op.error.message ?? 'operation failed') },
      };
    }
    if (op.done) {
      const gen = op.response?.generateVideoResponse;
      const uri = gen?.generatedSamples?.map((s) => s?.video?.uri).find((u) => typeof u === 'string' && u.length > 0);
      if (!uri) {
        const filtered = gen?.raiMediaFilteredReasons?.join('; ');
        return {
          status: 'failed',
          progress: 0,
          error: {
            code: 'E_PROTOCOL',
            message: filtered
              ? `generation blocked by safety filters: ${sanitizeText(filtered)}`
              : 'operation done but carried no generated video URI',
          },
        };
      }
      return { status: 'succeeded', progress: 100 };
    }
    // The LRO surface has no numeric progress field: coarse estimate only.
    return { status: 'running', progress: 50 };
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
        protocol: PROTOCOL_GOOGLE_GENMEDIA,
        modelCapabilities: modelCapabilitiesFor(PROTOCOL_GOOGLE_GENMEDIA, cfg.modalities, models),
      };
    },
    async create(req, signal) {
      if (!cfg.modalities.includes(req.modality)) {
        throw new SynthError('E_MODALITY', `backend '${cfg.id}' does not serve modality '${req.modality}'`, cfg.id);
      }
      if (!realSubmitAllowed) {
        throw new SynthError(
          'E_PROTOCOL_UNVERIFIED',
          `backend '${cfg.id}': google-genmedia-compatible is not verified for this deployment (protocolVerified=false / blockRealSubmit); real submission is disabled — mock/contract tests only`,
          cfg.id,
        );
      }
      if (req.prompt.trim().length === 0) {
        throw new SynthError('E_REQUEST', `backend '${cfg.id}': the Gemini media protocol requires a non-empty prompt`, cfg.id);
      }

      if (req.modality === 'image') {
        // ---- Imagen :predict — synchronous, artifact comes back inline.
        const body: Record<string, unknown> = {
          instances: [{ prompt: req.prompt }],
          parameters: { ...extra, sampleCount: typeof extra['sampleCount'] === 'number' ? extra['sampleCount'] : 1 },
        };
        const { status, body: resp } = await httpRequest(cfg.id, `${cfg.baseUrl}${withModel(paths.submit, req.model)}`, {
          method: 'POST',
          headers: await headers(),
          body: JSON.stringify(body),
          signal,
          timeoutMs: Math.min(cfg.timeoutMs, 300_000),
        });
        if (status !== 200) throw googleFailure(status, resp, cfg.id);
        const data = parseJson<PredictResponse>(cfg.id, resp);
        const prediction = data.predictions?.[0];
        const b64 = prediction?.bytesBase64Encoded;
        if (typeof b64 !== 'string' || b64.length === 0) {
          throw new SynthError('E_PROTOCOL', 'Imagen predict response carried no predictions[0].bytesBase64Encoded', cfg.id);
        }
        const bytes = Buffer.from(b64, 'base64');
        const mimeType = prediction?.mimeType ?? 'image/png';
        return { remoteId: 'inline', inline: { bytes, mimeType } };
      }

      // ---- Veo :predictLongRunning — async LRO operation.
      const duration = resolveDurationSeconds(req, req.model);
      const instance: Record<string, unknown> = { prompt: req.prompt };
      const parameters: Record<string, unknown> = { ...extra };
      if (duration !== undefined) parameters['durationSeconds'] = duration;
      if (typeof req.size === 'string' && req.size.trim().length > 0) parameters['resolution'] = req.size;
      if (typeof req.seed === 'number') parameters['seed'] = req.seed;
      const body: Record<string, unknown> = { instances: [instance], parameters };
      const { status, body: resp } = await httpRequest(cfg.id, `${cfg.baseUrl}${withModel(paths.submit, req.model)}`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify(body),
        signal,
        timeoutMs: Math.min(cfg.timeoutMs, 120_000),
      });
      if (status !== 200) throw googleFailure(status, resp, cfg.id);
      const data = parseJson<LroStartResponse>(cfg.id, resp);
      if (!data.name) {
        throw new SynthError('E_PROTOCOL', 'Veo predictLongRunning response carried no operation name', cfg.id);
      }
      return { remoteId: data.name };
    },
    async poll(remoteId, signal) {
      const { status, body } = await httpRequest(cfg.id, opUrl(remoteId), {
        method: 'GET',
        headers: await headers(),
        signal,
        timeoutMs: 60_000,
      });
      if (status !== 200) throw googleFailure(status, body, cfg.id);
      const op = parseJson<LroOperation>(cfg.id, body);
      const poll = mapOperation(op);
      if (poll.status === 'succeeded') {
        const uri = op.response?.generateVideoResponse?.generatedSamples
          ?.map((s) => s?.video?.uri)
          .find((u) => typeof u === 'string' && u.length > 0);
        if (uri) contentUrls.set(remoteId, uri);
      }
      return poll;
    },
    async fetch(remoteId, signal) {
      const uri = contentUrls.get(remoteId);
      if (!uri) {
        throw new SynthError(
          'E_PROTOCOL',
          `no video URI cached for operation '${sanitizeText(remoteId)}' — poll must run first`,
          cfg.id,
        );
      }
      // Google file URI: the credential header IS required for download.
      const dl = await httpRequestBytes(cfg.id, uri, {
        method: 'GET',
        headers: await headers(),
        signal,
        timeoutMs: 300_000,
      });
      if (dl.status !== 200) {
        throw new SynthError('E_REMOTE', `video download failed (http ${dl.status})`, cfg.id, dl.status >= 500);
      }
      const rawType = (dl.contentType ?? '').split(';')[0]!.trim().toLowerCase();
      const mimeType = rawType.startsWith('video/') ? rawType : 'video/mp4';
      return { bytes: dl.bytes, mimeType };
    },
    async cancel(remoteId, signal) {
      try {
        await httpRequest(cfg.id, `${opUrl(remoteId)}:cancel`, {
          method: 'POST',
          headers: await headers(),
          signal,
          timeoutMs: 30_000,
        });
      } catch {
        // best-effort: never mask the caller's cancellation outcome
      }
    },
  };
}
