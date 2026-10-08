---
id: 005
title: "G1 parity-phasing"
labels: [wayfinder:grilling]
type: grilling
status: closed
assignee: "agent"
blocked-by: [001, 002, 003]
---

## Question

拿着 R1（durable 能力面）、R2（stable 功能清单）、R3（extensions/MCP 兼容路径）的结论与用户对齐：MVP 切片与分期顺序——v0.1 包含什么、各期验收标准是什么、"体验一致"的可检验定义是什么。

HITL：需用户逐题确认（一次一个问题）。

## Resolution

2026-10-08 与用户逐题定案：

- **Q1 方向 + 自研边界**：选差异化优先（B）——首版主攻上游不会做的扩展宿主面，避开上游 TODO。总策略：**能复用就复用，复用不了才自己写**；自研收缩到最小内核 = 实验版本体上的接口层（ctx.ui 界面面/命令注册/原始输入合成 + 个别一行级 CLI 口子，如启动指定会话），**其余一切功能尽量做成 extension、官方原生实现后可摘除**（会话选择器、bash 直通、MCP bridge、footer 等均 extension 化）。做不成 extension 的仅：print/rpc 进程级模式、harness 内部行为（均在长尾/上游 TODO）。已知代价：若官方将来出自己的界面接口，需把内核换成他们的并小改 extension——换掉而非重写。
- **Q2 v0.1 验收样本**：仅 `pi-powerline-footer`（用户自有扩展，纯 UI）移植全绿 = ctx.ui 界面面成型。命令注册/工具平移/input 事件三条线不设 v0.1 卡点，风险后移到首个工具型扩展移植时。
- **Q3 分期顺序**：v0.1 核心环+接口层+footer 绿 → v0.2 扩展全线（命令/工具/事件面补齐，自家扩展按需搬）→ v0.3 MCP（R3 原生 bridge 方案）→ v0.4 会话管理（优先赌上游出、出则搬，未出再自建数据层）→ 长尾（print/rpc/export/图片）按需不主动排期。
- **Q4 验收定义**："体验一致" = **分期对齐**——每期落地时该期覆盖的 R2 checklist 域逐项与 stable 打勾（命令行为/键位/设置语义/主题渲染），不做一次性全局验收。100ms commit 节流观感：ticket 008 的 15 分钟人工检查；钝则 v0.1 先调节流设置逃生口，再考虑本体改动。

输入来源：docs/research/{durable-api-surface,stable-feature-inventory,extension-mcp-compat}.md。
