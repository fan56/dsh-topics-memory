---
id: 001
title: "R1 durable-api-surface"
labels: [wayfinder:research]
type: research
status: closed
assignee: "agent"
blocked-by: []
---

## Question

`@earendil-works/pi-durable`（packages/durable）对外 API 全景是什么？stable coding agent TUI 依赖的运行时能力各映射到 durable 的什么？

产出 `docs/research/durable-api-surface.md`：

1. API 面：Harness / Conversation / Entry / Commit / Document（`pi.live`、`pi.inbox`、`pi.agent`、`pi.usage`、`pi.provider`）/ Task（`pi.generation`、`pi.tool`、compaction）/ Submission、Registry 与 extensions、hooks、事件流、`Conversation.viewState()`、`Harness.taskGraph()`、storage 后端（memory/jsonl/sqlite + conformance suite）——各自能力与稳定性标注。
2. 映射矩阵：stable `packages/coding-agent/src/modes/interactive` 消费的每个运行时能力（session 事件流、流式 partial、工具进度、queue/steer、compaction 状态、model/thinking 选择、usage/cost、abort、session 列表/resume/fork）→ durable 对应物：有 / 无 / 部分（写清差异）。
3. 结论：durable 无对应物的 stable 特性清单——这些要自建或改 harness，直接影响 G1 分期。

每条结论带 file:line 引用；primary source 只用本仓源码与 README。

## Resolution

durable（@earendil-works/pi-durable@1.1.0）的对外 API 面分九层盘点完毕（Harness/Conversation/Submission/五个 pi.* 文档/三个内置任务+hooks/Registry/观察面 viewState·watch·watchEvents·taskGraph/Storage+conformance/Session 底层逃生舱），整体标注 Experimental（README:3）。stable TUI 消费的 24 项运行时能力逐项映射成矩阵：主干（事件流、流式 partial、工具进度、queue/steer、compaction、model/thinking、usage、abort、fork、子代理）durable 已有等价物，其中子代理与崩溃恢复反而强于 stable。缺口集中在宿主应用层：无 session 元数据/列表 API、无树导航+branchSummary、无 bash 直跑通道、无队列批量编辑、compaction 无单独取消与运行时开关、无 agent_settled/bash_execution_update/summarization_retry_* 事件、无虚拟模型、无 cache warmer、无图片输入、扩展生态面（MCP/skills/prompt templates/slash commands/扩展 UI）整体缺位——完整清单按"自建 vs 改 harness"分了 A/B/C 三类，直接作为 G1 分期输入。详见 [docs/research/durable-api-surface.md](../../docs/research/durable-api-surface.md)。
