# UsageBoost 计入门槛分（受结构门与上限双重约束）

Status: accepted（2026-09-09，grilling 六问拍板；设计全文 `docs/design/2026-09-09-usage-boost.md`）
Amends: 0014（快道结构门一节：gateScore 的构成扩入 usageBoost，结构证据要求不变）

## 背景

检索打分至今只有内容侧信号：词面命中（triggers/title/slug/tags/description/conclusion 各有权重）、tagBoost、recency tiebreaker。这意味着「实际帮到过对话」这一最强证据——注入命中与 `topic_open`——完全没有反馈回排序。本仓 2026-09 语料的突出病灶恰是**命名漂移**（旧包名 slug、口语化 title）：这类条目词面弱、常年在 gate（阈值 0.3）之下，但它们可能正是一直在帮上忙的记忆。

给 Topic 打静态质量分（LLM 评 quality: N）被否决：主观、昂贵、会随结论过时而漂移。ilog 里的行为数据（Injection Log + opens.jsonl）是零成本、自动积累、可解释的客观分数，缺的只是接回检索。

## 决定

滚动 30 天内聚合每条 Topic 的使用票数：**Injection 命中 = 1 票，topic_open = 3 票**（open 是模型自发动作，语义最接近「真有用」）。票数折算为排序加成，**计入门槛数字分**，但受三重约束：

1. **帽 0.2**：生效值 = min(`usageBoost` 配置, 0.2)，低于阈值 0.3——boost 永远不足以单独把条目抬过门槛；
2. **词面分为 0 不加**：零内容相关性的条目永不靠资历入选（结构门本就要求词法证据，两道锁方向一致）；
3. **结构门不豁免**（ADR 0014 不变式）：强字段/正文证据要求照旧，boost 只垫数字分。

新配置 `usageBoost`（默认 `0.15`，与 tagBoost 同量级，`0` 关闭）；窗口 30 天与 open 票权为内部常量。同源统计（`{ injections30d, opens30d }`）进整理 lane 的簇 payload，配零使用护栏句——「冷门」是 refresh/deprecate 的支持证据而非充分条件。

## 备选与取舍

- **仅排序（gate 之下，如 recency）**：无马太效应风险，但救不了命名漂移的常用条目——而补这个短板正是本功能的动机；被否。
- **无帽计入 gate**：实现最简，但「常用→必入选」的马太效应无结构性约束，且重复了 ADR 0014 拆掉的「tag 底分自行翻阈值」雷；被否。
- **静态 LLM 质量分**：见背景；主观、贵、漂移；被否。

## 后果

- gateScore 的语义从「剔除 recency 的分」扩为「剔除 recency、含 usageBoost 的分」——理由：usage 与 recency 同为时效性信号，但 usage 有结构门+帽双锁，recency 没有，故两者不同层。
- 使用信号按机器积累（Injection Log 随 bundle 同步后自然汇合多机行为），无需新增同步机制。
- 冷启动无影响：无 IL 数据时 boost 全零，检索行为与现状逐字节一致。
- 风险 acknowledged：热门条目获得排序惯性。若实测出现「老热门挤占新条目」，第一调参位是下调 `usageBoost`，第二位才是缩短窗口。
