# topics-memory × System One 决策模型集成设计

- 日期：2026-09-25
- 状态：待终审（wayfinder 图 [`.wayfinder/map.md`](../../.wayfinder/map.md) 产物；T6 终审通过即可开工）
- 决策依据：T1 对拍基线（`.wayfinder/research/t1-corpus-baseline.md`）、T2/T3/T5 决议（`.wayfinder/tickets/`）、09-25 laya vs jev 头对头
- 关联：ADR 0004（注入热路径零 LLM）、ADR 0015（UsageBoost，已落地不动）、dsh-jev-mcp（三后端实证参照，零改动）

## 1. 目标与原则

在 topics-memory 的**异步决策缝**接入 System One typed-decision 模型，用极低成本（实测 ≈343–571 input tok/问；延迟单问亚秒级期待值，20 问批量实测均值 1.76s/最大 8.47s，6 问批待 shadow 实测）替代/前置现有生成式 LLM 判断，**不碰注入热路径、不阻塞会话、失败一律回退现行为**。

三条红线（全程有效）：

1. **快道零远程调用**——每条用户消息的同步检索（prompt assembly 前必须返回）永不发起任何远程调用；System One 只进异步 lane。（拟立 ADR）
2. **fail-open 硬编码**——判定失败/超时/坏答案一律回退现行为，不设开关键。（拟立 ADR）
3. **secret gate 硬性**——state 含会话内容，出网前必须过完整序列化 body 扫描，命中即 blocked 不发送、错误不回显 secret。

## 2. 范围

**v1 进**：

| 缝 | 位置 | System One 用法 | 替换/保留边界 |
|---|---|---|---|
| 慢车道 rerank | `src/quality.ts:51-58, 244-310` | 每候选一问批量 typed **noul**（双面 criteria，对齐校准协议；6 候选一请求），noul 概率门控产 picks | **替换 LLM rerank**；query build 保留 LLM（生成步骤） |
| 整理 lane 前置 | `src/consolidate.ts:35, 149-209` 入口 | 每簇取 Jaccard top-k 对（k≤5，对齐 1-6 问/簇）问 **pair noul**「同一问题吗」；簇级「值得动吗」问 v1 **只记录不门控**（无扫描数据） | **前置过滤**砍无效对的 LLM 调用；merge 结论生成保留 LLM |
| 快道门禁 | `src/retrieval.ts:243-319` | **仅 shadow**：异步（turn-end lane）调用，verdict 只落 decisions.jsonl（`lane=fastgate-shadow` + 与词法处置 `agree` 对账）；ilog 注入记录不动（同步构造定稿、追加式不可回填） | 不替换；对拍证据积累 |

**不进 v1**（fog / out of scope，见 map）：写入门控、query build needs 分岔、UsageBoost 重设计（ADR 0015 已拍板）、蒸馏生成步骤、TTL 语义化、laya 本地后端。

## 3. 引擎架构

### 3.1 后端（`jevBackend`，默认 `zen`）

| backend | 端点 | 协议家族 | 默认 model（钉版本） | key 来源 |
|---|---|---|---|---|
| `zen` | `https://opencode.ai/zen/v1/systemone` | systemone | `jev-1.13-free` | `JEV_ZEN_API_KEY` / 钥匙串 `opencode-zen-inference` |
| `native` | `https://api.typesafe.ai/v1/systemone` | systemone | `jev-1.13.0` | `TYPESAFE_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/alpha/decisions` | decisions | `typesafe/jev-1.13` | `OPENROUTER_API_KEY`（钥匙串 `openrouter-inference` 需显式 JEV_KEYCHAIN） |

**双协议分叉**（对齐 dsh-jev-mcp `backends.mjs` 实证，实现为两个请求构造器）：

- systemone（zen/native）：每问 `instructions` 必填；noul `criteria` 可选（给了必须双面）；score levels 可为结构化。
- decisions（openrouter）：`instructions` 可选；**noul `criteria` 必填且必须双面 `{true, false}`**；score levels 仅字符串。本插件统一发双面 criteria + string levels，两类后端通吃。

钥匙串默认回退**仅 zen 有**（对齐 dsh-jev-mcp server.mjs:156）；native/openrouter 走钥匙串需显式 `JEV_KEYCHAIN`。

key 传递：dsh 清洗 ambient `KEY|PASSWORD|SECRET|TOKEN` 变量——key 必须走 profile patch `env:` 块显式透传或 JEV_KEYCHAIN 同款钥匙串机制；配置样板进 README（对齐 dsh-jev-mcp 文档惯例）。

### 3.2 调用语义

- `jevTimeoutMs` 默认 **3000**（单问期待值 p50≈450ms/p95<2s，6 问批待 shadow 实测校准；实测参照：20 问批量均值 1.76s/最大 8.47s——timeout 按 6 问批设定留足余量）；单次 `AbortSignal.timeout`，不重试（retry 交给 lane 的下一 cadence 天然重试，与整理 lane stamp 语义一致）。
- 批量模式：一请求多问（questions 并行评估不加延迟，实测 10 问 3.0s 内）；慢车道 rerank = 6 问/请求，整理前置 = 1-6 问/簇。
- 调用量级由批结构天然约束（rerank 每触发 1 请求；整理 ≤8 簇/run），**不新增预算键**。

**fail-open 分缝动作**（红线②的展开——失败/超时/坏答案时）：

| 缝 | 动作 | 旧路径去留 |
|---|---|---|
| 慢车道 rerank | 本轮回退**旧 LLM rerank**，picks 照常产出 | RERANK_PROMPT 路径保留至灰度第 4 步（默认开观察）后再删 |
| 整理前置 | 该簇照旧全量送 LLM（行为=今天） | 无 |
| 快道 shadow | 只记 outcome，零行为影响 | 无 |

### 3.3 secret gate（内嵌）

移植 dsh-jev-mcp `server.mjs` 机制，自含进插件：

- 13 条内建模式（JWT / sk- 系列 / ghp_ / github_pat_ / glpat- / xox- / AKIA / ASIA / AIza / PEM 块），前缀模式要求 20+ 字符延续防「讨论前缀」误伤；
- 外部清单文件（语义同 `JEV_SECRET_FILE`，键名 `jevSecretFile`，按仓内 kebab 显示习惯）：≥8 字符行、全长匹配、>512 字符行警告不截断；
- 扫描对象 = `JSON.stringify({model, state, questions})` 完整出网 body；命中 → 结构化错误（pattern+offset，context 重脱敏），**什么都不发送**；
- 诊断静默默认（对齐插件现有日志纪律，`jevDebug` 可选走宿主 logger）。

## 4. 配置面（四处接线：TopicsConfig / CONFIG_KEYS / parseConfigValue / DEFAULTS；全 volatile；键族名 09-26 用户定 `jev*`——原 decision* 有歧义已废）

| 键 | 默认 | 说明 |
|---|---|---|
| `jevEnabled` | `false` | default-off 总闸（灰度 T5）；false 时零行为变化。命名注：jev 前缀对齐 env 族（JEV_*）与兄弟仓（dsh-jev-mcp/zcode-jev-router），三后端皆服务 jev 系模型；"System One" 保留给概念层（标题/ADR） |
| `jevBackend` | `zen` | `zen \| native \| openrouter` |
| `jevModel` | `''` 哨兵（DEFAULTS 空串，调用时按 backend 解析，对齐 distillProvider 模式） | `jev-1.13-free` / `jev-1.13.0` / `typesafe/jev-1.13`（钉版本，升级是显式动作） |
| `jevTimeoutMs` | `3000` | 单请求超时 |
| `jevSecretFile` | （无） | 外部 secret 清单路径；清单启动时一次性加载（对齐参照实现），volatile 热更换路径时**重读清单**（set 时重载） |

不设 `jevFailOpen`（fail-open 硬编码，连键都不存在——T2 决议）、不设调用预算键。`/topics set` 热更全兼容（volatile 键既有机制）。

## 5. 阈值骨架与校准程序

**三档骨架**（**数字已由单案 A/B + 383 案例阈值扫描双步校准终定**，rerank 与整理前置分列）：

| 档 | rerank（慢车道，候选问） | merge（整理前置，**pair 问**——簇级问只记不门控） | 动作 |
|---|---|---|---|
| 采纳线 | noul ≥ **0.60**（无双确认——扫描实证双确认不增查准、纯损失 2 个真拯救） | ≥ **0.50**（F1 0.889 峰值） | 进 picks / 送 LLM 生成 |
| 记录带 | **0.10 – 0.60** | **0.15 – 0.50** | 只落 decisions.jsonl，不影响行为 |
| 回退线 | < **0.10**（0.15 会误杀 11 个 hit 层真例，0.10 仅 8） | < **0.15**（92 负例零误杀） | 强否决，回退词法门现行为 |

**绝对线绑定批量协议**（协议漂移实证：同案例 T1 批 0.15 / 单案 0.60 / 本批 0.71）——换协议必须重扫，不可搬数字。

**校准程序**（数字由程序产出）：

1. **单案 A/B**（✅ 已完成 09-25，报告 `.wayfinder/research/t4-ab-single-case.md`）：**批量稀释假设不成立**——单案单请求 + 摘录加长后正例均值不升反降（0.54→0.36，无一案上 0.7，峰值 0.61），"正例置信弱"是案例/判据固有而非批量效应；**排序跨协议高度稳定（Spearman ρ=0.87）、负例判别双协议均 ≤0.06**，但绝对分数协议敏感（mean |Δ|=0.152）→ **对拍集跑批统一用批量协议**（单案协议只留给校准复核与分歧仲裁）；初始 0.7 采纳线据此修订为 0.60+双确认，回退线从 0.5 收紧为 0.15（强否决）。成本：10 调用 input 9,893 tok。
2. **对拍集扫描**（✅ 已完成 09-25 夜，报告 `.wayfinder/research/t4-threshold-sweep.md`）：383 案例已由 oldfox 全量 gold 标注（rerank true67/false126/probe7 · merge true13/false107/probe0 · gate true38/false18/probe7，`~/dsh-topics-eval/corpus-20260925/`），批量协议 16 请求 0 失败（input 228k tok）扫出终值。**判别力：AUC rerank 0.846（词法 0.786）/ merge 0.989；负例干净度 rerank 0/126**。**验收门槛①首个实测：通过（proxy 属性）**——对照是词法基线（0.596），门槛①定义的 LLM rerank 基线在 shadow 期同流测量；jev 0.3–0.8 全线查准 0.778–1.000 压制词法，最优复合操作点（≥0.5/<0.08）P 0.760 / R 0.851 / F1 0.803，对纯词法（0.596/0.836/0.696）**查准查全同时占优**；hit 层 38 个词法误放行纠正 37–38 个。正文骨架采 0.60/0.10（F1 0.769），sweep 的 F1 最优点 0.50/<0.08 留作灰度备选档。
3. **数字回填**本节（gold 标注者 = oldfox 推理模型，定位为「LLM 判断基准」——恰是验收门槛①的对照面；用户抽查可选，gate 类 true=处置正确语义已写进 `labelSemantics` 字段）。
4. **分歧证据条款**：jev 与词法/人工分歧的案例结构化落 **decisions.jsonl 判定层 `agree` 字段**（离线分歧清单脚本消费；对 T3 决议"落 ilog"措辞的收窄已在 T6 关票记录注明——ilog 注入记录同步定稿不可回填，R6 类「jev 可能对」是校准金矿，不许静默丢）。

**已知校准风险**：批量共享 state 疑似稀释正例置信（T1）；R8 式内容漂移——回放必须锚定当期 git 版本正文（备料包已实现锚定）；中文负载阈值不可照搬英文直觉（头对头结论）。

## 6. jev 使用统计与优化埋点（用户 09-25 终审追加，恒开）

**定位**：统计是校准程序的燃料、优化的依据——没有它，四条验收门槛里的 ECE、shadow 对账、成本核算全是空话。**shadow 灰度阶段的前置**：埋点与慢车道改造同批落地，先于任何"生效"。

### 6.1 落点与形态

- 新文件 `~/.dsh/topics/meta/decisions.jsonl`（与 ilog 同目录同纪律：512KB 自动紧缩保最近 1/4、逐行 JSON、写失败静默不影响功能——fail-open 延伸到统计本身）。
- 快道 shadow verdict 同样只落 decisions.jsonl（`lane=fastgate-shadow`）：ilog 的注入记录在注入时同步构造定稿、追加式不可回填——让 jev verdict 进 ilog 就必须快道同步等远程，直接违反红线①；与词法处置的对账由 `agree` 字段离线 join 完成。
- **脱敏红线**：统计只存元数据与概率——slug/pair-hash/question 类型/分数/延迟/token 数，**绝不存 state 原文或结论正文**（与 decisions.jsonl 同目录的 ilog 也从不存 state）。
- 无配置键：统计恒开（本地写入微克级成本、是 spec 的组成部分而非可选件）；关闭 = 关 `jevEnabled`（连统计一起停，语义一致）。

### 6.2 三层埋点 schema

**调用层**（每次 HTTP，一行）：

```json
{"at":"…","lane":"slowlane-rerank|consolidate-prefilter|fastgate-shadow","backend":"zen|native|openrouter",
 "model":"…","questionCount":6,"stateChars":1843,"latencyMs":448,
 "usage":{"input_tokens":2417,"output_tokens":108},
 "outcome":"ok|timeout|network|http_4xx|http_5xx|bad_json|secret_gate_blocked|missing_key",
 "fallback":true|false}
```

`fallback=true` 即 fail-open 触发——**回退率本身就是健康度指标**（持续 >5% 说明 timeout/后端要调）。

**判定层**（每问一条，批量请求展开）：

```json
{"at":"…","lane":"…","questionId":"c3","qtype":"noul|choice|score", // v1 两缝皆 noul，choice|score 为 reserved；簇级「值得动吗」问 band 固定 'record'
 "ref":"slug:xxx|pair:hash3",          // 候选引用，不携正文
 "digest":"h1:…",                      // 规范化 state+question 的哈希——重复决策率分析的 key
 "probability":0.62,"band":"adopt|record|fallback",
 "agree":"hit|nearFloor|gate-blocked|wouldBlock|n/a", // 与词法处置对账（fastgate shadow 必填）；wouldBlock=词法放行但 jev 落回退线（反向分歧，校准金矿另一半）；人工分歧由离线 gold join 产出，不进 agree
}
```

**闭环层**（不新增写入，由离线 join 产出）：`decisions.jsonl` 的 `ref` × `opens.jsonl` 的 slug × 30 天窗口 → 每个 probability 桶的实际 open 率 → ECE 与分桶校准表。ADR 0015 的 open 信号（3 票）就是 ground truth 源——**这是"以后好做优化"的主数据流**。**总体限定**：ECE 只统计窗口内实际被注入过的 ref——被词法拦截的 ref 没有被 open 的机会，混入总体会把高分桶 open 率系统性压低（量到的是拦截不是校准）；如需全总体视角，按词法处置分层报告。

### 6.3 优化分析产出（离线脚本，replay 模式扩展）

| 分析 | 回答的问题 | 喂给哪个决策 |
|---|---|---|
| 成本账 | 日/周调用数 × tokens（zen 免费、native/openrouter 折价） | 后端选型、预算护栏 |
| 延迟分布 | p50/p95/超时占比 | `jevTimeoutMs` 要不要动 |
| 档位占比 | 采纳率/记录带率/回退率 | 采纳线/回退线健康度 |
| ECE 分桶 | 概率可信吗、哪个桶偏 | 采纳线校准（T5 门槛④的数据源） |
| 重复决策率 | state+question hash 重复度 | 要不要上 jevcache 式决策缓存 |
| 分歧清单 | jev vs 词法 vs 人工的分歧案例 | 校准金矿（T3 分歧证据条款的落点） |

`/topics status` 增一行 30 天窗口摘要（调用数/回退率/p50/失败率）；明细分析走离线脚本不进命令面。

### 6.4 与验收门槛的依赖关系

T5 门槛②③④（漏报率、shadow 2 周、ECE ≤0.1）**全部以本节埋点为数据前提**——埋点不落地，灰度梯子第 2 级（shadow）不可启动。

## 7. 验收与灰度（T5 决议）

**换正门 = 四条复合门槛全过**（任何一条不过 → 继续 shadow）：

1. rerank picks 查准 ≥ 现有 LLM rerank 基线（同水平省成本，不要求显著超越）；
2. noul 门控漏报率 ≤ 词法基线（丢记忆 > 多注入，漏报权重显式更高）；
3. shadow 数据 ≥ 2 周生产流量（shadowVerdict 现状 0% 覆盖，从零攒）；
4. 校准 ECE ≤ 0.1。

**灰度四步**：`jevEnabled` default-off → shadow（verdict 只落 decisions.jsonl）→ opt-in per-profile → 默认开观察。每步回退 = 关总闸。**shadow 的启动前提 = §6 埋点已落地**（门槛②③④的数据源）。

## 8. 测试与对拍基建

- 单测：假 backend（hermetic fetch），断言双协议分叉、gate 拦截、fail-open 三路（timeout/http 错误/坏答案）、decisions.jsonl 三层埋点字段完整性与轮转紧缩；
- shadow 对拍：`scripts/replay-structural-gate.mjs` 模式扩展出 decision 对拍器（只读回放 ilog 词法处置 × decisions.jsonl jev verdict 离线 join）；
- e2e：`e2e/scenarios/` 新增 50 号场景——`@deepseek-ai/dsh-llm-replay` 同款思路 mock systemone 端点，断言 verdict 真落 decisions.jsonl；
- 评测资产纪律：corpus 在 `~/dsh-topics-eval/`（仓外），备份 `~/dsh-topics-eval-backup-20260925/`，**禁上传**；仓内只进脱敏 fixture 与加载器。

## 9. ADR 提案清单（实现期落 `docs/adr/`）

1. **直连 HTTP 而非 MCP**——生态主流、少一层进程、批量 rank 逐次跨进程不现实；
2. **快道零远程调用红线**——chancelu 热路径教训 + ADR 0004 延伸；
3. **fail-open 硬编码**——判定降级不允许变成 lane 停摆；
4. **secret gate 内嵌**——state 含会话内容，出网扫描不能依赖外部进程存活。

## 10. 开放项（不阻塞开工）

- openrouter decisions 端点限速/配额实测（fog，T5 数据需要时）；
- 慢车道 ground truth 从零攒（shadow 2 周起步）；
- merge 类 gold 依赖人工标注（M1 类「相邻但独立」最需要标）。

## 11. 参考

- T1 报告：`.wayfinder/research/t1-corpus-baseline.md`（463 轮 ilog 盘点、18 问真负载首批、token 成本模型）
- T4 备料与 A/B：`.wayfinder/research/t4-labeling-kit/`、`.wayfinder/research/t4-ab-single-case.md`
- dsh-jev-mcp：`~/repo/dsh-jev-mcp/`（backends.mjs 双协议实证、server.mjs secret gate 原版）
- 头对头数据：laya（local）vs jev-1.13.0 判别力对比，见 memory `laya-local-deployment`
