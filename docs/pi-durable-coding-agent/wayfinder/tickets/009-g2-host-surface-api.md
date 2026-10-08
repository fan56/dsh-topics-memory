---
id: 009
title: "G2 host-surface-api"
labels: [wayfinder:grilling]
type: grilling
status: closed
assignee: "agent"
blocked-by: [006, 007]
---

## Question

ctx.ui 宿主面（最小自研内核）的 API 形状：照抄 stable ExtensionAPI 的哪些方法（setFooter / setEditorComponent(CustomEditor) / setWidget / 命令注册 / getContextUsage / getBranch …）、extension 生命周期如何对接 durable Registry（install/uninstall/热替换）、原始输入如何合成给 extension（对应 stable `pi.on("input")`）。以 pi-powerline-footer 的移植需求为最小完备标准，参考 R5（dsh-tui-pi / opencode）的模式。

HITL：API 取舍逐题与用户确认；P1（骨架选型）与 R5（参考调研）完成后开启。

## Resolution

**用户委托代决（2026-10-08），否决窗开放**——以下 API 形状在 v0.1 构建中落地，任何一条用户可随时否决回本票修订：

1. **槽位化 UI 面，不做自由绘制**（opencode 模式）：footer / widget / 自定义编辑器等固定槽位 + 预制 Dialog 工厂（alert/select/toast）；扩展只能占槽，不能任意画。
2. **命令与键位首版合一**：一个注册 API 同时声明命令与快捷键（opencode legacy `api.command` 两年后废弃的教训）。
3. **生命周期**：`lifecycle { signal, onDispose }`；状态读取走只读快照（viewState 派生），写入走显式写接口，不做可变出参（`(input, output)` 形状明确避开）。
4. **问答/确认走服务面**（dsh 模式 `ctx.userQuestions` waterfall），不进 UI 面。
5. **最小完备标准 = pi-powerline-footer 可移植**：setFooter / setEditorComponent(CustomEditor) / setWidget / getContextUsage / getBranch；`pi.on("input")` 由宿主合成事件提供。
6. **宿主面实现清单**（P1 spike 实测的 6 项 durable 侧缺口）：transcript 按 session 形状重建（EntryRecord→SessionEntry）、CompactionResult（摘要+条目落位）、会话身份/命名/列表、queue 按 text 操作（pendingMessageCount/getSteeringMessages/clearQueue）、`thinking_level_changed`/`session_info_changed`/`queue_update`/`agent_settled` 事件、工具装载可见性（footer 工具计数）。
7. **生产化接缝**：AgentSession 私有 `_handleAgentEvent`/`_emit` 依赖要么公共化、要么提供"外部事件驱动 headless session"一等契约（R4 约束下优先加文件不改上游）。

输入：docs/research/{reference-implementations,extension-mcp-compat}.md + spike `spike/p1-route-b` 摩擦清单。
