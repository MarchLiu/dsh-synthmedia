/**
 * ProviderProfile layer: connection + deployment configuration. A profile
 * says WHERE a protocol is spoken (baseURL), HOW it is authenticated (an
 * environment-variable name or a DSH credential reference — never a value),
 * WHICH paths and timeouts apply, and WHICH model ids it serves. It contains
 * no provider-specific branching: the protocol id selects the adapter, the
 * profile only parameterises it.
 *
 * Defaults below are PRESETS (examples), not special cases:
 * - zgci-h3            → openai-video-compatible `/v1/videos` (hub.zgci.org, third-party relay)
 * - minimax-official   → minimax-video-compatible `/v2/video_generation` (api.minimax.io)
 * - minimax-relay      → minimax-video-compatible (third-party relay; blocked until verified)
 * - local-h3-sidecar   → openai-video-compatible (vLLM-Omni / SGLang)
 * - local-h3           → videogen-task-api (PhotoStory intranet videogen)
 * - bza-*              → volcengine-ark-compatible (Seedance/Seedream/Seed TTS)
 *
 * Secrets are NEVER stored here. `authEnv` / `credentialRef` hold NAMES that
 * are resolved per call through the host credential provider or process.env.
 * @module
 */
import { SynthError } from './errors.js';
import type { Modality, ProtocolKind } from './types.js';
import {
  PROTOCOL_ARK,
  PROTOCOL_MINIMAX_VIDEO,
  PROTOCOL_OPENAI_CHAT,
  PROTOCOL_OPENAI_VIDEO,
  PROTOCOL_VIDEOGEN,
  PROTOCOL_DASHSCOPE_WAN,
  PROTOCOL_GOOGLE_GENMEDIA,
  PROTOCOL_OPENAI_IMAGES,
  PROTOCOLS,
  LEGACY_PROTOCOL_ALIASES,
  presetModels,
} from './presets.js';

/** Canonical wire-protocol id (legacy `kind` spellings are normalised). */
export type BackendKind = ProtocolKind;

/** Official Doubao async TTS request/response tunables (all overridable). */
export interface TtsProfile {
  /** Value of the resource-id header, e.g. `seed-tts-2.0`. */
  readonly resourceId?: string;
  /** Credit-card style speaker id; required by the official submit body. */
  readonly speaker?: string;
  /** Audio container: mp3 | pcm | ogg_opus (official default mp3). */
  readonly format?: 'mp3' | 'pcm' | 'ogg_opus';
  /** Sample rate in Hz (official default 24000). */
  readonly sampleRate?: number;
  /** Body `user.uid` (non-secret account label). */
  readonly uid?: string;
  /** Header carrying the API key (official: X-Api-Key). */
  readonly apiKeyHeader?: string;
  /** Header carrying the resource id (official: X-Api-Resource-Id). */
  readonly resourceHeader?: string;
  /** Header carrying the request id (official: X-Api-Request-Id). */
  readonly requestIdHeader?: string;
}

export interface BackendConfig {
  readonly id: string;
  /** Wire protocol; selects the adapter. */
  readonly protocol: ProtocolKind;
  /** Default model id (must be in `models`). */
  readonly model: string;
  /** Every model id routable on this profile (default `[model]`). */
  readonly models?: readonly string[];
  readonly modalities: ReadonlyArray<Modality>;
  /** Base URL, no trailing slash. */
  readonly baseUrl: string;
  /**
   * Environment variable NAME holding the credential. Read at request time
   * (through the DSH credential provider when present) and never persisted.
   */
  readonly authEnv?: string;
  /** DSH credential reference; defaults to `authEnv`. Also just a name. */
  readonly credentialRef?: string;
  readonly authStyle: 'bearer' | 'basic' | 'raw' | 'none';
  /** Header that carries the credential (default `Authorization`). */
  readonly authHeader?: string;
  /** Static, non-secret headers merged into every request. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Static query parameters appended to every request URL. A generic protocol
   * knob, not a provider branch: gateways that require e.g. a `GroupId` or an
   * `api-version` query parameter are configured here.
   */
  readonly queryParams?: Readonly<Record<string, string>>;
  /**
   * Default video duration when a request omits `durationSeconds` and the
   * model has no capability preset (protocols that require a duration).
   */
  readonly defaultDurationSeconds?: number;
  readonly online: boolean;
  readonly timeoutMs: number;
  /** Async-task profiles: paths relative to baseUrl. */
  readonly paths?: {
    readonly submit: string;
    /** May contain {id} for task APIs; TTS query takes the id in the body. */
    readonly status: string;
    readonly content?: string;
    readonly cancel?: string;
  };
  readonly pollIntervalMs?: number;
  /** Submit body encoding: 'json' (default) or 'multipart' (vLLM-Omni form). */
  readonly submitEncoding?: 'json' | 'multipart';
  /** HTTP method for the cancel path (vLLM-Omni uses DELETE). Default POST. */
  readonly cancelMethod?: 'POST' | 'DELETE';
  /** Send `seconds` as a JSON string (hub /v1/videos verifies with "4"). */
  readonly secondsAsString?: boolean;
  /** Optional synchronous endpoint returning raw video bytes (/v1/videos/sync). */
  readonly syncEndpoint?: string;
  /** Extra static JSON body fields merged into submit payloads. */
  readonly extraBody?: Record<string, unknown>;
  /** Wire-shape verification (official docs / harness). Gates real submission. */
  readonly protocolVerified?: boolean;
  /**
   * A REAL call against THIS deployment has succeeded. Independent of
   * `protocolVerified`; false means "documented or mocked, never called live".
   */
  readonly liveVerified?: boolean;
  /** When true create() refuses to submit anything (guard). */
  readonly blockRealSubmit?: boolean;
  /** Volcengine Ark TTS tunables (voice async API). */
  readonly tts?: TtsProfile;
}

export interface SynthMediaConfig {
  readonly outputDir: string;
  readonly backends: Readonly<Record<string, BackendConfig>>;
  readonly defaultTimeoutMs: number;
}

export const OUTPUT_DIR_ENV = 'SYNTHMEDIA_OUTPUT_DIR';

/** Environment variable names documented in the README (names only). */
export const ENV_DOC = {
  zgciApiKey: 'SYNTHMEDIA_ZGCI_API_KEY',
  bzaApiKey: 'SYNTHMEDIA_BZA_API_KEY',
  bzaBaseUrl: 'SYNTHMEDIA_BZA_BASE_URL',
  minimaxApiKey: 'MINIMAX_API_KEY',
  minimaxApiKeyEnv: 'SYNTHMEDIA_MINIMAX_API_KEY_ENV',
  minimaxBaseUrl: 'SYNTHMEDIA_MINIMAX_BASE_URL',
  minimaxModels: 'SYNTHMEDIA_MINIMAX_MODELS',
  minimaxModel: 'SYNTHMEDIA_MINIMAX_MODEL',
  minimaxRelayApiKey: 'SYNTHMEDIA_MINIMAX_RELAY_API_KEY',
  minimaxRelayBaseUrl: 'SYNTHMEDIA_MINIMAX_RELAY_BASE_URL',
  dashscopeApiKey: 'SYNTHMEDIA_DASHSCOPE_API_KEY',
  dashscopeApiKeyEnv: 'SYNTHMEDIA_DASHSCOPE_API_KEY_ENV',
  dashscopeBaseUrl: 'SYNTHMEDIA_DASHSCOPE_BASE_URL',
  dashscopeVideoModels: 'SYNTHMEDIA_DASHSCOPE_VIDEO_MODELS',
  dashscopeVideoModel: 'SYNTHMEDIA_DASHSCOPE_VIDEO_MODEL',
  dashscopeImageModels: 'SYNTHMEDIA_DASHSCOPE_IMAGE_MODELS',
  dashscopeImageModel: 'SYNTHMEDIA_DASHSCOPE_IMAGE_MODEL',
  geminiApiKey: 'SYNTHMEDIA_GEMINI_API_KEY',
  geminiApiKeyEnv: 'SYNTHMEDIA_GEMINI_API_KEY_ENV',
  geminiBaseUrl: 'SYNTHMEDIA_GEMINI_BASE_URL',
  geminiImageModels: 'SYNTHMEDIA_GEMINI_IMAGE_MODELS',
  geminiImageModel: 'SYNTHMEDIA_GEMINI_IMAGE_MODEL',
  geminiVideoModels: 'SYNTHMEDIA_GEMINI_VIDEO_MODELS',
  geminiVideoModel: 'SYNTHMEDIA_GEMINI_VIDEO_MODEL',
  openaiApiKey: 'SYNTHMEDIA_OPENAI_API_KEY',
  openaiApiKeyEnv: 'SYNTHMEDIA_OPENAI_API_KEY_ENV',
  openaiBaseUrl: 'SYNTHMEDIA_OPENAI_BASE_URL',
  openaiImageModels: 'SYNTHMEDIA_OPENAI_IMAGE_MODELS',
  openaiImageModel: 'SYNTHMEDIA_OPENAI_IMAGE_MODEL',
  localH3Auth: 'SYNTHMEDIA_LOCAL_H3_AUTH',
  localH3BaseUrl: 'SYNTHMEDIA_LOCAL_H3_BASE_URL',
  localH3SidecarBaseUrl: 'SYNTHMEDIA_LOCAL_H3_SIDECAR_BASE_URL',
  outputDir: OUTPUT_DIR_ENV,
} as const;

function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : dflt;
}

function str(v: unknown, dflt: string): string {
  return typeof v === 'string' && v.length > 0 ? v : dflt;
}

function csvModels(value: string | undefined, dflt: string[]): string[] {
  if (!value) return dflt;
  const parsed = value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : dflt;
}

function normalizeBase(v: unknown, id: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new SynthError('E_CONFIG', `backend '${id}': baseUrl is required`, 'config');
  }
  if (!/^https?:\/\//.test(v)) {
    throw new SynthError('E_CONFIG', `backend '${id}': baseUrl must be http(s)`, 'config');
  }
  return v.replace(/\/+$/, '');
}

/**
 * Normalise a configured protocol id. Accepts the canonical ids plus the
 * legacy spellings used by earlier versions (`ark`, `task-api`,
 * `openai-compatible`). Unknown ids are a hard configuration error — never a
 * silent guess.
 */
export function normalizeProtocol(value: unknown, id = 'config'): ProtocolKind {
  if (typeof value === 'string') {
    if ((PROTOCOLS as readonly string[]).includes(value)) return value as ProtocolKind;
    const alias = LEGACY_PROTOCOL_ALIASES[value];
    if (alias) return alias;
  }
  throw new SynthError(
    'E_CONFIG',
    `backend '${id}': unknown protocol '${String(value)}'; supported: ${PROTOCOLS.join(', ')}`,
    'config',
  );
}

/**
 * Default ProviderProfiles. Every value is an example that a user overrides
 * through config/env — nothing here is required by the protocol adapters.
 */
export function defaultConfig(overrides: Record<string, unknown> = {}): SynthMediaConfig {
  const raw = overrides.backends as Record<string, Record<string, unknown>> | undefined;

  const seedanceModels = csvModels(
    process.env['SYNTHMEDIA_BZA_SEEDANCE_MODELS'],
    presetModels(PROTOCOL_ARK, 'video'),
  );
  const seedreamModels = csvModels(
    process.env['SYNTHMEDIA_BZA_SEEDREAM_MODELS'],
    presetModels(PROTOCOL_ARK, 'image'),
  );
  const ttsModels = csvModels(
    process.env['SYNTHMEDIA_BZA_TTS_MODELS'],
    presetModels(PROTOCOL_ARK, 'audio'),
  );
  const minimaxModels = csvModels(
    process.env[ENV_DOC.minimaxModels],
    presetModels(PROTOCOL_MINIMAX_VIDEO, 'video'),
  );
  const dashVideoModels = csvModels(
    process.env[ENV_DOC.dashscopeVideoModels],
    presetModels(PROTOCOL_DASHSCOPE_WAN, 'video'),
  );
  const dashImageModels = csvModels(
    process.env[ENV_DOC.dashscopeImageModels],
    presetModels(PROTOCOL_DASHSCOPE_WAN, 'image'),
  );
  const geminiImageModels = csvModels(
    process.env[ENV_DOC.geminiImageModels],
    presetModels(PROTOCOL_GOOGLE_GENMEDIA, 'image'),
  );
  const geminiVideoModels = csvModels(
    process.env[ENV_DOC.geminiVideoModels],
    presetModels(PROTOCOL_GOOGLE_GENMEDIA, 'video'),
  );
  const openaiImageModels = csvModels(
    process.env[ENV_DOC.openaiImageModels],
    presetModels(PROTOCOL_OPENAI_IMAGES, 'image'),
  );

  const backends: Record<string, BackendConfig> = {
    'local-h3': {
      id: 'local-h3',
      protocol: PROTOCOL_VIDEOGEN,
      model: 'minimax-h3',
      models: ['minimax-h3'],
      modalities: ['video'],
      baseUrl: normalizeBase(
        process.env[ENV_DOC.localH3BaseUrl] ?? 'http://127.0.0.1:8791',
        'local-h3',
      ),
      authEnv: ENV_DOC.localH3Auth,
      authStyle: 'basic',
      online: false,
      protocolVerified: true, // verified against PhotoStory utils/videogen.py
      liveVerified: false, // no instance deployed here; mock contract tests only
      timeoutMs: 1_800_000,
      pollIntervalMs: 10_000,
      paths: {
        submit: '/v1/videogen',
        status: '/v1/videogen/{id}',
        content: '/v1/videogen/{id}/content',
        cancel: '/v1/videogen/{id}/cancel',
      },
      ...(raw?.['local-h3'] ?? {}),
    },
    'local-h3-sidecar': {
      id: 'local-h3-sidecar',
      protocol: PROTOCOL_OPENAI_VIDEO,
      model: str(process.env['SYNTHMEDIA_LOCAL_H3_SIDECAR_MODEL'], 'minimax-h3'),
      models: [str(process.env['SYNTHMEDIA_LOCAL_H3_SIDECAR_MODEL'], 'minimax-h3')],
      modalities: ['video'],
      baseUrl: normalizeBase(
        process.env[ENV_DOC.localH3SidecarBaseUrl] ?? 'http://127.0.0.1:8000',
        'local-h3-sidecar',
      ),
      authEnv: ENV_DOC.localH3Auth,
      authStyle: 'none',
      online: false,
      protocolVerified: true, // official vLLM-Omni videos_api.md shape
      liveVerified: false, // never deployed here; mock contract tests only
      timeoutMs: 1_800_000,
      pollIntervalMs: 5_000,
      submitEncoding: 'multipart',
      cancelMethod: 'DELETE',
      syncEndpoint: '/v1/videos/sync',
      paths: {
        submit: '/v1/videos',
        status: '/v1/videos/{id}',
        content: '/v1/videos/{id}/content',
        cancel: '/v1/videos/{id}',
      },
      ...(raw?.['local-h3-sidecar'] ?? {}),
    },
    'zgci-h3': {
      id: 'zgci-h3',
      protocol: PROTOCOL_OPENAI_VIDEO,
      model: 'minimax-h3',
      models: ['minimax-h3'],
      modalities: ['video'],
      baseUrl: normalizeBase(process.env['SYNTHMEDIA_ZGCI_BASE_URL'] ?? 'https://hub.zgci.org', 'zgci-h3'),
      authEnv: process.env['SYNTHMEDIA_ZGCI_API_KEY_ENV'] ?? ENV_DOC.zgciApiKey,
      authStyle: 'bearer',
      online: true,
      // 60 min (not 10): the one authorized real run queued for ~29.6 min with
      // progress stuck at 0 the whole time before generation even started, so a
      // 10-minute cap aborted healthy tasks. This matches the validation
      // script's WAIT_CAP_MS. Keep it in this range for real hub use.
      timeoutMs: 3_600_000,
      pollIntervalMs: 5_000,
      secondsAsString: true,
      // OpenAI Sora video task shape verified from PhotoStory
      // backend/scripts/verify_ai_models.py L184-235 (hub.zgci.org), and ONE
      // authorized live task really completed (see README live record).
      protocolVerified: true,
      liveVerified: true,
      paths: {
        submit: '/v1/videos',
        status: '/v1/videos/{id}',
        content: '/v1/videos/{id}/content',
      },
      ...(raw?.['zgci-h3'] ?? {}),
    },
    // ---- MiniMax official video V2 (H3) preset. The protocol shape below is
    // taken from the OFFICIAL docs (platform.minimax.io): POST
    // /v2/video_generation → {task_id}; GET /v2/query/video_generation/{id} →
    // {task:{status,content:{url},error}}; DELETE /v2/video_generation/{id}
    // cancels a queued task. Documented ⇒ protocolVerified=true, but this
    // profile has NEVER been called for real ⇒ liveVerified=false (mock-only).
    // The credential is referenced by NAME (MINIMAX_API_KEY) and never read
    // here. Override baseUrl/model/paths/queryParams for any MiniMax-compatible
    // relay — no source change needed.
    'minimax-official': {
      id: 'minimax-official',
      protocol: PROTOCOL_MINIMAX_VIDEO,
      model: process.env[ENV_DOC.minimaxModel] ?? minimaxModels[0]!,
      models: minimaxModels,
      modalities: ['video'],
      baseUrl: normalizeBase(process.env[ENV_DOC.minimaxBaseUrl] ?? 'https://api.minimax.io', 'minimax-official'),
      authEnv: process.env[ENV_DOC.minimaxApiKeyEnv] ?? ENV_DOC.minimaxApiKey,
      authStyle: 'bearer',
      online: true,
      timeoutMs: 1_800_000,
      pollIntervalMs: 5_000,
      protocolVerified: true,
      liveVerified: false,
      paths: {
        submit: '/v2/video_generation',
        status: '/v2/query/video_generation/{id}',
        cancel: '/v2/video_generation/{id}',
      },
      ...(raw?.['minimax-official'] ?? {}),
    },
    // Third-party relay speaking the same MiniMax V2 shape. Its paths/base URL
    // are NOT confirmed, so it stays blocked (real submission refused) until
    // an operator verifies it and flips protocolVerified explicitly.
    'minimax-relay': {
      id: 'minimax-relay',
      protocol: PROTOCOL_MINIMAX_VIDEO,
      model: process.env[ENV_DOC.minimaxModel] ?? minimaxModels[0]!,
      models: minimaxModels,
      modalities: ['video'],
      baseUrl: normalizeBase(
        process.env[ENV_DOC.minimaxRelayBaseUrl] ?? 'https://minimax-relay.invalid',
        'minimax-relay',
      ),
      authEnv: process.env['SYNTHMEDIA_MINIMAX_RELAY_API_KEY_ENV'] ?? ENV_DOC.minimaxRelayApiKey,
      authStyle: 'bearer',
      online: true,
      timeoutMs: 1_800_000,
      pollIntervalMs: 5_000,
      protocolVerified: false,
      liveVerified: false,
      blockRealSubmit: true,
      paths: {
        submit: '/v2/video_generation',
        status: '/v2/query/video_generation/{id}',
        cancel: '/v2/video_generation/{id}',
      },
      ...(raw?.['minimax-relay'] ?? {}),
    },

    // ---- Volcengine Ark presets (bza Coding Plan is ONE deployment of the
    // protocol, not the reason the adapter exists). Model ids come from the
    // official docs / the user's bza plan; used verbatim.
    'bza-seedance': {
      id: 'bza-seedance',
      protocol: PROTOCOL_ARK,
      model: process.env['SYNTHMEDIA_BZA_SEEDANCE_MODEL'] ?? seedanceModels[0]!,
      models: seedanceModels,
      modalities: ['video'],
      baseUrl: normalizeBase(process.env[ENV_DOC.bzaBaseUrl] ?? 'https://llm.inner.bza.edu.cn/plan/v3', 'bza-seedance'),
      authEnv: process.env['SYNTHMEDIA_BZA_API_KEY_ENV'] ?? ENV_DOC.bzaApiKey,
      authStyle: 'bearer',
      online: true,
      timeoutMs: 1_800_000,
      pollIntervalMs: 10_000,
      protocolVerified: false,
      liveVerified: false,
      paths: {
        submit: process.env['SYNTHMEDIA_BZA_VIDEO_SUBMIT_PATH'] ?? '/contents/generations/tasks',
        status: process.env['SYNTHMEDIA_BZA_VIDEO_STATUS_PATH'] ?? '/contents/generations/tasks/{id}',
        content: '/contents/generations/tasks/{id}', // unused: content comes via content.video_url
        cancel: process.env['SYNTHMEDIA_BZA_VIDEO_CANCEL_PATH'] ?? '/contents/generations/tasks/{id}',
      },
      ...(raw?.['bza-seedance'] ?? {}),
    },
    'bza-seedream': {
      id: 'bza-seedream',
      protocol: PROTOCOL_ARK,
      model: process.env['SYNTHMEDIA_BZA_SEEDREAM_MODEL'] ?? seedreamModels[0]!,
      models: seedreamModels,
      modalities: ['image'],
      baseUrl: normalizeBase(process.env[ENV_DOC.bzaBaseUrl] ?? 'https://llm.inner.bza.edu.cn/plan/v3', 'bza-seedream'),
      authEnv: process.env['SYNTHMEDIA_BZA_API_KEY_ENV'] ?? ENV_DOC.bzaApiKey,
      authStyle: 'bearer',
      online: true,
      timeoutMs: 300_000,
      protocolVerified: false,
      liveVerified: false,
      paths: {
        submit: process.env['SYNTHMEDIA_BZA_IMAGE_SUBMIT_PATH'] ?? '/images/generations',
        status: '/images/generations/{id}', // unused for the sync image API
        content: '/images/generations/{id}', // unused
      },
      ...(raw?.['bza-seedream'] ?? {}),
    },
    // Seed TTS: official Doubao voice async protocol (submit → query →
    // audio_url). The bza relay for this surface is NOT confirmable, so the
    // preset keeps protocolVerified=false and real submission is blocked until
    // an operator verifies the relay and sets protocolVerified:true.
    'bza-seed-tts': {
      id: 'bza-seed-tts',
      protocol: PROTOCOL_ARK,
      model: process.env['SYNTHMEDIA_BZA_TTS_MODEL'] ?? ttsModels[0]!,
      models: ttsModels,
      modalities: ['audio'],
      baseUrl: normalizeBase(process.env[ENV_DOC.bzaBaseUrl] ?? 'https://llm.inner.bza.edu.cn/plan/v3', 'bza-seed-tts'),
      authEnv: process.env['SYNTHMEDIA_BZA_API_KEY_ENV'] ?? ENV_DOC.bzaApiKey,
      authStyle: 'raw',
      authHeader: 'X-Api-Key',
      online: true,
      timeoutMs: 300_000,
      pollIntervalMs: 5_000,
      protocolVerified: false,
      liveVerified: false,
      blockRealSubmit: true,
      paths: {
        submit: process.env['SYNTHMEDIA_BZA_TTS_SUBMIT_PATH'] ?? '/api/v3/tts/submit',
        status: process.env['SYNTHMEDIA_BZA_TTS_QUERY_PATH'] ?? '/api/v3/tts/query',
      },
      tts: {
        resourceId: process.env['SYNTHMEDIA_BZA_TTS_RESOURCE_ID'] ?? 'seed-tts-2.0',
        speaker: process.env['SYNTHMEDIA_BZA_TTS_SPEAKER'] ?? 'zh_female_xiaohe_uranus_bigtts',
        format: 'mp3',
        sampleRate: 24000,
        uid: 'synthmedia',
        apiKeyHeader: 'X-Api-Key',
        resourceHeader: 'X-Api-Resource-Id',
        requestIdHeader: 'X-Api-Request-Id',
      },
      ...(raw?.['bza-seed-tts'] ?? {}),
    },

    // ---- Aliyun Wanxiang (万相) presets — dashscope-wan-compatible. The
    // protocol shape below is taken from the OFFICIAL Model Studio docs
    // (help.aliyun.com, fetched 2026-11): submit with the mandatory
    // `X-DashScope-Async: enable` header, query the generic task endpoint
    // GET /api/v1/tasks/{id}, cancel POST /api/v1/tasks/{id}/cancel.
    // Documented but NEVER called here ⇒ protocolVerified=false (mock-only,
    // per the operator's brief) with blockRealSubmit as a hard belt. The
    // credential is referenced by NAME (SYNTHMEDIA_DASHSCOPE_API_KEY, or the
    // official DASHSCOPE_API_KEY via *_ENV override) and never read here.
    'dashscope-wan-video': {
      id: 'dashscope-wan-video',
      protocol: PROTOCOL_DASHSCOPE_WAN,
      model: process.env[ENV_DOC.dashscopeVideoModel] ?? dashVideoModels[0]!,
      models: dashVideoModels,
      modalities: ['video'],
      baseUrl: normalizeBase(
        process.env[ENV_DOC.dashscopeBaseUrl] ?? 'https://dashscope.aliyuncs.com',
        'dashscope-wan-video',
      ),
      authEnv: process.env[ENV_DOC.dashscopeApiKeyEnv] ?? ENV_DOC.dashscopeApiKey,
      authStyle: 'bearer',
      online: true,
      timeoutMs: 1_800_000,
      pollIntervalMs: 15_000,
      protocolVerified: false,
      liveVerified: false,
      blockRealSubmit: true,
      paths: {
        submit: '/api/v1/services/aigc/video-generation/video-synthesis',
        status: '/api/v1/tasks/{id}',
        cancel: '/api/v1/tasks/{id}/cancel',
      },
      ...(raw?.['dashscope-wan-video'] ?? {}),
    },
    'dashscope-wanx-image': {
      id: 'dashscope-wanx-image',
      protocol: PROTOCOL_DASHSCOPE_WAN,
      model: process.env[ENV_DOC.dashscopeImageModel] ?? dashImageModels[0]!,
      models: dashImageModels,
      modalities: ['image'],
      baseUrl: normalizeBase(
        process.env[ENV_DOC.dashscopeBaseUrl] ?? 'https://dashscope.aliyuncs.com',
        'dashscope-wanx-image',
      ),
      authEnv: process.env[ENV_DOC.dashscopeApiKeyEnv] ?? ENV_DOC.dashscopeApiKey,
      authStyle: 'bearer',
      online: true,
      timeoutMs: 600_000,
      pollIntervalMs: 10_000,
      protocolVerified: false,
      liveVerified: false,
      blockRealSubmit: true,
      paths: {
        submit: '/api/v1/services/aigc/text2image/image-synthesis',
        status: '/api/v1/tasks/{id}',
        cancel: '/api/v1/tasks/{id}/cancel',
      },
      ...(raw?.['dashscope-wanx-image'] ?? {}),
    },

    // ---- Google GenAI (Gemini API) presets — google-genmedia-compatible.
    // Shape per ai.google.dev/gemini-api/docs/imagen and /docs/video
    // (fetched 2026-11): auth via the `x-goog-api-key` header; Imagen
    // `:predict` is synchronous base64; Veo `:predictLongRunning` returns an
    // LRO operation polled at `{base}/v1beta/{operation-name}` and cancelled
    // with `:cancel`. All mock-only (protocolVerified=false, never called).
    'gemini-imagen': {
      id: 'gemini-imagen',
      protocol: PROTOCOL_GOOGLE_GENMEDIA,
      model: process.env[ENV_DOC.geminiImageModel] ?? geminiImageModels[0]!,
      models: geminiImageModels,
      modalities: ['image'],
      baseUrl: normalizeBase(process.env[ENV_DOC.geminiBaseUrl] ?? 'https://generativelanguage.googleapis.com', 'gemini-imagen'),
      authEnv: process.env[ENV_DOC.geminiApiKeyEnv] ?? ENV_DOC.geminiApiKey,
      authStyle: 'raw',
      authHeader: 'x-goog-api-key',
      online: true,
      timeoutMs: 300_000,
      protocolVerified: false,
      liveVerified: false,
      blockRealSubmit: true,
      paths: {
        submit: '/v1beta/models/{model}:predict',
        status: '/v1beta', // unused for sync predict; operation prefix if reused
      },
      ...(raw?.['gemini-imagen'] ?? {}),
    },
    'gemini-veo': {
      id: 'gemini-veo',
      protocol: PROTOCOL_GOOGLE_GENMEDIA,
      model: process.env[ENV_DOC.geminiVideoModel] ?? geminiVideoModels[0]!,
      models: geminiVideoModels,
      modalities: ['video'],
      baseUrl: normalizeBase(process.env[ENV_DOC.geminiBaseUrl] ?? 'https://generativelanguage.googleapis.com', 'gemini-veo'),
      authEnv: process.env[ENV_DOC.geminiApiKeyEnv] ?? ENV_DOC.geminiApiKey,
      authStyle: 'raw',
      authHeader: 'x-goog-api-key',
      online: true,
      timeoutMs: 1_800_000,
      pollIntervalMs: 10_000,
      protocolVerified: false,
      liveVerified: false,
      blockRealSubmit: true,
      paths: {
        submit: '/v1beta/models/{model}:predictLongRunning',
        status: '/v1beta', // prefix: operation GET = {base}/v1beta/{operation-name}
        cancel: '{op}:cancel', // reserved; adapter appends :cancel to the op URL
      },
      ...(raw?.['gemini-veo'] ?? {}),
    },

    // ---- OpenAI media presets. Image: synchronous images API (gpt-image-1
    // returns b64_json). (The former `openai-video` Sora preset profile was
    // removed — the official Sora Videos API was shut down by OpenAI on
    // 2026-09-24. The `openai-video-compatible` adapter itself remains in
    // service for third-party compatible gateways, e.g. zgci-h3 and
    // local-h3-sidecar.)
    'openai-images': {
      id: 'openai-images',
      protocol: PROTOCOL_OPENAI_IMAGES,
      model: process.env[ENV_DOC.openaiImageModel] ?? openaiImageModels[0]!,
      models: openaiImageModels,
      modalities: ['image'],
      baseUrl: normalizeBase(process.env[ENV_DOC.openaiBaseUrl] ?? 'https://api.openai.com', 'openai-images'),
      authEnv: process.env[ENV_DOC.openaiApiKeyEnv] ?? ENV_DOC.openaiApiKey,
      authStyle: 'bearer',
      online: true,
      timeoutMs: 300_000,
      protocolVerified: false,
      liveVerified: false,
      blockRealSubmit: true,
      paths: {
        submit: '/v1/images/generations',
        status: '/v1/images/generations', // unused: synchronous surface
      },
      ...(raw?.['openai-images'] ?? {}),
    },
  };

  for (const [key, patch] of Object.entries(raw ?? {})) {
    if (!backends[key]) {
      // Custom profile supplied by configuration (alternative gateway /
      // self-hosted endpoint). Protocol defaults to the OpenAI video-task
      // shape because that is the only one with a safe generic default.
      const p = patch as Record<string, unknown>;
      const protocol = normalizeProtocol(p['protocol'] ?? p['kind'] ?? PROTOCOL_OPENAI_VIDEO, key);
      const model = str(p['model'], 'default');
      const models = Array.isArray(p['models']) ? (p['models'] as string[]) : [model];
      // Storage-compat fallback: when the patch names no protocol of its own
      // (i.e. it relied on a preset that no longer exists — e.g. the removed
      // `openai-video` Sora profile), auto-fill the canonical task-protocol
      // paths so a legacy stored reference degrades to a working custom
      // profile instead of failing config validation. Patches that declare
      // `protocol` explicitly keep strict validation (paths still required).
      const legacyProtocolRef = p['protocol'] === undefined && p['kind'] === undefined;
      const legacyPaths = legacyProtocolRef && protocol === PROTOCOL_OPENAI_VIDEO
        ? {
            submit: '/v1/videos',
            status: '/v1/videos/{id}',
            content: '/v1/videos/{id}/content',
            cancel: '/v1/videos/{id}',
          }
        : undefined;
      const base: BackendConfig = {
        id: key,
        protocol,
        model,
        models,
        modalities: ['video'],
        baseUrl: 'http://127.0.0.1',
        authStyle: 'none',
        online: true,
        timeoutMs: 600_000,
        ...p,
        ...(legacyPaths && !p['paths'] ? { paths: legacyPaths } : {}),
      } as BackendConfig;
      backends[key] = base;
    }
  }

  // A profile may carry the legacy `kind` field in an override; fold it into
  // the canonical protocol (explicit `protocol` wins). A model override
  // without an explicit model list makes that model the whole routable list.
  for (const [key, b] of Object.entries(backends)) {
    const patch = raw?.[key] as Record<string, unknown> | undefined;
    if (!patch) continue;
    let next = b;
    if (patch['kind'] !== undefined && patch['protocol'] === undefined) {
      next = { ...next, protocol: normalizeProtocol(patch['kind'], key) };
    }
    if (typeof patch['model'] === 'string' && patch['models'] === undefined) {
      next = { ...next, models: [patch['model'] as string] };
    }
    // Profile spelling aliases: baseURL → baseUrl, apiKeyEnv → authEnv.
    if (typeof patch['baseURL'] === 'string' && patch['baseUrl'] === undefined) {
      next = { ...next, baseUrl: normalizeBase(patch['baseURL'], key) };
    }
    if (typeof patch['apiKeyEnv'] === 'string' && patch['authEnv'] === undefined) {
      next = { ...next, authEnv: patch['apiKeyEnv'] };
    }
    backends[key] = next;
  }

  for (const b of Object.values(backends)) {
    validateBackend(b);
  }
  return {
    outputDir: str(overrides.outputDir, str(process.env[OUTPUT_DIR_ENV], 'synthmedia-output')),
    backends,
    defaultTimeoutMs: num(overrides.defaultTimeoutMs, 1_800_000),
  };
}

/** Validate one profile; throws SynthError('E_CONFIG') on problems. */
export function validateBackend(b: BackendConfig): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(b.id)) {
    throw new SynthError('E_CONFIG', `invalid backend id '${b.id}'`, 'config');
  }
  if (!(PROTOCOLS as readonly string[]).includes(b.protocol)) {
    throw new SynthError('E_CONFIG', `backend '${b.id}': unknown protocol '${String(b.protocol)}'`, 'config');
  }
  if (!/^https?:\/\//.test(b.baseUrl)) {
    throw new SynthError('E_CONFIG', `backend '${b.id}': baseUrl must be http(s)`, b.id);
  }
  if (b.models && b.models.length > 0 && !b.models.includes(b.model)) {
    throw new SynthError(
      'E_CONFIG',
      `backend '${b.id}': default model '${b.model}' must appear in models [${b.models.join(', ')}]`,
      b.id,
    );
  }
  switch (b.protocol) {
    case 'openai-video-compatible':
    case 'videogen-task-api':
      if (!b.paths?.submit || !b.paths.status || !b.paths.content) {
        throw new SynthError('E_CONFIG', `backend '${b.id}': ${b.protocol} requires paths.submit/status/content`, b.id);
      }
      for (const p of [b.paths.status, b.paths.content]) {
        if (!p.includes('{id}')) {
          throw new SynthError('E_CONFIG', `backend '${b.id}': task path '${p}' must contain {id}`, b.id);
        }
      }
      break;
    case 'volcengine-ark-compatible':
      if (!b.paths?.submit) {
        throw new SynthError('E_CONFIG', `backend '${b.id}': ark requires paths.submit`, b.id);
      }
      // Video is a task API (poll + cancel); image is sync; TTS is submit+query.
      if (b.modalities.includes('video')) {
        if (!b.paths.status?.includes('{id}') || !b.paths.cancel?.includes('{id}')) {
          throw new SynthError('E_CONFIG', `backend '${b.id}': ark video requires {id} status/cancel paths`, b.id);
        }
      }
      if (b.modalities.includes('audio') && !b.paths.status) {
        throw new SynthError('E_CONFIG', `backend '${b.id}': ark audio requires a status (query) path`, b.id);
      }
      break;
    case 'minimax-video-compatible':
      if (!b.paths?.submit || !b.paths.status || !b.paths.cancel) {
        throw new SynthError(
          'E_CONFIG',
          `backend '${b.id}': minimax-video-compatible requires paths.submit/status/cancel`,
          b.id,
        );
      }
      for (const p of [b.paths.status, b.paths.cancel]) {
        if (!p.includes('{id}')) {
          throw new SynthError('E_CONFIG', `backend '${b.id}': task path '${p}' must contain {id}`, b.id);
        }
      }
      break;
    case 'openai-chat-compatible':
      if (!/^https?:\/\//.test(b.baseUrl)) {
        throw new SynthError('E_CONFIG', `backend '${b.id}': baseUrl must be http(s)`, b.id);
      }
      break;
    case 'dashscope-wan-compatible': {
      if (!b.paths?.submit || !b.paths.status) {
        throw new SynthError('E_CONFIG', `backend '${b.id}': dashscope-wan-compatible requires paths.submit/status`, b.id);
      }
      if (!b.paths.status.includes('{id}')) {
        throw new SynthError('E_CONFIG', `backend '${b.id}': task path '${b.paths.status}' must contain {id}`, b.id);
      }
      // Video tasks support remote cancel (PENDING only); image tasks reuse
      // the same endpoint, so cancel is required whenever configured.
      if (b.paths.cancel && !b.paths.cancel.includes('{id}')) {
        throw new SynthError('E_CONFIG', `backend '${b.id}': task path '${b.paths.cancel}' must contain {id}`, b.id);
      }
      break;
    }
    case 'google-genmedia-compatible':
      if (!b.paths?.submit || !b.paths.submit.includes('{model}')) {
        throw new SynthError('E_CONFIG', `backend '${b.id}': google-genmedia-compatible requires paths.submit containing {model}`, b.id);
      }
      break;
    case 'openai-images-compatible':
      if (!b.paths?.submit) {
        throw new SynthError('E_CONFIG', `backend '${b.id}': openai-images-compatible requires paths.submit`, b.id);
      }
      break;
    default:
      throw new SynthError('E_CONFIG', `backend '${b.id}': unhandled protocol`, b.id);
  }
  if (b.authStyle !== 'none' && !b.authEnv && !b.credentialRef) {
    throw new SynthError('E_CONFIG', `backend '${b.id}': authStyle '${b.authStyle}' requires authEnv or credentialRef`, b.id);
  }
  if (b.modalities.length === 0) {
    throw new SynthError('E_CONFIG', `backend '${b.id}': at least one modality required`, b.id);
  }
}

/** Resolve config with overrides; used by apply() and tests. */
export function resolveConfig(config: Record<string, unknown> = {}): SynthMediaConfig {
  return defaultConfig(config);
}
