# bza Coding Plan：Seedream（图像）与 Seed TTS（语音）实测报告

日期：2026-11-17 · 网关：`llm.inner.bza.edu.cn/plan/v3`（与 Seedance 视频同一部署）

## 结论先行

- **Seedream（图像）：真实调用跑通，Ark 协议已验证。** `POST /images/generations`，模型 `doubao-seedream-5.0-pro`，HTTP 200，同步返回 `data[0].url` + `usage`，产物 2496×1664 JPEG 可解码。`protocolVerified=true`、`liveVerified=true` 已落 `src/config.ts`。
- **Seed TTS（语音）：真实调用失败，协议未验证，后端保持锁定。** 早期探测（`{base}` 下两条 submit 候选路径 404 空 body）之后，本轮完成完整路由探测（见下节 [TTS 路由探测（2026-11-17）](#tts-路由探测2026-11-17)，详见 [probe notes](<bza-seed-tts-probe-notes.md>)）：官方 host 上 plan TTS 流式路由**存在**（401 结构化错误，plan key 被拒），bza 网关 5 条候选路径 + 2 条变体**全部 404**（`server: uvicorn`）。准确表述是「官方路由存在但 key 作用域不匹配；bza 网关侧无该路由」，协议兼容性未知。全程零 200、零计费、无音频产物。`bza-seed-tts` 维持 `protocolVerified=false`、`liveVerified=false`、`blockRealSubmit=true`。
- 仅解锁 `bza-seedream`；`bza-seedance` 未改动；其它 preset 一律未碰。
- ~~插件侧真实提交待宿主重载后验证~~ **已于 2026-11-17 插件侧实证通过**（见下节「插件侧端到端实证」，job `9c11c5c6-d1ea-4af1-adf0-4406068d7b83`）。

## 逐后端实测表

| 后端 | 协议 | 模型 | 路径 | HTTP | 端到端耗时 | 产物 | 字节数 | usage |
|---|---|---|---|---|---|---|---|---|
| bza-seedream | ark `/images/generations`（同步） | doubao-seedream-5.0-pro | POST `/plan/v3/images/generations` | 200 | 26,921 ms（含下载） | `synthmedia-output/bza-seedream-real/image-doubao-seedream-5.0-pro.jpg`（2496×1664 JPEG，identify 通过） | 295,303 B | `generated_images:1, output_tokens:16224, total_tokens:16224` |
| bza-seed-tts | 官方 Doubao TTS（submit→query→audio_url） | doubao-seed-tts-2.0 | POST `/plan/v3/api/v3/tts/submit` → 404；POST `/plan/v3/tts/submit` → 404 | 404×2 | 27 ms / 70 ms | 无 | — | — |

（上行为早期 2 条 submit 路径探测；完整 8 条路由探测矩阵见下节 [TTS 路由探测（2026-11-17）](#tts-路由探测2026-11-17)。）

图像调用 1 次（pro 一次成功，未消耗 flash 降级名额）；TTS 调用 2 次（均在 submit 阶段失败，未产生计费产物）。

## 脱敏请求 / 响应（无 Authorization / Key）

**Seedream 请求体**（见 `synthmedia-output/bza-seedream-real/job.json`）：

```json
{
  "model": "doubao-seedream-5.0-pro",
  "prompt": "一张白纸折成的纸船漂在浅水洼里，晨光逆光，浅景深，写实电影感",
  "response_format": "url",
  "watermark": false
}
```

认证：`Authorization: Bearer <REDACTED>`。响应关键字段（截断）：

```json
{"model":"doubao-seedream-5-0-pro","created":1794901066,
 "data":[{"url":"https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/…（TOS 签名 URL，已截断）"}],
 "usage":{"input_images":0,"generated_images":1,"output_tokens":16224,"total_tokens":16224}}
```

注意：响应 `model` 字段返回的是 `doubao-seedream-5-0-pro`（连字符风格）而非请求的 `5.0`；产物 URL 指向火山 TOS（`ark-acg-cn-beijing.tos-cn-beijing.volces.com`，签名 query 已脱敏）。返回内容实际为 **JPEG 2496×1664**：响应明确携带 `"output_format":"jpeg"`，插件 ark.ts 按 `output_format` 推断 MIME 的逻辑在该网关下工作正常。初始文件名 `image-doubao-seedream-5.0-pro.png` 中的 `.png` 来自探测脚本 `scripts/bza-seedream-tts-probe.mjs` 硬编码的 `image-${model}.png` 模板，与插件命名行为无关，实测产物已改名 `.jpg`。

**Seed TTS 请求体**（`synthmedia-output/bza-seed-tts-real/job.json`）：

```json
{
  "user": {"uid": "synthmedia"},
  "unique_id": "<uuid>",
  "req_params": {
    "text": "一只纸船漂在水面上，安静地向前行驶",
    "speaker": "zh_female_xiaohe_uranus_bigtts",
    "audio_params": {"format": "mp3", "sample_rate": 24000}
  }
}
```

认证头：`X-Api-Key: <REDACTED>`、`X-Api-Resource-Id: seed-tts-2.0`、`X-Api-Request-Id: <uuid>`。两次响应均为 **HTTP 404、Content-Type null、空 body**（无 Ark `code/message` 信封，无 JSON）。

## 配置 diff（文件 / 字段 / 旧→新）

`src/config.ts`（及构建产物 `lib/config.js`）：

| 字段 | 旧 | 新 |
|---|---|---|
| `bza-seedream.protocolVerified` | `false` | `true`（注释附 2026-11-17 + HTTP 200 证据） |
| `bza-seedream.liveVerified` | `false` | `true`（注释附日期 + 产物路径） |

`bza-seedream` 无 `blockRealSubmit` 字段，`protocolVerified=true` 即解除提交锁（`backends/ark.ts` 的 `realSubmitAllowed`）。

**未改动**：`bza-seedance`（两标记保持 true）、`bza-seed-tts`（三锁全部保持）、`minimax-relay` / `dashscope-*` / `gemini-*` / `openai-images` 等其它 preset。`docs/paper-boat-bza-seedance-report.md` 未触碰。

测试同步（与上一轮 seedance 处理方式一致）：

- `test/bza.test.mjs` capabilities 用例：`bza-seedream.protocolVerified false→true`、`realSubmitAllowed false→true`，seed-tts 断言不变。
- `test/unit.test.mjs` defaults 用例：verification 循环移除 seedream，单独断言其 protocolVerified=true。

## 证据脱敏与勘误（2026-11-17）

本轮对报告与两份 job.json 做了纯文档层面的脱敏与勘误，无网络请求、无配置改动：

1. **TTS 第二次耗时 69ms → 70ms**：报告实测表原写 69 ms，与 `synthmedia-output/bza-seed-tts-real/job.json` 的 `retry.elapsedMs=70` 不一致，按落盘证据改为 **70 ms**。
2. **MIME 说法勘误**：删除「响应未带 `output_format`、插件按 png 兜底命名」的不实表述。事实依据：`synthmedia-output/bza-seedream-real/job.json` 的 `responseRaw` 明确含 `"output_format":"jpeg"`，插件按 `output_format` 推断 MIME 的逻辑正常；初始文件名里的 `.png` 来自探测脚本 `scripts/bza-seedream-tts-probe.mjs` 硬编码的 `image-${model}.png` 模板，与插件行为无关。产物实际为 **JPEG 2496×1664**（295,303 B）。
3. **签名 URL 脱敏**：`synthmedia-output/bza-seedream-real/job.json` 的 `responseRaw` 原含完整 TOS 签名 URL（`X-Tos-Signature` / `X-Tos-Credential` / `X-Tos-Expires` 等）。已将 query 参数全部截断（保留 host 与路径），并新增 `redactionNote` 字段注明「签名 URL 已脱敏，原始值不落盘」。其余证据字段（status、elapsedMs、usage、size、output_format 等）未删。`synthmedia-output/bza-seed-tts-real/job.json` 经检查不含任何签名 URL，仅新增 `evidenceNotes`：如实注明第一条 submit 的具体 path/Content-Type 当时未记录，不伪造。
4. **TTS 失败口径保持**：准确表述是「该网关在已探测路径（`/api/v3/tts/submit`、`/tts/submit`）上无路由（404 空 body，无 Ark 错误信封）」；协议本身是否兼容**未知**，不写「协议不兼容」。

## TTS 路由探测（2026-11-17）

在早期 2 条 submit 路径 404 之后，追加了一轮完整路由探测（纯探测，无 config 改动、零计费）。完整原始记录见 [docs/bza-seed-tts-probe-notes.md](<bza-seed-tts-probe-notes.md>) 与 `synthmedia-output/bza-seed-tts-probe/job.json`。

| # | URL | 认证方式 | 状态码 | 耗时 | 判定 |
|---|---|---|---|---|---|
| 1 | `https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional` | X-Api-Key | **401** | 0.24s | 路由**存在**（结构化错误码 45000010 `Invalid X-Api-Key`）——plan key 在官方 host 被拒 |
| 2 | `https://llm.inner.bza.edu.cn/api/v3/plan/tts/unidirectional` | X-Api-Key | 404 | 0.03s | 无路由 |
| 3 | `https://llm.inner.bza.edu.cn/plan/api/v3/plan/tts/unidirectional` | X-Api-Key | 404 | 0.09s | 无路由 |
| 4 | `https://llm.inner.bza.edu.cn/plan/v3/plan/tts/unidirectional` | X-Api-Key | 404 | 0.05s | 无路由 |
| 5 | `https://llm.inner.bza.edu.cn/plan/tts/unidirectional` | X-Api-Key | 404 | 0.09s | 无路由 |
| 6 | `https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional` | Bearer | **400** | 0.09s | 对照组：官方 host 明确要求 X-Api-Key（45000000 `app key not found in header or query`），**Bearer 不被接受** |
| 7 | `https://llm.inner.bza.edu.cn/api/v3/tts/unidirectional`（变体） | X-Api-Key | 404 | 0.03s | 无路由 |
| 8 | `https://llm.inner.bza.edu.cn/openspeech/api/v3/plan/tts/unidirectional`（变体） | X-Api-Key | 404 | 0.02s | 无路由 |

四条关键判定：

1. **路由存在于官方 host 但 key 被拒**：`openspeech.bytedance.com` 上的 plan TTS 流式路由返回结构化 plan 网关错误（非 404）；bza plan key 在其上不被接受（401），说明 key 是**网关作用域**（网关内可用、官方 host 被拒）。
2. **bza 网关 404 且是 uvicorn**：5 条候选路径 + 2 条变体全部 404，响应头 `server: uvicorn`——网关是真实 FastAPI 应用网关（非 TLS 直通），路由显式注册，当前无 TTS 路由。
3. **Bearer 不被接受**：官方 openspeech 只认 `X-Api-Key`（+ `X-Api-Resource-Id: seed-tts-2.0`）；`Authorization: Bearer` 返回 400。
4. **零计费**：全程零 200、零计费、无音频产物、无 usage 信号。

结论：`bza-seed-tts` **三重锁定不变**（`protocolVerified=false`、`liveVerified=false`、`blockRealSubmit=true`）。准确表述是「官方路由存在但 key 作用域不匹配；bza 网关侧无该路由」——协议兼容性未知，不得写「协议不兼容」。仍待 bza 确认：① plan TTS 是否在网关侧代理；② plan key 是否具备 openspeech 直连资格。

产品决定（2026-11-17）：Seed TTS 暂不实现，保持 `protocolVerified:false` / `blockRealSubmit:true`（未验证状态），待 bza 就托管与密钥归属给出答复后再评估。

## 坑与风险

1. **宿主旧内存 preset**：`synthmedia_generate` 在宿主重载前仍会以 `E_PROTOCOL_UNVERIFIED` 拦截 seedream 真实提交。**插件侧真实提交待宿主重载后验证**。
2. **路径前缀差异是真实风险且已命中**：视频/图像共享 `{base}/…` 相对路径，而 TTS 官方完整 URL 本身含 `/api/v3/tts/submit`；在 `{base}=…/plan/v3` 下两种拼接（`/api/v3/tts/submit`、`/tts/submit`）均 404 空 body。后续完整路由探测确认（见下节）：官方 host 流式路由存在但 plan key 被拒（401），bza 网关 7 条路径全 404（uvicorn）。**仍待向 bza 确认两件事**：① plan TTS 是否在网关侧代理（网关是 FastAPI 显式注册路由，可问运维索取确切 path）；② plan key 是否具备 openspeech 直连资格（当前 401 说明没有，可能需在 plan 控制台单独签发 openspeech 用 key）。
3. **图像同步接口与视频任务接口不同**：图像无 task id、无轮询，超时即失败（preset `timeoutMs=300_000`，实测 27s）；`data[0].url` 是火山 TOS 签名 URL，有时效，插件 fetch 逻辑已内置下载，但 job.json 只保留截断 URL。
4. **MIME 小坑（本轮勘误）**：早期记录称「响应无 `output_format`、插件按 png 兜底命名」是错的——`job.json.responseRaw` 明确含 `"output_format":"jpeg"`，插件推断逻辑正常；初始 `.png` 扩展名来自探测脚本 `scripts/bza-seedream-tts-probe.mjs` 硬编码的 `image-${model}.png` 模板，与插件无关。产物实际为 JPEG 2496×1664。
5. **计费口径未知**：`usage.output_tokens=16224` 的换算方式（是否计图片分辨率/质量）无文档依据；TTS 未消耗计费。
6. GET 路由探测（无计费）显示网关在鉴权层先返回 401，无法用匿名探测区分"路由不存在"与"鉴权后 404"，故 TTS 结论以带鉴权的 POST 结果为准。
7. **实现判断（若要打通 TTS）**：官方 plan TTS 是 HTTP chunked 流式 / WebSocket，而现有 `bza-seed-tts` preset 是 submit→query 任务式——**不能靠改 path/baseUrl 复用**。打通 TTS 是「新增流式适配器 + 确认托管/密钥归属」的**独立工程**，不是改配置项的事。

## 自验清单

- [x] 图像产物可解码：`identify` → JPEG 2496×1664，295,303 B
- [x] `synthmedia-output/bza-seedream-real/job.json`：请求体（脱敏）/ HTTP 200 / usage / 耗时 26,921 ms / 产物路径与字节数齐全
- [x] `synthmedia-output/bza-seed-tts-real/job.json`：两次失败调用的路径、状态码 404、耗时、原始空 body 证据齐全
- [x] `node -e "…require('./lib/config.js')…"`：seedream `protocol=true live=true block=false`；seed-tts 仍三锁；seedance 未变
- [x] `pnpm test`：**163 pass / 0 fail**
- [x] 仅解锁 seedream；未触碰 seedance 标记、seedance 报告与其它 preset
- [x] 未 git commit；未打印任何 Key / 完整签名 URL
- [x] 计费额度：图像 1/2 次，TTS 2/2 次（均失败于 submit，未产生计费产物）

## 宿主重载后应当看到的能力表文本

```
bza-seedance   video  doubao-seedance-2.0/2.0-fast/2.0-mini/2.5   protocolVerified=true  liveVerified=true  realSubmitAllowed=true
bza-seedream   image  doubao-seedream-5.0-flash/5.0-pro           protocolVerified=true  liveVerified=true  realSubmitAllowed=true
bza-seed-tts   audio  doubao-seed-tts-2.0                          protocolVerified=false liveVerified=false realSubmitAllowed=false (blockRealSubmit)
```

## 插件侧端到端实证（2026-11-17）

宿主重载后，`synthmedia_capabilities` 能力表原文（本轮实际输出）：

```
bza-seedream volcengine-ark-compatible: doubao-seedream-5.0-flash,doubao-seedream-5.0-pro [image] online protocol-verified default:* eco:seedance
```

`protocol-UNVERIFIED` 与 `real-submit:BLOCKED` 已消失；`bza-seed-tts` 仍为 `protocol-UNVERIFIED real-submit:BLOCKED`（预期，保持）。

### 调用记录（synthmedia_generate 发起）

- **plugin job id**：`9c11c5c6-d1ea-4af1-adf0-4406068d7b83`
- **backend / model / modality**：`bza-seedream` / `doubao-seedream-5.0-pro` / `image`
- **prompt**：一张白纸折成的纸船漂在浅水洼里，晨光逆光，浅景深，写实电影感
- **size**：`2496x1664`（像素直传，ark.ts 图像分支原样映射到 `/images/generations` payload）
- **提交时刻**：2026-11-17T07:54:37.620Z（createdAt）；**完成时刻**：2026-11-17T07:55:00.305Z（finishedAt）
- **端到端 elapsed**：约 **22.7 s**，状态 `succeeded`，无需重试（真实图像调用共 1 次）

### 产物

- 路径：`synthmedia-output/9c11c5c6-d1ea-4af1-adf0-4406068d7b83/result.jpg`（宿主侧），归档副本 `synthmedia-output/bza-seedream-plugin/result.jpg` + `job.json`
- 格式/尺寸：JPEG 2496×1664（`file` 与 `identify` 均确认，8-bit sRGB，3 components）
- 字节数：**314,162 B**；`read_image` 目视确认画面为白色纸船漂在浅水洼、晨光逆光、浅景深，符合 prompt
- 响应形态：`remoteId: inline-image`（该网关下插件图像分支下载/内联产物，job.json 不含任何签名 URL 或凭据，无需脱敏）

### 与直连 wire 实证对照

| | 直连 wire（探测脚本） | 插件侧（synthmedia_generate） |
|---|---|---|
| 时间 | 2026-11-17 上午 | 2026-11-17 07:54 UTC |
| 耗时 | 26,921 ms（含下载） | ≈22,690 ms |
| 尺寸 | JPEG 2496×1664 | JPEG 2496×1664 |
| 字节 | 295,303 B | 314,162 B |
| usage | 16,224 tokens | 未透出（插件图像分支不记录 usage） |
| 证据 | `synthmedia-output/bza-seedream-real/` | `synthmedia-output/bza-seedream-plugin/` |

### 这条实证覆盖了什么、没覆盖什么

- **覆盖**：插件工具面（`synthmedia_generate` → job 生命周期 → 产物落盘）→ bza 网关 → 火山 Ark `/images/generations` 图像路径的完整提交链路。至此 Seedream 侧「直连 wire」与「插件侧真实提交」双重实证均完成。
- **未覆盖**：**Seedance 视频的插件侧提交**——视频仍只有直连 wire 实证（见 `docs/paper-boat-bza-seedance-report.md`）；因用户已裁定不额外消耗视频额度，本轮不补。`bza-seed-tts` 保持锁定，未触碰。
