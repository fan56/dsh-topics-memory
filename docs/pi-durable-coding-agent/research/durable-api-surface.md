# durable API 面与 stable coding agent 能力映射（R1）

- Ticket: `wayfinder/tickets/001-r1-durable-api-surface.md`
- 分支: `research/r1-durable-api-surface`（基于 `feat/durable-coding-agent` 线）
- 日期: 2026-10-08；版本基线: `@earendil-works/pi-durable@1.1.0`（`packages/durable/package.json:3`，CHANGELOG `packages/durable/CHANGELOG.md:5`，2026-10-07 发布）
- 方法: 只读源码研究，未运行构建/测试。所有引用为 `packages/durable` 与 `packages/coding-agent` 源码的 `file:line`（相对两个包根）。

## 0. 结论速览

1. durable 的核心 API 面已经完整覆盖 coding agent 的"运行时主干"：提交/队列/steer、流式 partial、工具进度、compaction、model/thinking 配置、usage、abort、fork、子代理、观察面（viewState/watch/watchEvents/taskGraph）。消费端 `packages/coding-agent/src/experimental/durable/` 用 ~1400 行搭出了一个可用的 TUI，证明主干可用。
2. 缺口集中在"宿主应用层"能力：session 元数据与列表、树导航、bash 直跑通道、扩展生态（MCP/skills/prompt templates/slash commands/扩展 UI）、虚拟模型、cache warmer、图片输入、统计/导出。这些要么自建、要么改 harness，见 §4。
3. 事件流 `watchEvents` 与 stable `AgentSessionEvent` 结构对齐但有语义差：派生自 commit（有 100ms 级节流粒度），无 `agent_settled`/`bash_execution_update`/`summarization_retry_*` 三组事件，见 §3.2。

## 1. 稳定性标注

- 整包标注 **Experimental**："The API changes without notice between releases."（`README.md:3`）。这是全局前提，G1 分期不能假设任何 API 冻结。
- 规范层：`docs/spec.md` 是 normative specification（`README.md:607`），源码注释大量以 spec §编号 引用（如 `harness/live.ts:70` 引 §8.2、`harness/compaction.ts:99` 引 §8.7、`harness/view.ts:25` 引 §9.3、`harness/task-graph.ts:18` 引 §9.5、`harness/events.ts:55` 引 §9.4）。
- 二级标注：`watchEvents`/`AgentEvent` 额外标注 Experimental（`README.md:368-370`，"For consumers that want coding-agent style events"）；storage 层有正式 conformance suite（`README.md:556-570`，`src/testing/storage-conformance.ts`、`src/testing/env-conformance.ts`），是包内最接近"契约化"的部分。
- 节流默认值等行为参数集中在 `harness/agent.ts:19-36`（`DEFAULT_RETRY_POLICY`/`DEFAULT_COMPACTION_POLICY`/`DEFAULT_PROGRESS_POLICY`），settings 覆盖见 §2.1。

## 2. durable 对外 API 面

### 2.1 Harness 与 HarnessOptions

入口 `Harness.open(storage, options, context)`（`harness/harness.ts:411-436`）：校验 registry 含三个内置任务（`harness.ts:418-424`，缺则抛错——registry 必须来自 `createRegistry()`），随后 reconcile 存活 `running` 任务为 `pending`（`harness.ts:234-236`）。`resume()` 启动调度器，幂等（`harness.ts:238-241`；哪些调用会自动 resume 见 `harness/types.ts:572-578` 的接口注释）。

`HarnessOptions`（`harness/types.ts:453-469`）：`models`（pi-ai `Models`）、`registry`（`RegistryReader`，可运行中变化）、`settings`（每次使用时读取、永不存储，getter 可做成活的，`README.md:214-233`）、`env`（按 conversation+cwd 构建执行环境，`README.md:237-249`）、`conversationCreated`（每个创建/fork conversation 的 commit 内回调，用于保证自定义文档存在，`README.md:526`）、`now`、`onReport`。

`HarnessSettings`（`harness/types.ts:414-429`）：`extensions`（默认选择）、`stream`（timeoutMs/maxRetries/headers/cacheRetention/deferred 等，透传 pi-ai，`types.ts:361-371`）、`retry`、`compaction`、`progress`（partial/output 提交节流）、`toolExecution`（parallel/sequential）、`steeringMode`/`followUpMode`（all / one-at-a-time）、`contextRetentionMs`。

Harness 接口其余成员（`harness/types.ts:572-614`）：`root()`/`conversation(id)`/`createConversation()`、`getTask()`、`inspect()`（活跃任务+未决 submission 快照，不跑任何代码）、`submission(id)`（重开进程后重取）、`abortSubmission()`、`abortTask()`、`waitForTask()`、`waitForIdle()`、`usage()`（全 Session 汇总）、`taskGraph()`/`watchTaskGraph()`。

### 2.2 Conversation（17 个方法）

接口定义 `harness/types.ts:514-567`；实现 `harness/harness.ts:83-163`。

- 身份与配置：`agent(context)`（按当前 registry+settings 解析，`harness.ts:92-94`）、`configure(change)`（单 commit 修改 `pi.agent`，`harness.ts:96-98`）。
- 输入：`submit(submission, context)`（见 §2.3）、`reset(handoff?)`（本质是提交一条 `pi.reset` write，`harness.ts:110-117`；busy 时排到下一 boundary，`README.md:327-334`）、`compact(instructions?)`（创建手动 compaction 任务，`harness.ts:104-108`）。
- 事务与读：`commit(change)`、`context(context, {at})`（原始活跃 transcript + 推导出的模型上下文；`at` 即 fork 预览，`types.ts:502-511`）、`entries(query, limit, cursor)`（fork 感知的历史分页，默认新→旧，`README.md` CHANGELOG `ScanOrder`）、`fork(at, options, context)`、`abort(context, {background})`、`waitForIdle()`。
- 观察面：`viewState()` / `watch()`，见 §2.7。

### 2.3 Submission 与 inbox 语义

`SubmissionDraft`（`harness/types.ts:55-70`）：`{type:"input", content, whenBusy?: "steer"|"followUp"|"reject"}` 或 `{type:"write", entry}`，均可带 `requestId`（幂等重试，`README.md:115-124`；实现 `harness/submissions.ts:155-163`）。`Submission` 句柄：`status()`/`wait()`/`abort()`（`types.ts:79-84`）。

准入逻辑 `admitSubmission`（`harness/submissions.ts:148-207`）：busy 或 inbox 非空 → 入队 `pi.inbox`；`whenBusy:"reject"` 抛 `ConversationBusy`（`submissions.ts:166`）；idle input 直接落 `pi.user` entry 并 `startRun`；idle write 直接 append（head 早于活跃区间的 write 判 `stale`）。

边界放置 `applyBoundary`（`harness/inbox.ts:65-106`）：`postTools` boundary 放所有 write + 首个/全部 steer；`final` boundary 追加首个/全部 followUp；`write` 先于 user 项。abort 时 `withdrawQueuedInputs` 只撤 input、write 保留（`inbox.ts:124-131`）。

### 2.4 内置文档（五个 `pi.*` doc）

| kind | 定义 | 内容 |
|---|---|---|
| `pi.agent` | `harness/agent.ts:42-50` | `AgentState`：model/thinkingLevel/extensions(数组或 add/remove)/tools(数组或 remove)/instructions/cwd（`types.ts:307-319`）。`history:"rewindable"`, `fork:"asOf"`——fork 继承分叉点时的 agent；task-owned 子会话拷贝 owner 的 agent（`agent.ts:141-147`）。 |
| `pi.live` | `harness/live.ts:63-76` | `LiveState`（`live.ts:44-61`）：`run{taskId,inputs}`、`generation{attempt,message,retry,deferred}`、`tools:ToolSlot[]`（callId/name/status/output/details/diagnostics/entry，`live.ts:11-30`）、`compactions:CompactionStatus[]`（`live.ts:33-41`）。idle 时必须是空基态（`live.ts:70-75` 的 REMARK）。 |
| `pi.inbox` | `harness/inbox.ts:16-24` | `InboxItem[]`：steer/followUp 带 `content`，write 带 `entry`（`inbox.ts:8-12`）。 |
| `pi.provider` | `harness/provider.ts:12-20` | 持久 UUIDv7 `sessionId`，转发给 pi-ai 做 prompt-cache/亲和；fork/子会话拿新身份（`README.md:113`）。 |
| `pi.usage` | `harness/usage.ts:14-22` | `{models:{"provider/modelId":Usage}, tools:{name:Usage}}` 两桶累计；失败/中止尝试也计（`README.md:530`，记账点 `generation.ts:654-661`）。 |

宿主自定义文档：`defineDoc`（scope conversation/session/task、`history:"latest"|"rewindable"`、`fork` 策略，`README.md:511-518`）+ `harness.watchDoc()`/`snapshot()`/`documentState()`（`README.md:526`）。

### 2.5 内置任务与 hooks

- `pi.generation`（`harness/generation.ts:115-282`）：checkpoint 五相 `prepare/request/retry/poll/tools`（`generation.ts:51-90`）。prepare 渲染位置性 system prompt + 工具清单并按阈值决定 blocking/background compaction（`generation.ts:125-183`、`306-323`）；request 流式调用，partial 按 `progress.partialIntervalMs` 节流提交（`generation.ts:364-416`）；classify 处理 deferred（poll 相）、toolUse（startToolRound）、answer（final boundary + onYield 续跑，`generation.ts:513-538`）、context overflow（compact 后重试一次，`generation.ts:461-476`）、可重试错误（retry 相 + durable backoff，`generation.ts:477-505`）；tools 相拥有并等待本轮 `pi.tool` 任务（顺序轮逐个启动，`generation.ts:233-251`）；`finishToolRound` 应用工具 control：`terminate`/`handoff`/`addTools`/queued reset（`generation.ts:597-648`）。
- `pi.tool`（`harness/tool.ts`）：intent 先落 commit 再执行；中断后仅 `replay:"safe"` 的工具重跑，否则模型收到 `interrupted` 错误结果（`README.md:168`）；`ToolRegistration` 扩展字段：`replay`/`executionMode`/`prepareArguments`/`outputLimits`（`types.ts:212-236`）。
- `pi.compaction`（`harness/compaction.ts:103-228`）：`select`（选切点 `selectCut`，`compaction.ts:255-273`）→ `summarize`（固定结构化摘要 prompt，`compaction.ts:61-96`）→ `retry`。blocking（generation 拥有）直写 summary entry；conversation-owned 经 write submission 放置，busy 时排到下一 boundary、过期判 `stale`（`compaction.ts:407-436`）。
- hooks（`harness/types.ts:617-678`）：Generation `beforeRequest`/`afterResponse`/`onYield`/`afterTools`；Tool `beforeTool`(block/改参)/`afterTool`(换结果)；Compaction `beforeCompact`(decline/自带 summary)。按扩展选择限定作用域（`README.md:386-403`）。
- 自定义 durable 任务：`defineTask` + 多相 checkpoint + `waiting{on, policy: allSettled|failFast}` + 子任务 ownership + abort 自底向上（`README.md:461-486`）。

### 2.6 Registry 与 Extension

`Extension`：`{name, tools?, sections?, hooks?, wraps?, tasks?}`（`harness/types.ts:268-277`）。registry 仅存代码不存状态；conversation 只存扩展名（`README.md:145`）。`install` 同名原位替换、`uninstall` 按名移除，发布同步（`harness/registry.ts:60-93`）；进行中的调用用旧代码跑完，下一 phase/请求用新代码（`README.md:274`）。内置任务不可移除（`registry.ts:9-10`）。helpers：`defineExtension`/`defineTool`/`section`/`hook`/`wrapTool`/`wrapSection`（`harness/define.ts`）。工具名冲突：后装扩展的同名工具覆盖先装的（`README.md:170`）。

内置 `CodingTools` 扩展 = `read`/`write`/`edit`/`bash`（`tools/index.ts:21-25`），另有 `createPowerShellTool`；**图片读取不支持**（`README.md:149`）。

### 2.7 观察面：viewState / watch / watchEvents / taskGraph

- `Conversation.viewState()`：结构视图 `ConversationView = {conversation, entries, docs{pi.*}}`（`harness/view.ts:26-32`）作为只读 Chord state，每次触及该会话的 commit 后更新（`view.ts:100-112`、`README.md:278-289`）。只挂载五个内置 doc（`view.ts:48-55`）；自定义 doc 不在视图里，要单独 watch。
- `Conversation.watch()`：同值 + 每 commit 的精确 ops（`view.ts:114-128`），慢消费者最多积压 100 帧后折叠为一个全量帧（`README.md:302`）。
- `watchEvents(harness, conversationId, context)`（`harness/events.ts:140-182`）：coding-agent 风格事件流，"one batch per commit"，attach 时给 `snapshot` 事件，落后 100 batch 后重发 snapshot（`README.md:374-382`）。事件全集 `AgentEvent`（`events.ts:56-89`）见 §3.2 对照。partial/tool 输出的提交受 `settings.progress` 节流（默认 100ms，`agent.ts:33-36`），即 UI 粒度是"每 100ms 一批 delta"，不是 stable 的逐 token 事件。
- `Harness.taskGraph()`/`watchTaskGraph()`：全 Session 活跃任务图 `{tasks: {id → node}}`，node 含 owner 边、状态（pending/running/waiting{on,policy}/completing）、background/abortRequested、拥有的 conversations（`harness/task-graph.ts:19-49`）；terminal 即出图（`task-graph.ts:163-167`）。

### 2.8 Storage 后端与 conformance

四种后端（`README.md:538-545`）：`MemoryStorage`（包根导出）、`openNodeSqliteStorage`（`storage/sqlite/node.ts`，WAL+NORMAL）、`openNodeJsonlStorage`（`storage/jsonl/node.ts`，append-only，可 `fsync`）、`openDurableObjectSqliteStorage`（`storage/sqlite/cloudflare.ts`）。单进程独占，无跨进程锁（`README.md:545`）——应用层锁要自己做（消费端用 `proper-lockfile`，见 §6）。自定义后端跑 `registerStorageConformance`（`src/testing/storage-conformance.ts`），自定义环境跑 `registerEnvConformance`（`README.md:556-570`、`262`）。

### 2.9 底层逃生舱（Session 层）

包根导出 `createSession` 与全套表/事务类型（`src/index.ts:101`、`104-184`）：entries/documents/tasks/submissions 的 scan/append API、`Tx`。entry 层有 `ContextEdit`（对历史 entry 的模型上下文贡献做 omit/replace，`src/types.ts:300-314`，挂在 `EntryRecord.edits`，`types.ts:329`）和 `head` 标记（重置活跃区间起点，`types.ts:327`）。这层是"改 harness 前先看能不能用逃生舱解决"的地方。

## 3. stable → durable 映射矩阵

stable 侧锚点：`packages/coding-agent/src/core/agent-session.ts`（下称 AS）、`core/session-manager.ts`（SM）、`modes/interactive/interactive-mode.ts`（IM）。

### 3.1 运行时能力矩阵

| # | stable 能力（stable 锚点） | durable 对应物（durable 锚点） | 判定 | 差异 |
|---|---|---|---|---|
| 1 | session 事件流 `subscribe`/`AgentSessionEvent`（AS:1369, 196-237; IM:3400-3406） | `watchEvents` 事件流 或 `viewState()`/`watch()` | 有（部分） | 事件集不完全对齐（§3.2）；事件派生自 commit，受 100ms 节流影响；viewState 是全量状态非事件，更适合重建 |
| 2 | 流式 partial `message_start/update/end` + usage | `pi.live.generation.message` 提交节流 + `message_update` deltas（`generation.ts:364-416`; `events.ts:230-235, 349-389`） | 有 | 节流粒度 100ms 可调（`settings.progress`）；deltas 含 text/thinking/toolcall 三类 |
| 3 | 工具进度 `tool_execution_start/update/end`（IM:3606-3652） | `pi.live.tools` ToolSlot + 同名事件（`live.ts:11-30`; `events.ts:224-241, 392-421`） | 有 | durable update 是 output trim/append/set + details/diagnostics；start 的 args 从任务 checkpoint 恢复（`events.ts:226-228`），重启后仍在 |
| 4 | bash 流式专用通道 `bash_execution_update`（AS:237; IM:3602） | 无专用事件；bash 走通用 tool update | 部分 | stable 有高频直通；durable 合并进 100ms 工具输出通道。渲染流畅度需 G1 验证 |
| 5 | 队列/steer：`steer()`/`followUp()`/`queue_update`/`clearQueue()`/读队列文本（AS:2211-2423） | `submit(whenBusy)` + `pi.inbox` + `inbox_update` + `submission.abort()`（`submissions.ts:148-207`; `inbox.ts:65-106`） | 有（部分） | 入队/撤销/读文本（inbox item 带 content）都有；**无** bulk `clearQueue`、无"编辑全部排队消息"（dequeue）——只能逐个 `submission.abort()` 后重排 |
| 6 | compaction：`compact()`/`abortCompaction()`/`isCompacting`/`setAutoCompactionEnabled`/阈值+溢出（AS:2764-2922, 3249） | `Conversation.compact()` 任务化 + `pi.live.compactions` + `settings.compaction` + `beforeCompact` hook（`compaction.ts:103-247`; `live.ts:33-41`） | 有（部分） | 无 per-session 运行时开关（settings 是 harness 级 getter，可绕过）；**只取消 compaction** 无专用 API——`abort()` 是整会话 abort（README:349 说 Esc 取消手动 compaction，代价是停掉当前工作）；结果要等 task receipt（消费端示例 `runtime.ts:253-280`） |
| 7 | model/thinking：`setModel`/`cycleModel`/`setThinkingLevel`/`cycleThinkingLevel`（AS:2477-2665） | `configure({model, thinkingLevel})` 写 `pi.agent` + `agent_changed`（`agent.ts:76-79`; `events.ts:332-334`） | 有 | cycle 逻辑在消费端自写（`runtime.ts:283-298` 已示范）；模型在请求 prepare 时固定，中途换模型下一请求生效（`README.md:210`） |
| 8 | usage/cost：UsageEntry/`getSessionStats`/`getContextUsage`（SM:1244; AS:4183, 4237） | `pi.usage` + `usage_changed` + `harness.usage()`（`usage.ts:14-39`; `harness.ts:286-296`） | 有（部分） | token/cost 累计齐全；**无** context 占用百分比 API（消费端自算：`tui.ts:549-561` 取最新成功 answer 的 usage）；**无** SessionStats 聚合（消息数/时长/cache 命中等）——部分可从 entries + 新版 `durationMs` 字段推（CHANGELOG:18-19） |
| 9 | abort：`abort()`/`waitForIdle`（AS:2434-2446） | `Conversation.abort({background})`/`waitForIdle`/`submission.abort`/`abortTask`（`harness.ts:146-154`; `types.ts:104-111`） | 有 | durable abort 撤队列 input、abort 全部所属任务、等 idle；`background:true` 跨后台边界；abort 语义比 stable 细（子代理级联，`README.md:450-454`） |
| 10 | 自动重试：`auto_retry_*`/`abortRetry`/`setAutoRetryEnabled`（AS:221-222, 3807-3824） | `pi.live.generation.retry` + `auto_retry_start/end` 事件 + `settings.retry`（`generation.ts:477-505`; `events.ts:245-251`） | 有（部分） | 无单独 `abortRetry`（abort 会话即取消重试）；无运行时开关（同 #6 settings getter） |
| 11 | session 列表/resume：`listSessionsFromDir`/`findMostRecentSession`/`/resume`（SM:749, 941; slash-commands.ts:41） | **无 harness API**。消费端自扫目录 + `proper-lockfile` 锁（`sessions.ts:18-55`）；resume = 重开 storage + `harness.resume()`（README:106-111） | 无→自建 | durable 的"session"= 一个 storage 文件；无名称/标题/时间元数据 API（`pi.agent` 只有 agent 字段）；跨 session 列表/选择器全靠应用层 |
| 12 | fork/树：`/fork`→`createBranchedSession`、`/tree`→`navigateTree`、`branch`/`branchWithSummary`/`getTree`/label（SM:1529-1632; AS:3964） | `Conversation.fork(at, ownership)`（新 conversation，`harness.ts:142-144`）+ `context({at})` 只读预览（`types.ts:544`） | 部分 | fork 有（且 agent asOf 继承、provider 身份刷新）；**无**同一 conversation 内树导航/leaf 切换、**无** `branchWithSummary`（分支摘要）、**无** entry label。跨会话 fork 是不同交互模型 |
| 13 | context edit：`appendContextEdit` 改历史消息上下文（SM:1360, 175-181） | `EntryRecord.edits`/`ContextEdit`（`src/types.ts:300-314`） | 部分（底层有，无 API） | entry 载荷层支持 omit/replace 历史贡献；无便捷方法、无 UI；`ContextView.contributions` 注释提到"after edits"（`types.ts:507`），推导已支持 |
| 14 | bash 直跑（`!`/`!!` 前缀）：`executeBash`/`recordBashResult`/`abortBash`/`isBashRunning`（AS:3841-3917） | **无会话集成**。宿主可用 `env.exec()`（README:251-260）跑命令，但无"记录为会话 entry + 可 abort + 计入上下文"的通道 | 无→自建 | 可用 write submission 写自定义 entry + env.exec 组合自建 |
| 15 | 自定义消息/entry：`sendCustomMessage`/`appendCustomEntry`/`appendCustomMessageEntry`（AS:2293; SM:1290, 1339） | `submit({type:"write", entry})` + `defineEntry` 自定义 kind | 有 | 语义等价且更通用（任意 entry kind + docs） |
| 16 | session 名称：`setSessionName`/`session_info_changed`（AS:3942; SM:1304） | 无内置 | 无→自建 | 用自定义 doc（`conversationCreated` 保证存在）替代 |
| 17 | 扩展生态：`bindExtensions`/`reload`/ExtensionRunner UI context（widgets/selector/input/editor）、MCP、skills、prompt templates、slash commands（AS:3258-3660, 1672; IM 大量） | durable Extension（tools/sections/hooks/wraps/tasks）+ registry 热替换（§2.6） | 部分 | 代码扩展模型有且更严格（按会话选择、durable）；**无** UI 扩展点、MCP、skills、prompt templates、slash command 注册、主题/键位热载（后两者消费端直接复用了 pi 的，`tui.ts:34-46`） |
| 18 | cache warmer（`cacheWarmingStatus`/`setCacheWarmingMode`，AS:1431-1440） | 无（`pi.provider.sessionId` 只是身份透传，`provider.ts:26-38`） | 无 | 保活需自建或提 feature |
| 19 | 虚拟模型/路由：`routedModel`/provider-composer/`/scoped-models`（AS:1452; slash-commands.ts:24） | 无：`ModelRef` 只认 `models.getModel(provider, modelId)`（`generation.ts:130`） | 无→自建 | 可在 pi-ai `Models` 层实现（durable 只走 `models`）；或 hook `beforeRequest` 改写 |
| 20 | 图片输入：粘贴/附件（IM:3152-3194）、read 图片 | 无：`README.md:149` "Reading images is not supported yet" | 无 | 工具层限制，需改 `tools/read.ts` |
| 21 | print/JSON 模式（`modes/print-mode.ts`、`modes/json-event.ts`） | 无内置；watchEvents 即 JSON 模式基础，示例 18/19 展示做法（README:587-588） | 部分→自建 | 每次输出一行/JSONL 的包装要应用层做 |
| 22 | 会话导出/导入/分享：`/export`/`/import`/`/share`（AS:4288-4314; slash-commands.ts:25-27） | 无内置；entries 可全量分页读（`Conversation.entries`） | 无→自建 | HTML/JSONL 渲染复用 stable 代码即可 |
| 23 | 登录：`/login`/`/logout`（slash-commands.ts:37-38） | 无；消费端直接共享 pi 的 ModelRuntime/凭证（durable README:15） | 部分 | auth 流程 UI 属宿主应用 |
| 24 | 子代理 | durable 原生：task-owned conversation + `ConversationHandle` + background 边界 + taskGraph（§2.5、README:416-459） | 有（更强） | stable 的 subagent 走扩展进程；durable 是一等公民、可中断可恢复可后台 |

### 3.2 事件对照表

stable `AgentSessionEvent`（AS:196-237，含 pi-ai `AgentEvent` 基础集）↔ durable `AgentEvent`（`events.ts:56-89`）：

| stable 事件 | durable 事件 | 说明 |
|---|---|---|
| `agent_start` | `run_start` | durable 载荷是 `inputs: SubmissionId[]`（无文本，文本在 inbox/entries） |
| `turn_start` | `turn_start` | 等价 |
| `message_start` | `message_start` | durable 在首个非空 partial 提交时发（`events.ts:232`）；完整 assistant entry 也发（`events.ts:291`） |
| `message_update`（deltas + usage） | `message_update`（usage + `MessageChange[]`） | durable changes 含 text/thinking/toolcall 三类 delta 与整块替换（`events.ts:27-33`） |
| `message_end` | `message_end`（带 entry） | 等价 |
| `tool_execution_start/update/end` | 同名 | start 的 args 从任务 checkpoint 恢复；end 可无 entry（fault/orphan，`events.ts:77`） |
| `bash_execution_update` | —（走 tool_execution_update） | 无专用高频通道 |
| `agent_end` | `run_end` | 等价（run 的 inputs 换代时发） |
| `agent_settled` | — | 无事件；用 `run_end` + `Conversation.waitForIdle()`（或观察 `pi.live` 空）替代 |
| `queue_update` | `inbox_update` | durable item 是 `{id, mode}`，文本从 `pi.inbox` doc 读 |
| `entry_appended` | `entry_appended` | 等价（durable 是 `EntryRecord`） |
| `session_info_changed` | — | 无 session 名称概念（§3.1 #16） |
| `thinking_level_changed` | `agent_changed`（合并进 AgentState） | 粒度更粗，UI 需 diff |
| `compaction_start/end` | 同名 | durable 带 `taskId`/`reason`/`blocking`；结果/`aborted` 要查 task receipt 或 outcome |
| `auto_retry_start/end` | 同名 | 字段差：stable `{attempt, maxAttempts, delayMs}`；durable `{attempt, at, errorMessage}` / `{attempt}` |
| `summarization_retry_scheduled/attempt_start/finished` | —（仅 `pi.live.compactions[].retry{at,error}` + `attempt` 状态） | 无事件级对应；轮询 doc 或扩展 events.ts |
| （durable 独有） | `snapshot`、`submission`、`deferred_poll`、`task_failed`、`usage_changed`、`agent_changed`、`inbox_update` | late-join/断线恢复靠 `snapshot`；`deferred_poll` 是 pi-ai deferred 响应轮询状态 |

## 4. durable 无对应物的 stable 特性清单（G1 分期输入）

按"自建（应用层）还是改 harness"分类；§3.1 的行号即证据。

**A. 应用层可自建（不动 harness）：**
1. session 元数据与列表/resume picker：目录扫描 + 锁已有雏形（`sessions.ts`）；名称/标题/自定义元数据用 `conversationCreated` + 自定义 doc（#11、#16）。
2. 队列清空/批量编辑：逐 submission.abort + 重排（#5）。
3. context 百分比与 SessionStats：从 entries + `pi.usage` + `durationMs` 自算（`tui.ts:549-561` 已示范前者）（#8）。
4. bash 直跑 `!`/`!!`：`env.exec()` + write submission 自定义 entry（#14）。
5. print/JSON 模式包装（#21）、导出/导入/分享（#22）、`/login` UI（#23）。
6. cycle model/thinking 等迭代器（消费端已示范，`runtime.ts:283-298`）。

**B. 需要 harness/包级改动（或上游 feature）：**
7. `agent_settled` 等价事件、`summarization_retry_*` 事件、`bash_execution_update` 高频通道（§3.2；可先在应用层从 viewState 派生，但事件化更干净——改 `events.ts` 的 translate）。
8. 只取消 compaction 的 API（`abortCompaction` 等价物）：现只能整会话 abort（#6；`harness.ts:146-149` → `tasks.abortConversation`）。
9. per-session 运行时开关（autoCompaction/autoRetry）：settings 是 harness 级，需把开关做成 conversation 级 doc 或 settings getter 按会话分流（#6、#10）。
10. 同 conversation 树导航 + `branchWithSummary` + entry label：fork 模型不同；要么接受"fork 即新会话"的交互改写，要么给 conversation 加 leaf 切换（#12、#13）。
11. 图片输入：改 `tools/read.ts` + 粘贴管线（#20）。
12. 虚拟模型/路由模型：在 pi-ai Models 层或 `beforeRequest` hook 实现，注意 `generation.ts:130` 的 `getModel` 直查（#19）。
13. cache warmer：需 harness 暴露最后请求信息或应用层包装 models（#18）。

**C. 扩展生态面（最大的一块，基本全靠应用层移植）：**
14. MCP servers、skills、prompt templates、slash command 注册、扩展 UI（widgets/selectors/input/editor/footer）、扩展自定义编辑器——durable Extension 模型只覆盖 tools/sections/hooks/wraps/tasks（#17）。stable 的 `resourceLoader`/`ExtensionRunner` 体系需要适配层：把 pi 的扩展/skill/command 桥接成 durable extension 或宿主侧直接绑定。

## 5. 反向：durable 有而 stable 无（不要在 parity 中丢掉）

- 崩溃恢复/断点续跑：一切先 commit 再可见（README:5、80）；stable 无。
- 多会话并存 + 会话切换（`/agents`）+ task 图可视化。
- 子代理一等公民（ownership、background 边界、abort 级联、重启续跑）（README:416-459）。
- `requestId` 幂等提交、submission 可重取可等待（README:115-124）。
- 后台 compaction（不阻塞对话）+ blocking compaction（generation 等待）（`compaction.ts:234-247`）。
- deferred 响应轮询（`generation.ts:429-449`）与 `pi.provider` 会话亲和（README:113）。

## 6. 消费端现状（experimental/durable，截至本分支）

- 已实现：viewState 渲染（流式/工具卡/队列/compaction/usage/context%）、submit(steer/followUp)、Esc abort、/model、thinking cycle、/compact、/agents 切换、/tasks 面板、前台 subagent 工具、settings 桥接（getters）、pi 的主题/键位/编辑器复用（`runtime.ts`、`tui.ts`、`harness-setup.ts`、`subagent.ts`）。
- 自述"Not here"（durable README:64）：sessions list and resume picker、forks and tree navigation、extensions、prompt templates、images、`/login`——与 §4 清单互证。
- TUI 观察模式是"全量 viewState diff 渲染"（`tui.ts:278-311`），未用 watchEvents；G1 若要逐 delta 动画/远程同步，watchEvents 是现成通道。

## 7. 对 G1 分期的直接建议

1. 主干 parity（事件流矩阵 §3.1 #1-#10、#15、#24）durable 已就绪，G1 可直接以 `experimental/durable` 为骨架替换 `AgentSession`。
2. §4-A 类先做（应用层、低风险）；§4-B7（事件补齐）建议作为对 `events.ts` 的第一批 harness 改动提案；§4-C 扩展生态单独立项（工作量大且决定产品形态）。
3. 100ms 节流粒度对 TUI 渲染的影响（流式打字机感、bash 输出跟手感）应在 G1 早期做一次实际验证，`settings.progress` 可调是兜底。
