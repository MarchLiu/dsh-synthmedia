# bza Coding Plan Seed TTS 路由探测笔记（2026-11-17）

本轮为**纯探测与定性**：不改 config、不改共享报告、不 git commit、不调用 `synthmedia_generate`。
原始探测记录见 [job.json](<../synthmedia-output/bza-seed-tts-probe/job.json>)。

## 探测矩阵

认证头：`X-Api-Key: <redacted>`（取自活动凭据库 `/Users/mars/.dsh/.credentials-cli.yaml`，全程仅在内存，未回显未落盘）+ `X-Api-Resource-Id: seed-tts-2.0`。
请求体：`{"user":{"uid":"synthmedia"},"req_params":{"text":"纸船。","speaker":"zh_female_xiaohe_uranus_bigtts","audio_params":{"format":"mp3","sample_rate":24000}}}`。

| # | URL | Auth | 状态码 | 耗时 | Content-Type | 判定 |
|---|---|---|---|---|---|---|
| 1 | `https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional` | X-Api-Key | **401** | 0.24s | application/json | 路由**存在**（结构化错误码 45000010 `Invalid X-Api-Key`）——bza 的 plan key 在官方 host 上不被接受 |
| 2 | `https://llm.inner.bza.edu.cn/api/v3/plan/tts/unidirectional` | X-Api-Key | 404 | 0.03s | application/json | 无路由 |
| 3 | `https://llm.inner.bza.edu.cn/plan/api/v3/plan/tts/unidirectional` | X-Api-Key | 404 | 0.09s | (空) | 无路由 |
| 4 | `https://llm.inner.bza.edu.cn/plan/v3/plan/tts/unidirectional` | X-Api-Key | 404 | 0.05s | (空) | 无路由 |
| 5 | `https://llm.inner.bza.edu.cn/plan/tts/unidirectional` | X-Api-Key | 404 | 0.09s | (空) | 无路由 |
| 6 | `https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional` | **Bearer** | **400** | 0.09s | application/json | 对照：官方 host 明确要求 X-Api-Key（45000000 `app key not found in header or query`），Bearer **不被接受** |
| 7 | `https://llm.inner.bza.edu.cn/api/v3/tts/unidirectional`（额外变体） | X-Api-Key | 404 | 0.03s | application/json | 无路由 |
| 8 | `https://llm.inner.bza.edu.cn/openspeech/api/v3/plan/tts/unidirectional`（额外变体） | X-Api-Key | 404 | 0.02s | application/json | 无路由 |

所有 404 均由 `server: uvicorn` 返回 —— 说明 bza 网关是真实的 FastAPI 应用网关（非 TLS 直通），TTS 路由必须在网关侧显式实现，而当前不存在。

## 结论

### 1. 真实 host：官方 openspeech vs bza 代理？
- **官方路由存在且活跃**：`openspeech.bytedance.com/api/v3/plan/tts/unidirectional` 返回结构化 plan 网关错误（非 404）。
- **bza 网关没有 TTS 路由**（5 条候选 + 2 条变体全 404）。
- **关键事实**：bza plan key 在官方 host 上被拒（401 Invalid X-Api-Key）——说明 key 是**网关作用域**的，不能直连官方；而网关又不代理 TTS。
- 准确表述：**「这些候选路由在该网关/该 host 组合上均无可用通路」**。官方文档的 plan 网关（走 AFP 抵扣）未在 bza 域名上落地，或路径约定与本文档不同。

### 2. 鉴权风格
- 官方 openspeech：**只认 `X-Api-Key`**；`Authorization: Bearer` 返回 400「app key not found」。
- bza 网关的视频/图像接口用 Bearer（既往轮次已验证），但 TTS 无路由，无法在网关侧对比两种风格。
- 结论：TTS 表面如要打通，鉴权应为 `X-Api-Key` + `X-Api-Resource-Id`。

### 3. 响应形状与插件影响
- 未拿到 200，无法直接观察响应体。但官方文档口径明确为 **HTTP chunked 单向流式 POST**（另有双向/单向 WebSocket 两种流式端点），不是 submit→query 任务式。
- 现有 `bza-seed-tts` preset（`src/config.ts:449` 起）假设 Ark 任务式协议（`/api/v3/tts/submit` + `/api/v3/tts/query`，`protocolVerified:false`、`blockRealSubmit:true`）。
- **判断：不能只改 path/baseUrl 复用现有 preset。** 理由：
  1. 协议形状不同：流式 chunked 请求-响应 vs 任务式两段轮询；现有 Ark adapter 的 submit/poll 状态机、audio_url 下载逻辑都不适用。
  2. 路由根本不存在：即使改 path，bza 网关也返回 404。
  3. 正确路径是**新写一个流式适配器**（POST 全文 → 直接读 chunked 音频/JSON-base64 分片），且需要先确认托管位置（见下）。

### 4. 计费信号
- 未获得 200，无从观察 usage/token 字段。本轮**零计费**（无任何可能计费的请求完成）。

## 下一步建议（超出本轮边界）
1. **找 bza 确认 TTS hosting**：plan TTS 是否经 `llm.inner.bza.edu.cn` 代理？若是，索取确切 path（网关是 uvicorn，路由是显式注册的，可问运维）；若否，确认 plan key 是否有 openspeech 直连资格（当前 401 说明没有，可能需要 plan 控制台单独签发 openspeech 用 key）。
2. 若确认直连官方：需一枚 openspeech 侧有效的 `X-Api-Key`，然后按官方文档实现流式适配器。
3. `resolve-key.py`（probe 目录内）不含密钥，仅从活动凭据库解析后经环境变量传递，可复用于后续探测。

## 敏感信息自查
- 全部产物中 key 均以 `<redacted>` 表示；无 Authorization/完整签名 URL 落盘。
- 音频产物：无（无 200）。
