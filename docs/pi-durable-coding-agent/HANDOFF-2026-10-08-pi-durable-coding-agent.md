# HANDOFF — pi-durable-coding-agent（2026-10-08）

> 以 `@earendil-works/pi-durable` 为底座、复用 pi monorepo 组件、体验对齐正式版 `pi` 的 coding agent。
> 决策地图（wayfinder）已全部走完，**下一步 = v0.1 构建**。本文件是跨会话续接的入口。

## 仓与分支

- **本地 fork**：`~/github/pi-durable-coding-agent`（earendil-works/pi 本地 clone）
  - `main` 只跟上游；工作分支 `feat/durable-coding-agent`（本次结束时 HEAD `1a850edd0`，树干净）
  - remotes：`pi-src`（本地路径）、`upstream`（github.com/earendil-works/pi）；**不 push 远端**
- 上游只读 checkout `~/github/pi-src` 勿动；fork 依赖已 `npm install --ignore-scripts`
- 原型凭证：分支 `spike/p1-route-b`（保留，勿删；worktree 已清）

## 决策地图（9 票全关；权威 = 仓内 `wayfinder/MAP.md` + `wayfinder/tickets/`）

1. **底座**：monorepo fork——npm 包不导出 coding-agent 内部件（实验版 20+ 相对路径 import），复用必须在 monorepo 内
2. **上游策略**（R4）：跟 **release tag**（非日更 main）、ff main 后 **merge 不 rebase**、周批 ≤1 周；**只加新文件不改上游**；`packages/durable/src/harness/**` 只经 ToolExecutionApi/HookApi 扩展；**别抢先做**上游 TODO（树导航/resume 队列/subagent 服务化/历史分页/experimental 补全/pi-durable API compat 层）
3. **总策略**（G1，用户逐题确认）：能复用就复用；自研收缩到**最小内核**（宿主面接口层 + 一行级 CLI 口子如启动指定会话），**其余一切 extension 化、官方原生实现后可摘除**；做不成 extension 的仅 print/rpc 进程模式与 harness 内部行为（长尾）
4. **分期**：v0.1 = 核心环 + 接口层 + pi-powerline-footer 移植绿（验收样本仅此一个）→ v0.2 扩展全线（自家 fleet 按需搬）→ v0.3 MCP（R3 原生 bridge 方案）→ v0.4 会话管理（赌上游，出则搬）→ 长尾按需。"体验一致" = 分期对齐 R2 checklist 逐项打勾
5. **TUI 骨架**（P1，spike 实测定案）：**路线 B**——stable interactive-mode 一行不改 + durable 后端 facade；胶水 ~590 行（facade 328/事件适配 210/入口 85）≈ 路线 A 先例（dsh-tui-pi ~5100 行）的 11%。生产化注意：facade 依赖 AgentSession 私有接缝（`_handleAgentEvent`/`_emit`，agent-session.ts:513），需公共契约或"外部事件驱动 headless session"一等接口
6. **宿主面 API**（G2，**用户委托代决、否决窗开放**——用户可否决任一条回 ticket 009 修订）：槽位化 UI 面（不自由绘制）+ 预制 Dialog；命令/键位合一注册；`lifecycle{signal,onDispose}` + 只读快照/显式写接口；问答走服务面（dsh 模式）；最小完备标准 = powerline-footer 可移植（setFooter/setEditorComponent/setWidget/getContextUsage/getBranch + 宿主合成 input 事件）

## 调研资产（仓内 `docs/research/`，全带 file:line）

`durable-api-surface.md`（24 项能力映射矩阵）· `stable-feature-inventory.md`（231 行 parity checklist）· `extension-mcp-compat.md`（shim 只做宿主面；MCP 传输层零耦合可原样用）· `upstream-roadmap.md`（pico 系是淘汰链，现 API 不会被替代）· `reference-implementations.md`（dsh-tui-pi/opencode 可抄与避开清单）

## v0.1 开工清单

1. spike 的 facade/事件适配器从 `spike/p1-route-b` 落到 feat 分支（按 G2 形状重构，私有接缝公共化；可 cherry-pick 参考 `packages/coding-agent/src/experimental/durable-p1/`）
2. 宿主面接口层——G2 清单 6 项缺口：transcript 按 session 形状重建（EntryRecord→SessionEntry）、CompactionResult（摘要+落位）、会话身份/命名/列表、queue 按 text 操作（pendingMessageCount/getSteeringMessages/clearQueue）、`thinking_level_changed`/`session_info_changed`/`queue_update`/`agent_settled` 事件、工具装载可见性（footer 工具计数）
3. 移植 `~/github/pi-powerline-footer`（验收样本，全绿 = v0.1 达标）
4. 验收：spike 未覆盖项（多轮 compaction / 运行中 steer / `/model` 切换 / kill 后续跑 / subagent）+ R2 checklist 对应域打勾；流式观感钝则先调 `settings.progress` 逃生口

## 约束与规矩

- 仓根 `AGENTS.md`：上半 = 上游规则（commit 格式 `{feat,fix,docs}(...):`、禁 `git add -A`、不跑根 `npm run check` 会改文件、测试用 `./test.sh` 或包内 vitest）；**末节 = fork 层**（文档中文/代码注释与 commit 英文、`research/*` throwaway、上游文件实质改动须 ticket 登记）
- wayfinder：一会话一票（research 除外）；HITL 票须用户参与；grill 一次一题（用户指定）
- 会话数据隔离：原型用 `~/.pi/agent/experimental/durable-p1-sessions/`（可删）；`~/.pi/agent` 正式 pi 配置共享、只读对待
- R4 撞车红线：不包 pi-durable 公共 API 做 compat 层（每版必碎）

## 快速命令

```bash
# 跑 P1 原型（spike 分支）
cd ~/github/pi-durable-coding-agent && git worktree add .wt/p1 spike/p1-route-b
cd .wt/p1 && (cd packages/ai && npm run hydrate-model-data)   # 一次性
node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  packages/coding-agent/src/experimental/durable-p1/main.ts

# 跑上游实验版（对照）
node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  packages/coding-agent/src/experimental/durable/main.ts

# 上游同步（按 R4 基线）
git fetch upstream --tags && git switch main && git merge --ff-only upstream/main \
  && git switch feat/durable-coding-agent && git merge main
```

## 悬而未决（MAP fog，随期次毕业）

session 双 agent 共存/迁移 · 发布形态（bin 名/push 节奏）· SQLite 大会话性能上限 · 中文 locale · MCP bridge 实现级细化（v0.3 前）· v0.2 逐扩展排期 · G2 否决窗

## 续接方式

新会话直接说「继续 pi-durable-coding-agent v0.1」→ 读本文 + 仓内 `wayfinder/MAP.md` → 按开工清单第 1 步动工。
