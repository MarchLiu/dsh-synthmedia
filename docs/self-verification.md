# 自验报告：生成任务子代理化 + 侧栏 Synthmedia 页签

> 范围：`/Users/mars/jobs/dsh-synthmedia` 仓库内的改动。本文件记录**每个需求的实现位置**、**验证证据**（命令 + 输出摘要）、**已知限制**、以及**需要人工完成的一步**。
> 基线：`pnpm run typecheck` 干净、`pnpm test` **192 pass / 0 fail**、`pnpm run build` 成功、`lib/` 与 `src/`+`client/` 同步。

---

## 0. 改动清单

| 类别 | 文件 | 说明 |
| --- | --- | --- |
| 宿主 | `src/task-agent.ts`（新增） | 产物路径 fence、目录 reveal 计划、`GET /synthmedia/api/artifact/<jobId>/<file>` 下载路由 |
| 宿主 | `src/jobs-endpoint.ts`（新增） | `GET /synthmedia/api/jobs`（页面 token 门控）— 取代轮询命令通道 |
| 宿主 | `src/index.ts` | 会话树祖先解析、artifact 路由注册、jobs 端点 + 页面 token 注入、命令 handler 传入 caller |
| 宿主 | `src/jobs.ts` | `JobRecord.owner/ancestors/toolCall`；`list({session})` 按**会话树**过滤 |
| 宿主 | `src/tools.ts` | `hostOwnerOf()`：从调用 agent 取 owner + 祖先链，随 `jobs.start()` 落盘 |
| 宿主 | `src/page/snapshot.ts` | `/synthmedia jobs`（caller 作用域）、`reveal`、`cancel` 的越权拦截 |
| 客户端 | `client/client.js` | better-sidebar 页签注册、引导区滚动补丁、任务面板（进度/耗时/错误/产物）、popup 菜单（下载/复制相对/复制绝对/打开目录/预览）、`withTimeout`、token 端点轮询 |
| 构建 | `lib/**` | 提交的构建产物（含新增 `task-agent.*`、`jobs-endpoint.*`） |
| 测试 | `test/task-agent.test.mjs`（新增 29 例）、`test/profile.test.mjs` | 见下 |
| 文档 | `README.md` | 子任务归属、页签、产物操作、降级、人工验证步骤 |
| 脚本 | `scripts/h3-origami-clip.mjs`（新增） | 操作脚本：向学院 hub 提交一条 H3 折纸任务并本地裁剪（`--prompt/--slug/--seconds`；仅从环境变量取凭据，不打印） |

`git diff --stat`：22 个已跟踪文件、+1743 / −30（另有上述新增文件与 `lib/` 产物），`designs/` 未纳入提交。

---

## 1. 需求 1：生成任务自动成为可观测的“子任务/任务代理”

**实现**
- `src/jobs.ts:137` `start(req, hostOwner)`：每次生成落盘 `owner`（发起会话）、`ancestors`（会话树祖先链）、`toolCall`，并有 `id/status/progress/artifacts/cancel` 全字段；`src/tools.ts:28` `hostOwnerOf()` 负责从工具调用上下文推导这三项。
- `src/index.ts:300` `resolveAncestors()`：沿 `ctx.agents` 的 `session.meta.parentSession` 上溯（≤8 层、环检测），因此**cybernetics 的 task agent 发起的生成，父会话也能看到**。
- 取消：5 个既有工具契约不变（返回 job 记录、结构化错误、无需凭据），`synthmedia_cancel` 仍按 job id 取消；父 agent 不必等待（`wait` 是显式选择）。

**为什么不是 `ctx.subagents`**：宿主 `ctx.subagents`（`@deepseek-ai/dsh-subagent`）的 `SubagentStartRequest` 要求 `prompt: ContentBlock[]` + `SubagentProvider.start()` 产出真正的 LLM 子代理运行（`SubagentRunId`/`SubagentResult`）。为一个媒体生成任务伪造一个 agent run 会污染 agent 归属与 cybernetics 的事件语义（`workflow`/`subagent/end` 会被当成真实子代理），违反“禁止伪造 subagent/workflow 事件”。因此选择**宿主 job registry 的归属增强**（`owner` + `ancestors` + `toolCall`），它是真实数据、可观察、可取消，且不假装是 LLM agent。此判断已写入 README 的兼容边界一节。

**证据**
- `test/task-agent.test.mjs`：`apply(): a child agent generation is listed by the parent session, not by others`（真实 `apply()` 激活 + 假 agent 树：子会话发起的 job 在父会话 `/synthmedia jobs` 里出现且 `owner=child-C`，外部会话为 0）；
- `JobManager.list session = own ∪ ancestors` 单测；旧版无 `owner` 的历史记录**不会**出现在任何 `session` 查询里（避免把别人的任务漏给新会话）。

## 2. 需求 2：sidebar「Synthmedia」页签

**实现** `client/client.js:1684` `svc.registerTab({...})`：
- `id: synthmedia-jobs`、`order` 靠后、`single`、`title/description` 走 locale（zh/en，`client/client.js:148` / `:263`）；
- 面板 `JobsPanel`（`client/client.js:1319`）：运行中优先，显示 `backend/model/modality`、进度条、耗时、状态、错误、产物列表；空态 `jobs.empty`；
- 轮询只在 `visible !== false` 时进行（2s），不可见即 `clearInterval`；
- 会话隔离：列表请求带当前会话 id，宿主按会话树过滤（`src/page/snapshot.ts:394`）。

## 3. 需求 3：兼容 better-sidebar（缺省不崩）

- 注册走 `ctx.get('betterSidebar')` 探测 + `ctx.inject(['betterSidebar'], …)` + 定时重试（页面加载早于服务就绪也不丢），`registerTab` 的 disposer 挂到 `ctx.effect`，热更新不重复注册。
- `betterSidebar` 缺席：页签不出现，其余功能（工具、设置卡、对话页「媒体服务」）照常；**主 client 的顶层 `inject` 不含 `betterSidebar`**，因此它未安装时不会卡住整条 client entry。
- 证据：`test/profile.test.mjs`（profile 条目断言）、`test/task-agent.test.mjs` 的激活用例（假 `ctx` 无 `betterSidebar` 时不抛错）、README 降级表。

## 4. 需求 4：兼容 cybernetics（归属自然落到 task agent）

- 归属 = 调用工具的那个 agent 的会话 id（`owner`）+ 其祖先链（`ancestors`）；cybernetics 的 round 里 task/verify/triage 都是独立会话，父会话（会话树根）因此能看到该任务。**未修改 dsh-cybernetics**。
- 证据：见 §1 的 `apply()` 端到端用例（子代理 → 父会话可见，外部不可见）。

## 5. 需求 5/6：产物 popup 菜单（右键 + 「⋯」）

菜单项与文案：`client/client.js:1417-1423`（下载 / 复制相对路径 / 复制绝对路径 / 打开所在目录 / 在 Sidebar 预览），locale 键 zh `:158`、en `:273`。

- **下载**：`src/task-agent.ts:165` `createArtifactRoute`，`Content-Disposition: attachment`、按扩展名给 `Content-Type`、`Cache-Control: no-store`；路径经 `fenceArtifactPath`（`src/task-agent.ts:53`）校验：必须落在 outputDir/dataDir、拒绝 `..`、绝对路径注入、符号链接逃逸、伪造 jobId。宿主无 `webServer` 时 `downloadBase` 不下发，前端隐藏下载项而不是报错。
- **复制路径**：`navigator.clipboard` + `withTimeout`（`client/client.js:1278`/`:1288`）；相对路径基于 `scope.cwd`；clipboard 不可用降级为可见提示（`jobs.noDownload` 等提示文案由 locale 提供）。
- **打开所在目录**：`/synthmedia reveal <jobId>` → `src/task-agent.ts:92` `planReveal`（darwin `open -R`、win32 `explorer /select,`、linux `xdg-open`），**只允许 outputDir 内**，spawn 参数数组、无 shell 拼接。
- **预览**：点击文件名或菜单「在 Sidebar 预览」→ `onOpenFile(绝对路径)` 打开 better-sidebar 编辑器页签；`onOpenFile` 缺失时降级为复制路径提示。
- **证据**：`test/task-agent.test.mjs` 中 artifact 路由用例（200 + `video/mp4` + attachment 头；traversal / 伪造 id 一律 404 且不泄露真实路径；未知路径 404；**不存在未鉴权的 list 端点**）、`planReveal` 三平台用例、命令越权用例（`jobVisibleTo` 拦外部会话）、客户端模板断言（菜单五项、`onOpenFile` 预览路径、相对/绝对路径复制）。

## 6. 需求 2（补充修复）：轮询不得污染会话记录

**问题**（用户截图）：对话里每 2 秒出现 `>_ synthmedia · 当前没有生成任务。`。
**根因**：宿主 `@deepseek-ai/dsh-commands` 的 `execute()` 对**每次**命令执行都追加 `command/run` + `command/done` 会话事件（`source:{kind:'user'}`），页签用 `ctx.remote.commands.execute('/synthmedia jobs')` 轮询，于是每个 tick 写两行可见记录、会话日志无界增长。
**修复**：
- 宿主新增 `src/jobs-endpoint.ts`：`GET /synthmedia/api/jobs?token=…&session=…`，token 为**每次激活随机生成**，通过 `webserver/index-inject` 的 `global` 行注入到页面（`globalThis.__SYNTHMEDIA_JOBS_TOKEN__`），用 `timingSafeEqual` 比对；回答走与命令**同一条** `runPageCommand` 代码路径，JSON 形状、会话树过滤、`downloadBase` 不会漂移；只读（reveal/cancel 仍是显式点击，一次一条命令事件是预期的）。
- 客户端：有 token 时用 `fetch` 轮询（每次挂载、页签重新可见、面板「刷新」按钮 + 可见时 2s），**命令通道不再挂任何定时器**——它只按需读一次（挂载/重新可见/刷新），并把 reveal/cancel 保留为用户点击触发。
- 证据：`test/task-agent.test.mjs` 新增 4 例（缺 token 403、错 token 403、缺 session 400、非 GET 405 且不执行命令；200 返回命令 JSON 并只带 caller 会话；命令失败 → 500 且不泄露堆栈；注入行形状）+ 客户端模板断言（`__SYNTHMEDIA_JOBS_TOKEN__`、`/synthmedia/api/jobs?token=`、`canFetch` 分支、可见性门控）。

**这轮回归发现并修掉的真 bug**：端点最初把 `'/synthmedia jobs'` 整串传给 `runPageCommand`，而命令面收到的是**已剥掉命令名**的参数（`' jobs'`），所以真实宿主里端点会返回 500「未知子命令」。新增的 apply 级往返用例（注入 token → `GET /synthmedia/api/jobs?session=…` → 200 + 子会话任务 + `downloadBase`）立刻暴露了它，现改为传 `'jobs'`，用例通过。

额外证据（行为级，非模板断言）：`start(): a generation returns while the task is still running (parent is not blocked)` —— 假 minimax-official 服务保持 `running`，`jobs.start()` 在 5s 内返回 `running` 记录、`get()` 之后仍在跑、`cancel()` 可取消；`tool contract: generate returns immediately, only wait blocks` —— `synthmedia_generate` 只调 `jobs.start`，`jobs.wait` 只在 `synthmedia_wait` 里出现。即需求 1 的「父 agent 不被阻塞」有运行时证据。

**生效条件**：宿主半改动 → 需重启 DSH；客户端改动 → 硬刷新页面。两者都做之前，页签的命令通道会按需读一次（不再每 2 秒打印重复行，因为定时器已移除）。

## 7. 引导区「+ 菜单被裁切」补丁

原生 `@deepseek-ai/dsh-client-ui-sidebar-right` 的引导区是 `min-height:100%` + `justify-content:center` + body `overflow:hidden`，多出一行就会两端被裁且无法滚动。插件注入一条 `flex-start` + `overflow-y:auto` 的样式（幂等：`document.querySelector('style[data-dsh-synthmedia="guide-scroll"]')`，`client/client.js:1573`），并在卸载时移除。
用真实类名（`P3OORG_tabBody` / `geFEbW_guide`）在 `/tmp/guide-probe/*.html` 复现验证：未打补丁 → 顶部条目被裁且不可滚；`flex-start` → 首位可见且可滚。`justify-content: safe center` 在 Chromium 中 `CSS.supports` 通过但**仍会裁切**，因此未采用。这是对上游布局缺陷的兜底，非本插件 bug。

## 8. 验证命令与结果

```
pnpm run typecheck        # tsc --noEmit，无输出 = 干净
pnpm test                 # 194 pass / 0 fail（test/*.test.mjs，共 22 个文件）
pnpm run build            # tsc + node scripts/build-client.mjs 成功，lib/ 更新
```

补充（真实宿主，未重启时为旧宿主）：
- `GET /synthmedia/api/jobs`（无 token）→ 403；带 token + session → 200 JSON；
- `GET /synthmedia/api/artifact/<jobId>/<file>` → 200 `video/mp4` + attachment；`../`、伪造 id → 404 `not found`；
- 历史不裁剪：完成的任务保留 `job.json` 与产物，面板「运行中优先 + 最近完成」排序，「加载更早的任务」把 pageSize 从 50 翻倍到 200（`--limit` 只在翻页时下发，普通列表对旧宿主保持兼容）。
- 宿主版本比页面旧（404）与宿主重启后旧 token 失效（403）都走同一条降级：本次挂载内切命令通道读一次，不再把错误留在屏幕上。
- 宿主重启后旧 token 失效的降级：端点回 403 时面板在同一挂载内切回命令通道（只读一次、不挂定时器），因此页面不刷新也不会卡在报错；模板断言 `res.status === 403 && typeof execute === 'function'` 与 `setTokenStale(true)` 覆盖此路径。
- apply 级往返：`webserver/index-inject` 的行被真实 `apply()` 推入注入表（`kind:'global'`、`__SYNTHMEDIA_JOBS_TOKEN__`、32 位 hex），用该 token + 父会话 id 请求端点得 200 且只列出子会话任务；同长度伪造 token 403；别的会话 0 条。
- 客户端包校验：当前下发的 bundle 已含 `__SYNTHMEDIA_JOBS_TOKEN__`、`/synthmedia/api/jobs?token=`、`if (!canFetch || visible === false) return undefined;`（定时器只属于 token 端点）与「刷新」按钮（`rev=2bfbe9896773`）。

## 9. 已知限制

1. **需要重启宿主要一次**：新增宿主路由与 token 注入只在重启后生效；重启前页签退回命令轮询（会打印重复行）。
2. 页签轮询间隔 2s 内不区分“任务数变化”，全量刷新列表（当前实现足够，任务量级在几十条）。
3. 预览依赖 better-sidebar 的 `onOpenFile`；编辑器不支持该扩展名时会显示其自身的“不支持”占位，本插件不做二次转换。
4. artifact 路由不带会话鉴权（内容型 capability URL：jobId 为随机 UUID，且只暴露 outputDir 内文件）；如需要可再叠加 token 门控，但会让「浏览器直接打开下载链接」失效。
5. `designs/` 为设计稿目录，未纳入本次改动/提交。

## 10. 需要人工完成

1. 重启 DSH（宿主半改动）：本轮之后请重启一次并硬刷新浏览器。
2. 在侧栏「+」菜单打开 Synthmedia 页签，确认：页签可滚、空态/运行中列表正确、产物菜单五项可用、点击文件能在 sidebar 预览。
3. 确认对话区**不再**出现 `>_ synthmedia · …` 的重复行。

## 七B、工具面接入预设（用户操作侧，仓库外只读说明）

工具不可见的机制（读宿主源码确认）：预设的 `plugins` 列表就是该会话的工具面——每个工具是一个挂载的服务（`standard.patch.yml` 逐个挂 `@deepseek-ai/dsh-tool-*`），第三方插件工具必须把插件本体挂进预设（如 `dsh-synthmedia`），其 `apply()` 才会在会话作用域向 tools 座席注册。

已代用户创建 `~/.dsh/.agent-presets/synthmedia-studio/`（preset.yml + agent.cordis.yml）：标准编码面 + dsh-synthmedia 插件条目 + persona 纪律（报成本/≤5s 720p/排队不取消）。已知风险：插件在宿主级与预设级双挂载，若重启后报工具重复/冲突，回退方案是去掉预设中的插件条目（改走宿主级注册 + 预设不设 deny）。需要用户：重启 DSH → 新会话选「SynthMedia 工作台」。

## 七A、首尾帧能力（本轮追加，代码就位 / wire 未实测）

- 类型：`GenerationRequest.images: {role:'first_frame'|'last_frame', dataUri}[]`（`src/types.ts`），`JobRecord.frameImages` 只记角色不记字节。
- 工具面：`synthmedia_generate` 增 `firstFrame`/`lastFrame`（绝对路径，≤8MB，magic bytes 验 jpg/png/webp，data URI 内联；坏路径/假图/超限 → 结构化错误且零 HTTP）。
- wire：`minimax-video-compatible`（zgci hub H3 与 MiniMax 官方 preset 共用）把帧拼进 `content`（`role` 字段），**有图时省略 ratio**（API 按首帧定）。0/1/2 张图对应官方文档的文生/首帧/尾帧/首尾帧四种模式。
- 证据：apply 级测试用假 H3 服务器断言提交体 content=[text, first, last]、data URI 前缀、`ratio` 缺席、`frameImages=['first_frame','last_frame']`；失败输入不触网。
- **未实测（真实付费）**：hub 的 MiniMax-H3 是否透传 `role`、模型 id 是否需要 `H3-Base-FL2VA` 变体——等用户批准一次 4s/720p 最小探针。
- Ark seedance 不受影响（首尾帧仍走 seedance_frames.sh 直连）。

## 七、本机排查发现的「刷新无效」根因（已修，2026-11-17 晚）

用户反馈：硬刷新后页签仍无自动进度。实机取证：宿主其实**已重启过**（`/synthmedia/api/jobs` 返回 403 而非 404，路由是活的），但页面里没有 token 全局。根因有两个，都是绑定错了 ctx：

1. **index-inject 监听绑在了工具 ctx**：宿主在 **webServer 自己的 ctx** 上 `emit('webserver/index-inject')`（`dsh-client-connection` 也是在 `inject(['webServer'], webCtx => webCtx.on(...))` 里绑的）。已改为 `webCtx.on(...)`。
2. **webServer 服务读的是工具 ctx**：`readService(ctx,'webServer')` 永远 undefined，路由其实来自另一处；已改为直接读 `webCtx.webServer` 属性（并保留 readService 兜底）。

回归护栏：apply 级测试现在把 **web ctx 建成独立 emitter**（`inject(deps)` 按 `webServer` 分流），断言注入行必须出现在 webCtx 监听里、`downloadBase` 必须真取到 origin——这两条在旧实现下都会失败。

## 八、人工验收的两种状态（说明为什么「刷新」和「重启」不是同一件事）

| 用户动作 | 生效内容 | 页签表现 |
|---|---|---|
| 只硬刷新浏览器 | 新客户端（无定时器轮询、刷新按钮、403/404 降级、历史翻页按钮） | 列表可见、无报错、不再打印重复行；**无 2s 自动刷新**（旧宿主没有 token 端点） |
| 再重启 DSH 宿主 | 新宿主（`GET /synthmedia/api/jobs` + 页面 token 注入 + `--limit` 解析） | 页签实时进度条、可见时 2s 自动刷新、运行中优先排序 |
