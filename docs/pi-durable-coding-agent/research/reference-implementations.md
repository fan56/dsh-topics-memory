# R5: 参考实现调研 — dsh/dsh-tui-pi 与 opencode

- Ticket: `wayfinder/tickets/007-r5-reference-implementations.md`
- 方法: 只读源码研究。引用约定：`dsh-tui-pi/…` 相对 `~/github/dsh-tui-pi`；`dsh/…` 相对 `~/github/deepseek-harness`；`opencode/…` 相对 `/tmp/opencode-ref`（sst/opencode shallow clone，`dev` 分支，2026-10-08 快照）。带 `file:line`。
- 本报告只回答「可借鉴什么」；durable 与 stable 的能力映射见 R1（`docs/research/durable-api-surface.md`），扩展 compat 见 R3（`docs/research/extension-mcp-compat.md`）。

## 0. 结论速览

1. **dsh-tui-pi 把「在 pi 体系外用 pi-tui 搭 TUI」这条路完整走通了**，但代价是自带全套 shell 设施（canvas 背景、focus 契约、主题 bundle、宽度裁剪、overlay 框架）。pi-tui 只是一个普通 npm 依赖（精确 pin，零 patch）。这证明 pi-tui 组件面够用，也证明**外部复用 ≈ 重做一遍 stable interactive-mode 已经解决的事**——对 P1 的直接含义：选 stable interactive-mode 做 durable 骨架，等于免费继承这些解法。
2. **opencode 是干净的 client/server 分层**：server 拥有全部状态与持久化，TUI 是薄视图（solid-js + SSE 事件流 reconcile）。session 管理（SQLite + slug/parentID/archived 字段 + like 搜索 + 分页）是「将来 durable 版 session 管理层」最成形的参照。
3. **扩展宿主面两种哲学**：dsh 没有 ctx.ui——UI 是「驱动 ctx 服务 + 渲染 session 事件」的自备消费者（`dsh/docs/architecture.md:137`）；opencode 有显式 UI 插件面（槽位 + 预制 Dialog + route + keymap）。R3 已确认 ctx.ui 是 stable↔durable 最大 parity 缺口，这两个先例给出「补齐」的两条路线。

## 1. TUI 架构

### 1.1 dsh-tui-pi：外部仓复用 pi-tui 的现成先例

**进程模型**：in-process cordis 插件，无独立进程、无 RPC。TUI 与 dsh 服务直连（`ctx.get(...)` / `ctx.on(...)`），对照 web 客户端走 client-RPC（`dsh-tui-pi/ARCHITECTURE.md:8-39`）。teardown 顺序固定：`bridge.dispose() → ui.dispose() → ctx.root.fiber.dispose() → process.exit()`，且 fiber disposer 里 TUI 先停、agent 后拆（热重载不得让旧 TUI 占着终端，ARCHITECTURE.md:36-39, 529-551）。

**依赖形态**：`@earendil-works/pi-tui` 是精确 pin 的普通 dependency（`dsh-tui-pi/package.json:79`，`"0.85.1"`），**零 patch**。历史上 canvas 背景曾走 patch（ARCHITECTURE.md:457 提及 `patches/@earendil-works__pi-tui.patch`），现已演化为 `CanvasTerminal` write-stream decorator：包装 `ProcessTerminal`，在每条 erase 序列（BCE）前与每条 SGR reset 后注入 canvas 颜色，`DSH_TUI_TRANSPARENT=1` 可退回透明（`dsh-tui-pi/src/canvas-terminal.ts:1-26`、`src/tui.ts:161-210`）。**教训：能用装饰器/包装解决的事不要 fork 上游。**

**组件复用面**：全部从 `@earendil-works/pi-tui` 具名导入，共约 30 个符号——组件 `Container/ScrollView/Spacer/Text/TuiAltScreen/ProcessTerminal/VStack/HStack/Editor/Markdown/Image/Loader`，类型 `Component/TUI/KeyId/EditorTheme/AutocompleteProvider/OverlayHandle/SelectItem/Terminal`，工具 `matchesKey/getKeybindings/truncateToWidth/visibleWidth/isKeyRelease/isKeyRepeat`（`grep "from '@earendil-works/pi-tui'" src/*.ts` 全量枚举；入口 import 块见 `src/tui.ts:25-36`）。其余全是自建（`FramedOverlay`、`TablePanel`、`EditField`、`CwdBorderEditor` 等）。

**布局与渲染循环**：固定 alt-screen 两段式——transcript `ScrollView`（`basis 0 / grow 1`）+ dock `VStack`（`basis auto / grow 0`），dock 七槽：status / widgets(Todos) / askUser / editor / lastRequest / notices / footer（`src/tui.ts:255-268`）。渲染纪律（AGENTS.md 铁律，`dsh-tui-pi/AGENTS.md:244-278`）：

- **render 从不重扫**：footer/stats 只读 O(1) 维护计数器，事件路径 O(event)；
- **流式 = 已有组件 `setText`**，绝不 removeChild+addChild；Markdown 只在完整 `assistant/message` 上解析一次；
- **所有裁剪走 `clipToWidth`**（`src/text.ts`），裸 `String.length` 禁用（CJK 全角 2 列）；先裁剪后加 ANSI；
- 主题热切换：每个操作 append 进 `ReplayOp` buffer，`setTheme` 清空重放（ARCHITECTURE.md:124-139）。

**状态注入**：`startTui(options)` 以回调注入宿主逻辑——`onSubmit/onKeyAction/isRunning/getRunningAgents/hasSession/dockedModalActive/themePreference/keyBindings`（`src/tui.ts:48-78`），全部有缺省（smoke 模式本地 echo）。UI shell 与宿主完全解耦；session 面收敛在唯一入口 `DshSessionBridge`（`src/session.ts:244`；lazy `ensureSession` 1899、resume 1356、`firstLiveSeq` 重放契约见 AGENTS.md 铁律 9）。

**必须知道的 pi-tui 0.84/0.85 限制**（AGENTS.md:326-368「Known limitations」，dsh-tui-pi 选择绕开而不是对抗）：layout 不下探 plain Container → 嵌套 ScrollView 拿不到 viewport（overlay 内同理，`/history` 自管滚动窗，ARCHITECTURE.md:384-398）；`SelectListTheme` 无 unselected 行背景 hook；截断标签会提前终止 selected 背景_span；`Input` 无 masking（自建 `EditField` 掩码）；editor 会被主题热切换重建 → **overlay 关闭必须经 `restoreFocus` 重聚焦当前 editor 实例**（铁律 8，`src/tui.ts:301-333` rebuildEditor）。

### 1.2 opencode：client/server + TUI 分层

**分层**：core（`opencode/packages/opencode`，agent/循环/存储）→ server（`packages/server`，HttpApi routes/handlers/auth）→ client（`packages/client`，从 HttpApi 生成的 SDK，`packages/client/package.json` 的 `generate` 脚本）→ TUI（`packages/tui`，渲染栈 `@opentui/core` + `@opentui/solid` + `solid-js`，`packages/tui/package.json:55-65`）。

**进程关系**：TUI 不内嵌 server。CLI 的 Daemon 服务负责发现/拉起后台 server——注册文件 `server.json` + 密码文件发现已有实例，不健康则 `spawn(process.execPath, [entrypoint, "serve", "--register"])`（`opencode/packages/cli/src/services/daemon.ts:40-48, 122`）；`runTui(transport)` 只拿 `{url, headers}` 连上去（`packages/cli/src/tui.ts:7-18`）。另有一条 Embedded 路线：同一 HttpApi router 挂 in-memory HttpClient，同进程复用全部 handler（`CONTEXT.md`「Embedded OpenCode」词条）。

**TUI 状态模型**：solid-js store + SSE 事件流。启动 bootstrap 阻塞拉 `session.list`（继续会话时），per-session `sync(sessionID)` single-flight Map 保证并发只拉一次（`packages/tui/src/context/sync.tsx:151, 451-479, 594-665`）；事件按帧 batch flush 成单次渲染（`context/sdk.tsx:44-60`）。UI 是响应式组件树（声明式），与 pi-tui 的立即模式 `render(width)` 根本不同。

**对我们的启示**：opencode 证明「后端面（事件 + 查询 API）干净时，视图层可以很薄、可整体替换」（TUI/web/desktop 共享同一 server）。durable 的 `watchEvents`/`viewState`（R1 §3）已经是这种形状——P1 选哪种 TUI 骨架，都不影响 durable 后端面按「可被任意客户端消费」设计。

## 2. opencode 会话管理（session 存储/列表/resume）

**存储**：SQLite（drizzle）。`Session.Info` 字段（`opencode/packages/opencode/src/session/session.ts:224-245`）：`id/slug/projectID/workspaceID/directory/parentID/summary/cost/tokens/share/title/agent/model/version/metadata/time{created,updated,compacting,archived}/permission/revert`。要点：

- **归档是一级公民**：`time.archived` 时间戳 + `GlobalListInput.archived` 过滤（session.ts:313-321），删除不是唯一出路；
- **fork 血统内建**：`parentID` + `revert{messageID, partID, snapshot, diff}`（session.ts:209-214, 231）；列表 `roots: true` 只看根会话（`isNull(parent_id)`，session.ts:988）；
- **可查询**：`listByProject` 用 `eq/like/gte` 组合——title `like %search%`、`time_updated >= start`、limit 分页（session.ts:955-1000），搜索下沉到存储层而不是客户端全量过滤；
- 会话按 `projectID`（+ 可选 `workspaceID/directory/path`）归属，跨目录有 `listGlobal`。

另有 JSON 文件 storage 模块（带编号 migration + 事务锁，`packages/opencode/src/storage/storage.ts:222-254`）承载其他资源——存储是分后端的，session 走 SQLite。

**列表/resume UX**（`opencode/packages/tui/src/component/dialog-session-list.tsx`）：

- 查询策略：无搜索拉 100 条、有搜索拉 30 条（:28），debounce 150ms（:57）；
- **「查询 ∪ 实时」合并**：服务端 list 结果与 SSE 维护的 sync store 合并去重（:80-90），当前会话与 pinned 无论如何都进列表（:83），`session.deleted` 事件即时剔除（:96），客户端再做 title 前缀过滤兜底（:89-92）；
- 删除/快速切换是快捷键命令（`session.delete`、`session.quick_switch.1-9`，:58-60）；
- **resume = 路由切换**：选中即 `route.navigate({type:'session', sessionID})`（:284-308），消息/parts 由 per-session sync 拉取。没有独立的 "resume" 动作——会话常驻 server，UI 进去就是继续。

**对 durable session 管理层的启示**：(a) 会话元数据（title/slug/parentID/archived/time.updated）字段化进存储，列表/搜索/fork 血统/归档全部变成查询，不用扫 jsonl（对照 stable 的 `loadSessionLastUpdates` mtime 方案，dsh-tui-pi `src/sessions.ts` 就是在扫日志文件 mtime）；(b) UI 侧「一次查询打底 + 事件流维持新鲜」的 sync store 模式，与 durable 的 `watchEvents` 天然契合；(c) fork/revert 作为 session 记录字段而非独立机制，树导航（R1 缺口之一）有现成数据形状。

## 3. 扩展宿主面

### 3.1 dsh（cordis 插件，用户熟悉的心智模型）

**一切皆插件**：无特权核心，扩展 = 在共享 context 上挂插件，注册是可逆 effect、卸载即回滚（`dsh/docs/architecture.md:11-13`）。「新行为落在哪」有一张权威表（architecture.md:119-143），其中 UI 一行是关键：**"Add UI or editor integration → drive `ctx.agents` and render from `session/event`"**（:137）——**dsh 没有 ctx.ui**，UI 面是自备组件树的服务消费者。

**命令注册**（`dsh/packages/interaction/commands`）：

- `ctx.commands.register({ name, description, input: {hint, images?}, handler(invocation) => CommandResult })`（README「Registering a command」；类型 `src/types.ts:15-59`）。handler 直接对 agent 跑，**不产生 model message**；结果 `{kind:'success'|'error', text?, sourceEventSeq?}` 由 dispatching UI 渲染；
- 命令生命周期落 session log：`command/run` → handler → `command/done`，按 `commandId` 配对（README「Lifecycle events」）——命令执行可回放；
- agent-scoped shadow：插件挂在 `agent.ctx` 下可注册同名命令遮蔽全局（README「Agent-scoped commands」）；
- 注册/移除发 `commands/change` 事件，live UI 刷新 discovery（`src/types.ts:72-86`）。

**dsh-tui-pi 的双通道教训**（对 ctx.ui/命令面直接适用）：TUI 自有命令（`/model`、`/resume`…）同时注册两条通道——`ctx.commands.register`（discovery + 有 agent 时的生命周期）+ `CommandService.registerLocal`（**无 live agent 时直派，避免为跑一条 UI 命令 mint 一个空 session**；`dsh-tui-pi/src/index.ts:1007-1022`、`src/commands.ts:156-216`）。未注册命令名 fall through 给模型当普通 prompt（commands.ts:189-203）。

**事件即扩展点**（architecture.md:64-101）：session events（durable facts，落 log）/ agent events（live，waterfall 需 `next()`）/ capability events（挂策略与适配器，不 import 循环）。turn 流水的每个拦截位（`agent/pre-step`、`agent/request`、`llm/stream`、`tools/pre|post-execute`）都是 waterfall。

**UI 相关服务面**（dsh 的「ctx.ui 等价物」是三个服务）：问答走 `ctx.userQuestions.ask()` waterfall，UI 插件 `registerProvider` 接管应答（`dsh/packages/interaction/user-questions/README.md`；dsh-tui-pi 侧 `src/ask-user.ts:74, 1921`）；prompt 段走 `ctx.systemPrompt.section()`（文本 provider 每次装配时读文件，dsh-tui-pi `src/index.ts:966`）；配置走 `settings.mutate(ns, pathOps, revision)` 乐观并发 + `scope.watch` 热应用（AGENTS.md「Config safety」）。

### 3.2 opencode 的 plugin API 形状

**宿主面 Hooks**（`opencode/packages/plugin/src/index.ts:222-335`）：插件是 `async (input, options) => Hooks` 工厂；Hooks = `dispose/event/config/tool.{name}/auth/provider` + 命名 hook 字符串，统一 **`(input, output)` 双参 transform 形态**——output 是可变出参，插件改字段：`"chat.message"`、`"chat.params"`、`"chat.headers"`、`"permission.ask"`、`"command.execute.before"`、`"tool.execute.before/after"`、`"shell.env"`、`"tool.definition"`、`experimental.chat.messages/system.transform`、`experimental.session.compacting`、`experimental.compacting.autocontinue`、`experimental.text.complete`。工具以 `ToolDefinition` 字典注册（`tool: {[key]: ToolDefinition}`）。

**TUI 面 TuiPluginApi**（`opencode/packages/plugin/src/tui.ts:581-626`）：

- `ui.*` **预制组件工厂**：`Dialog/DialogAlert/DialogConfirm/DialogPrompt/DialogSelect/Slot/Prompt + toast + dialog stack`（:599-609）——插件不自由绘制，塞内容进宿主控制的形状；
- **命名槽位**：`TuiHostSlotMap` 十个槽（`app/app_bottom/home_logo/home_prompt/home_prompt_right/session_prompt/session_prompt_right/home_bottom/home_footer/sidebar_title/sidebar_content/sidebar_footer`，:455-486），插件经 `slots.register`（SolidPlugin）或 `route.register`（整页路由，`TuiRouteDefinition`，:69-72）贡献 UI；
- `state`：session/message/part/permission/question/lsp/mcp 的**只读快照查询**（:375-399）；`client`：完整生成的 `OpencodeClient`（:614）；`event`：类型化事件总线（:519-521）；
- `keymap.registerLayer({commands, bindings})`：命令与键位**合一流**；旧的 `api.command.register/trigger` 已标 deprecated、v2 移除（:86-120）；
- `lifecycle: {signal: AbortSignal, onDispose}`（:525-528）+ 插件管理（list/activate/deactivate/install，:618-624）；同一插件模块可同时带 `tui` 与 `server` 入口（`TuiPluginModule`，:630-633）。

## 4. 结论：对 P1 与 ctx.ui 的具体启示

### 4.1 P1（TUI 骨架选型）

**倾向 stable interactive-mode 做骨架 + durable 后端**，三条论据全部来自本次调研：

1. **dsh-tui-pi 量化了「外部重搭 shell」的成本**：~2400 行 `index.ts` + ~560 行 `tui.ts` + ~2160 行 `session.ts`（另有 editor/footer/messages/activity/live-widgets…），其中相当部分是在重新解决 stable interactive-mode 已内置的事：canvas 背景、focus 契约（overlay 后重聚焦重建的 editor）、主题 bundle 与热切换、overlay 框架、宽度裁剪纪律。experimental durable TUI 若继续自长，这些坑一个都躲不掉；用 stable 骨架则直接继承。
2. **pi-tui 已知限制是「interactive-mode 内部已消化」的知识**：嵌套 ScrollView 无 viewport、SelectListTheme 背景缺口、截断丢 backdrop、Input 无 masking——stable 的 interactive mode 就是拿同一批组件在宿主内组装的，它对这些限制的绕法就是现成代码。
3. **opencode 证明视图层可后换**：只要 durable 后端按「事件 + 查询」面设计（`watchEvents`/`viewState` 已是），TUI 骨架不是单向门。先用 stable 骨架达成 parity，未来要响应式/要 web 客户端时再换，成本低。

**从 dsh-tui-pi 照抄的件**（无论选哪个骨架）：dock 槽位布局（七槽 VStack）；「render 从不重扫 + setText 流式 + Markdown 一次」三条铁律；ReplayOp 式主题重放（若 durable TUI 引入主题热切换）；`startTui(options)` 回调注入式的 shell/宿理解耦（smoke 可测）；resume 的 `firstLiveSeq` 重放契约。

### 4.2 ctx.ui / 扩展宿主面设计

**从 opencode 抄**：

- **槽位化 + 预制 Dialog**优于自由绘制：宿主面小一个数量级、布局权在宿主、可测试。stable 的 `ctx.ui.widget/footer/dialogs` 可向「命名槽 + 预制组件」靠拢收敛，而不必保留全套自由 API 才能达成 parity；
- 命令注册**首版就与键位绑定合一**（`keymap.registerLayer` 的教训：legacy `api.command` 单独存在两年后进 deprecated）；
- 插件 `lifecycle {signal, onDispose}`；
- `state` 只读快照 + `client` 全量 SDK 的「读面宽、写面窄」分工。

**从 dsh 抄**：

- 命令注册带 `input.hint`/`input.images` 声明 + `CommandResult` 成败形状 + `commands/change` 通知；
- **agentless 直派通道**：UI 命令在无 live session 时必须可跑（不 mint 空 session）——dsh-tui-pi 双通道是最直接的先例；
- 命令生命周期事件（`command/run`↔`command/done`）落 session log，可回放可审计；
- **问答作为服务面**：`ctx.userQuestions` waterfall + provider 注册，而不是把 ask-user 塞进 UI 面——任何面（TUI/web/feishu）都能接管应答；
- 配置写路径统一乐观并发（`mutate + revision`）。

**避开**：

- opencode 的 `(input, output)` 可变出参在 TS 里类型不安全（靠 mutation 传值，编译器不强制写字段）；pi stable 现有 event/callback 风格更贴本仓生态，durable 的 hooks 若吸收 opencode 的 hook 命名，宜保持显式返回值；
- dsh-tui-pi 的 patch 史（canvas 曾走 patch 后改 decorator）——上游变更时 patch 是负债，wrapper/decorator 是资产；
- opencode `experimental.*` 前缀钩子直接进公共 API 面——实验钩子应有隔离层，避免 parity 面被实验形状污染。

**一个值得注意的架构选项**：dsh 根本没有 ctx.ui——它把「UI 集成」定义为服务消费（drive `ctx.agents`、render `session/event`）。如果 durable 路线接受这个哲学，R3 的 ctx.ui parity 缺口可以转化为「durable TUI 需要暴露哪些等价服务」的问题（问答、命令、prompt 段、配置四处），stable 扩展的 ctx.ui 调用则由 compat shim 映射到这些服务 + durable TUI 的槽位。这是 P1 与后续 G 票需要联合拍板的分叉。

## 附：本次调研的证据清单

- dsh-tui-pi：`AGENTS.md`、`ARCHITECTURE.md`、`package.json`、`src/{index,tui,commands,session,canvas-terminal}.ts`（只读）
- deepseek-harness：`AGENTS.md`、`docs/architecture.md`、`packages/interaction/{commands,user-questions}`（README + src/types）、`packages/session/session-persistence-jsonl/README.md`（只读，blobless checkout 未走历史）
- opencode：`/tmp/opencode-ref` shallow clone（`dev` 分支）；`packages/plugin/src/{index,tui}.ts`、`packages/tui/src/{context/sdk.tsx,context/sync.tsx,component/dialog-session-list.tsx}`、`packages/cli/src/{tui.ts,services/daemon.ts}`、`packages/opencode/src/session/session.ts`、`packages/opencode/src/storage/storage.ts`、`CONTEXT.md`
