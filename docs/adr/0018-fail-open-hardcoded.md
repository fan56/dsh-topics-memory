# fail-open 硬编码：判定失败一律回退现行为，无开关键

Status: accepted（2026-09-26，T2 决议；设计全文 `docs/design/2026-09-25-system-one-integration.md` 红线②）

## 背景

System One 三个缝都在异步 lane，但异步不等于无害：判定失败若演变成 lane 停摆、空产出或半成品数据，记忆维护会被静默劣化——比慢更糟的是坏。仓内既有 lane 纪律已是这个方向：整理 lane 模型调用失败不推进 stamp、下次启动自动重试；统计写失败静默不影响功能。T2 决议进一步拍死：降级路径不允许成为可配置项。

## 决定

判定失败/超时/坏答案（outcome：`timeout` / `network` / `http_4xx` / `http_5xx` / `bad_json` / `secret_gate_blocked` / `missing_key`）**一律 fail-open 回退现行为，硬编码进调用语义——不设开关键（连 `jevFailOpen` 都不存在）**。分缝动作：

| 缝 | 失败动作 | 旧路径去留 |
|---|---|---|
| 慢车道 rerank | 本轮回退**旧 LLM rerank**，picks 照常产出 | RERANK_PROMPT 路径保留至灰度第 4 步（默认开观察）后再删 |
| 整理前置 | 该簇照旧全量送 LLM（行为 = 今天） | 无 |
| 快道 shadow | 只记 outcome，零行为影响 | 无 |

配套语义：

- 调用点单次 `AbortSignal.timeout`（默认 3000ms，按 6 问批留足余量），**不重试**——重试交给 lane 的下一 cadence 天然重试（与整理 lane stamp 语义一致）；
- `fallback=true` 落 decisions.jsonl 调用层——回退率本身就是健康度指标（持续 >5% 说明 timeout/后端要调）；
- fail-open 延伸到统计本身：decisions.jsonl 写失败静默，不影响功能。

## 理由

- 降级策略属正确性语义而非用户偏好：「判定坏了要不要继续跑」不是该暴露给配置面的选择题；
- 「判定降级不允许变成 lane 停摆」反过来也成立：lane 停摆不允许被当成一种「严格模式」出售；
- 回退即现行为，意味着 `jevEnabled` 的风险上限 = 一次异步等待，不可能是行为损坏——这是 default-off 之外的第二重安全垫。

## 备选与取舍

- **`jevFailOpen` 配置键**：被否（T2 决议）——给了键就有人关，关了就是 fail-closed：判定挂 → lane 挂。
- **调用点自动重试**：被否——与 lane cadence 重试重复烧 token，且推迟回退发生的时间。
- **失败即中断本轮（fail-closed）**：被否——这正是要避免的 lane 停摆。
- **`decision*` 键族命名**：被否——歧义（decision 既是动作名又是模型行为名），且与 env 族 `JEV_*`、兄弟仓（dsh-jev-mcp / zcode-jev-router）不对齐；09-26 用户定名 `jev*`，"System One" 保留给概念层（标题/ADR）。

## 后果

- 用户无法「关掉回退」——刻意的；降级健康度靠 decisions.jsonl 的 outcome/fallback 字段观测，而非开关。
- 灰度期间旧 LLM rerank 与 jev 双路径并存，有明确退役点（灰度第 4 步后删）；期间 rerank 行为在两者间切换是设计内语义，不是 bug。
- 回退的代价上限 = 一次 3s 超时等待，发生在异步 lane，不阻塞会话。
