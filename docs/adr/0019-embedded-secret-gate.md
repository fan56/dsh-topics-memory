# secret gate 内嵌出网路径

Status: accepted（2026-09-26；设计全文 `docs/design/2026-09-25-system-one-integration.md` 红线③）
See also: dsh-jev-mcp `server.mjs`（gate 原版实现，同源移植）

## 背景

System One 的 state 含会话内容（claimed 用户文本、候选 Topic 摘录）——出网即把会话内容发往第三方端点。红线③要求出网前必须过完整序列化 body 扫描，命中即 blocked 不发送、错误不回显 secret。参照实现 dsh-jev-mcp 的 gate 活在独立 MCP 进程里；本插件直连 HTTP（ADR 0016）后没有外部进程替它把关——**gate 若依赖外部进程存活，进程死了扫描就没了，等于留了绕过面**。

## 决定

secret gate 自含进插件（移植 dsh-jev-mcp `server.mjs` 机制），作为出网路径的硬性前置——不可选、无开关：

- **13 条内建模式**（JWT / sk- 系列 / ghp_ / github_pat_ / glpat- / xox- / AKIA / ASIA / AIza / PEM 块），前缀模式要求 20+ 字符延续，防「讨论 secret 前缀」误伤；
- **外部清单**（配置键 `jevSecretFile`，语义同 `JEV_SECRET_FILE`）：≥8 字符行、全长匹配、>512 字符行警告不截断；启动时一次性加载，volatile 热更换路径时重读清单；
- **扫描对象 = `JSON.stringify({model, state, questions})` 完整出网 body**——与线上请求逐字节一致，不是扫输入片段；
- 命中 → 结构化错误（pattern + offset，context 重脱敏），**什么都不发送**，错误不回显 secret；
- 诊断静默默认（对齐插件现有日志纪律），`jevDebug` 可选走宿主 logger。

## 理由

- 扫描必须与发送同进程同函数：只有扫最终 wire 格式才是扫「真正要发出去的字节」；
- 自含 = gate 生命周期与插件一致，不存在「gate 进程没起」的状态；
- 安全性与可用性各归各位：blocked 是 hard stop（什么都不发送），可用性由 ADR 0018 的 fail-open 回退兜住（outcome=`secret_gate_blocked` 可观测，缝照常回退现行为）。

## 备选与取舍

- **复用 dsh-jev-mcp 进程做 gate（出网前先过 MCP 校验）**：被否——依赖外部进程存活（绕过面），外加进程编排与可用性耦合。
- **抽共享 gate 包（dsh-jev-mcp 与本插件共同依赖）**：被否——跨仓发布/版本协调成本高于小段自含代码；共享包不可用时插件侧仍要自备 fallback，绕不开自含。
- **只扫 state、不扫完整 body**：被否——序列化层可能并入新字段（`model` 也在 body 里），扫 wire 格式才是最终事实。

## 后果

- 模式维护进插件版本：新 secret 格式随插件更新内建清单；仓内自定义 token 前缀由外部清单兜底（用户自防）。
- 误伤面双约束压低：内建前缀模式要求 20+ 字符延续、外部清单全长匹配；「讨论前缀」不触发。
- dsh-jev-mcp 与本插件各持一份 gate 实现，语义同源对齐（漂移时两边一起改，同 ADR 0016 的双份维护面）。
