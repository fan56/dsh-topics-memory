---
labels: [wayfinder:map]
title: pi-durable-coding-agent
---

## Destination

以 `@earendil-works/pi-durable` 为执行底座（durable Harness + SQLite 会话）、复用 pi monorepo 既有组件（pi-tui、主题、键位、settings、auth、system prompt、tools）的 coding agent，TUI 命令/样式/功能与正式版 `pi` coding agent 基本一致，并暴露 durable 特有能力（崩溃续跑、task graph、子 agent 会话树、inbox 队列）。地图完成 = 通往它的决策全部落定、可以开工。

## Notes

- 仓：`~/github/pi-durable-coding-agent`（earendil-works/pi 本地 fork）。代码规则见仓根 `AGENTS.md` 上游部分，fork 层约定见其末节。
- HITL ticket（grilling/prototype）配 grilling + domain-modeling skill；research ticket 配 research skill（primary sources + file:line 引用，发现落 `docs/research/`）。
- 用户偏好：grill 类一次只问一个问题；文档中文、代码/commit 英文。
- 基线事实（2026-10-08 核实）：`src/experimental/durable/` 以 20+ 相对路径 import 复用 coding-agent 内部件，而 npm 包不导出它们 → 组件复用必须在 monorepo 内；stable（pi-agent-core loop + JSONL）与 durable（Harness 任务机 + SQLite）两条执行路径平行、互不依赖；pi-durable 1.0 起步、API Experimental。

## Decisions so far

- [R1 durable-api-surface](tickets/001-r1-durable-api-surface.md): pi-durable@1.1.0 九层 API（Harness/Conversation 17 方法/Submission 幂等/5 内置 documents/3 内置 tasks/Registry/观察面 viewState+watch+taskGraph/存储 4 后端+conformance/Session 逃生口），全部 Experimental。24 项 stable 运行时能力映射：核心 loop（事件流/流式/工具进度/steer/compaction/model 选择/usage/abort/fork/子agent）均有对应，子 agent 与崩溃恢复反而更强；语义差 = 事件派生自 commit（100ms 节流）、无 per-session 运行时开关、fork=新会话非树。无对应物分两类：应用层自建（session 元数据/列表/picker、queue 批量操作、context-%%、bash 直通、print 模式、导入导出、/login UI）vs 需动 harness/包（4 类事件、compaction-only abort、in-conversation 树导航、图片输入、虚拟模型、cache warmer）；最大缺口仍是 extension 生态。G1 需先验证 100ms 节流流式观感。详 `docs/research/durable-api-surface.md`。

- [R2 stable-feature-inventory](tickets/002-r2-stable-feature-inventory.md): stable 全景 = 24+3 个 slash 命令、~90 可配键位、~71 设置项、~41 flags + 8 子命令、8 内置工具、interactive/print/json/rpc 四模式；experimental durable 仅 4 命令/6 键位/4 工具/仅 interactive。五大缺口：extensions 生态（结构性，MCP/codemode/templates 都挂在这条线上）、MCP 全家、session 管理面（picker/fork/树/导入导出）、print/rpc 模式、图片+`/login`+templates+skills。详 `docs/research/stable-feature-inventory.md`。
- [R3 extension-mcp-compat](tickets/003-r3-extension-mcp-compat.md): 建议「shim 只做宿主面」——不整体模拟 stable ExtensionAPI（40+ 事件 vs durable 8 hooks，只能近似）；三件事分治：TUI 宿主长出 `ctx.ui`/命令注册面（两个样本扩展都卡在这，与 durable 核心正交）、MCP 走原生 bridge extension（传输层零依赖可原样用，投影经 `registry.install()` 同名重装，`replay:"unsafe"` 天然对齐）、自家 fleet 逐个移植（pi-topic-memory 中等、pi-powerline-footer 小-中，工具直移成本低）。未验证项列文档 §6。详 `docs/research/extension-mcp-compat.md`。
- [R4 upstream-roadmap](tickets/004-r4-upstream-roadmap.md): 现版 pi-durable **不会**被 pico 后继替代——pico→pico2→pico3→Pico5 是淘汰链，v1.0.0 删掉的是旧 AgentHarness；上游节奏 1-2 天一版、39/142 提交在 durable，方向 = 加固 + `experimental/durable` 产品化 + 新后端。**别抢先做**：services README 里上游自有的 TODO（树导航/resume 队列/subagent 服务化/历史分页）、experimental/durable 补全、env/tool 加固、pi-durable 公共 API 的任何 compat 层。Merge 基线：跟 release tag（非日更 main）、ff main 后 merge 不 rebase、周批 ≤1 周；改上游文件须 ticket 登记，`packages/durable/src/harness/**` 只经 ToolExecutionApi/HookApi 扩展不改。详 `docs/research/upstream-roadmap.md`。
- [G1 parity-phasing](tickets/005-g1-parity-phasing.md): **分期定案**——策略"能复用就复用，自研收缩到最小内核（本体 ctx.ui 接口层+一行级 CLI 口子），其余一切 extension 化、官方实现后可摘除"；v0.1 = 核心环+接口层+pi-powerline-footer 移植绿（验收样本仅此一个）；v0.2 扩展全线 → v0.3 MCP（bridge extension）→ v0.4 会话管理（赌上游）→ 长尾按需。"体验一致" = 分期对齐 R2 checklist 逐项打勾；100ms 观感 15 分钟人工检查（ticket 008）。衍生 ticket 008/009。
- [R5 reference-implementations](tickets/007-r5-reference-implementations.md): dsh-tui-pi 实证"仓外自搭 shell"成本（~5100 行，大量重解 stable interactive-mode 已内置的事：overlay 框架/焦点契约/主题重放/宽度纪律）→ **P1 倾向 stable interactive-mode 骨架 + durable 后端**；opencode 证明视图层可后换（后端=事件+查询面，durable 已具备）。可抄：opencode 槽位化 UI 面（10 槽+Dialog 工厂）、命令/键位首版合一、lifecycle{signal,onDispose}、session 存储字段化+搜索下沉；dsh 的命令注册声明式元数据、agentless 直派双通道、command/run↔done 落 log、问答走服务面。避开：可变出参 API、对上游打 patch、experimental 钩子进公共面。**待拍板分叉**：dsh 哲学是"无 ctx.ui、驱动 agents+从 session 事件渲染"——若采，R3 的 ctx.ui 缺口转为"durable TUI 暴露等价服务+槽位 shim"。详 `docs/research/reference-implementations.md`。
- [P1 tui-architecture](tickets/006-p1-tui-architecture.md): **定案路线 B**——stable interactive-mode 骨架 + durable 后端。spike `spike/p1-route-b` 实测：interactive-mode 零改动跑通核心环（渲染/流式/工具/中止），胶水 ~590 行 ≈ 路线 A 先例 11%。用户委托决策未人工试用；未覆盖项（多轮 compaction/steer//model/kill 续跑/subagent）转 v0.1 验收。生产化注意：私有接缝（_handleAgentEvent/_emit）需公共契约。原型保留在 spike 分支出处可查。
- [T1 streaming-feel-check](tickets/008-t1-streaming-feel-check.md): 用户免验关闭；渲染正确性由 spike 覆盖，主观跟手度后置到 v0.1 日常使用，钝则调 settings.progress 逃生口。
- [G2 host-surface-api](tickets/009-g2-host-surface-api.md): **用户委托代决（否决窗开放）**——槽位化 UI 面（不自由绘制）、命令/键位合一注册、lifecycle{signal,onDispose}+只读快照、问答走服务面；最小完备标准 = pi-powerline-footer 可移植；宿主面实现清单 = spike 实测 6 项缺口（transcript 重建/compaction 结果/会话身份/queue-by-text/4 类事件/工具装载可见性）；私有接缝公共化或提供 headless session 契约。

## Not yet specified

- session 双 agent 共存/迁移策略（durable-sessions 与 stable JSONL 的关系、互相导入）
- 发布形态：bin 名、是否/何时替代日常 `pi`、GitHub fork 与 push 节奏
- 性能基线：SQLite 大会话规模上限、流式提交粒度观感（观感判断已后置到 v0.1 日常使用，见 ticket 008）
- 中文 locale 需求（stable 无 locale 机制）
- MCP bridge 落地细化（R3 方案的实现级问题：registry 同名重装 churn、AgentEvent 字段对齐——v0.3 前毕业）
- v0.2 扩展全线的逐个扩展排期（首个工具型扩展移植时定）

## Out of scope

- charting 阶段不写产品代码、不 push 远端、不发 npm
- 不改动 `~/github/pi-src`（上游只读 checkout）
