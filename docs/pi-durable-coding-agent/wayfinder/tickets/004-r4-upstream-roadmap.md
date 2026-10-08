---
id: 004
title: "R4 upstream-roadmap"
labels: [wayfinder:research]
type: research
status: closed
assignee: "agent"
blocked-by: []
---

## Question

上游 earendil-works/pi 的 durable 演进轨迹是什么？fork 的 merge 基线策略怎么定？

产出 `docs/research/upstream-roadmap.md`：

1. `v1.0.0..main` 提交脉络：`experimental/durable`、`packages/durable`、pico 文档、work-packages 的演进节奏与方向（本仓 git log/git show 即完整历史，无需联网）。
2. 设计文档信号：`packages/agent/docs/pico-v3.md`、`packages/durable/docs/`（spec、pico-v5-*、handoff）、`packages/agent/docs/post-wp05-roadmap.md`——上游自己规划了什么、哪些 parity 工作大概率上游会先做。
3. 结论：merge 基线建议——跟 main 的节奏（按 release tag / 按周）、merge vs rebase 取舍、冲突高危目录（我们大改 `experimental/durable` 后）、"别抢先做"清单（上游马上会重写的部分）。

## Resolution

上游 durable 演进链是 pico→pico2→pico3→**Pico5**（09-09..09-24 设计淘汰链），Pico5 规格即 `packages/durable/docs/spec.md`，Package 1–23 已全部实现并在 v1.0.0（10-01）删除旧 AgentHarness 后成为唯一现行动力——**不存在"将被 pico2/pico-v5 重写"的下一代**，被淘汰的是旧一代。节奏极快：v1.0.0 后 7 天连发 5 个 release、142 commits（39 个触及 durable/experimental），且 v1.0.4/v1.1.0 均带 Breaking Changes（Experimental API）。"别抢先做"清单以 `experimental/services/README.md` 的 TODO（navigate/nextRun/subagent keyed services/transcript paging）与 `experimental/durable/README.md` 的 "Not here" 为准，另含执行环境硬化与 Chord graph 存储方向。merge 基线：**跟 release tag（≤1 周一批）+ merge 不 rebase + 冲突高危目录分级**（experimental/durable 与 services 最高危、packages/durable/src/harness 原则不改）；fork 当前代码 delta 为零，现在定基线成本最低。详见 [docs/research/upstream-roadmap.md](../../docs/research/upstream-roadmap.md)（commit ca6b44075）。
