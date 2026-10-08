# Stable pi coding agent 功能清单（parity checklist）

Ticket: `wayfinder/tickets/002-r2-stable-feature-inventory.md`。基线：`packages/coding-agent/package.json` version `1.1.0`（post-v1.1.0 main，本地 fork）。对象：stable `pi`（`packages/coding-agent/src/`）全量用户可见功能，逐项对照 experimental durable agent（`packages/coding-agent/src/experimental/durable/`，下称 durable）。

引用约定：`file:line` 均相对仓库根；docs 页码引用 `packages/coding-agent/docs/<page>.md`。durable 状态三档：**已有**（行为对齐或有等价物）、**部分**（机制存在但覆盖面/入口缺失）、**缺失**。

---

## 0. 结论摘要（headline counts）

| 维度 | stable | durable |
|---|---|---|
| 内置 slash 命令 | 24 个（`BUILTIN_SLASH_COMMANDS`）+ 3 个隐藏（`/debug` `/arminsayshi` `/dementedelves`）+ `!`/`!!` bash 前缀 + 资源命令（extension/template/`/skill:name`） | 4 个：`/model` `/compact` `/agents` `/tasks`（后两个是 durable 新增） |
| 键位 action | ~90 个可配置 action（docs/keybindings.md 全表） | 接线 6 个 + 选择器 4 个（复用 pi KeybindingsManager） |
| settings.json 设置项 | ~71 个已文档化（docs/settings.md，11 个域）+ 少量内部项 | 启动时读取约 10 项（theme/compaction/retry/steering/followUp/http/skills/defaultModel） |
| 启动 flags | ~41 个 flag + 8 个子命令（install/remove/uninstall/update/list/config/auth/mcp） | 1 个：`--continue`/`-c` |
| 内置 tools | 8 个：read/bash/powershell/edit/write/grep/find/ls | 4 个：read/bash/edit/write（+自研 subagent 工具） |
| 运行模式 | interactive / print / json / rpc 四种 | 仅 interactive TUI |

durable 完全缺失的大块（G1 需拍板优先级）：**MCP 全家（含 OAuth、`/mcp`、mcp.json、tool_search）**、**pi ExtensionAPI 扩展生态 + packages**、**codemode**、**session 管理面（picker/fork/tree/导出/分享）**、**print/json/rpc 模式**、**图片（粘贴/渲染/发送）**、**`/login` 认证流**、**prompt templates**、**skills 的 `/skill:name` 命令形态**。

durable 独有优势（stable 没有的）：进程崩溃后 `--continue` 续跑中断的 tool call；`Harness.taskGraph()` 实时任务面板；subagent 子会话可 `/agents` 切换并在调用返回后继续对话（README.md:20-31）。

---

## 1. Slash 命令（含隐藏）

内置命令注册表：`packages/coding-agent/src/core/slash-commands.ts:19-43`（24 项）。分发逻辑：`packages/coding-agent/src/modes/interactive/interactive-mode.ts:3205-3344`。文档：`packages/coding-agent/docs/slash-commands.md`。

### 1.1 内置命令（24）

| 命令 | stable 位置 | durable 状态 | 依据 |
|---|---|---|---|
| `/settings` 设置菜单 | slash-commands.ts:20；interactive-mode.ts:3205 | **缺失** | durable 无设置 UI（tui.ts:625-631 仅 4 命令） |
| `/model [provider/model]` 模型选择器 | slash-commands.ts:21；interactive-mode.ts:3215 | **已有**（简化版列表，无 fuzzy 搜索/元数据） | durable tui.ts:577-600, 625 |
| `/tree` 会话树导航 | slash-commands.ts:22；interactive-mode.ts:3283 | **缺失** | durable README.md:66 |
| `/thinking [level]` | slash-commands.ts:23；interactive-mode.ts:3221 | **部分**（仅 Shift+Tab 循环，无命令/选择器） | durable tui.ts:638；README.md:39 |
| `/scoped-models` Ctrl+P 循环范围 | slash-commands.ts:24；interactive-mode.ts:3210 | **缺失** | durable 无模型循环 |
| `/export [path]` HTML/JSONL 导出 | slash-commands.ts:25；interactive-mode.ts:3227 | **缺失** | durable 无导出 |
| `/import <path>` JSONL 导入续跑 | slash-commands.ts:26；interactive-mode.ts:3232 | **缺失** | — |
| `/share` gist/Radius 分享 | slash-commands.ts:27；interactive-mode.ts:3237 | **缺失** | — |
| `/bug [description]` | slash-commands.ts:28；interactive-mode.ts:3242 | **缺失** | — |
| `/copy` 复制最后回复 | slash-commands.ts:29；interactive-mode.ts:3248 | **缺失** | — |
| `/name [name]` 会话命名 | slash-commands.ts:30；interactive-mode.ts:3253 | **缺失** | durable 会话目录名固定 `<ts>-<uuid>`（sessions.ts:40） |
| `/session` 会话信息统计 | slash-commands.ts:31；interactive-mode.ts:3258 | **部分**（footer 常显 usage/cost/上下文%） | durable tui.ts:376-404 |
| `/changelog` | slash-commands.ts:32；interactive-mode.ts:3263 | **缺失** | — |
| `/hotkeys` | slash-commands.ts:33；interactive-mode.ts:3268 | **缺失** | — |
| `/fork` 从历史消息分叉 | slash-commands.ts:34；interactive-mode.ts:3273 | **缺失** | durable README.md:66 |
| `/clone` 当前位置复制会话 | slash-commands.ts:35；interactive-mode.ts:3278 | **缺失** | — |
| `/trust` 保存项目信任决定 | slash-commands.ts:36；interactive-mode.ts:3288 | **缺失**（直接读 context files，无信任门） | durable prompt.ts:33；trust 流见 core/trust-manager.ts |
| `/login [provider]` 认证配置 | slash-commands.ts:37；interactive-mode.ts:3293 | **缺失**（凭证与 pi 共享，须先在 pi 登录） | durable README.md:16,66 |
| `/logout` | slash-commands.ts:38；interactive-mode.ts:3299 | **缺失** | — |
| `/new` 新会话 | slash-commands.ts:39；interactive-mode.ts:3304 | **缺失**（重启进程才开新会话） | durable main.ts:6-13 |
| `/compact [instructions]` | slash-commands.ts:40；interactive-mode.ts:3309 | **已有**（含自定义指令与「Nothing to compact」提示） | durable tui.ts:628-631；runtime.ts:253-280 |
| `/resume` 会话选择器 | slash-commands.ts:41；interactive-mode.ts:3335 | **缺失**（`--continue` 只取最新目录） | durable sessions.ts:30-43；README.md:66 |
| `/reload` 重载资源 | slash-commands.ts:42；interactive-mode.ts:3315 | **缺失**（skills/context files 每目录只加载一次） | durable prompt.ts:24 |
| `/quit` | slash-commands.ts:43；interactive-mode.ts:3340 | **部分**（Ctrl+C/Ctrl+D 直接退出） | durable tui.ts:194-195；README.md:45-46 |

### 1.2 隐藏命令（3，不在注册表、无补全）

| 命令 | stable 位置 | durable 状态 |
|---|---|---|
| `/debug` | interactive-mode.ts:3320 | **缺失** |
| `/arminsayshi` | interactive-mode.ts:3325 | **缺失** |
| `/dementedelves` | interactive-mode.ts:3330 | **缺失** |

### 1.3 非 `/` 输入与资源命令

| 项 | stable 位置 | durable 状态 | 依据 |
|---|---|---|---|
| `!cmd` / `!!cmd`（后者不进上下文）bash 直通 | interactive-mode.ts:3346-3362 | **缺失**（所有文本都作为 prompt 提交） | durable tui.ts:632 |
| extension 注册命令（如 `/mcp`、`/llama`） | docs/slash-commands.md:54-58；extensions.ts API `pi.registerCommand()`（docs/extensions.md:78） | **缺失**（不加载 pi 扩展） | durable README.md:66 |
| prompt template 命令（`/<template>` 展开） | docs/prompt-templates.md:19；agent-session.ts:2005 | **缺失** | durable README.md:66 |
| `/skill:name [args]` 技能命令 | docs/skills.md:45-53；agent-session.ts:2143-2148 | **缺失**（技能描述已进 system prompt，但无命令展开形态） | durable prompt.ts:34 |
| slash 命令补全菜单（输入 `/` 搜索） | docs/slash-commands.md:3 | **缺失** | durable editor 为普通提交 |

---

## 2. 键位（keybindings）

权威源：`packages/coding-agent/docs/keybindings.md`（~90 个 action，含 `tui.editor.*` 32、`tui.input/select` 10、`tui.altScreen.*` 14、app 级 6、session 10、model/thinking 7、显示/队列 4、tree 导航 11、scoped-models 选择器 5）；定义于 `packages/coding-agent/src/core/keybindings.ts`（`DEFAULT_EDITOR_KEYBINDINGS`/`DEFAULT_APP_KEYBINDINGS`），用户可改 `<agent-dir>/keybindings.json`。

durable 复用 pi 的 `KeybindingsManager`（durable tui.ts:186-187），即改键基础设施在；实际接线的 action：

| action | stable 默认 | durable 状态 | 依据 |
|---|---|---|---|
| `app.clear` | ctrl+c（先清空再退出） | **部分**（语义不同：直接退出） | durable tui.ts:195；README.md:45-46 |
| `app.exit`（Ctrl+D） | ctrl+d | **已有** | durable tui.ts:194 |
| `app.model.select` | ctrl+l | **已有** | durable tui.ts:196 |
| `app.thinking.cycle` | shift+tab | **已有** | durable tui.ts:197 |
| `app.tools.expand` | ctrl+o | **已有**（工具输出+压缩摘要共用展开） | durable tui.ts:198-202 |
| `app.message.followUp` | alt+enter | **已有** | durable tui.ts:203-208 |
| `tui.select.*` 4 项 | — | **已有**（ListSelector 转发） | durable tui.ts:92-94 |
| `app.interrupt`（Esc 中止） | escape | **已有**（onEscape→abort，含中止压缩） | durable tui.ts:193；README.md:37 |
| `app.clipboard.pasteImage`（ctrl+v 粘贴） | ctrl+v | **缺失** | durable 无图片 |
| `app.editor.external`（ctrl+g 外部编辑器） | ctrl+g | **缺失** | — |
| `tui.altScreen.search`（ctrl+shift+f transcript 搜索） | ctrl+shift+f | **缺失** | — |
| `app.session.*` / `app.tree.*` / `app.models.*` / `app.thinking.toggle` / `app.message.copy|dequeue` / `app.suspend` | 见 docs/keybindings.md:130-194 | **缺失** | durable tui.ts 只注册上表 action |
| transcript 滚动 pageUp/pageDown 等 `tui.altScreen.*` | pageUp/pageDown 等 | **部分**（ScrollView follow:end，无按键滚动绑定） | durable tui.ts:217 |

---

## 3. `settings.json` 设置项（按域）

权威源：`packages/coding-agent/docs/settings.md` + schema `packages/coding-agent/src/core/settings-manager.ts:133` 起（`interface Settings`）。用户级 `~/.pi/agent/settings.json`、项目级 `.pi/settings.json` 叠加（docs/settings.md:3）。

| 域 | stable 要点（条数） | durable 状态 | 依据 |
|---|---|---|---|
| Model/thinking（9）：`defaultProvider` `defaultModel` `defaultThinkingLevel` `modelThinkingLevels` `thinkingBudgets` `enabledModels` `hideThinkingBlock` `showCacheMissNotices` `cacheWarming` | docs/settings.md:9-23 | **部分**：读 defaultProvider/defaultModel/defaultThinkingLevel；其余不读 | durable harness-setup.ts:106-113 |
| Interaction（6）：`steeringMode` `followUpMode` `externalEditor` `doubleEscapeAction` `treeFilterMode` `defaultProjectTrust` | docs/settings.md:27-34 | **部分**：steeringMode/followUpMode 生效；其余缺失 | durable harness-setup.ts:43-47 |
| Tools（3）：`defaultTools` `codemode.mode` `codemode.inlineBudget` | docs/settings.md:38-58 | **缺失**（工具集固定 CodingTools+subagent，无按需启停） | durable harness-setup.ts:52-56 |
| Sessions（1）：`sessionDir` | docs/settings.md:64 | **缺失**（固定 `experimental/durable-sessions/`） | durable sessions.ts:20-25 |
| Compaction（4）：`enabled` `reserveTokens` `keepRecentTokens` `modelOverrides` | docs/settings.md:68-79 | **已有**（Harness settings getter 每次使用时读取） | durable harness-setup.ts:36-38；README.md:59-60 |
| Branch summaries（2）：`branchSummary.reserveTokens` `skipPrompt` | docs/settings.md:83-87 | **缺失**（无分支概念） | — |
| Terminal/display（22）：`theme` `quietStartup` `tuiMode` `fullscreen*` 4 `editorPaddingX` `outputPad` `autocompleteMaxVisible` `showHardwareCursor` `terminal.*` 7 `images.*` 2 `markdown.*` 2 | docs/settings.md:91-115 | **部分**：theme + terminal capability overrides 生效；其余缺失 | durable tui.ts:568,641-646 |
| Network/retry（11）：`transport` `httpProxy` `httpIdleTimeoutMs` `websocketConnectTimeoutMs` `retry.*` 7 | docs/settings.md:119-133 | **部分**：httpProxy/httpIdleTimeoutMs/retry 全域/stream 超时生效 | durable harness-setup.ts:19-49 |
| Shell（3）：`shellPath` `shellCommandPrefix` `npmCommand` | docs/settings.md:137-143 | **缺失** | — |
| Resources（6）：`packages` `extensions` `skills` `prompts` `themes` `enableSkillCommands` | docs/settings.md:149-160 | **部分**：仅 `skills`（skillPaths 进 prompt）；packages/extensions/prompts/themes 缺失 | durable prompt.ts:34 |
| Updates/telemetry（4）：`collapseChangelog` `enableInstallTelemetry` `enableAnalytics` `warnings.anthropicExtraUsage` | docs/settings.md:164-169 | **缺失** | — |

---

## 4. 启动 flags 与子命令

权威源：`packages/coding-agent/docs/cli.md`（接口在 `src/cli/setup.ts` 解析、`src/main.ts:111-131` 分发模式）。

| 组 | stable flags | durable 状态 | 依据 |
|---|---|---|---|
| 模式/输出（4）：`-p/--print` `--mode text\|json\|rpc` `--export <input> [output]` | docs/cli.md:43-51 | **缺失**（仅 TUI） | durable main.ts:15-17 |
| 模型（6）：`--provider` `--model` `--api-key` `--thinking` `--models` `--list-models` | docs/cli.md:63-74 | **缺失**（`findInitialAgentModel` 支持 cli 参数但 main.ts 不传） | durable harness-setup.ts:91-105 vs main.ts:6-13 |
| 会话（8）：`-c/--continue` `-r/--resume` `--session` `--session-id` `--fork` `--session-dir` `--no-session` `-n/--name` | docs/cli.md:86-101 | **部分**：仅 `--continue`/`-c` | durable main.ts:9 |
| 工具（4）：`-t/--tools` `-xt/--exclude-tools` `-nbt/--no-builtin-tools` `-nt/--no-tools` | docs/cli.md:119-128 | **缺失** | — |
| 资源（11）：`-e/--extension` `-ne/--no-extensions` `--no-mcp` `--skill` `-ns/--no-skills` `--prompt-template` `-np/--no-prompt-templates` `--theme` `--use-theme` `--no-themes` `-nc/--no-context-files` | docs/cli.md:194-216 | **缺失** | — |
| 提示/进程（9）：`--system-prompt` `--append-system-prompt` `--tui-mode` `--verbose` `-a/--approve` `-na/--no-approve` `--offline` `-h/--help` `-v/--version` | docs/cli.md:229-248 | **缺失** | — |
| 子命令（8）：`pi install/remove/uninstall/update/list/config/auth/mcp` | docs/cli.md:8-16, 250-332 | **缺失** | durable 是 `node --import ... main.ts` 直跑（README.md:8） |
| `@path` 文件/图片引用、stdin 管道拼接、`--` 终止符 | docs/cli.md:32-39 | **缺失** | — |

---

## 5. 功能面 parity checklist

### 5.1 MCP 集成 — durable **缺失**（整块）

stable 面（`packages/mcp` 连接层 + `src/extensions/mcp` builtin + `src/core/mcp-servers.ts` + docs/mcp.md）：

| 项 | stable 位置 | durable 状态 |
|---|---|---|
| `mcp.json` 用户级/项目级服务器配置（stdio + streamable HTTP） | docs/mcp.md:30-64；core/mcp-servers.ts | **缺失** |
| `/mcp` 交互管理（状态/重连/启停/exposure） | docs/mcp.md:88-90（builtin:mcp 注册） | **缺失** |
| `pi mcp add/remove/list/login/logout` 子命令 | docs/cli.md:318-332 | **缺失** |
| MCP OAuth（动态注册/CIMD/refresh，`mcp-auth.json`） | docs/mcp.md:115-187 | **缺失** |
| exposure 体系：`codemode`/`deferred`/`direct`/`hidden` + `toolExposure` | docs/mcp.md:189-231 | **缺失** |
| MCP resources 三工具（`list_mcp_resources` 等） | docs/mcp.md:236-248 | **缺失** |
| `pi.registerMcpServer()` 扩展注册 | docs/extensions.md:192-203 | **缺失** |

依据：durable registry 只装 `CodingTools` + pi-prompt + `Subagent`（harness-setup.ts:52-56；runtime.ts:133-134），不加载 pi 扩展系统，无 mcp.json 读取路径。

### 5.2 codemode 与 tool_search — durable **缺失**

stable：QuickJS 沙箱脚本编排工具 `codemode` + 延迟声明工具 `tool_search`（builtin extensions，默认 inactive，`src/extensions/codemode/`、`src/extensions/tool-search/`；docs/codemode.md；启用方式 docs/cli.md:151-183）。durable 工具集固定 4+1，无编排/延迟声明层。

### 5.3 Extensions 加载 — durable **缺失**（pi 生态），另有自有小体系

stable：`src/core/extensions/` 加载用户/项目/CLI 指定扩展（jiti 免编译 TypeScript），API 面 `pi.on/registerTool/registerCommand/registerShortcut/registerFlag/registerProvider/registerVirtualModel/registerMcpServer/appendEntry/sendMessage` 等约 15 类集成点（docs/extensions.md:73-88）；四个 builtin：`builtin:mcp` `builtin:llama.cpp` `builtin:codemode` `builtin:tool-search`（docs/settings.md:160）。packages 分发（`pi install` npm/git 源）。

durable：用 pi-durable 自有 `defineExtension` 机制，固定装 3 个（CodingTools、pi-prompt、Subagent），无目录发现、无用户扩展入口（runtime.ts:133-134）。**注意**：两套 extension API 不兼容，这是架构层 parity 决策点。

### 5.4 认证 `/login` 各 provider 流 — durable **缺失**

stable：`/login [provider]` OAuth 浏览器流（openai/anthropic/google/xai/groq 等，`core/auth-storage.ts`、`core/runtime-credentials.ts`）、环境变量 API key、`!command` 取 key、provider 专项配置（Radius/Azure/Bedrock/Cloudflare×2/Vertex，docs/providers.md:86-227）、`pi auth check/print-api-key/print-bearer-token`（docs/cli.md:293-316）。durable 复用 pi 的 ModelRuntime 与凭证存储（README.md:16），即**已登录则可用**，但自身无任何登录/登出/检查入口。

### 5.5 Session 管理 — durable **部分**

stable：JSONL 会话树（`core/session-manager.ts`），`/tree` 分支导航+分支摘要（branchSummary）、`/fork`、`/clone`、`/resume` picker（搜索/重命名/删除/排序）、`--session/--session-id/--fork`、`/import`、`/export`（`core/export-html/` HTML + JSONL）、`/share`（gist/Radius）、`/name`、`/session` 统计、`/bug` 报告（docs/sessions.md）。

durable：SQLite 会话（`~/.pi/agent/experimental/durable-sessions/<cwd-hash>/<session>/session.sqlite`，sessions.ts:20-25）+ 进程锁（10s 过期，sessions.ts:45-54）；`--continue` 只挑最新（sessions.ts:30-43）。无 picker/fork/tree/import/export/share/name。**独有**：崩溃后续跑中断 tool call、turn 中断结果补记（README.md:20-22）。

### 5.6 运行模式 — durable **缺失**（3/4）

stable：interactive / `--print` / `--mode json`（`src/modes/json-event.ts`）/ `--mode rpc`（`src/modes/rpc/`、`src/rpc-entry.ts`，JSONL 命令协议 docs/rpc.md）+ 非重定向自动 print（main.ts:111-123）。SDK 嵌入（docs/sdk.md）。durable 仅 interactive。

### 5.7 图片 — durable **缺失**

stable：ctrl+v 剪贴板图片→临时文件插入（interactive-mode.ts:3171-3182）、`@path` 图片入首条消息（main.ts:437-438）、`read` 工具读图、terminal kitty/iterm2 内联渲染（tool-execution.ts:356；settings `terminal.showImages` 等）、发送前 2000×2000 缩放（settings `images.autoResize`）。durable：`userText()` 只取 text block（tui.ts:522-528），无粘贴、无渲染、无发送。

### 5.8 `/model` 与 thinking — durable **部分**

stable：模型选择器（fuzzy 搜索、收藏/缓存元数据、`/model provider/model` 直选，interactive-mode.ts:3215；`model-search.ts`）、`/thinking` 七档（off..max）、Ctrl+P 循环 + `/scoped-models`、`app.thinking.save`、thinking block 折叠（ctrl+t）、模型目录刷新（`model-catalog-refresh.ts`）、`/llama` 本地模型管理、classifier/image 模型（docs/models.md:129-187）。durable：`/model` 简单列表选择（tui.ts:577-600）、Shift+Tab 循环 thinking（runtime.ts:283-291）、模型切换时 clamp thinking（runtime.ts:292-298）。无搜索/循环/收藏/刷新/折叠。

### 5.9 上下文窗口指示器 — durable **已有**（近似）

stable：footer 显示上下文用量，接近上限自动压缩 + 变色（docs/sessions.md:40；`core/footer-data-provider.ts`）。durable：footer `percent%/contextWindow` 常显、>90% 变红，取自最近一次成功回答的 usage（tui.ts:385-393, 549-561）；缺 cache-hit 口径等细节。

### 5.10 其余 stable 功能面速览

| 功能 | stable 位置 | durable 状态 |
|---|---|---|
| 自动/手动 compaction | core/compaction/；docs/compaction.md | **已有**（Harness 内建 + settings getter） |
| steering/follow-up 队列 | settings steeringMode/followUpMode；docs | **已有**（inbox 队列显示 + whenBusy 提交） |
| prompt templates | core/prompt-templates.ts；docs/prompt-templates.md | **缺失** |
| skills（Agent Skills 规范） | core/skills.ts；docs/skills.md | **部分**：描述进 system prompt、模型可读 SKILL.md；无 `/skill:name`、无 reload |
| AGENTS.md/CLAUDE.md context files | core/resource-loader.ts | **部分**：已注入（每目录一次）；无 `-nc` 开关、无信任门 |
| themes（含 system 主题、light/dark 对） | modes/interactive/theme/；docs/themes.md | **已有**（InteractiveThemeController） |
| external editor | interactive/external-editor.ts | **缺失** |
| bug report 上传/zip | core/bug-report*.ts | **缺失** |
| crash log、诊断 | core/crash-log.ts、diagnostics.ts、settings-diagnostics.ts | **缺失**（Harness onReport 进 notices，runtime.ts:145,199-201） |
| telemetry/更新检查 | core/telemetry.ts；`pi update` | **缺失** |
| shell aliases 指南 | docs/shell-aliases.md（`shellCommandPrefix`） | **缺失** |
| subagent | 无内置（靠扩展） | **durable 独有**：`subagent` 工具 + 子会话存活可续聊（subagent.ts:19-52；README.md:26-29） |
| 任务图面板 | 无 | **durable 独有**：`/tasks` 实时 `Harness.taskGraph()`（runtime.ts:299-309；README.md:30-31） |
| 崩溃恢复续跑 | 无 | **durable 独有**（README.md:20-22） |

---

## 6. 内置工具对照

stable 8 个（docs/cli.md:140-149；定义 `src/core/tools/`：bash.ts/powershell.ts/edit.ts/write.ts/read.ts/grep.ts/find.ts/ls.ts）+ 2 个 builtin extension 工具（codemode、tool_search，默认 inactive）+ MCP 工具 + 扩展工具。durable：`CodingTools` = read/write/edit/bash（`packages/durable/src/tools/index.ts:21-25`）+ `subagent`（自装）。**缺** powershell（可经 `createPowerShellTool()` 加装）、grep、find、ls、codemode、tool_search、全部 MCP/扩展工具。

---

## 7. G1 输入建议（优先级排序参考，非决定）

1. **结构性差距**（决定架构，早拍板）：pi ExtensionAPI 生态兼容路线（5.3）——MCP/codemode/templates/packages 全挂在这条线上；MCP 直连（5.1）可先行独立。
2. **大块用户面**：session 管理面（picker/fork/tree/export/share，5.5）、print/json/rpc 模式（5.6）、图片（5.7）。
3. **中块**：`/login`（5.4）、skills 命令化 + `/reload`、工具面补齐（§6）、`/settings` 与设置热改。
4. **小件**：`!` bash 前缀、`/copy`、`/name`、`/hotkeys`、`/bug`、transcript 搜索、外部编辑器、键位补全。
5. **保留 durable 独有**：任务面板、subagent 会话切换、崩溃续跑——parity 时勿倒退。

## 复核方式

全部结论来自本 worktree（`research/r2-stable-feature-inventory` 分支，基线 commit `080bddb1e`）源码与 docs 实读；无二手资料。行号为当日快照，后续以 `git log` 对应文件为准。
