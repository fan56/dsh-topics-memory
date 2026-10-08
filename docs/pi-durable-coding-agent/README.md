# pi-durable-coding-agent — 实施包（跨机器自包含）

> 本目录是 2026-10-08 会话的完整决策与凭证快照：在另一台机器上从零续接 v0.1 构建所需的一切都在这里。

## 内容

| 文件/目录 | 说明 |
|---|---|
| `HANDOFF-2026-10-08-pi-durable-coding-agent.md` | 跨会话续接入口：决策链摘要、约束规矩、v0.1 开工清单、快速命令 |
| `wayfinder/MAP.md` + `wayfinder/tickets/`（9 张） | 决策地图全量：每张票的 Question + Resolution |
| `research/`（5 份） | 调研报告（全带 file:line）：durable API 面 / stable 功能清单 / extensions+MCP 兼容 / 上游轨迹 / dsh+opencode 参考 |
| `spike-p1-route-b.patch` | P1 原型 3 个提交的 patch（~590 行胶水：AgentSession facade + 事件适配器 + 入口） |

## 新机器引导（从零到跑通原型）

```bash
# 1. clone 上游 pi monorepo（MIT），建工作分支
git clone https://github.com/earendil-works/pi.git ~/github/pi-durable-coding-agent
cd ~/github/pi-durable-coding-agent
git switch -c feat/durable-coding-agent

# 2. 应用 spike patch（只新增 experimental/durable-p1/ 下的文件，任意基线可干净 apply）
git am /path/to/this/dir/spike-p1-route-b.patch

# 3. 把决策地图放回仓内（可选，恢复 wayfinder 工作流）
mkdir -p wayfinder docs/research
cp -r /path/to/this/dir/wayfinder/* wayfinder/
cp /path/to/this/dir/research/*.md docs/research/

# 4. 装依赖 + hydrate 模型数据（一次性）
npm install --ignore-scripts
(cd packages/ai && npm run hydrate-model-data)

# 5. 跑原型（凭据与正式版 pi 共享——先用 pi 登录一次）
node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  packages/coding-agent/src/experimental/durable-p1/main.ts
```

## v0.1 要做什么（详见 HANDOFF「开工清单」）

1. facade/事件适配器按 G2 形状重构落地（私有接缝 `_handleAgentEvent`/`_emit` 公共化）
2. 宿主面接口层 6 项缺口（ticket 009 Resolution 有清单）
3. 移植 pi-powerline-footer 作验收样本（需一并 clone `fan56/pi-powerline-footer`）
4. 验收：spike 未覆盖项 + R2 checklist 对应域打勾

## 红线提醒（违反会返工）

- 上游同步只跟 **release tag**、merge 不 rebase、**只加新文件不改上游**、`packages/durable/src/harness/**` 只经 ToolExecutionApi/HookApi 扩展
- 不给 pi-durable 公共 API 包 compat 层（每版必碎）
- 别抢先做上游 TODO：树导航/resume 队列/subagent 服务化/历史分页/experimental 补全
- G2 宿主面 API 是代决（否决窗开放）——落地时觉得形状不对，回 ticket 009 修订而不是硬扛
- 代码注释/commit 英文，文档中文；会话数据走 `~/.pi/agent/experimental/durable-p1-sessions/`
