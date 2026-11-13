# dsh-synthmedia

Provider-agnostic **media generation for DSH agents**, built on three decoupled
layers so any compatible gateway can be added **by configuration only**:

| Layer | File(s) | What it owns | What it must NOT contain |
|---|---|---|---|
| **ProtocolAdapter** | `src/backends/*.ts` | the wire protocol only | provider ids, base URLs, credentials |
| **ProviderProfile** | `src/config.ts`, `BackendConfig` | id, protocol, baseURL, credential **reference**, path mapping, timeouts, static defaults | protocol logic, secrets |
| **ModelCapability** | `src/presets.ts`, `ModelCapabilitySpec` | modality, duration/size/format limits, the protocol a model speaks | URLs, credentials, provider ids |

Every job lands in a unified async `JobManager` (persisted records + artifacts on
disk, progress, cancel, timeout, sanitized errors) and, when the deployment
provides the DSH jobs service (`ctx.get('jobs')`, late-bound via
`ctx.inject(['jobs'], …)`), is also registered in the **DSH Jobs UI** (kind
`synthmedia`, owner = initiating agent session, live progress, mapped terminal
outcome). Five agent tools are exposed:
`synthmedia_capabilities` / `generate` / `status` / `wait` / `cancel`.

## Protocols

| Protocol id | Adapter | Official shape | Default presets |
|---|---|---|---|
| `volcengine-ark-compatible` | `backends/ark.ts` | Video: `POST/GET/DELETE /contents/generations/tasks` ([create](https://ark.volcengine.com/region:cn-beijing/docs/create-video-generation-task-api), [get](https://ark.volcengine.com/region:cn-beijing/docs/get-video-generation-task-api), [cancel/delete](https://ark.volcengine.com/region:cn-beijing/docs/cancel-or-delete-video-generation-tasks-api)); the create body has **no pixel `size` field** — a tool-level `size` is mapped to `resolution` + `ratio` (or rejected with `E_SIZE` before any request); Image: `POST /images/generations` ([image API](https://ark.volcengine.com/region:cn-beijing/docs/image-generation-api)); TTS: Doubao voice async `POST /api/v3/tts/submit` → `POST /api/v3/tts/query` → `audio_url` ([submit](https://docs.volcengine.com/docs/doubao-voice/task-sub-mission?lang=zh), [query](https://docs.volcengine.com/docs/doubao-voice/result-query?lang=zh)) | `bza-seedance`, `bza-seedream`, `bza-seed-tts` |
| `openai-video-compatible` | `backends/task-api.ts` | OpenAI-style task API: JSON/multipart `POST /v1/videos` (accepts 200 **and** 201) → `GET /v1/videos/{id}` (`queued`/`in_progress`/`completed`/`failed` + `progress`) → `GET /v1/videos/{id}/content`; `DELETE` cancels; optional synchronous `POST /v1/videos/sync`. **Note:** the official OpenAI Sora 2 models and Videos API were shut down on **2026-09-24** ([guide](https://developers.openai.com/api/docs/guides/video-generation), [deprecations](https://developers.openai.com/api/docs/deprecations)); the former `openai-video` preset profile was removed, but the adapter itself remains in service for third-party compatible gateways | `zgci-h3`, `local-h3-sidecar`, user-defined compatible gateways |
| `minimax-video-compatible` | `backends/minimax.ts` | MiniMax **official Video V2 (MiniMax-H3)** async task API — [create](https://platform.minimax.io/docs/api-reference/video-generation-v2-create), [query](https://platform.minimax.io/docs/api-reference/video-generation-v2-query), [cancel/delete](https://platform.minimax.io/docs/api-reference/video-generation-v2-delete): `POST /v2/video_generation` (`{model, content:[{type:'text',text}], resolution, duration, ratio}` → `{task_id}`) → `GET /v2/query/video_generation/{task_id}` (`{task:{status, content:{url}, error, created_at, updated_at}}`) → `DELETE /v2/video_generation/{task_id}`; output is a signed `task.content.url`. **Not** the Sora `/v1/videos` shape, so it has its own protocol adapter (no provider branch) | `minimax-official`, `minimax-relay` (blocked) |
| `videogen-task-api` | `backends/task-api.ts` | Intranet videogen: `POST /v1/videogen` → status → content (Basic auth) — mirrors PhotoStory `utils/videogen.py` | `local-h3` |
| `openai-chat-compatible` | `backends/openai-compatible.ts` | `POST /chat/completions` — **text only**, no default profile uses it | — |
| `dashscope-wan-compatible` | `backends/dashscope.ts` | Aliyun Model Studio (百炼/DashScope) async task surface, shared by wan2.x **video** and wanx2.1 **image**: submit (`POST /api/v1/services/aigc/video-generation/video-synthesis` / `.../text2image/image-synthesis`) with the mandatory `X-DashScope-Async: enable` header → generic task query `GET /api/v1/tasks/{task_id}` (`output.task_status` PENDING/RUNNING/SUCCEEDED/FAILED/CANCELED/UNKNOWN; artifacts under `output.video_url` / `output.results[].url`) → cancel `POST /api/v1/tasks/{task_id}/cancel` (PENDING only). Docs: [wan t2v](https://help.aliyun.com/zh/model-studio/legacy-wan-text-to-video-api-reference), [wanx t2i V2](https://help.aliyun.com/zh/model-studio/text-to-image-v2-api-reference), [async task mgmt](https://help.aliyun.com/zh/model-studio/manage-asynchronous-tasks) | `dashscope-wan-video`, `dashscope-wanx-image` |
| `google-genmedia-compatible` | `backends/gemini.ts` | Google GenAI media on `generativelanguage.googleapis.com`, `x-goog-api-key` auth: Imagen `POST /v1beta/models/{model}:predict` (sync, `predictions[].bytesBase64Encoded`) and Veo `POST /v1beta/models/{model}:predictLongRunning` → LRO operation polled at `GET /v1beta/{operation-name}` until `done` (`response.generateVideoResponse.generatedSamples[].video.uri`, or `error` / `raiMediaFilteredReasons`), cancel `POST ...:cancel`. Docs: [Imagen](https://ai.google.dev/gemini-api/docs/imagen), [Veo](https://ai.google.dev/gemini-api/docs/video) | `gemini-imagen`, `gemini-veo` |
| `openai-images-compatible` | `backends/openai-images.ts` | OpenAI synchronous images API: `POST /v1/images/generations` → `{created, data:[{b64_json\|url}]}`; GPT image models return `b64_json` by default and do not accept `response_format`. Docs: [guide](https://developers.openai.com/api/docs/guides/image-generation), [reference](https://developers.openai.com/api/reference/resources/images/methods/generate) | `openai-images` |

Legacy `kind` spellings (`ark`, `task-api`, `openai-compatible`) are accepted and
normalised; an unknown protocol is a hard `E_CONFIG` error, never a silent guess.

Routing invariant: **one job is pinned to one profile.** There is no fallback
path — an offline profile failure is an `E_OFFLINE_UNAVAILABLE` error and nothing
is forwarded to a cloud profile.

## Model presets (all overridable)

| Model id | Modality | Limits |
|---|---|---|
| `doubao-seedance-2.0` | video | ≤ 15 s, `720p`/`1080p`, ratio `16:9`/`4:3`/`1:1`/`3:4`/`9:16`/`21:9`/`adaptive` (1080p+ is 10-bit H.265) |
| `doubao-seedance-2.0-fast` | video | ≤ 15 s, `720p`, same ratio set |
| `doubao-seedance-2.0-mini` | video | ≤ 10 s, `720p`, same ratio set |
| `doubao-seedance-2.5` | video | 2–30 s, `480p`/`720p`/`1080p`, same ratio set, optional audio |
| `doubao-seedream-5.0-flash` | image | 2K, png/jpeg, url or b64_json |
| `doubao-seedream-5.0-pro` | image | 2K/4K, png/jpeg |
| `doubao-seed-tts-2.0` | audio | mp3 / pcm / ogg_opus, 24 kHz default |
| `MiniMax-H3` | video | official MiniMax V2: `768P`/`2K`, 4–15 s, ratios `21:9`/`16:9`/`4:3`/`1:1`/`3:4`/`9:16` (plus `adaptive` for image/reference input) |
| `MiniMax-H3-Highspeed` | video | `480P`/`768P` (no 2K), 4–15 s, same ratio set incl. `adaptive` |
| `MiniMax-H3-Lite` | video | `480P`/`768P` (no 2K), 4–15 s, **no `adaptive`** |
| `MiniMax-H3-Max` | video | `480P`/`768P` (no 2K), **5–15 s** (4 s unsupported), incl. `adaptive`, `extra.prompt_expansion_mode` |
| `wan2.6-t2v` | video | DashScope: 2–15 s (default 5), 720P/1080P `W*H` sizes, optional `audio_url` / auto audio |
| `wan2.5-t2v-preview` | video | DashScope: 5/10 s, 480P/720P/1080P sizes, audio |
| `wan2.2-t2v-plus` | video | DashScope: fixed 5 s, 480P/1080P sizes, silent video |
| `wanx2.1-t2v-turbo` / `wanx2.1-t2v-plus` | video | DashScope: fixed 5 s, 480P/720P (`-turbo`) or 720P (`-plus`), silent video |
| `wanx2.1-t2i-turbo` / `wanx2.1-t2i-plus` | image | DashScope async t2i task, `W*H` sizes (e.g. `1024*1024`), `output.results[].url` |
| `imagen-4.0-generate-001` / `-fast-` | image | Gemini `:predict`, sync base64, sizes `1024x1024`/`1024x1408`/`1408x1024` |
| `veo-3.1-generate-preview` / `-fast-` | video | Gemini `:predictLongRunning`, 8 s clips with audio, 720p/1080p, LRO operation polling |
| `gpt-image-1` / `gpt-image-1-mini` | image | OpenAI images API, sync `b64_json`, sizes `1024x1024`/`1024x1536`/`1536x1024`/`auto` |

(The former `sora-2` / `sora-2-pro` video presets were removed: the official
OpenAI Sora Videos API was shut down on 2026-09-24.)

Ark's video task API has **no pixel `size` field** (unlike its image API). A
tool-level `size` is therefore translated onto the official `resolution` +
`ratio` fields: either a resolution token (`480p` / `720p` / `1080p`) or a pixel
size whose short side is 480/720/1080 and whose aspect ratio matches a
documented ratio *by value* (e.g. `1280x720` → `720p` + `16:9`, `720x1280` →
`720p` + `9:16`, `2520x1080` → `1080p` + `21:9`). An inexpressible size (e.g.
`2560x1440`, `2048x858`, `4K`) is
an explicit `E_SIZE` failure **before any network I/O** — the tool-level size is
never silently dropped — and the model preset's declared resolutions/ratios are
enforced too.

MiniMax's official V2 API follows the same principle: it has **no pixel `size`
field**. A tool-level `size` is translated to `resolution` + `ratio`: either a
resolution token (`480P`/`768P`/`2K`, case-insensitive) or a pixel size whose
short side is exactly 480/768 and whose aspect ratio matches a documented ratio
by value (e.g. `1792x768` → `768P` + `21:9`). Anything else — `1920x1080`,
`1366x768`, `4K` — is an `E_SIZE` rejection before any network I/O. For a
text-only request `ratio` is required and cannot be `adaptive` (this plugin
uses `16:9` when the request carries no ratio); `duration` is a required integer
and each model's documented range is enforced.
The current tool surface submits **text-to-video** content items only; image /
reference inputs are a future extension, not silently accepted. `seed` and
`negative_prompt` are **not** part of the V2 schema, so they are never sent;
relay-specific fields go through the profile's `extraBody` (for example the
documented `extra.prompt_expansion_mode`).

A preset carries **capability data only**. Any deployment may replace the model
ids without touching source:

```js
apply(ctx, {
  backends: {
    'bza-seedance': { model: 'my-gateway-video-9000' },       // becomes the whole list
    'bza-seedance-2': {                                        // or an explicit list
      protocol: 'volcengine-ark-compatible',
      models: ['my-video-a', 'my-video-b'],
    },
  },
});
```

Env overrides: `SYNTHMEDIA_BZA_SEEDANCE_MODELS`, `SYNTHMEDIA_BZA_SEEDREAM_MODELS`,
`SYNTHMEDIA_BZA_TTS_MODELS` and `SYNTHMEDIA_MINIMAX_MODELS` (comma-separated), plus
the single-model variables in the table below.

## Provider profiles (bring your own gateway/URL/key name)

```js
apply(ctx, {
  outputDir: 'synthmedia-output',          // or SYNTHMEDIA_OUTPUT_DIR; config wins
  defaultTimeoutMs: 1_800_000,
  backends: {
    // Any H3 service speaking the OpenAI video-task shape:
    'my-h3': {
      protocol: 'openai-video-compatible',
      model: 'minimax-h3',
      models: ['minimax-h3'],
      modalities: ['video'],
      baseUrl: 'https://my-h3.example.net',
      authStyle: 'bearer',
      authEnv: 'MY_H3_API_KEY',            // env-var NAME, never the value
      // credentialRef: 'MY_H3_DSH_REF',  // DSH credential reference (ctx.credentials)
      paths: {
        submit: '/v1/videos',
        status: '/v1/videos/{id}',
        content: '/v1/videos/{id}/content',
      },
      pollIntervalMs: 5_000,
      timeoutMs: 900_000,
      secondsAsString: true,               // optional wire detail
      protocolVerified: true,              // REQUIRED for real submissions
    },

    // Any Volcengine-Ark-compatible relay (bza is just one deployment):
    'my-ark': {
      protocol: 'volcengine-ark-compatible',
      model: 'doubao-seedance-2.5',
      modalities: ['video'],
      baseUrl: 'https://relay.example.org/v3',
      authStyle: 'bearer',
      authEnv: 'MY_ARK_KEY',
      paths: {
        submit: '/contents/generations/tasks',
        status: '/contents/generations/tasks/{id}',
        cancel: '/contents/generations/tasks/{id}',
      },
    },

    // A MiniMax V2-compatible gateway (official api.minimax.io or a relay).
    // GroupId / tenant query params, extra headers and relay-only body fields
    // are all plain configuration — no source change, no provider branch.
    'my-minimax': {
      protocol: 'minimax-video-compatible',
      model: 'MiniMax-H3',
      models: ['MiniMax-H3', 'MiniMax-H3-Lite'],
      modalities: ['video'],
      baseUrl: 'https://api.minimax.io',      // or the relay's base URL
      authStyle: 'bearer',
      credentialRef: 'MY_MINIMAX_DSH_REF',    // or authEnv: 'MINIMAX_API_KEY'
      queryParams: { GroupId: '1234567890' }, // only if the gateway requires it
      headers: { 'X-Tenant-Id': 'tenant-a' },
      extraBody: { extra: { prompt_expansion_mode: 'quality' } },
      paths: {
        submit: '/v2/video_generation',
        status: '/v2/query/video_generation/{id}',
        cancel: '/v2/video_generation/{id}',
      },
      pollIntervalMs: 5_000,
      timeoutMs: 1_800_000,
      protocolVerified: true,                 // documented V2 wire shape
    },
  },
});
```

Profile fields: `id`, `protocol`, `baseUrl`, `authEnv` / `credentialRef`,
`authStyle` (`bearer`/`basic`/`raw`/`none`), `authHeader` (default
`Authorization`), static `headers`, static `queryParams` (e.g. a required
`GroupId` or `api-version`), `paths` (`{id}` templated), `timeoutMs`,
`pollIntervalMs`, `submitEncoding` (`json`/`multipart`), `cancelMethod`,
`secondsAsString`, `syncEndpoint`, `extraBody`, `models`, `modalities`,
`protocolVerified`, `liveVerified`, `blockRealSubmit`, and `tts` tunables.

Credentials resolve **per call** through `ctx.credentials` when the host
provides it (a DSH credential reference), with `process.env` as the documented
fallback. Values are never cached, persisted, logged or returned.

### Verification guard

Official-doc URLs for the three new ecosystems (all protocol shapes were taken
from these pages, fetched 2026-11; no account exists on this machine so every
new profile ships **mock-only**):

- Aliyun Wanxiang: [wan t2v API](https://help.aliyun.com/zh/model-studio/legacy-wan-text-to-video-api-reference) ·
  [wanx t2i V2 API](https://help.aliyun.com/zh/model-studio/text-to-image-v2-api-reference) ·
  [async task management](https://help.aliyun.com/zh/model-studio/manage-asynchronous-tasks)
- Google GenAI: [Imagen](https://ai.google.dev/gemini-api/docs/imagen) ·
  [Veo](https://ai.google.dev/gemini-api/docs/video)
- OpenAI: [image generation](https://developers.openai.com/api/docs/guides/image-generation)
  (the Sora video-generation guide was retired with the API on 2026-09-24;
  the former `openai-video` preset profile was removed accordingly)

Example custom profiles (all reuse the SAME protocol adapters — no source
change needed for a compatible gateway):

```yaml
# 一个说 DashScope 协议的第三方网关：同一 adapter，只换 profile 字段。
wan-relay:
  protocol: dashscope-wan-compatible
  model: wan2.5-t2v-preview
  models: [wan2.5-t2v-preview]
  modalities: [video]
  baseUrl: https://wan-gateway.example.com
  authEnv: WAN_RELAY_API_KEY      # 环境变量名，绝不写值
  authStyle: bearer
  paths:
    submit: /wan/video            # 网关自己的路径映射
    status: /tasks/{id}
    cancel: /tasks/{id}/cancel
  protocolVerified: false         # 未在本机实测 ⇒ 真实提交被阻止
```

```yaml
gemini-relay:
  protocol: google-genmedia-compatible
  model: veo-3.1-generate-preview
  modalities: [video]
  baseUrl: https://gemini-gateway.example.com
  authEnv: GEMINI_RELAY_API_KEY
  authStyle: raw
  authHeader: x-goog-api-key
  paths:
    submit: /v1beta/models/{model}:predictLongRunning
    status: /v1beta               # 操作轮询前缀：{base}/v1beta/{operation-name}
```


Real submission requires `protocolVerified: true` on the profile **and**
`blockRealSubmit !== true`. Deployments whose relay is unconfirmed keep
`protocolVerified: false` (every default `bza-*` preset and `minimax-relay` do)
and `create()` throws `E_PROTOCOL_UNVERIFIED` **before any network I/O**.
`synthmedia_capabilities` reports `protocolVerified`, `liveVerified` and
`realSubmitAllowed` per profile.

## Support matrix — default profiles

| Backend id | Protocol | Model | Modality | Online | Verification |
|---|---|---|---|---|---|
| `zgci-h3` | `openai-video-compatible` | `minimax-h3` | video | online | Protocol shape verified against PhotoStory `backend/scripts/verify_ai_models.py` L184-235 (`POST https://hub.zgci.org/v1/videos`, 200/201, `queued`/`in_progress`/`completed`/`failed` + `progress`). **Live-validated once** (see *Live validation record* below). |
| `minimax-official` | `minimax-video-compatible` | `MiniMax-H3` (+ Highspeed/Lite/Max) | video | online | Official **MiniMax Video V2** wire shape ([create](https://platform.minimax.io/docs/api-reference/video-generation-v2-create), [query](https://platform.minimax.io/docs/api-reference/video-generation-v2-query), [delete](https://platform.minimax.io/docs/api-reference/video-generation-v2-delete), [guide](https://platform.minimax.io/docs/guides/video-generation)): bearer auth, `POST /v2/video_generation`, `GET /v2/query/video_generation/{id}`, `DELETE /v2/video_generation/{id}`, OpenAI-style errors. `protocolVerified: true`, **`liveVerified: false`** — mock-only, never called for real. |
| `minimax-relay` | `minimax-video-compatible` | `MiniMax-H3` (+ …) | video | online | A third-party relay that may speak the same shape. Its base URL, paths and model ids are unconfirmed placeholders, so `protocolVerified: false` + `blockRealSubmit: true`; real submission is refused until an operator verifies it and flips the flag. |
| `local-h3-sidecar` | `openai-video-compatible` | env model (default `minimax-h3`) | video | **offline** | Official shape: [vLLM-Omni videos API](https://github.com/vllm-project/vllm-omni/blob/main/docs/serving/videos_api.md) + [SGLang MiniMax-H3 cookbook](https://docs.sglang.io/cookbook/diffusion/MiniMax/MiniMax-H3): multipart `POST /v1/videos`, `GET /v1/videos/{id}`, `GET /v1/videos/{id}/content`, `DELETE` cancels, optional `POST /v1/videos/sync`. Mock-tested only. |
| `local-h3` | `videogen-task-api` | `minimax-h3` | video | **offline** | Intranet videogen async API (PhotoStory `utils/videogen.py`); needs a deployed instance. Mock-tested only. |
| `bza-seedance` | `volcengine-ark-compatible` | 4 Seedance presets | video | online | Official Ark task protocol implemented; **relay never contacted** (`protocolVerified: false`, real submit blocked). |
| `bza-seedream` | `volcengine-ark-compatible` | 2 Seedream presets | image | online | Official Ark image protocol implemented; relay never contacted (`protocolVerified: false`). |
| `bza-seed-tts` | `volcengine-ark-compatible` | `doubao-seed-tts-2.0` | audio | online | Official Doubao voice async TTS protocol implemented (submit → query → download); relay never contacted, real submit hard-blocked. |
| `dashscope-wan-video` | `dashscope-wan-compatible` | wan2.x t2v presets (`wan2.6-t2v`, `wan2.5-t2v-preview`, `wan2.2-t2v-plus`, `wanx2.1-t2v-turbo/-plus`) | video | online | Official Aliyun Model Studio async task protocol ([wan t2v API](https://help.aliyun.com/zh/model-studio/legacy-wan-text-to-video-api-reference), [task mgmt](https://help.aliyun.com/zh/model-studio/manage-asynchronous-tasks)). Implemented from docs but **never contacted**: `protocolVerified: false`, `blockRealSubmit: true` (mock-only). Credential NAME: `SYNTHMEDIA_DASHSCOPE_API_KEY` (or the official `DASHSCOPE_API_KEY` via `SYNTHMEDIA_DASHSCOPE_API_KEY_ENV`). Workspace domains (`{WorkspaceId}.{region}.maas.aliyuncs.com`) are a baseUrl override away. |
| `dashscope-wanx-image` | `dashscope-wan-compatible` | wanx2.1 t2i presets (`-turbo`, `-plus`) | image | online | Same protocol/adapter, image submit path (`text2image/image-synthesis`), same mock-only gating. Docs: [wanx t2i V2](https://help.aliyun.com/zh/model-studio/text-to-image-v2-api-reference). |
| `gemini-imagen` | `google-genmedia-compatible` | `imagen-4.0-generate-001`, `imagen-4.0-fast-generate-001` | image | online | Official Gemini API `:predict` surface ([Imagen docs](https://ai.google.dev/gemini-api/docs/imagen)); `x-goog-api-key` auth, sync base64 predictions. Implemented from docs, **never contacted** (`protocolVerified: false`, `blockRealSubmit: true`, mock-only). |
| `gemini-veo` | `google-genmedia-compatible` | `veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview` | video | online | Official Gemini API `:predictLongRunning` LRO surface ([Veo docs](https://ai.google.dev/gemini-api/docs/video)): submit → poll `{base}/v1beta/{operation-name}` → download `video.uri` (with the api-key header) → cancel `:cancel`. Implemented from docs, **never contacted** (mock-only). |
| `openai-images` | `openai-images-compatible` | `gpt-image-1`, `gpt-image-1-mini` | image | online | Official synchronous images API ([guide](https://developers.openai.com/api/docs/guides/image-generation)); b64_json default. Implemented from docs, **never contacted** (mock-only). |

(The former `openai-video` preset profile was **removed** — the official Sora
Videos API was shut down by OpenAI on 2026-09-24 and could never be
live-verified. The `openai-video-compatible` **adapter** remains in service
for third-party compatible gateways such as `zgci-h3` and `local-h3-sidecar`;
a user-defined profile on that protocol still works and any stored override
for the removed `openai-video` id degrades to a custom profile at load time.)

### `zgci-h3` real-queue behaviour (read before a live run)

- The one authorized live run took **~29.6 minutes** end to end. The hub
  reported `queued` / `running` with **progress 0 for the whole queueing
  phase**; progress only moves once generation itself starts, so a long 0%
  plateau is expected and is not a hang.
- The default `timeoutMs` for `zgci-h3` is **3,600,000 ms (60 minutes)** — the
  same budget as the validation script's `WAIT_CAP_MS`. Do not lower it toward
  the old 10-minute value: it aborts healthy queued tasks.
- Request model vs returned model: send `model: minimax-h3`; the hub answers
  with `model: zgcai-minimax-h3`. That response field is informational gateway
  naming — routing is pinned to the *requested* model id and the response value
  is never used to re-route.

### MiniMax official (Video V2) vs the `zgci-h3` relay — do not conflate them

| | `minimax-official` (direct) | `zgci-h3` (third-party relay) |
|---|---|---|
| Protocol | `minimax-video-compatible` — MiniMax **Video V2** task API | `openai-video-compatible` — OpenAI-style `/v1/videos` task API |
| Base URL | `https://api.minimax.io` (official; override with `SYNTHMEDIA_MINIMAX_BASE_URL`) | `https://hub.zgci.org` (override with `SYNTHMEDIA_ZGCI_BASE_URL`) |
| Model ids | `MiniMax-H3`, `MiniMax-H3-Highspeed`, `MiniMax-H3-Lite`, `MiniMax-H3-Max` (official spelling) | `minimax-h3` request alias; the hub answers with `zgcai-minimax-h3` |
| Create / query / cancel | `POST /v2/video_generation` / `GET /v2/query/video_generation/{id}` / `DELETE /v2/video_generation/{id}` | `POST /v1/videos` / `GET /v1/videos/{id}` / (no cancel path configured) |
| Output | signed `task.content.url` (time-limited; fetched without the API key) | `GET /v1/videos/{id}/content` binary |
| Verified | wire shape from official docs ⇒ `protocolVerified: true`, **`liveVerified: false`**, never called for real | one authorized real run ⇒ `protocolVerified: true`, `liveVerified: true` |

Because the two wire shapes differ (task envelope, delete path, no `/content`
endpoint, `resolution`/`ratio` instead of `size`), the official surface has its
own **protocol-named** adapter (`src/backends/minimax.ts`) and does **not**
reuse the `/v1/videos` task adapter. Neither adapter names a provider: `minimax-official`,
`minimax-relay` and any user-defined MiniMax-compatible gateway all reuse the
same adapter through configuration (base URL, paths, credential reference,
`queryParams`, `headers`, `extraBody`). A relay that needs `GroupId` or a
special header is configured, never patched into code.

Operational notes for the official API:
- Errors use the documented OpenAI-style envelope
  (`{type:'error', error:{type,message,http_code}, request_id}`; see the
  [error code reference](https://platform.minimax.io/docs/api-reference/errorcode)),
  mapped to structured `E_AUTH` / `E_BALANCE` / `E_RATE_LIMIT` / `E_REQUEST` /
  `E_REMOTE`. A task that fails after submission carries `task.error{code,message}`.
- There is **no numeric progress** in the query response; the unified job shows
  a coarse estimate (queued 5 %, running 50 %, terminal 100 %).
- `DELETE` cancels **only a `queued`** task; `running`/`cancelled` return an
  error, which the plugin treats as best-effort (the local job still
  cancels). A succeeded/failed task is *deleted* by the same call.
- The query response reports `created_at` / `updated_at` (unix seconds). For a
  terminal task, `updated_at` is kept as `remoteCompletedAt`; it is **not** the
  local download time (see *Guarantees* below).
- A real direct call requires the operator to provide `MINIMAX_API_KEY` (name
  only is stored in config). No MiniMax call was made by this build.

### Offline H3 runtime support matrix (OS / GPU)

| Runtime | macOS | Windows | Linux | GPU | Notes |
|---|---|---|---|---|---|
| vLLM-Omni (`vllm serve <model> --omni`) | ❌ | ❌ | ✅ (CUDA) | NVIDIA (H200-class recommended for H3) | Official H3 recipe + `/v1/videos` |
| SGLang diffusion (`sglang.launch_server`) | ❌ | ❌ | ✅ (CUDA) | NVIDIA | Official MiniMax-H3 cookbook |
| GGUF via `sd-cli` ([stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)) | ✅ | ✅ | ✅ | Apple Silicon / NVIDIA / Vulkan | Day-1 H3 support (2026-08-04). Weights: [`unsloth/MiniMax-H3-GGUF`](https://huggingface.co/unsloth/MiniMax-H3-GGUF), **~33 GiB** for the Q4 combo. Pruned + quantized ⇒ lower quality. Requires `--mode vid_gen --cfg-scale 1.0 --offload-to-cpu`. Plain `ollama run` is **not** an H3 video path. |
| Native Metal ([antirez/h3.c](https://github.com/antirez/h3.c)) | ✅ (Apple Silicon) | ❌ | ❌ | M3/M5-class | MIT, original BF16 weights (no conversion), measured on M5 Max by upstream: 512²/22-frame 19-pass denoise **36.3 s**. Last commit 2026-08-11 (unmaintained). |
| MLX serving (community) | ✅ (Apple Silicon) | ❌ | ❌ | Apple M-series | [MacOS-H3-Speedrun](https://github.com/EvolvingLMMs-Lab/MacOS-H3-Speedrun) / [mlx-h3](https://github.com/appautomaton/mlx-h3); Turbo LoRA + Sol-Attn, fastest measured 480p/5 s ≈ 3m14s on M3 Ultra. |

Windows: no officially documented H3 *diffusion* runtime supports it; use WSL2
or the GGUF `sd-cli` path.

### Offline deployment

```bash
# A: vLLM-Omni videos API (Linux + NVIDIA)
vllm serve MiniMaxAI/MiniMax-H3 --omni --port 8091
export SYNTHMEDIA_LOCAL_H3_SIDECAR_BASE_URL=http://127.0.0.1:8091

# B: SGLang diffusion server (Linux + NVIDIA)
python -m sglang.launch_server --model-path MiniMaxAI/MiniMax-H3
export SYNTHMEDIA_LOCAL_H3_SIDECAR_BASE_URL=http://127.0.0.1:30000

# C: GGUF quantized + stable-diffusion.cpp (lightest: ~33 GiB, cross-platform)
sd-cli --mode vid_gen --diffusion-model minimax_h3_fl2va_pruned-Q4_K.gguf \
  --llm qwen3vl_32b_minimax_h3-Q4_K_M.gguf --vae <video_vae> --audio-vae <audio_vae> \
  --cfg-scale 1.0 --offload-to-cpu --rng cpu --fps 24
export SYNTHMEDIA_LOCAL_H3_SIDECAR_BASE_URL=http://127.0.0.1:<port>   # via the /v1/videos shim

# D: native Metal engine for Apple Silicon (original BF16, no conversion)
git clone https://github.com/antirez/h3.c && cd h3.c && make -j8
./h3 --info -d ./MiniMax-H3

# E: existing intranet videogen service
export SYNTHMEDIA_LOCAL_H3_BASE_URL=https://your-videogen-host
```

## Priority & routing (providerOrder)

`providerOrder` is a volatile Config field (JSON array string of profile ids; earlier
wins). Routing only **reorders** — every profile stays usable, an unlisted profile
simply ranks after all listed ones in its existing order. For each modality the
plugin picks the first profile in this order that (a) serves the modality,
(b) doesn't `blockRealSubmit`, and (c) passes the ecosystem gate (`supported: true`);
that profile is reported as `effectiveDefault: true` in
`synthmedia_capabilities` (absent ⇒ unranked). Saving `providerOrder` from the
Config page triggers a hot refresh (`VOLATILE_REBUILD_KEYS`), so the next
capabilities result and the config page reflect the new order without
restarting DSH. Generation itself always takes an explicit `backend` id —
priority only decides which profile is reported as the effective default;
there is still **no fallback**: a job is pinned to the chosen profile and a
failure is `E_OFFLINE_UNAVAILABLE`, never a silent reroute. Pure logic lives in
`src/page/priority.ts` (`parseOrder` / `orderProfiles` / `resolveDefaultProfile`)
and is unit-tested against corrupted JSON (degrade, never throw).

## Ecosystem gate (h3 / seedance)

`src/page/ecosystems.ts` classifies every model into one ecosystem — `h3`
(MiniMax-H3 family), `seedance` (Doubao Seedance/Seedream/Seed-TTS) or `other`
(wan, Gemini, OpenAI images, …). Only `h3` and `seedance` are in
`SUPPORTED_ECOSYSTEMS`; `other` is **not** default-routable: its gate reports
`supported: false` with a reason string, and it is skipped when picking the
effective default profile. Unsupported does **not** mean unusable — an explicit
`backend` id in `synthmedia_generate` still calls the profile directly, exactly
as before; the gate only decides who may win default routing. Each backend in
`capabilities` therefore carries `ecosystem` / `supported` / `ecosystemReason`
alongside `priority` and `effectiveDefault`, so agents can reason about why a
profile is (or is not) the default. Gates are per-model via `modelGate` and
aggregated per-profile via `profileGate`, which classifies a profile by its
default model (profiles are single-ecosystem by construction).

## Toolchain detection (enabledTools)

`enabledTools` is a volatile Config field listing which local tools matter to
you (`ffmpeg` / `imagemagick` / `gimp` / `blender`); unknown names are dropped
with a warning, corrupted JSON degrades to defaults. Detection (`src/page/toolchain.ts`)
probes only **enabled** tools via `which` + `--version` (ffmpeg uses `-version`;
ImageMagick probes `magick` and falls back to legacy `convert` when absent or
unresponsive), so disabled tools are never spawned. Results surface in three
places: the `snapshot` (Config page「媒体服务」tab), `/synthmedia detect` command,
and `synthmedia_capabilities` → `tools` (`enabled` / `installed` / `path` /
`version` / `installHint`, platform-aware hints). All probes are injectable,
so tests run without spawning processes.

## Offline H3 guide

完整离线部署指引在 [docs/offline-h3.md](docs/offline-h3.md)：本机实测表、阈值判定、
五条路径（GGUF + sd.cpp 最省空间约 33 GiB；h3.c 原生 Metal 直接吃 BF16；MLX +
Turbo LoRA 质量档；远端 vLLM-Omni / SGLang 是速度上限；内网 videogen 走 `local-h3`）
逐条命令、体积实测、故障排查与「未核验」清单。快速入口：

```bash
# 1. 探测本机硬件 + 工具链，给出阈值判定与推荐路径（只读，不下载）
node scripts/h3-setup.mjs --plan
# 2. 按清单下载模型文件（Diffusers 结构外的单文件补拉）
node scripts/h3-setup.mjs --download [--only <id>] [--data-dir synthmedia-data]
# 3. 健康检查一个已部署的 sidecar 端点
node scripts/h3-setup.mjs --check http://127.0.0.1:8091
```

接入后用 `SYNTHMEDIA_LOCAL_H3_SIDECAR_BASE_URL` / `_MODEL`（或内网 videogen 的
`SYNTHMEDIA_LOCAL_H3_BASE_URL`）指向服务，`synthmedia_capabilities` 里确认
`supported: true` 再发起首次生成。

## Config page (GUI settings card +「媒体服务」session tab)

The plugin ships a browser half (`exports["./client"]`, built by
`scripts/build-client.mjs` into `lib/client.js` as a hand-written ModuleLoader
module — the same mechanism dsh-cybernetics uses). After a host restart the
Plugins page shows ONE settings card (seats `plugins.item` /
`plugins.row.config` / `plugins.bundle.config`, bound to the plugin's
ConfigForm) with a fixed six-section information architecture, top to bottom:

1. **概览 Overview** — read-only status strip: effective profile count, the
   default profile per modality, the offline-H3 verdict (when a detection
   result is available), toolchain readiness, plus every parse warning
   (`configWarnings` + client-side JSON parse errors). No action buttons.
2. **资源来源 Sources** —
   a. **DSH 订阅账户**: checkbox list built from the baked providers snapshot
      (live data via the session tab). Only h3 / seedance ecosystem models are
      checkable; anything else (LLM ids AND other ecosystems like
      wan/imagen/veo) is greyed「暂不支持」and not checkable. Checks write
      `enabledDshResources` (entries shaped `"providerId::modelId"`).
     「应用勾选」turns the checked resources into custom-profile DRAFTS
      (preserving remote `/v1/models` fetch, memory-only Bearer token and the
      preset fallback); remote pull failure shows `import.fetchFailed` and
      falls back to baseURL-matched preset suggestions.
   b. **自建 Provider（影像专用）**: list + add/edit/delete + enable(online)/
      test-connection; fields id / protocol (dropdown) / baseURL / credential
      env-var NAME / model ids / modalities / online — writes `customProfiles`.
      Delete requires a second confirming click. Credential VALUES never enter
      the DOM (the optional fetch token is a `type=password` input, memory
      only).
3. **优先级 Priority** — ONE global ordered list (chosen over per-modality
   grouping: `providerOrder` IS a flat array, and a single column directly
   expresses「按顺序来」). Each row: profile id + mono meta line (protocol ·
   baseURL · models) + ecosystem badge + rank + per-modality「默认」badge +
   上移/下移/置顶 — writes `providerOrder` (JSON array of profile ids, earlier
   wins). The section states explicitly: generation still takes an explicit
   backend; this order only picks each modality's DEFAULT profile and the
   display order — it never auto-falls-back.
4. **生态 Ecosystems** — display-only cards for **h3** and **seedance**
   (model families, current profile count, default-hit yes/no); all other
   ecosystems collapse under「未支持（仍可显式调用）」(they never become the
   default but remain callable via an explicit backend id). No delete.
5. **工具链 Toolchain** — ffmpeg / imagemagick / gimp / blender checkboxes;
   each row shows probe status (installed ✓ with path/version from the tools
   snapshot, or missing ✗ with a copyable one-line install hint). Checks write
   `enabledTools`; unchecked tools are NOT probed (same contract as the
   backend).
6. **高级 Advanced** — outputDir / dataDir / providersPatchPath /
   defaultTimeoutMs, collapsed by default.

**Interaction consistency** (one implementation, shared by every section): a
single `Section` component (title + one-line description + optional action +
content) and a single `Row` component (name + monospace meta + status badge +
right-aligned actions). All edits go to a LOCAL DRAFT; ONE「保存并生效」button
commits ONLY the dirty fields as ONE mutate batch — the host ConfigForm first,
the plugin's own `remote.settings.mutate` (`directMutate`) as an independent
fallback when no ConfigForm is served — with saving/saved/failed states and an
unsaved-changes banner. The three volatile JSON fields
(`providerOrder` / `enabledDshResources` / `enabledTools`) plus
`customProfiles` hot-reload via `VOLATILE_REBUILD_KEYS` on save.

**「媒体服务」conversation tab** (unchanged): live profile list, system
detection (`/synthmedia detect`) with the offline-H3 verdict, and offline
model downloads (`/synthmedia dl list|start <id>|cancel <id>`, 3s polling,
host Jobs UI kind `synthmedia-download`).

Storage: user customisation lives ONLY in the plugin's config fields
(`customProfiles` JSON string + the three volatile JSON-array strings above)
written through the host settings API — `customProfiles` is schema-validated
on every read (`src/page/custom.ts`) and corrupt payloads degrade to a warning
+ empty list, never a failed boot. Credential values are never stored; only
env-var NAMES.

### 系统资源检测阈值（评估「能否运行离线 H3」）

Probes: `os.cpus/totalmem/arch/platform`、目标目录 `fs.statfs`、darwin
`sysctl machdep.cpu.brand_string`、`which python3|uv|node` + `--version`。
全部只读、固定参数、3s 超时，失败降级为「未知 → 不足」并标注 unknownData。

| 维度 | 充足 | 勉强 | 不足 | 来源 |
|---|---|---|---|---|
| 内存 | ≥73 GiB | ≥48 GiB | 更低 | 73 GiB 为任务给定值（4-bit H3 统一内存）；48 GiB 为估算 |
| 磁盘（目标目录可用） | ≥480 GiB | ≥40 GiB | 更低 | **实测尺寸**：40 GiB = GGUF Q4 组合 33 GiB + 余量；480 GiB = 整仓 BF16 464.2 GiB + 余量（FL2VA 单族 133.8 GiB） |
| CPU | ≥8 核 | ≥4 核 | 更低 | 估算（sidecar 单流） |
| 运行时 | python/uv/node 齐备 | 缺 1 项 | 缺 ≥2 项 | sidecar 需要 python+uv |

### 离线模型下载

- 清单：`<dataDir>/downloads.json`（用户可编辑）。首次启动自动写入默认清单：
  MiniMax H3 全套官方文件的逐文件条目（开源发布仅含 **H3-Base**，即 HF 仓库根
  pipeline 的 FL2VA / Ref2VA 两个 checkpoint；官方文档明确 H3-Context-IR 是
  托管预处理系统、未随开源发布，H3-Regenerate-2K "not yet open-sourced"，
  二者均无独立权重可下载）。
- 官方下载源（2026-08-03 开源）：
  - Hugging Face（默认源）：https://huggingface.co/MiniMaxAI/MiniMax-H3
    （文件 URL 形如 `.../resolve/main/transformer/diffusion_pytorch_model-00001-of-00014.safetensors`）
  - ModelScope 镜像（备选，改写 `url` 前缀即可）：
    https://modelscope.cn/models/MiniMax/MiniMax-H3 （文件 URL 形如 `.../resolve/master/<path>`）
  - 本地部署指南：https://platform.minimax.io/docs/guides/local-deploy-h3 ；仓库：https://github.com/MiniMax-AI/MiniMax-H3
- 文件集：根 pipeline 全部文件（transformer 14 分片 + transformer_ref 14 分片
  （reference 子管线）+ text_encoder 14 分片 + vae 3 分片 + audio_vae +
  tokenizer/processor 配置 + model_index 等，共 79 个文件，BF16 Safetensors，
  约 33.1B 参数/仓库总占用 ≈ 355 GiB 含 FL2VA/Ref2VA 子目录副本）。默认清单
  **不含** FL2VA/Ref2VA 子目录（与根管线组件重复），需要时自行在
  downloads.json 补条目。
- 运行时要求：vLLM-Omni / SGLang / diffusers（见上文「Offline H3 runtime
  support matrix」）；4-bit GGUF 走 `unsloth/MiniMax-H3-GGUF`，不在本清单内。
- 目标目录：`<dataDir>/downloads/`（默认 `synthmedia-data/downloads/`，可在
  设置表单改 `dataDir`）。注意：每个条目下载为平铺的 `<id>.bin` 文件，文件名
  不保留仓库子目录结构；如需完整 diffusers 目录布局，建议直接用
  `huggingface-cli download MiniMaxAI/MiniMax-H3`，本清单适合单文件补拉。
- 断点续传：字节先落 `<id>.bin.part`；重启任务时若存在合法 .part 则发
  `Range: bytes=<size>-` 续传（服务器不支持 Range 时自动从头）；完成后原子
  rename 为 `<id>.bin`；取消/失败保留 .part。HF/ModelScope 的 resolve URL 均
  302 重定向到 CDN，下载器自动跟随最多 5 次重定向（Range 头逐跳保留），每次
  重定向目标都过 SSRF 检查（私有/回环地址拒绝）；最终响应仍要求 200/206。
- 后台与取消：复用 `ctx.jobs`（宿主 JobRegistry，kind
  `synthmedia-download`），进度（百分比/速度/剩余）经 `updateProgress` 进入
  宿主 Jobs UI； Jobs UI 的取消与配置页取消同一 AbortController。
- MVP 仅面向 H3 生态；清单条目 schema 校验（id 必须 `[a-z0-9][a-z0-9._-]*`），
  非法条目被丢弃。

## Environment variables (names only — values are never read into config/logs)

| Name | Purpose |
|---|---|
| `SYNTHMEDIA_ZGCI_API_KEY` / `SYNTHMEDIA_ZGCI_API_KEY_ENV` | zgci hub credential (Bearer) and its reference-name override |
| `SYNTHMEDIA_ZGCI_BASE_URL` | zgci hub base URL (default `https://hub.zgci.org`) |
| `MINIMAX_API_KEY` | MiniMax official credential **name** (Bearer); the value is resolved per call via DSH credentials or the environment, never stored |
| `SYNTHMEDIA_MINIMAX_API_KEY_ENV` | overrides the credential reference **name** used by `minimax-official` |
| `SYNTHMEDIA_MINIMAX_BASE_URL` | `minimax-official` base URL (default `https://api.minimax.io`) |
| `SYNTHMEDIA_MINIMAX_MODEL` / `SYNTHMEDIA_MINIMAX_MODELS` | default / full official model list (defaults: `MiniMax-H3`, `-Highspeed`, `-Lite`, `-Max`) |
| `SYNTHMEDIA_MINIMAX_RELAY_API_KEY` / `_API_KEY_ENV` | credential name for the blocked `minimax-relay` preset |
| `SYNTHMEDIA_MINIMAX_RELAY_BASE_URL` | `minimax-relay` base URL (unconfirmed; real submit stays blocked) |
| `SYNTHMEDIA_BZA_API_KEY` / `SYNTHMEDIA_BZA_API_KEY_ENV` | bza (or any Ark relay) credential and its reference-name override |
| `SYNTHMEDIA_BZA_BASE_URL` | Ark-compatible base URL (default `https://llm.inner.bza.edu.cn/plan/v3`; the public `ark.cn-beijing.volces.com` address is never hardcoded) |
| `SYNTHMEDIA_BZA_SEEDANCE_MODEL` / `_MODELS` | default / full video model list |
| `SYNTHMEDIA_BZA_SEEDREAM_MODEL` / `_MODELS` | default / full image model list |
| `SYNTHMEDIA_BZA_TTS_MODEL` / `_MODELS` | default / full TTS model list |
| `SYNTHMEDIA_BZA_VIDEO_SUBMIT_PATH` / `_STATUS_PATH` / `_CANCEL_PATH` | Ark video path overrides |
| `SYNTHMEDIA_BZA_IMAGE_SUBMIT_PATH` | Ark image path override |
| `SYNTHMEDIA_BZA_TTS_SUBMIT_PATH` / `_QUERY_PATH` | Doubao voice TTS path overrides |
| `SYNTHMEDIA_BZA_TTS_RESOURCE_ID` / `_SPEAKER` | TTS resource id (`seed-tts-2.0`) and voice id |
| `SYNTHMEDIA_DASHSCOPE_API_KEY` / `SYNTHMEDIA_DASHSCOPE_API_KEY_ENV` | Aliyun Model Studio credential NAME (Bearer) for the wan profiles, and its reference-name override (e.g. set `_ENV=DASHSCOPE_API_KEY` to use the official variable name directly) |
| `SYNTHMEDIA_DASHSCOPE_BASE_URL` | wan profiles base URL (default `https://dashscope.aliyuncs.com`; workspace domains are an override) |
| `SYNTHMEDIA_DASHSCOPE_VIDEO_MODEL` / `_MODELS` | default / full wan video model list |
| `SYNTHMEDIA_DASHSCOPE_IMAGE_MODEL` / `_MODELS` | default / full wanx image model list |
| `SYNTHMEDIA_GEMINI_API_KEY` / `SYNTHMEDIA_GEMINI_API_KEY_ENV` | Google GenAI credential NAME (`x-goog-api-key`) and its reference-name override (e.g. `GEMINI_API_KEY`) |
| `SYNTHMEDIA_GEMINI_BASE_URL` | Gemini profiles base URL (default `https://generativelanguage.googleapis.com`) |
| `SYNTHMEDIA_GEMINI_IMAGE_MODEL` / `_MODELS` | default / full Imagen model list |
| `SYNTHMEDIA_GEMINI_VIDEO_MODEL` / `_MODELS` | default / full Veo model list |
| `SYNTHMEDIA_OPENAI_API_KEY` / `SYNTHMEDIA_OPENAI_API_KEY_ENV` | OpenAI credential NAME (Bearer) and its reference-name override (e.g. `OPENAI_API_KEY`) |
| `SYNTHMEDIA_OPENAI_BASE_URL` | OpenAI media base URL (default `https://api.openai.com`) |
| `SYNTHMEDIA_OPENAI_IMAGE_MODEL` / `_MODELS` | default / full images model list |
| `SYNTHMEDIA_LOCAL_H3_AUTH` | `user:password` (Basic) or bearer token for local H3 |
| `SYNTHMEDIA_LOCAL_H3_BASE_URL` | videogen base URL (default `http://127.0.0.1:8791`) |
| `SYNTHMEDIA_LOCAL_H3_SIDECAR_BASE_URL` | videos-API sidecar URL (default `http://127.0.0.1:8000`) |
| `SYNTHMEDIA_LOCAL_H3_SIDECAR_MODEL` | model id exposed by the sidecar |
| `SYNTHMEDIA_SIDECAR_SYNC` | `1` → use synchronous `/v1/videos/sync` |
| `SYNTHMEDIA_OUTPUT_DIR` | artifact root (default `synthmedia-output`, git-ignored) |
| `SYNTHMEDIA_ZGCI_LEDGER` / `SYNTHMEDIA_ZGCI_OUT_DIR` | validation-script ledger and artifact paths (defaults under the output root; used to test the guard with throwaway fixtures) |
| `SYNTHMEDIA_ZGCI_POLL_MS` | validation-script poll cadence override (default 15 s; tests use a short value) |

## Tools

```
synthmedia_capabilities()
→ backends with protocol, models, per-model capability limits, online,
  protocolVerified, liveVerified, realSubmitAllowed

synthmedia_generate({ backend: "zgci-h3", model: "minimax-h3", modality: "video",
                      prompt: "aurora over mountains", durationSeconds: 4, size: "1280x720" })
→ { job: { id, status: "running", progress: 10, ... } }   // also in the host Jobs UI

synthmedia_status({ id })
synthmedia_wait({ id })
synthmedia_cancel({ id })
```

Jobs persist `job.json` + artifacts (`result.mp4` / `result.png` / `result.jpg` /
`result.mp3` / `result.wav` / `result.txt` / `result.bin`) under
`<outputDir>/<jobId>/`. Artifacts are written from raw `Buffer`s fetched through
`response.arrayBuffer()` — no character decoding anywhere, so `0xff`, `0x80` and
multi-byte UTF-8 bytes survive byte-for-byte (regression-tested for video, image
and audio).

`job.json` timestamps keep the two clocks apart: `createdAt` / `downloadedAt` /
`finishedAt` are **local** (`downloadedAt` is written only after the artifact
bytes have landed), while `remoteCompletedAt` is the **provider's** terminal
instant (`completed_at`, or the terminal `updated_at`). Either one may be
absent; neither is ever derived from the other.

## Guarantees & limits

- **No silent routing/fallback**: a job is pinned to one profile; unknown
  backend/model/modality are structured errors (`E_NO_BACKEND`, `E_MODEL`,
  `E_MODALITY`); offline failures map to `E_OFFLINE_UNAVAILABLE`.
- **No unverified submission**: `protocolVerified: true` is required on the
  profile; otherwise `E_PROTOCOL_UNVERIFIED` before any network I/O.
- **No silently ignored size**: for the Ark video task API a tool-level `size`
  is mapped to `resolution` + `ratio`, and an inexpressible size fails with
  `E_SIZE` before any request (request-body regression-tested). The official
  MiniMax V2 API follows the same rule (resolution tiers / value-matched
  ratios, `E_SIZE` otherwise).
- **Remote time ≠ local time**: `remoteCompletedAt` is only ever the
  provider-reported terminal instant (`completed_at`, or a terminal status's
  `updated_at`); `downloadedAt` and `finishedAt` are **local** clocks, written
  only after the artifact bytes finished downloading/writing. A provider that
  reports no timestamp yields no `remoteCompletedAt` — the plugin never invents
  one, and never labels a local time as remote.
- **Documented fields only**: adapters submit the documented wire fields. The
  MiniMax V2 schema has no `seed` / `negative_prompt`, so the adapter does not
  send them; gateway-specific extras are configuration (`extraBody`,
  `queryParams`, `headers`), not code.
- **Host Jobs UI (optional service)**: the DSH jobs registry is read through the
  service seam `ctx.get('jobs')` and late-bound with `ctx.inject(['jobs'], …)`,
  so a composition that loads `@deepseek-ai/dsh-jobs` after this plugin still
  gets jobs in the UI. Each host job is kind `synthmedia` with `owner` = the
  initiating agent session id (from `exec.agent.id`) plus the creating
  `toolCall`, and carries `updateProgress`, a cancel hook and a mapped `done`
  outcome. Without a registry the plugin degrades to its private records.
- **Credential safety**: credential **references** only (env name or DSH
  credential reference), resolved per call; `Bearer`/`Basic`/`sk-`/`key=`
  shapes are redacted from every error path; signed artifact URLs are fetched
  without the API key.
- **Cancellation**: abort-responsive sleep (no poll-interval-scale latency),
  listener cleanup, `exec.signal` forwarded by the cancel tool, best-effort
  remote DELETE where the protocol documents one.

## Verification boundary (real vs mock)

- **Contract/mock tests** (all green via `pnpm test`): zgci `/v1/videos` shape,
  videogen shape, vLLM-Omni sidecar (async + sync), Ark video/image/TTS shapes,
  **MiniMax official V2 create/query/cancel/binary** shape, protocol reuse
  across two profiles (including two MiniMax-compatible gateways),
  **Aliyun Wanxiang** (dashscope-wan video + wanx image: submit/async-header/
  query/cancel/binary/error shapes plus a third-party gateway reusing the same
  adapter), **Google GenAI** (Imagen `:predict` base64, Veo LRO poll/download/
  cancel/safety-error), **OpenAI media** (images `b64_json` + auth error;
  the `/v1/videos` task cycle + DELETE cancel is covered via a custom
  openai-video-compatible profile since the Sora preset was removed),
  preset overrides, DSH credential
  resolution, ctx.jobs wiring, remote-vs-local timestamps, binary integrity,
  cancellation/timeout, offline→no-cloud.
- **Real calls**: `bza-*` relays have **never** been contacted by this project;
  their presets advertise `protocolVerified: false`. **MiniMax was never
  contacted at all** — `minimax-official` is documented-and-mocked only
  (`protocolVerified: true`, `liveVerified: false`) and `minimax-relay` stays
  blocked (`protocolVerified: false`, `blockRealSubmit: true`). **The three
  newer ecosystems (Aliyun Wanxiang, Google GenAI, OpenAI media) were never
  contacted either** — the operator has no account on any of them, so all six
  new profiles ship `protocolVerified: false` + `blockRealSubmit: true`
  (mock-only; the unverified gate refuses real submission before any network
  I/O). One minimal `zgci-h3` real task was executed under explicit
  authorization — see the record below. Offline H3 runtimes were not deployed
  here (no GPU); their protocols are covered by mock contract tests. Note that
  the OpenAI Sora videos API was **shut down by OpenAI on 2026-09-24**; the
  former `openai-video` preset profile was removed from this build and the
  `openai-video-compatible` adapter now serves third-party compatible
  gateways only.
- **Current build vs the live record**: this build adds the MiniMax official
  V2 protocol, the remote/local timestamp split, the value-matched Ark ratio
  mapping, and three new ecosystem protocols (dashscope-wan-compatible,
  google-genmedia-compatible, openai-images-compatible; the former
  `openai-video` Sora-shape preset profile was removed). The real zgci video
  was produced by an earlier authorized
  build; no remote generation (zgci, bza, MiniMax, Aliyun, Google, OpenAI or
  any relay) was executed by this build. The current tree's remote-facing paths
  are covered by **mock contract tests only**.
- No global plugin activation (`cordis.patch.yml` absent), no DSH profile
  changes, no long-running services.

## Live validation record (zgci hub, once)

| Field | Value |
|---|---|
| Endpoint | `https://hub.zgci.org` — `openai-video-compatible` (`POST /v1/videos`, `GET /v1/videos/{id}`) |
| Requested model | `minimax-h3` — the hub's response carried `model: zgcai-minimax-h3` (informational gateway naming; routing stays pinned to the requested id) |
| Prompt | `一只纸船在安静水面上缓慢前行，无人物` — 4 s, `size: "1280x720"` (this protocol has a real `size` field; the Ark resolution/ratio mapping does not apply to it) |
| Remote task id | `task_7pxiHV7kEES4kzOqjcUF4j8tuFxzdkWn` |
| Remote final status | `succeeded` with `progress: 100`. The hub returned no remote completion timestamp, so this record has **no** `remoteCompletedAt`; the local finish time below must **not** be read as a remote completion time. |
| Polling while queued | `queued` / `running` with progress **0** for most of the wait (expected: progress only moves once generation starts) |
| Local submit time | `job.json` `createdAt` = `2026-11-12T10:42:38.430Z` — **local clock**, when the job record was created and the POST issued |
| Local finish time | `job.json` `finishedAt` = `2026-11-12T11:12:14.462Z` — **local clock**, written after the final successful poll *and* the content download completed. It labels local polling/download completion, **not** the remote completion time. Records written by the current build additionally carry `downloadedAt` for that same local instant; this older run predates the split. Local elapsed ≈ 29m36s. |
| Artifact | `synthmedia-output/zgci-real/65e7c85d-1a0f-49dd-90bb-fe046d9a4e96/result.mp4` |
| Integrity | 1,426,282 bytes, `ftyp`/`moov`/`mdat` present, sha256 `76f5edfa0ecde149ac59cd1eca824e83b4556c39006813035af23d7d7e3946d0` |
| Duplicate guard | `synthmedia-output/zgci-real-runs.json` records the attempt **before** the POST; any future run also scans the output root (job records and logs, `scripts/zgci-guard.mjs`) for a remote id and then resumes query only — a missing ledger cannot cause a second create |

Only one task was created; no retry was attempted, no remote cancel was claimed,
and the credential came from the existing PhotoStory `.env` variable — never
printed, logged or committed.
