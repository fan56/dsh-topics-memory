---
id: 006
title: "P1 tui-architecture"
labels: [wayfinder:prototype]
type: prototype
status: closed
assignee: "agent"
blocked-by: [001, 002, 007]
---

## Question

TUI 骨架选型：路线 A——扩展 `src/experimental/durable/tui.ts`，逐步复用更多 interactive-mode 组件；路线 B——以 interactive-mode（`src/modes/interactive/`）为骨架，把后端换成 durable Harness。做一个可运行的粗 spike（cheap、rough、concrete）供用户反应，不追求功能完整。

HITL：原型产出后需用户试用并表态。

## Prototype（待用户试用）

- 分支：`spike/p1-route-b`（worktree `.wt/p1`，throwaway，未进 feat 分支）；代码在 `packages/coding-agent/src/experimental/durable-p1/`，~590 行胶水（facade 328 + 事件适配 210 + 入口/会话定位 85）
- 运行（worktree 内，首次需 hydrate 模型数据）：
  ```bash
  cd ~/github/pi-durable-coding-agent/.wt/p1
  (cd packages/ai && npm run hydrate-model-data)   # 一次性
  node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
    packages/coding-agent/src/experimental/durable-p1/main.ts
  ```
- 已验证（agent tmux 实跑）：TUI 完整渲染（模型/thinking/上下文/footer/扩展/模板加载）、流式回复、bash 工具调用渲染、Esc 中止、事件适配器单元级校验
- 待用户确认：多轮 + compaction 触发、运行中 steer、`/model` 切换、kill 后重启续跑、subagent 工具
- 结论预告：路线 B 可行，胶水成本 ≈ 路线 A 先例（~5100 行）的 11%；缺口集中在"宿主面 API"清单（transcript 重建、compaction 结果、会话身份/列表、queue 按 text 操作、若干 session 事件、工具装载可见性）——正是 G2 的输入

## Resolution

**定案：路线 B——stable interactive-mode 骨架 + durable 后端。**（2026-10-08）

依据：spike `spike/p1-route-b` 实测——interactive-mode 零改动跑通核心环（agent tmux 实跑：渲染/流式/工具/中止全过），胶水 ~590 行 ≈ 路线 A 先例的 11%；R5 的 dsh-tui-pi 量化证据支持。用户委托决策（"我不试了,你继续吧"），未做人工试用；多轮/compaction/steer/kill-续跑/subagent 等 spike 未覆盖项转入 v0.1 构建验收清单。

已知生产化注意：facade 依赖 AgentSession 私有接缝（`_handleAgentEvent`/`_emit`，agent-session.ts:513），生产化需把这层缝变公共契约或提供"外部事件驱动 headless session"一等接口；两套事件词表（auto_retry/compaction 仅在 AgentSessionEvent 层）需在宿主面归一。缺口清单移交 G2（ticket 009）。
