---
id: 008
title: "T1 streaming-feel-check"
labels: [wayfinder:task]
type: task
status: closed
assignee: "agent"
blocked-by: []
---

## Question

人工跑一次现有实验版 durable agent，确认 100ms commit 节流下流式输出/bash 输出的观感可接受（R1 标记的 G1 前置验证，已并入 v0.1 出口条件）。

步骤（主会话已备好依赖安装；用户执行）：

1. `cd ~/github/pi-durable-coding-agent`（依赖由主会话 `npm install --ignore-scripts` 装好）
2. `node --import ./packages/coding-agent/src/experimental/source-resolver.ts packages/coding-agent/src/experimental/durable/main.ts`（登录凭据与 pi 共享，无需重新 /login）
3. 观察：流式回复跟手程度、长 bash 输出滚动、滚动中继续输入；退出后加 `--continue` 复开验证
4. 结论记入本 ticket：可接受 / 钝（记录具体场景）

钝的处置：v0.1 先调 commit 节流设置（`settings.progress` 逃生口，见 docs/research/durable-api-surface.md），仍不行再考虑本体改动。

## Resolution

**用户免验关闭**（2026-10-08，"我不试了,你继续吧"）。渲染正确性已由 P1 spike 的 tmux 实跑覆盖（流式/工具输出均正常渲染）；主观"跟手度"判断后置到 v0.1 日常使用时自然暴露，钝则按上述处置路径调 `settings.progress` 逃生口。风险登记在 MAP fog（性能基线条）。
