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
import { modelCapabilitiesFor, preset, PROTOCOL_DASHSCOPE_WAN } from '../presets.js';
import { remoteCompletedAtOf } from '../time.js';

/** Official DashScope task statuses (generic async task API). */
type DashStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'UNKNOWN' | string;

interface DashSubmitResponse {
  output?: { task_id?: string; task_status?: string };
  code?: string;
  message?: string;
  request_id?: string;
}

interface DashTaskOutput {
  task_id?: string;
  task_status?: DashStatus;
  results?: Array<{ url?: string; code?: string; message?: string }>;
  video_url?: string;
  code?: string;
  message?: string;
  end_time?: string;
}

interface DashTaskEnvelope {
  output?: DashTaskOutput;
  code?: string;
  message?: string;
  request_id?: string;
}

/** Map an official DashScope task_status onto the unified poll vocabulary. */
export function mapDashScopeStatus(status: string, err?: { code?: string; message?: string }): BackendPoll {
  const norm = String(status).trim().toUpperCase();
  if (norm === 'SUCCEEDED') return { status: 'succeeded', progress: 100 };
  if (norm === 'FAILED') {
    return {
      status: 'failed',
      progress: 0,
      error: {
        code: err?.code ? sanitizeText(err.code) : 'E_REMOTE',
        message: sanitizeText(err?.message ?? 'task failed'),
      },
    };
  }
  if (norm === 'CANCELED' || norm === 'CANCELLED') return { status: 'cancelled', progress: 0 };
  if (norm === 'UNKNOWN') {
    return {
      status: 'failed',
      progress: 0,
      error: { code: 'E_PROTOCOL', message: 'remote task is UNKNOWN (expired or never existed)' },
    };
  }
  if (norm === 'PENDING') return { status: 'running', progress: 5 };
  return { status: 'running', progress: 50 };
}

/** HTTP failure carrying the DashScope error envelope `{code,message,request_id}`. */
function remoteFailure(status: number, body: string, backendId: string): SynthError {
  let codeText = '';
  let message = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { code?: string; message?: string };
    if (parsed.message) message = parsed.message;
    if (parsed.code) codeText = parsed.code;
  } catch {
    // Non-JSON error body: keep the sanitized snippet.
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
    `dashscope request failed (http ${status}${codeText ? `, ${codeText}` : ''}): ${sanitizeText(message)}`,
    backendId,
    status >= 500 || status === 429,
  );
}

export function createDashScopeBackend(cfg: BackendConfig, resolve: CredentialResolver = envCredentialResolver): GenerationBackend {
  const models = cfg.models && cfg.models.length > 0 ? [...cfg.models] : [cfg.model];
  const paths = cfg.paths!;
  const withId = (tpl: string, id: string): string => tpl.replace('{id}', encodeURIComponent(id));
  const extra = cfg.extraBody ?? {};
  const realSubmitAllowed = cfg.protocolVerified === true && cfg.blockRealSubmit !== true;
  // Artifact URLs cached by poll() and consumed by fetch().
  const contentUrls = new Map<string, string>();

  const capabilityFor = (modelId: string) => {
    const p = preset(modelId);
    return p && p.protocol === PROTOCOL_DASHSCOPE_WAN ? p : undefined;
  };

  const headers = async (): Promise<Record<string, string>> => ({
    // Mandatory on the submit surface: HTTP calls are async-only.
    'X-DashScope-Async': 'enable',
    'Content-Type': 'application/json',
    ...(await authHeaders(cfg, resolve)),
  });

  const pollHeaders = async (): Promise<Record<string, string>> => ({
    'Content-Type': 'application/json',
    ...(await authHeaders(cfg, resolve)),
  });

  /** `size` → official `W*H` token (WxH pixel inputs are normalised). */
  function resolveSize(size: string | undefined, modelId: string): string | undefined {
    if (typeof size !== 'string' || size.trim().length === 0) return undefined;
    const token = size.trim().replace(/[x×]/i, '*');
    const known = capabilityFor(modelId);
    const sizes = known?.sizes ?? [];
    if (sizes.length > 0 && !sizes.includes(token)) {
      throw new SynthError(
        'E_SIZE',
        `backend '${cfg.id}': model '${modelId}' supports sizes ${sizes.join('/')}, not '${token}'`,
        cfg.id,
      );
    }
    return token;
  }

  function resolveDuration(req: GenerationRequest, modelId: string): number | undefined {
    const known = capabilityFor(modelId);
    const requested = typeof req.durationSeconds === 'number' ? req.durationSeconds : cfg.defaultDurationSeconds;
    if (typeof requested !== 'number') return undefined; // image models / omit → provider default
    const d = Math.round(requested);
    if (d <= 0) {
      throw new SynthError('E_DURATION', `backend '${cfg.id}': duration must be a positive integer, got ${requested}`, cfg.id);
    }
    const allowed = known?.durations;
    if (allowed && allowed.length > 0 && !allowed.includes(d)) {
      throw new SynthError(
        'E_DURATION',
        `backend '${cfg.id}': model '${modelId}' supports durations ${allowed.join('/')} s, got ${d}`,
        cfg.id,
      );
    }
    const max = known?.maxDurationSeconds;
    if (max !== undefined && d > max) {
      throw new SynthError('E_DURATION', `backend '${cfg.id}': model '${modelId}' supports up to ${max} s, got ${d}`, cfg.id);
    }
    return d;
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
        protocol: PROTOCOL_DASHSCOPE_WAN,
        modelCapabilities: modelCapabilitiesFor(PROTOCOL_DASHSCOPE_WAN, cfg.modalities, models),
      };
    },
    async create(req, signal) {
      if (!cfg.modalities.includes(req.modality)) {
        throw new SynthError('E_MODALITY', `backend '${cfg.id}' does not serve modality '${req.modality}'`, cfg.id);
      }
      if (!realSubmitAllowed) {
        throw new SynthError(
          'E_PROTOCOL_UNVERIFIED',
          `backend '${cfg.id}': dashscope-wan-compatible is not verified for this deployment (protocolVerified=false / blockRealSubmit); real submission is disabled — mock/contract tests only`,
          cfg.id,
        );
      }
      if (req.prompt.trim().length === 0) {
        throw new SynthError('E_REQUEST', `backend '${cfg.id}': the DashScope protocol requires a non-empty prompt`, cfg.id);
      }
      const size = resolveSize(req.size, req.model);
      const duration = resolveDuration(req, req.model);

      const input: Record<string, unknown> = { prompt: req.prompt };
      if (req.negativePrompt) input['negative_prompt'] = req.negativePrompt;

      const parameters: Record<string, unknown> = { ...extra };
      if (size) parameters['size'] = size;
      if (duration !== undefined) parameters['duration'] = duration;
      if (typeof req.seed === 'number') parameters['seed'] = req.seed;

      const payload: Record<string, unknown> = { model: req.model, input, parameters };
      const { status, body } = await httpRequest(cfg.id, `${cfg.baseUrl}${paths.submit}`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify(payload),
        signal,
        timeoutMs: Math.min(cfg.timeoutMs, 120_000),
      });
      if (status !== 200 && status !== 201) throw remoteFailure(status, body, cfg.id);
      const data = parseJson<DashSubmitResponse>(cfg.id, body);
      const taskId = data.output?.task_id;
      if (!taskId) {
        throw new SynthError('E_PROTOCOL', 'DashScope create response carried no output.task_id', cfg.id);
      }
      return { remoteId: taskId };
    },
    async poll(remoteId, signal) {
      const { status, body } = await httpRequest(cfg.id, `${cfg.baseUrl}${withId(paths.status, remoteId)}`, {
        method: 'GET',
        headers: await pollHeaders(),
        signal,
        timeoutMs: 60_000,
      });
      if (status !== 200) throw remoteFailure(status, body, cfg.id);
      const data = parseJson<DashTaskEnvelope>(cfg.id, body);
      const output = data.output;
      if (!output || typeof output.task_status !== 'string') {
        throw new SynthError('E_PROTOCOL', 'DashScope query response carried no output.task_status', cfg.id);
      }
      // Success artifacts: image batches under output.results[].url, wan
      // video under output.video_url. Cache the first usable URL for fetch().
      if (output.task_status.toUpperCase() === 'SUCCEEDED') {
        const url = output.video_url ?? output.results?.map((r) => r?.url).find((u) => typeof u === 'string' && u.length > 0);
        if (url) contentUrls.set(remoteId, url);
      }
      const poll = mapDashScopeStatus(output.task_status, { code: output.code, message: output.message });
      const remoteCompletedAt = remoteCompletedAtOf(output as unknown as Record<string, unknown>, poll.status);
      if (remoteCompletedAt) poll.remoteCompletedAt = remoteCompletedAt;
      return poll;
    },
    async fetch(remoteId, signal) {
      const url = contentUrls.get(remoteId);
      if (!url) {
        throw new SynthError(
          'E_PROTOCOL',
          `no artifact URL cached for task '${sanitizeText(remoteId)}' — poll must run first`,
          cfg.id,
        );
      }
      // Signed OSS URL: no credential header is attached.
      const dl = await httpRequestBytes(cfg.id, url, { method: 'GET', signal, timeoutMs: 300_000 });
      if (dl.status !== 200) {
        throw new SynthError('E_REMOTE', `artifact download failed (http ${dl.status})`, cfg.id, dl.status >= 500);
      }
      const rawType = (dl.contentType ?? '').split(';')[0]!.trim().toLowerCase();
      const mimeType = rawType.startsWith('video/') || rawType.startsWith('image/') ? rawType : 'application/octet-stream';
      return { bytes: dl.bytes, mimeType };
    },
    async cancel(remoteId, signal) {
      if (!paths.cancel) return; // remote cancel unsupported: caller-side cancellation only
      try {
        await httpRequest(cfg.id, `${cfg.baseUrl}${withId(paths.cancel, remoteId)}`, {
          method: cfg.cancelMethod ?? 'POST',
          headers: await pollHeaders(),
          signal,
          timeoutMs: 30_000,
        });
      } catch {
        // best-effort: never mask the caller's cancellation outcome
      }
    },
  };
}
