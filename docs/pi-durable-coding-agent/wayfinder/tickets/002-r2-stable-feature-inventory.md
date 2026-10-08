---
id: 002
title: "R2 stable-feature-inventory"
labels: [wayfinder:research]
type: research
status: closed
assignee: "agent"
blocked-by: []
---

## Question

stable `pi` coding agent（packages/coding-agent，v1.1.0 基线）的完整功能清单是什么？作为 parity checklist。

产出 `docs/research/stable-feature-inventory.md`：

1. 全部 slash 命令（含隐藏）、默认键位（keybindings）、`settings.json` 设置项（按域分组、列要点）、启动 flags。
2. 功能面：MCP 集成（`/mcp`、OAuth、tool_search）、codemode、extensions 加载（目录与 API 面）、`/login` 各 provider 流、session 管理（树/fork/resume/导出 HTML）、print/rpc 模式、图片粘贴与渲染、`/model` 与 thinking 选择、上下文窗口指示器等。
3. 每项标注 experimental durable agent（`src/experimental/durable/`）已有 / 缺失 / 部分，依据 file:line。

清单要完整、可勾选——它是 G1（分期拍板）的直接输入。

## Resolution

清点完成：stable 侧 24 个内置 slash 命令 + 3 个隐藏命令（`/debug` 等）+ `!`/`!!` bash 前缀 + 资源命令，~90 个可配置键位 action，~71 个文档化设置项（11 域），~41 个启动 flag + 8 个子命令，8 个内置工具（read/bash/powershell/edit/write/grep/find/ls）。durable 侧只有 4 个命令（`/model` `/compact` `/agents` `/tasks`）、6 个接线键位、约 10 项启动时读取的设置、1 个 flag（`--continue`）、4+1 个工具。完整差距是：MCP 全家（mcp.json/`/mcp`/OAuth/tool_search）、pi ExtensionAPI 扩展生态与 packages、codemode、session 管理面（picker/fork/tree/export/share）、print/json/rpc 模式、图片、`/login`、prompt templates、`/skill:name` 命令形态——其中 ExtensionAPI 兼容路线是结构性决策，MCP 等大块功能都挂在它下面。durable 另有三个 stable 没有的独有能力（崩溃续跑、任务图面板、subagent 会话切换），parity 时应保留。逐项证据与 G1 优先级建议见 [docs/research/stable-feature-inventory.md](../../docs/research/stable-feature-inventory.md)（commit `39271693a`）。
