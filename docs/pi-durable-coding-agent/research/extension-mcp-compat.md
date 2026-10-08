# R3: 扩展与 MCP 在 durable harness 上的兼容路径

Ticket: `wayfinder/tickets/003-r3-extension-mcp-compat.md`。回答四件事：stable 与 durable 两套扩展模型的概念对照；抽样真实扩展的工作量分级；MCP 栈的复用路径；兼容策略选项。供 G1 拍板。

引用约定：无前缀路径相对本仓 `packages/...`；`pi-topic-memory/`、`pi-powerline-footer/` 指仓外只读样本 `~/github/pi-topic-memory`、`~/github/pi-powerline-footer`。

## 1. stable extensions API 面

### 1.1 形态与加载

扩展是默认导出工厂 `export default function (pi: ExtensionAPI)`（`packages/coding-agent/docs/extensions.md:15-30`）。加载器用 jiti 免编译跑 TS：`packages/coding-agent/src/core/extensions/loader.ts:576-581`（`createJiti` + `jiti.import`），目录发现（本地/全局 extensions dir、`--extension` 路径）在 `loader.ts:828-875`。

`pi.*` 对象的构造在 `ExtensionRunner`：构造函数只吃 `Extension[] + runtime + cwd + SessionManager + ModelRegistry`（`packages/coding-agent/src/core/extensions/runner.ts:395-408`），其余全部能力（sendMessage/setActiveTools/setModel/compact/executeTool/会话树操作/…）经 `bindCore(actions, contextActions, providerActions)` 回调注入（`runner.ts:410-544`），命令级操作再经 `bindCommandContext` 注入（`runner.ts:546-563`），UI 经 `setUIContext` 注入（`runner.ts:565-568`）。**这个「回调接线」结构是 compat shim 可行性的核心事实：pi.* 面与 AgentSession 内部没有静态依赖，换一套 actions 实现即可换宿主。**

### 1.2 API 面清单（`packages/coding-agent/src/core/extensions/types.ts:1564-1890`）

- 事件：40+ `on()` 重载（types.ts:1569-1636），覆盖 project_trust、resources_discover、session_*（start/info_changed/before_switch/before_fork/before_compact/compact/compact_failed/shutdown/before_tree/tree）、mcp_servers_change、context / context_with_system、cache_warming_decision、before_provider_request/headers、after_provider_response、provider_stream_event、before_agent_start、agent_start/end、agent_before_settle / agent_settled、ui_prompt_start/end、turn_start/end、message_start/update/end、tool_execution_start/update/end、model_select、thinking_level_select、tool_call / tool_result、user_bash、input
- 注册：`registerTool`（ToolDefinition，types.ts:574-654）、`registerCommand` / `registerShortcut` / `registerFlag`、`registerMessageRenderer` / `registerEntryRenderer` / `registerMarkdownTransformer` / `registerToolRenderer`、`registerProvider` / `unregisterProvider`、`registerVirtualModel`、`registerMcpServer` / `unregisterMcpServer` / `getMcpServers`
- 动作：`sendMessage` / `sendUserMessage` / `appendEntry`、`setSessionName` / `setLabel`、`exec`、`setActiveTools` / `getActiveTools` / `getAllTools`、`setModel` / `setThinkingLevel`、`getSettings`、`getCommands`、`events`（跨扩展总线，types.ts:1888-1889）
- ctx：`ExtensionContext`（cwd/mode/ui/sessionManager/modelRegistry/abort/getContextUsage/compact/shutdown，types.ts:325-365）；`ExtensionToolContext` 加 `executeTool` 嵌套调用（types.ts:383-399）；`ExtensionCommandContext` 加 waitForIdle/newSession/fork/navigateTree/switchSession/reload（types.ts:401-434）
- UI：`ctx.ui` 全套（dialogs/notify/status/widget/footer/header/editor/theme/terminal input，types.ts:149-299）

## 2. durable 扩展模型

### 2.1 形态

durable 的扩展是**宿主进程拥有的 Registry 里按名安装的具名 bundle**（`packages/durable/README.md:126-145`）：`Extension = { name, tools?, sections?, hooks?, wraps?, tasks? }`（`packages/durable/src/harness/types.ts:268-277`）。会话只存名字（`pi.agent` 文档，README:190-210），每次使用时对着 Registry snapshot 解析。`defineExtension/defineTool/section/hook/wrapTool/wrapSection` 都是恒等/构造助手（`packages/durable/src/harness/define.ts:6-44`）。

与 stable 的根本差异：stable 扩展是**进程级长驻对象 + 事件回调**；durable 扩展是**声明式 bundle + 按任务阶段解析**——工作开始后代码被冻结（「Work that already started keeps the code it took」，README:266-274 Reload 节）。

### 2.2 挂点（hooks，全量 8 个）

`packages/durable/src/harness/types.ts:629-679`：

| hook | 签名要点 |
|---|---|
| Generation `beforeRequest` | 替换单次请求的 messages（types.ts:631-635） |
| Generation `afterResponse` | 每个 terminal provider message、分类前（types.ts:637） |
| Generation `onYield` | 最终答案处可 `{continue: UserInput}` 续跑（types.ts:639） |
| Generation `afterTools` | 一轮工具全部 terminal 后（types.ts:641） |
| Tool `beforeTool` | block 或改参（types.ts:647-651） |
| Tool `afterTool` | 替换结果（types.ts:653-658） |
| Compaction `beforeCompact` | 拒绝或自带摘要（types.ts:668-678） |

另有两层「事件」面：`watchEvents()` 派生 coding-agent 风格 AgentEvent（run/turn/message/tool_execution/inbox/submission/auto_retry/entry_appended/agent_changed/usage_changed/task_failed/compaction，`packages/durable/src/harness/events.ts:56-89`）——**只读、给 UI 消费者，不是扩展挂点**；`viewState()`/`watch()` 提交后结构状态（README:276-304）。

### 2.3 概念对照表

| stable | durable | 适配性 |
|---|---|---|
| `registerTool(ToolDefinition)` | Extension `tools: ToolRegistration[]`（execute 签名 `(args, api, context)`，types.ts:231-235） | 近等价，签名/结果形状需适配层 |
| ToolDefinition `renderCall/renderResult/renderShell` | 无（UI 由 TUI 宿主从 viewState 渲染） | 落 TUI 宿主层 |
| `exposure`（direct/model-only/codemode/deferred/hidden）+ `setActiveTools` | per-conversation `agent.tools` 过滤 + `configure()`（README:192-210）；请求准备好时工具集冻结 | 语义近似，动态性不同（见 §4.3） |
| `prepareLoadout` / namespace / promptSnippet / promptGuidelines | `sections`（PromptSection，types.ts:252-257）+ wrapSection | 可投影：工具提示词变成 section |
| `before_agent_start`（prompt + systemPromptOptions.sections） | `sections` 渲染（每请求前）+ `beforeRequest`（改 messages） | 近似：注入改走 section 或 beforeRequest |
| `context` / `context_with_system`（transcript 变换） | `beforeRequest`（替换单次请求 messages） | 弱化等价：只有请求级，无 transcript 持久变换 |
| `tool_call`（block/改参） | `beforeTool` | 近等价 |
| `tool_result`（compose 改结果） | `afterTool` | 近等价 |
| `turn_end` / `agent_before_settle`（链式续跑） | `onYield`（`continue`）+ `afterTools` | 弱化等价：只能续一条 user input，不能链 custom entry |
| `message_end`（改写消息） | `afterResponse`（只观察，不改） | 只读等价 |
| `session_start` / `session_shutdown` | 无（进程/宿主生命周期概念） | 宿主 shim 合成 |
| `session_before_compact` / `session_compact` | `beforeCompact` | 近等价 |
| `session_before_switch/fork/tree` | `fork()`/会话创建是宿主 API，无 hook | 无等价（宿主层包一层可行） |
| `sendMessage`/`sendUserMessage`（steer/followUp/nextTurn） | `conversation.submit({whenBusy: "steer"|...})`（README:306-323） | 语义等价，API 形状不同 |
| `appendEntry`（custom entry 持久化） | `submit({type:"write", entry})` 或 `api.commit(tx.entry(...))`；自定义 entry kind | 等价 |
| `registerCommand` / `registerShortcut` / `registerFlag` | 无（命令是 TUI 宿主概念；experimental durable TUI 命令硬编码） | 宿主 shim 合成 |
| `ctx.ui` 全套 | 无（UI 是 viewState 的消费者） | 宿主 shim 合成（TUI 宿主提供） |
| `ctx.sessionManager`（getBranch/getSessionId/getSessionFile） | `viewState()` entries / `conversationId`；无文件概念 | 部分等价（文件语义无） |
| `registerProvider` / `registerVirtualModel` | `HarnessOptions.models`（宿主组装 Models） | 宿主层等价（进程级而非会话级） |
| `registerMcpServer` / `mcp_servers_change` | 无内置 | 见 §4 |
| `pi.events` 跨扩展总线 | 无（扩展间经 Registry/文档组合） | shim 自带 EventBus 即可 |
| `exec` | `ExecutionEnv.exec`（`env` 按 cwd 构建，README:235-262） | 等价 |
| `provider_stream_event` / before/after_provider_* | 无 hook（partial 每 100ms 提交，见 `pi.live`） | 无等价（事件流只读也不含 raw stream） |
| `user_bash` / `input` / `project_trust` / `resources_discover` | 无 | 宿主 shim（input/bash 拦截可部分由 beforeTool 顶替） |

### 2.4 当前 durable 消费者现状

`packages/coding-agent/src/experimental/durable/README.md:66` 明确「Not here: … extensions …」。现状接线：`createCodingRegistry()` 只装 `CodingTools` + `createPiPrompt`（`experimental/durable/harness-setup.ts:52-57`）；系统提示词整体做成一个 extension 的 sections（`experimental/durable/prompt.ts:69-73`）。**扩展兼容层是全新工作，不与现状冲突。**

## 3. 抽样扩展审计

### 3.1 pi-topic-memory（重逻辑扩展）

API 清单与分类：

| 用法 | 位置 | 分类 | 说明 |
|---|---|---|---|
| `pi.registerTool` ×5（topic_save/observe/search/history/status） | `pi-topic-memory/tools.ts:67,120,157,205,231` | **可适配（小改）** | durable `ToolRegistration` 直接移植；`execute(toolCallId, params, signal, onUpdate, ctx)` → `(args, api, context)`，abort 从 `signal` 改 `context`，`onUpdate` → `api.output/diagnostic`；`details` 落 `api.details()` |
| `pi.on("input")`（捕获 interactive 原始输入） | `pi-topic-memory/index.ts:278-288` | **无等价（宿主 shim）** | durable 无 raw input 事件；input 经 `submit()` 进 inbox。宿主层在提交路径上合成；或退化用 entry_appended（但拿不到 `source:"interactive"` 与命令过滤时机） |
| `pi.on("before_agent_start")` 注入 custom message（`customType`, `display:false`） | `pi-topic-memory/index.ts:291-335` | **可适配（改语义）** | durable `beforeRequest` 替换该次请求 messages —— 恰好匹配「每轮检索注入且不进 transcript」的意图（stable 的 custom message 会进 transcript）。shim 里可统一译成 beforeRequest 注入一条 user 消息 |
| `pi.on("message_end")`（观察 assistant 文本） | `pi-topic-memory/index.ts:338-344` | **可适配** | `afterResponse`（每 terminal message）或宿主从 AgentEvent `message_end` 合成 |
| `pi.on("turn_end")` | `pi-topic-memory/index.ts:347-368` | **可适配** | `afterTools` + `onYield` 组合，或 AgentEvent `turn_end`（若走宿主事件桥则为只读——本例 turn_end 纯观察，够用） |
| `pi.on("session_start")` / `session_shutdown` | `pi-topic-memory/index.ts:371-405,408` | **宿主 shim 合成** | 对应 Harness open/close + 会话 attach/detach |
| `pi.registerCommand("topics")`（list/set/config/onboard/browser/graph/sync 子命令族 + getArgumentCompletions） | `pi-topic-memory/commands.ts:102` 起 | **宿主 shim** | 命令本质是 TUI 宿主概念；experimental durable TUI 需先有命令注册面 |
| `ctx.ui.notify/select/input/confirm/editor/custom`（onboard 向导、浏览器） | `pi-topic-memory/commands.ts:628-745,804,913-1041` | **宿主 shim（TUI 宿主提供 ctx.ui）** | 与 harness 无关，落在 TUI 层 |
| `ctx.sessionManager.getSessionId()` / `getSessionFile()`（子代理检测） | `pi-topic-memory/index.ts:127-137` | **部分等价** | conversationId 有；`getSessionFile()===undefined` 判子代理需换成 ownership 语义（durable 子代理是 task-owned conversation） |
| `ModelRuntime.create()` + `completeSimple`（蒸馏模型调用，进程级单例） | `pi-topic-memory/modelcaller.ts:56-60,107` | **可适配** | durable `HookApi.models` / `ToolExecutionApi.models` 提供同源 Models 目录；或保留自建 ModelRuntime（它不依赖会话） |
| `ctx.modelRegistry.getAvailable()`（模型挑选） | `pi-topic-memory/commands.ts:606` | **可适配** | 同上 |

工作量级：**中等**。核心（tools + 注入 + 观察）约等于重写接线层而非逻辑——store/retrieval/distill 等纯逻辑模块零改动；热点在 input 捕获与 ctx.ui 命令族两处宿主依赖。若走 §5 的 compat shim：tools/sendMessage/事件可跑，input 与 session 身份语义需要 shim 特判，UI 命令依赖 TUI 宿主先具备 ctx.ui 面。

### 3.2 pi-powerline-footer（纯 UI 扩展）

API 清单与分类：

| 用法 | 位置 | 分类 | 说明 |
|---|---|---|---|
| `ctx.ui.setFooter((tui, theme, footerData) => …)`（powerline 渲染 + `footerData.getGitBranch()/onBranchChange`） | `pi-powerline-footer/index.ts:174-324` | **宿主 shim（TUI 宿主）** | durable TUI 目前渲染 viewState（`experimental/durable/tui.ts`），无 footer 注入面；需 TUI 宿主提供 setFooter/setEditorComponent/setWidget 等价物 |
| `ctx.ui.setEditorComponent`（`CwdBorderEditor extends CustomEditor`，覆写 renderTopBorder） | `pi-powerline-footer/index.ts:92-148,158-172` | **宿主 shim（TUI 宿主）** | 依赖 pi-tui 组件体系；durable TUI 复用 pi 的 interactive components（experimental README:4-5），可行 |
| `ctx.ui.setWidget("last-request")` | `pi-powerline-footer/index.ts:353-355` | **宿主 shim（TUI 宿主）** | 同上 |
| `ctx.sessionManager.getBranch()` 遍历统计（usage/cache/toolCall 计数、last user request） | `pi-powerline-footer/index.ts:226-249,332-350` | **可适配** | durable `viewState().entries` + `pi.usage` 文档；形状不同（entry kinds）需翻译层 |
| `ctx.getContextUsage()` / `ctx.model` / `pi.getThinkingLevel()` | `pi-powerline-footer/index.ts:154,264-273` | **可适配** | `pi.agent` 文档（model/thinkingLevel）+ context 用量由宿主从 viewState 估算（durable 无 getContextUsage 直等价；usage/上下文窗口数据在 `pi.usage` 与模型 catalog） |
| `pi.on` thinking_level_select/session_start/agent_start/agent_end/tool_result/ui_prompt_start/ui_prompt_end/session_shutdown | `pi-powerline-footer/index.ts:362-416` | **宿主 shim** | AgentEvent 流覆盖 agent/turn/message/tool（events.ts:56-89）+ `agent_changed`（thinking level 变更会落 `pi.agent` → `agent_changed`）；ui_prompt 事件无（durable 无内嵌 ask-user 概念，UI prompt 属 TUI 宿主） |

工作量级：**小到中**，且几乎全部在 TUI 宿主侧：一旦 durable TUI 提供 `ctx.ui` 兼容面（footer/editor/widget + 一个 stable `ExtensionUIContext` 实现），本扩展接近原样运行；只有数据源（getBranch/getContextUsage）要经 viewState 翻译。

**抽样结论**：扩展的「重量」分布决定兼容策略成本——逻辑型扩展卡在宿主事件语义（input、注入、会话身份），UI 型扩展卡在 TUI 宿主面，两者都不卡在 durable 核心。

## 4. MCP 复用路径

### 4.1 三层栈的现状

1. **传输/协议层 `packages/mcp`**：`McpClient` + stdio/http transports + oauth + JSON-RPC 协议（`packages/mcp/src/index.ts:1-71` 导出面；`client.ts` 615 行）。**零 coding-agent 依赖，可原样复用。**
2. **连接管理层** `packages/coding-agent/src/extensions/mcp/runtime.ts`：`McpServerConnection`（runtime.ts:156 起）管连接状态机（connecting/connected/needs-auth/failed）、重试、OAuth。依赖：pi-mcp、config 解析、`McpToolCaller`；不依赖 AgentSession。
3. **投影层** `packages/coding-agent/src/extensions/mcp/tools.ts` + `index.ts`：`createMcpToolName`（tools.ts:84-93，`mcp__<server>__<tool>` + hash 后缀）、`toParameters`（tools.ts:236-242）、`convertMcpResult`/`limitMcpContent`（tools.ts:124-230，20KB 截断+落盘）、`createMcpToolDefinition`（tools.ts:256-295）——**全部纯函数或窄接口**：`getClient: () => Promise<McpToolCaller>`，`McpToolCaller = { callTool(name, args, options) }`（tools.ts:74-76）。

### 4.2 manager 与 agent-loop 的耦合度：低

MCP manager 本身就是一个 stable 扩展（`packages/coding-agent/src/extensions/mcp/index.ts`），与宿主的全部交互经 ExtensionAPI：`session_start` 起连接（index.ts:1111-1148）、`before_agent_start` 写 `mcp_servers` prompt section（index.ts:1175-1181）、`tool_call` 做就绪等待（index.ts:1187-1206）、`turn_start` 捡外部登录（index.ts:1209-1211）、`mcp_servers_change` 管他扩展注册（index.ts:1214-1247）、`session_shutdown` 关连接（index.ts:1249-1255）、`pi.registerTool/setActiveTools/getAllTools` 投影工具、`pi.registerCommand("mcp")` 出管理 UI。**不 import AgentSession。** 结论：manager 耦合的是 ExtensionAPI 面，不是 agent 循环内部。

### 4.3 durable 上的投影方案

MCP 工具集是**运行时动态**的（服务器异步连接、禁用/重连），durable 的工具集在请求准备时冻结、来自 Registry。可行的投影：

- **方案 A（bridge extension + 同名重装）**：宿主持一个 `mcp` bridge extension；连接状态变化时重建 `defineExtension({ name: "mcp", tools: [...current] })` 并 `registry.install()` 同名替换（README:266-274 明确支持原地替换，运行中的调用用旧代码跑完）。工具由 `createMcpToolDefinition` 生成的定义适配成 `ToolRegistration`（execute 里 `await getClient()` 语义不变）。MCP 工具有副作用，默认 `replay: "unsafe"`（types.ts:216-217）——与 durable 崩溃语义天然对齐（interrupted 错误结果而非重放）。
- **方案 B（每服务器一 extension）**：粒度更细、churn 更小，注册表可读性更好；`configure({extensions:{add/remove}})` 可按会话开关服务器。
- 提示词：stable 的 `mcp_servers` section → durable `section("mcp_servers", …)` 放进 bridge extension；section 内容变化会被持久化为 positional system entry（README:188），对 prompt cache 友好。
- 就绪等待：stable 在 `tool_call` 里等服务器；durable 可放在 `beforeTool` hook（等 ready 或 block）。
- OAuth/管理 UI/`/mcp` 命令：落 TUI 宿主。

**结论：MCP 可大比例复用。** 传输层原样、连接层近原样、投影层纯函数直接搬；需要新写的是 bridge extension（动态重装编排）+ durable 侧 ToolRegistration 适配器，量级小。风险点：stable 的 exposure/codemode/deferred 体系（tool-search、codemode 联动）durable 无对应，第一版可全部降级为 direct + section 提示。

## 5. 兼容策略选项（供 G1）

| 选项 | 内容 | 利 | 弊 |
|---|---|---|---|
| **A. compat shim**（stable ExtensionAPI → durable/宿主） | 复用 jiti loader 跑现有扩展；实现一个 `ExtensionRunner` 替身：`bindCore` 式回调接到 durable（tools→临时 Registry、事件→hook+AgentEvent 桥、sendMessage→submit、ctx.ui→TUI 宿主） | 自家扩展 fleet 零改动即跑；生态扩展也能装 | 双 API 面长期维护；语义裂缝（input 事件、context 变换、续跑链、session 身份）只能近似；shim 内状态是进程内存，丢掉 durable 的可恢复性 |
| **B. 双轨** | durable Registry 为一等扩展模型 + shim 只作过渡，新扩展直接写 durable | 不背永久兼容债；durable 语义纯净 | fleet 逐个移植，周期长；两套并存期用户困惑 |
| **C. 只移植自家扩展** | 不做 shim，把 pi-topic-memory 等逐个重写为 durable extension | 每个移植都吃到 durable 红利（topic-memory 的观察/蒸馏任务天然适合 durable tasks） | 生态扩展完全不可用；TUI 宿主面（ctx.ui/命令）反正都得做，省不掉 |

**倾向（供拍板参考，非决定）**：B+ C 混合的「shim 只做宿主面，不模拟事件循环」——即：
1. TUI 宿主先提供 `ctx.ui`/命令注册面（§3 两个样本都卡在这，且这与 durable 核心正交，experimental TUI 反正要长出这些）；
2. MCP 走 §4.3 bridge extension（原生 durable，不经 shim）;
3. stable 扩展不整体跑在 durable 上，而是按「tools→直接移植（成本低）+ UI→宿主面 + 事件→逐个映射」移植自家 fleet；shim 只保留 jiti loader 与 EventBus 这类无语义裂缝的部件。

理由：shim 最贵的部分恰好是语义最脆的部分（§2.3 表中「无等价」行），而样本显示扩展逻辑本体移植成本不高；反过来 ctx.ui/命令这层无论哪个选项都必须建。

## 6. 风险与未验证项

- `watchEvents` 的 AgentEvent 是否足以合成 stable 事件的全部字段（如 `message_end` 的 replace 语义、`tool_result` 的 compose 语义）未逐字段核对——本研究的分类只到签名级。
- stable `context` 事件（transcript 变换，如 lean-ctx 类压缩扩展）在 durable 只有请求级 `beforeRequest`，做全文变换的扩展会有语义降级，未找样本验证实际影响。
- registry 同名重装（方案 A）在「MCP 服务器频繁断连重连」下的 churn 是否放大 storage 写放大，未测。
- experimental durable TUI 复用 pi interactive components 的程度（`tui.ts`）只读了 README 描述，未逐行核对 footer/editor 注入可行性。
