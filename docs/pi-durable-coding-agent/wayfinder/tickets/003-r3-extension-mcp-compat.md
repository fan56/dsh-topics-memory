---
id: 003
title: "R3 extension-mcp-compat"
labels: [wayfinder:research]
type: research
status: closed
assignee: "agent"
blocked-by: []
---

## Question

pi extensions 生态与 MCP 在 durable harness 上的兼容路径是什么？

产出 `docs/research/extension-mcp-compat.md`：

1. stable extensions API 面（`docs/extensions.md` + `src/extensions/`、jiti 加载、`pi.*` 对象）vs durable Registry/extensions（packages/durable README Extensions 节、harness/define、per-conversation agents）：概念对照表（stable 的 tool/command/editor/footer/… vs durable 的 tool/section/hook/wrapper/task）。
2. 抽样 1-2 个真实扩展（如 `~/github/pi-topic-memory`、`~/github/pi-powerline-footer`，只读）：看用了哪些 API，判断直接跑 / 适配层 / 必须移植，各工作量级。
3. `pi-mcp`（packages/mcp）与 coding-agent 的 MCP manager 在 durable harness 里复用的路径：manager 是否与 agent-loop 解耦、MCP tool 如何投影进 durable Registry。
4. 结论：兼容策略选项（compat shim / 双轨 / 只移植自家扩展）及利弊，供 G1 拍板。

带 file:line 引用。

## Resolution

研究完成，发现落 `docs/research/extension-mcp-compat.md`。核心结论：stable 与 durable 扩展模型是「进程级事件回调对象 vs Registry 里的声明式 bundle」之差，stable 40+ 事件对 durable 8 个 hook，但 `ExtensionRunner` 全部能力经 `bindCore` 回调注入（runner.ts:410），pi.* 面与 AgentSession 无静态耦合。抽样两个扩展：pi-topic-memory 是中等移植量（tools 直移，卡点在 `input` 事件/注入语义与 `ctx.ui` 命令族），pi-powerline-footer 几乎全落 TUI 宿主面。MCP 判定可大比例复用：传输层（packages/mcp）零依赖、连接层不 import AgentSession、投影层纯函数 + 窄接口 `McpToolCaller`，durable 侧走 bridge extension + registry 同名重装投影动态工具集。兼容策略建议「shim 只做宿主面」（ctx.ui/命令/loader），不整体模拟 stable 事件循环，供 G1 拍板。

发现文档: `docs/research/extension-mcp-compat.md`
