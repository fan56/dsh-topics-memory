---
id: 007
title: "R5 reference-implementations"
labels: [wayfinder:research]
type: research
status: closed
assignee: "agent"
blocked-by: []
---

## Question

dsh（DeepSeek Harness + 用户的 dsh-tui-pi）与 opencode（sst/opencode）的实现里，有哪些可借鉴到 pi-durable-coding-agent 的模式？

产出 `docs/research/reference-implementations.md`：

1. **TUI 架构**：`~/github/dsh-tui-pi` 如何在 pi monorepo 之外用 `@earendil-works/pi-tui` 搭 TUI——组件复用面、渲染循环、状态注入、与 dsh 本体的对接方式（这是"外部仓复用 pi-tui"的现成先例）；opencode 的 client/server + TUI 分层与插件面形状。
2. **会话管理**：opencode 的 session 存储/列表/resume 设计（对将来 durable 版 session 管理层的启示）。
3. **扩展宿主面**：dsh 的 cordis 插件如何注册命令与 UI（用户熟悉这套心智模型）；opencode 的 plugin API 形状（命令/工具/事件面）。
4. **结论**：对 P1（TUI 骨架选型）与 ctx.ui 宿主面设计的具体启示——照抄什么、避开什么。

只读调研：deepseek-harness 与 dsh-tui-pi 为本地仓（**只读，不改**）；opencode shallow clone 到 /tmp 或走 web。带 file:line 引用。

## Resolution

调研完成，产出 [docs/research/reference-implementations.md](../../docs/research/reference-implementations.md)（commit 14a31d60b）。核心发现：dsh-tui-pi 证明 pi-tui 可以纯 npm 依赖（0.85.1 精确 pin、零 patch）在 pi monorepo 外复用，但外部复用的代价是自建全套 shell 设施（canvas 背景 decorator、focus 契约、主题 bundle、overlay 框架）——这些 stable interactive-mode 已内置，直接量化了「另起 TUI 骨架」的隐性成本，为 P1 倾向 stable 骨架 + durable 后端提供三条论据。opencode 展示了干净的 client/server 分层（TUI 薄视图 + SSE sync store）与字段化的 session 存储（SQLite + slug/parentID/archived/like 搜索），是 durable session 管理层最成形的参照。扩展宿主面有两种哲学：dsh 无 ctx.ui（UI = 服务消费者 + 事件渲染，问答/命令/prompt 段/配置四个服务面），opencode 有显式槽位化 UI 插件面（TuiHostSlotMap 槽 + 预制 Dialog + keymap 合一）——§4 给出两边的照抄/避开清单，并指出 ctx.ui parity 缺口可转化为「durable TUI 暴露哪些等价服务」的架构选项。
