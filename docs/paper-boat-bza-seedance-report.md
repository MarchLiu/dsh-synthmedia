# 纸船验证报告：synthmedia × bza Coding Plan（火山 Ark 兼容网关）Seedance

日期：2026-11-17　工作区：`/Users/mars/jobs/dsh-synthmedia`

## 结论先行

1. **Seedance 跑通**：`doubao-seedance-2.5` 经 `https://llm.inner.bza.edu.cn/plan/v3` 真实提交成功，
   端到端 **约 2 分 41 秒**（提交 07:20:56Z → 终态 succeeded 07:23:37Z），产出 1280×720 / 24fps /
   5.06 s / 5,155,070 字节的 h264+aac mp4，ffprobe 可正常解析，抽帧内容确为纸船题材。
   任务 id：`cgt-c-20261117152106-dtbms`。
2. **Ark 协议验证通过**：请求/响应 wire shape 与官方 Ark task API 完全一致
   （POST `/contents/generations/tasks` → `{"id"}`；GET `.../tasks/{id}` →
   `{status, content.video_url}`；无额外专有字段）。据此把 `bza-seedance` preset 的
   `protocolVerified` / `liveVerified` 置为 `true`（含证据注释），`pnpm test` 163 项全过。
3. **本轮未验证 / 遗留**：
   - **插件工具面解锁（重载前如此，重载后已闭环）**：重载前 DSH web 宿主进程加载的仍是旧 lib，
     `synthmedia_generate` 现场曾返回 `E_PROTOCOL_UNVERIFIED`（job `e50e2130-…`，提交前即拦截、未发生网络请求）。
     2026-11-17 经 `plugin_manager` 对 `include:synthmedia` 禁用→启用完成重载后，能力表已转
     `protocol-verified`、BLOCKED 消失（证据见「重载闭环」小节）。这是进程内存态问题，不是配置问题。
   - 计费/抵扣信息：tokens 有记录 —— 响应含 `usage.completion_tokens = 108900`、`total_tokens = 108900`
     （见 `synthmedia-output/bza-seedance-real/job.json` 与 `synthmedia-output/bza-status-latest.json`）；
     **待确认的只是 tokens→AFP/计费的换算口径**，bza Coding Plan 如何把 108900 tokens 折算成抵扣仍未知。
   - **音轨未达成项（用户已豁免）**：目标要求无音频，但本次产物实际含 aac 32kHz 双声道音轨
     （且响应记录 `generate_audio: true`）。用户已裁定接受现有带音轨产物、豁免该验收项，
     **不补跑**（避免产生第二次视频计费）。
   - 1080p、Seedream（图像）、Seed TTS（音频）未实测；`bza-seedream` / `bza-seed-tts` 保持封锁。

## 三路对比

| 后端 | protocol | 模型 | 分辨率 | 时长 | 端到端耗时 | 文件大小 | 真实提交 | 备注 |
|---|---|---|---|---|---|---|---|---|
| local-h3（历史） | videogen-task-api（本地 vLLM-Omni 生态） | minimax-h3 | 1344×768 | 4.46 s | 164–303 s（4090 单卡，docs/offline-h3.md 估算档） | 2,120,746 B（paperboat-native-1344.mp4） | ✅（2026-11-14 本地产物） | 同题材非同 prompt 文本，仅定性参考；本轮 farm 零服务未实跑 |
| zgci-h3 / hub h3（历史） | openai-video-compatible | minimax-h3 | 1344×768 | 4.46 s | 29 m 36 s（10:42:38Z→11:12:14Z，2026-11-12） | 1,426,282 B | ✅（remoteId `task_7pxiHV…`） | prompt 与本次完全相同：「一只纸船在安静水面上缓慢前行，无人物」 |
| **bza-seedance（本次）** | volcengine-ark-compatible | doubao-seedance-2.5 | 1280×720（720p 16:9） | 5.06 s | **2 m 41 s** | 5,155,070 B | ✅（`cgt-c-20261117152106-dtbms`） | 直接以插件同款 wire shape 提交；**含 aac 32kHz 双声道音轨（目标要求无音频，属未达成项，用户已豁免，不补跑，见上）** |

hub h3 分辨率 1344×768 为 ffprobe 实测（`synthmedia-output/zgci-real/65e7c85d-1a0f-49dd-90bb-fe046d9a4e96/result.mp4`，1,426,282 B，h264 1344×768 24fps，duration 4.458s），2026-11-17 复核；早前误记的「1280×720*」已勘误。

速度对比：seedance（2m41s）≈ hub h3（29m36s）的 **1/11**；文件体积最大（码率 ~8.2 Mbps）。

## 本次请求体与响应关键字段（脱敏）

请求（POST `{base}/contents/generations/tasks`，`Authorization: Bearer <SYNTHMEDIA_BZA_API_KEY>`，Key 从 DSH 凭据库解析、全程未回显）：

```json
{"model":"doubao-seedance-2.5","content":[{"type":"text","text":"一只纸船在安静水面上缓慢前行，无人物"}],"ratio":"16:9","duration":5,"resolution":"720p"}
```

响应：
- 提交：`HTTP 200` → `{"id":"cgt-c-20261117152106-dtbms"}`
- 轮询：`{"status":"running"}` ×N → `{"status":"succeeded","content":{"video_url":"https://ark-acg-cn-beijing.tos-cn-beijing…(签名 URL，已截断)"}}`
- `usage` 字段：**有** —— `{"completion_tokens": 108900, "total_tokens": 108900}`；尚未确认的是 tokens→AFP/计费的换算口径。原始响应已存 `synthmedia-output/bza-submit-response.json`（无敏感头）与 `synthmedia-output/bza-seedance-real/job.json`（video_url 已含在记录中，为一次性签名 URL）。

## 解除封锁的配置 diff

官方开关确认：`src/backends/ark.ts:224` `realSubmitAllowed = cfg.blockRealSubmit !== true && cfg.protocolVerified === true`；
preset 通过 `src/config.ts` 的 `raw?.['bza-seedance']` 覆盖或直接改 preset 均可。本次改的是 preset 本体（最小范围，仅 bza-seedance）：

- `src/config.ts`（bza-seedance preset，约 :417-421）：
  - `protocolVerified: false → true`（附注释：2026-11-17 wire shape 确认）
  - `liveVerified: false → true`（附注释：task `cgt-c-20261117152106-dtbms`，doubao-seedance-2.5 720p/16:9/5s）
- `test/unit.test.mjs` :40-46、`test/bza.test.mjs` :325-345：把「出厂锁定」断言随验证事实同步
  （seedance → true/允许真实提交；seedream / seed-tts 保持 false/封锁）。
- 未改动：`bza-seedream`、`bza-seed-tts`、`minimax-relay`、dashscope、gemini 等其它后端；`docs/seedance_demo.py` 未动。
- `pnpm build` 已重建 `lib/`（`lib/config.js` 中两项均已为 true，node 直读验证过）。
- 未 git commit/push，改动留在工作区。

## 坑与风险

- **内网可达性**：`llm.inner.bza.edu.cn` 解析到 10.1.132.49/.60，本机可达（无鉴权 HEAD 返回 401，
  ~20ms）。离开该内网即不可用，不能当作公网 Ark 端点使用。
- **轮询/超时**：preset `timeoutMs=1_800_000`、`pollIntervalMs=10_000`，本次 2m41s 远低于上限；
  hub h3 曾跑 29m36s，超时预算对 Ark 网关应够用。
- **计费口径待确认**：响应 `usage.completion_tokens = 108900`、`total_tokens = 108900`（job.json :20-22），
  tokens 有记录；bza Coding Plan 的 tokens→抵扣换算口径仍未知。本次生成了 1 条（另有 1 条
  工具面被拦截、未产生计费）。
- **音轨未达成项（用户已豁免）**：目标要求无音频，本次产物实际含 aac 32kHz 双声道音轨
  （ffprobe 实测；响应记录 `generate_audio: true`，即本次默认开了音频）。用户已裁定
  **接受现有带音轨产物、豁免该项验收，不补跑**（避免产生第二次视频计费）。
- **运行中宿主滞后（重载前状态，已消除）**：lib 已重建但宿主未重载时，`synthmedia_capabilities`
  仍显示 `protocol-UNVERIFIED / real-submit:BLOCKED`，工具面 `synthmedia_generate` 仍被拦截 —— 这是
  进程内存态问题，不是配置问题。2026-11-17 经禁用→启用 synthmedia 重载后该滞后已消除
  （证据见「重载闭环」小节）。

## 自验清单

| 项 | 证据 |
|---|---|
| 解锁配置生效于仓库代码 | `node -e "…defaultConfig()"` → `{"protocolVerified":true,"liveVerified":true}`（lib/config.js 直读） |
| 能力表不再显示 BLOCKED（重载后） | 重载后 `synthmedia_capabilities` 输出：`bza-seedance volcengine-ark-compatible: doubao-seedance-2.0,doubao-seedance-2.0-fast,doubao-seedance-2.0-mini,doubao-seedance-2.5 [video] online protocol-verified eco:seedance`（`protocol-UNVERIFIED` / `real-submit:BLOCKED` 均已消失，详见「重载闭环」小节） |
| 测试全绿 | `pnpm test` → pass 163 / fail 0（含更新后的 bza 断言：realSubmitAllowed=true） |
| mp4 可解析 | ffprobe：h264 1280×720 24fps yuv420p + aac，duration 5.056s，size 5,155,070 |
| 抽帧证据 | `synthmedia-output/bza-seedance-real/frame_{first,mid,last}.png`（md5 各不相同；中帧目视为纸船+水面+逆光） |
| 数字可溯源 | 时间戳/字节数见 `synthmedia-output/bza-seedance-real/job.json`、`bza-run-timestamp.txt`、`bza-status-latest.json`；hub 历史见 `synthmedia-output/zgci-real/65e7c85d…/job.json`、`zgci-real-runs.json` |
| 无密钥泄漏 | 提交脚本内存中取 Key、不打印；本报告与产物 JSON 均只含 Key 的环境变量名，无 Key 值/Authorization 头 |

## 产物索引

- 视频：`synthmedia-output/bza-seedance-real/result.mp4`（+ 3 帧 PNG + `job.json`）
- 提交/轮询原始记录：`synthmedia-output/bza-submit-response.json`、`synthmedia-output/bza-status-latest.json`
- 工具面拦截证据：job `e50e2130-98f7-4364-97ae-a886fe03e773`（E_PROTOCOL_UNVERIFIED，宿主旧内存态；该拦截于 2026-11-17 重载后消失）

## 重载闭环（2026-11-17 15:5x）

**重载动作**：经 `plugin_manager` 对插件 `include:synthmedia` 执行两步重载：

1. `enabled=false` → 响应 `changed: true, application: "applied", warnings: []`
2. `enabled=true` → 响应 `changed: true, application: "applied", warnings: []`

**重载后能力表（synthmedia_capabilities 原文，bza-seedance 行）**：

```
bza-seedance volcengine-ark-compatible: doubao-seedance-2.0,doubao-seedance-2.0-fast,doubao-seedance-2.0-mini,doubao-seedance-2.5 [video] online protocol-verified eco:seedance
```

`protocol-UNVERIFIED` 与 `real-submit:BLOCKED` 均已消失。

**其它后端对照（未受影响，符合最小改动要求）**：`bza-seedream` / `bza-seed-tts` / `minimax-relay` /
`dashscope-*` / `gemini-*` / `openai-images` 仍为 `protocol-UNVERIFIED real-submit:BLOCKED`。

**tools 行前后差异**（同一时刻观察到的内存态 vs 配置态证据）：

| 时点 | tools 行 |
|---|---|
| 重载前 | `tools: ffmpeg✗(disabled) imagemagick✗(disabled) gimp✗(disabled) blender✗(disabled)` |
| 重载后 | `tools: ffmpeg✓ imagemagick✓ gimp✓ blender✓` |

说明旧内存态连 `enabledTools` 都没有按配置生效；重载后按配置生效。今后看到两套 tools 说法
以本节时点区分，不再视为矛盾。

**仍未完成的一件事**：尚未通过 `synthmedia_generate` 真实提交过一条 Seedance 视频（本次视频是
直连 wire 提交）。插件侧端到端提交待后续用同适配器的 seedream/seed-tts 实测，或另一次经用户
批准的调用补齐。

**当前结论口径**：网关 + Ark 协议真实可用已实证（直连）；插件侧封锁已解除且能力表已可见
（重载后）；但插件侧的真实提交尚未实证——不写「插件端到端已闭环」。

## 勘误记录（2026-11-17 复核）

1. **usage 说法**：原「响应体无 usage 字段，计费口径未知」不实。依据
   `synthmedia-output/bza-seedance-real/job.json`（:20-22）与 `synthmedia-output/bza-status-latest.json`：
   `usage.completion_tokens = 108900`、`total_tokens = 108900`。已改为「tokens 有记录（108900），
   待确认的只是 tokens→AFP/计费的换算口径」（结论先行、响应字段节、坑与风险节同步修改）。
2. **hub h3 分辨率**：原「1280×720*」错误。依据 ffprobe 实测
   `synthmedia-output/zgci-real/65e7c85d-1a0f-49dd-90bb-fe046d9a4e96/result.mp4`（1,426,282 B）：
   h264 1344×768 24fps，duration 4.458s。已改为 1344×768 并删除 `*` 含糊标注。
3. **音轨验收口径**：目标要求无音频，本次产物实测含 aac 32kHz 双声道（ffprobe：stream#1，
   sample_rate 32000，channels 2；响应 `generate_audio: true`）。已明确标注为**未达成项；
   用户已裁定接受现有带音轨产物、豁免该项验收，不补跑**（结论先行、三路对比表、坑与风险节同步）。
4. **其它数字复核**：端到端 2 m 41 s（07:20:56Z 提交 → 07:23:37Z succeeded，与
   `bza-run-timestamp.txt`/job.json 一致）、文件 5,155,070 B、帧 PNG md5 各不相同
   （sha256: first 833751dd… / mid f5f07c64… / last 6105173b…）、result.mp4 md5
   bb9f8f92abb3596a26824889be8aed68 —— 均与原始记录一致，未改。
5. 未改动项说明（本条本身也已被后续进展更新）：原文「运行中宿主未重载、插件侧仍 BLOCKED」
   在 2026-11-17 15:5x 完成禁用→启用重载后已不再成立——能力表转 `protocol-verified`、BLOCKED
   消失（见「重载闭环」小节）；历史叙述均带时间限定。
