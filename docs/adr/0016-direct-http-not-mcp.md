# System One 接入走直连 HTTP，不走 MCP

Status: accepted（2026-09-26；设计全文 `docs/design/2026-09-25-system-one-integration.md`）
See also: dsh-jev-mcp（`~/repo/dsh-jev-mcp/`，MCP 形态的兄弟实现，继续服务 agent 会话面）

## 背景

System One（jev 系模型）的 typed-decision API 已有三条托管端点（zen / native / openrouter），本仓要把它接进三个异步决策缝：慢车道 rerank（每触发 6 候选一问、一请求批量）、整理 lane 前置（每簇 1–6 问）、快道 shadow（turn-end lane）。仓内现成的参照 dsh-jev-mcp 是 stdio MCP server 形态——最顺手的路径看似是直接复用它。

## 决定

插件内自实现 HTTP 客户端直连三后端，不经 MCP：

- 双协议分叉对齐 dsh-jev-mcp `backends.mjs` 实证，实现为两个请求构造器：systemone（zen/native：`instructions` 每问必填，noul `criteria` 可选）与 decisions（openrouter：`instructions` 可选，noul `criteria` 必填且双面）；本插件统一发双面 criteria + string levels，两类后端通吃。
- dsh-jev-mcp 零改动、继续服务 agent 会话面；两者并存、互不依赖，协议行为以其实证为参照保持对齐。

## 理由

- **生态主流是直连**：System One 生态以直连 HTTP 集成为主流（wayfinder 调研口径：9264 仓直连），MCP 只是其中一种封装；协议事实以直连面为准。
- **批量语义跨不过进程边界**：rerank 一次触发 = 一请求 6 问（批量实测 10 问 3.0s 内），走 MCP 就退化成逐问逐次跨进程往返——时延、进程开销、顺序化都不可接受；而批量协议恰是阈值校准的前提（绝对线绑定批量协议，换协议必须重扫）。
- **少一层进程**：插件本就活在宿主进程内，直连后没有子进程生命周期、没有 MCP 握手与工具序列化层；单请求超时直接 `AbortSignal.timeout` 一手控制。

## 备选与取舍

- **复用 dsh-jev-mcp（插件做 MCP client 连本地 server）**：被否——批量逐次跨进程不现实（见上）；且插件可用性多押一个外部进程的存活。
- **把 client 逻辑抽成共享包（dsh-jev-mcp 与本插件共同依赖）**：被否——两仓发布节奏不同，跨仓版本协调成本高于自含两个请求构造器；协议分叉点小而稳定，各自测试更可控。

## 后果

- 插件自担协议分叉与 key 管理：三后端的端点/模型钉版本（升级是显式动作）、env/钥匙串两路 key 来源、出网 secret gate（ADR 0019）都进插件。
- dsh-jev-mcp 与本插件的协议行为存在双份维护面——以 dsh-jev-mcp 实证为参照，漂移时两边一起改。
- UsageBoost（ADR 0015）不受影响：open 信号统计与本决策层正交。
