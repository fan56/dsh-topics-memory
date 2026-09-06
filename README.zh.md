# dsh-topics-memory

[English](README.md) | 中文

一个 dsh 插件：把「工作 topic 记忆」维护成 [OKF 标准（Open Knowledge Format v0.2）](https://github.com/GoogleCloudPlatform/open-knowledge-format)的知识 bundle，持久化在本地 git 仓库（可选同步到 GitHub 私有仓库），利用 git 历史提供结论可追溯性，自动观察会话沉淀知识，并在每轮对话前向模型注入相关 Topic。

> **要求 dsh >= 0.1.2-rc.1** — 本插件只跟随 dsh RC/stable 线（CI 与发版在运行时解析 latest/next 中更新的 dist-tag）。**不再支持 alpha 线。**

## 演示

约 4 分钟的完整流程：topic 沉淀、蒸馏、注入在真实会话里跑起来。

https://github.com/user-attachments/assets/6e9b346d-2ec9-4148-ae62-7087797d3188

## 它解决什么问题

长会话会失忆，跨会话更会。本插件维护一份**结构化的 topic 记忆**：每个 Topic 记录一件事的**名字、依赖、未决问题、目前结论、影响、建议**。结论变了就改文件、打 commit——`git log` 直接回答「这个结论什么时候、被谁、为什么改的」。

## 初衷：记忆是编辑出来的，不是攒出来的

先说结论：**记忆不是越多越好。**

「记忆」类产品的常见思路是多多益善——能记的都记，用时全量检索。这对人也许成立，对 LLM 恰恰相反，而且反在两处：模型的注意力是有限资源，巨型记忆库意味着每一轮对话都在噪音里翻找信号；更危险的是，过程记忆里囤着大量「当时正确、事后失效」的中间判断，它们会理直气壮地把模型引向错误的决定。

所以本插件对「记什么」做了一次苛刻的取舍：**一个 topic 只记四件事——它从什么问题开始、得出了什么结论、影响什么、依赖什么。至于得出结论的过程：讨论、试错、绕过的弯路，一概不记。**过程属于 session，session 结束就该随它去；能留下的，只有经得起蒸馏的结论。

短时记忆交给 session，对话上下文本就是它，不需要插件再回喂一遍；长时记忆交给 topics——小、结构化、git 可追溯，注入按预算切片、零命中零注入，每轮给模型的都是**最小的高价值上下文**，而不是越大越好的仓库。

所以这个插件想做的不是模型的记事本，而是模型的编辑：替它决定什么值得记住，以及——更要紧的——什么应该被忘掉。

## 核心特性

- **OKF v0.2 严格合规**：每个 Topic 是 `markdown + YAML frontmatter` 的 concept 文档（`type: Topic`），可被 Obsidian、OKF 校验器等整个生态直接消费；自带 provenance（`sources`）、trust（`generated`/`verified`）、lifecycle（`status`/`stale_after`）三族字段。
- **git 可追溯**：一次结论变更 = 一个 commit（写穿）；`topic_history` 工具和 `/topics history` 把变更史工具化。
- **local-first**：默认 local-only 模式（`~/.dsh/topics/`），零配置零凭据；配置 `repo` 后启用 GitHub 同步（单库单 Bundle 单 main，写穿 + 去抖推送，rebase 冲突标记降权等人解，不做自动智能合并）。
- **免 LLM 热路径注入**：每轮输入做词法匹配（CJK bigram + 词 + tag 加权 + `depends` 图游走），毫秒级；无命中零注入；per-topic 摘要 ≤300 token、top-K ≤4、总预算 ≤1.5k token，全部可配。
- **注入可观测可调参**：每轮落 Injection Log（命中、得分、near-miss、预算占用），`/topics stats` 给出 hit rate、top-N、near-miss 分布和阈值调参建议——调参看证据，不拍脑袋。
- **知识连接成图**：`depends`（机器可读的有向依赖边）+ 正文 `[[wikilink]]` 与 markdown 链接（人写边）共同构成图；检索命中后沿图双向游走（每层衰减一半、深度可配），一次命中带入一个知识子图；每次写入自动重建 `meta/backlinks.json` 反向引用索引，`/topics show` 直接列出「谁引用了我、怎么引用的」——改一条结论前先看牵连面。
- **两段式观察（M2）**：主模型用 `topic_observe` 随手记原子观察，后台蒸馏 lane（session end + 每 N 轮，模型可配）把观察批量蒸馏成正式 Topic；主模型认为值得记时直接 `topic_save`。

## 工具与命令

| 模型工具 | 用途 |
|---|---|
| `topic_save` | 沉淀/修订一个 Topic（名字/依赖/未决问题/结论/影响/建议） |
| `topic_observe` | 随手记一条原子观察（decision/finding/constraint/question），等蒸馏 |
| `topic_search` | 免 LLM 关键词检索记忆 |
| `topic_history` | 某 Topic 的结论变更史（git log 工具化） |

| 命令 | 用途 |
|---|---|
| `/topics onboard` | 交互式配置向导：唤起 dsh 原生 ask-user 面板逐项问答（模式 / 仓库 / 蒸馏 / 注入档位 / 自动观察），末步确认才写入；无 ask-user UI 的环境自动退化为逐条输入 |
| `/topics status` | bundle 健康：topic 数、观察积压、冲突、最近蒸馏结果、同步状态 |
| `/topics distill` | 手动触发一次蒸馏 run（复用现有 lane 与 in-flight 守卫；输出摘要与 distill-state 字段一一对应） |
| `/topics stats` | 注入统计：hit rate、top-N、near-miss 分布与调参建议 |
| `/topics list` / `show` / `history` | 浏览 Topic、反向引用与变更史 |
| `/topics graph` | 生成关系图网页（力导向、可拖拽缩放、悬停看结论）并自动在浏览器打开 |
| `/topics sync [pull\|push]` | GitHub 模式手动同步 |
| `/topics config` / `set <key> <value>` | 查看与修改配置（阈值、预算、蒸馏模型等） |

## 安装

```bash
dsh plugin --profile <你的profile> add @aiwayds/dsh-topics-memory
```

Bundle 默认在 `~/.dsh/topics/`（`$DSH_TOPICS_HOME` 可覆盖）。装好后的第一件事：跑 `/topics onboard`——直接弹出 dsh 原生 ask-user 交互面板逐项问答（TUI 面板 / 浏览器会话 / 飞书卡自动适配，feishu 侧装了 dsh-ask-router 还能双端竞答）。GitHub 同步：`/topics set repo <owner/name>`（建议仓库名 `dsh-topics-data`，与插件源码仓区分开），凭据走 `$GITHUB_TOKEN` 或已登录的 gh CLI（登录不是本插件职责）。

### 从 0.5.x 升级（更名）

0.6.0 起插件更名：`@aiwayds/dsh-llmwiki-memory` → `@aiwayds/dsh-topics-memory`，命令族 `/wiki` → `/topics`，settings namespace `llmwiki` → `topics`。安装新包（并把旧包从 profile 移除）即可——首次启动时插件自动完成迁移：数据目录 `~/.dsh/llmwiki` 改名为 `~/.dsh/topics`，旧 `llmwiki` namespace 里用户调过的配置值一次性拷入 `topics`。无需手动操作；迁移某步失败时插件回落旧路径继续工作。

## 快速上手

1. 安装（上方命令），重启 dsh；
2. 跑 `/topics onboard`，在 ask-user 面板里走完 模式 / 仓库 / 蒸馏模型 / 注入档位 / 自动观察 五个决定——末步确认才写入；
3. 正常干活：相关结论每轮自动注入；说「记住…」让模型 `topic_save`；`/topics status` 看健康，`/topics stats` 看注入命中。

## 卸载

从 profile 移除插件：

```sh
dsh plugin --profile <name> remove @aiwayds/dsh-topics-memory
```

宿主会自动收敛：`dsh.profile.bundles` 条目被移除，patch 层随包消失。

以下内容有意保留在磁盘上（这是你的记忆本体）：

- `~/.dsh/topics/` —— 整个话题包：话题 markdown、`meta/`、以及内嵌的 `.git` 仓库（完整历史；可能带有 `origin` 远端 —— GitHub 同步随插件停止）。要异地归档就原样拷贝/克隆这个目录。
- `~/.dsh/settings.yaml` 的 `topics:` 段 —— 用户覆盖项。注意：重装会静默恢复同步（包括已配置的 `repo`）；想干净重来就先删这一段。
- 0.5.x → 0.6.x 迁移留下的 `llmwiki:` 旧设置段不会被自动删除；确认无用后手动移除。

彻底清除：先备份 `~/.dsh/topics`，再 `rm -rf ~/.dsh/topics`。

## 配置

首次配置交给 `/topics onboard`；日常微调用 `/topics set <key> <value>`（写 `settings.yaml` 的 `topics` namespace，下次会话启动生效）。全部键与默认值：

| 键 | 默认 | 说明 |
|---|---|---|
| `repo` | 空（local-only） | GitHub 同步仓 `owner/name`；建议 `dsh-topics-data`；置空回 local-only |
| `autoInject` | `true` | 每轮注入总开关 |
| `injectDedup` | `true` | 会话级注入去重：本会话已实际注入过的 Topic 不重注（会话结束清空注册表；被预算丢弃的仍可注入；被去重占用的 topK 名额不回填）——见 ADR 0012 |
| `topK` | `4` | 每轮最多注入的 Topic 数 |
| `perTopicBudget` | `300` | 单 Topic 摘要 token 预算 |
| `totalBudget` | `1500` | 每轮注入总预算 |
| `matchThreshold` | `0.3` | 命中阈值；按 `/topics stats` 的 near-miss 证据调 |
| `tagBoost` | `0.15` | tag 命中加成 |
| `graphDepth` | `2` | `depends` 图双向游走深度（0 关闭） |
| `recencyWindowDays` | `7` | 近因加分窗口（+0.2） |
| `autoObserve` | `true` | 每轮自动抓原子观察 |
| `includeSubagents` | `true` | 注入与观察是否作用于子代理会话（ADR 0011）；`off` = 子代理整体跳过 |
| `observationMaxChars` | `2000` | 每侧每轮观察截断长度 |
| `distillProvider` / `distillModel` | 空（蒸馏关闭） | 蒸馏 lane 模型路由，两者都设置才启用。有 UI 时 `/topics set distill-provider` / `distill-model` 不带值会弹选择面板（provider 列表 → 该 provider 的模型目录）；带值时 `distill-model` 支持 `provider model` 或 `provider/model` 混写自动拆成两个键 |
| `distillEveryTurns` | `5` | 长 session 每 N 轮触发一次蒸馏 |
| `distillOnSessionEnd` | `true` | session 结束时蒸馏一次 |
| `distillBatchSize` | `40` | 每次蒸馏模型调用携带的观察条数。遇输出上限（`max-tokens`）失败自动减半重试（下限 5），失败批次不再活锁积压；缩小状态跨 run 保持，直到插件重载或配置变更。注意：`/topics set distillBatchSize` 重设为同值不触发复位，需设为不同值或重载插件 |
| `distillMaxModelCalls` | `8` | 单次蒸馏 run 的模型调用预算，含 ops 未回显有效 `observed_ids` 时的纠错重试（至多一次，预算放不下即零消费停机）。预算耗尽即停，已成功的批次照常 markDistilled（部分前进优于零前进），distill state 记 `partial: …` |
| `pushDebounceSeconds` | `45` | GitHub 模式去抖推送间隔 |

## Acknowledgements

本项目的形态直接受以下项目的启发与支撑：

- **[zosmaai/pi-llm-wiki](https://github.com/zosmaai/pi-llm-wiki)** — pi 上的原生 OKF v0.2 知识库扩展，本项目的直接灵感来源。其两段式观察（便宜的原子观察 + 后台蒸馏）、缓存安全注入（易变内容不进 system prompt）、分层 vault 与 ownership 模型都被本设计吸收。
- **[GoogleCloudPlatform/open-knowledge-format](https://github.com/GoogleCloudPlatform/open-knowledge-format)** — Open Knowledge Format (OKF) v0.2 规范，本项目 Bundle 格式严格遵循的标准。
- **[Karpathy 的 LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** — 整个 LLM 维护个人知识库方法论 的起点。
- **[fan56/pi-topic-memory](https://github.com/fan56/pi-topic-memory)** — 同作者的前作：pi 上的工作 topic 台账与静默注入扩展，其热路径免 LLM 匹配与注入时序经验是本项目的直接技术前身。
- **[chancelu/dsh-llmwiki](https://github.com/chancelu/dsh-llmwiki)** — dsh 生态的同类先例，本项目的同轮注入 seam（`agent/inbox/spliced` + `systemPrompt.context()`）沿用了它在真实 dsh 上验证过的机制。

## 已知边界

- **子代理默认参与记忆，可整体关掉**：默认（`include-subagents` 开）注入与观察同样作用于子代理会话。`/topics set include-subagents off` 后，delegation depth > 0 的子代理会话被整体跳过——不注入、不观察、不触发蒸馏；topic 工具始终在全局层（子代理显式 `topic_save` 不受开关影响）。跨进程子代理（claude-code/codex 等 provider）本就不加载本插件。
- **headless 单发会话里的 session-end 蒸馏**：插件 disposer 现在会等待退出触发的末次蒸馏落盘（有界等待，上限 90s；挂死的模型调用在超时后放弃、退出照常进行），headless 进程默认不再输掉这场竞速。90s 窗口内退出 run 可能只完成部分调用预算，剩余积压留待下次触发。已有 session-end run 在跑时退出触发整体跳过（否则同一全局队头批次会被双份喂给模型）。会话内 `/topics distill` 手动触发则完全绕开竞速；`meta/distill-state.json` 记录每次 lane 的结局，`/topics status` 可查。
- **观察 GC（三振删除）**：被模型实际评估（返回了可解析应答，无论内容有无价值）却未被任何 op 消费的观察记一次 failed attempt，连续 3 次即物理删除（用户已明确授权删除 lane 确实无法处理的原始观察）。模型从未评估过的批次永不计数：基础设施失败（网络错误、蒸馏路由未配置 → 可读 `no-model` 短路）与输出不可解析（`invalid-output`）豁免；输出上限减半重试中的批次只有到达裁决（成功 / 触底 / stalled / 明确跳过）才计一次。删除立即 commit（数据销毁 git 可追溯），纯计数沿用 flush 节奏。
- **配置读取时机**：`/topics set` 与 settings.yaml 修改在下次会话启动后生效最稳。
- **蒸馏选模型**：`/topics onboard` 的蒸馏一步拆成两问（先 provider 后 model，模型列表取自该 provider 的目录），选完经 `resolveModelInfo` 预校验——provider 无活路由会阻断重选，模型目录校验非 NO_ADAPTER 失败（目录外，可能仍可用）则警告但放行；无 ask UI 或无可用模型路由的环境自动退回文本输入。`/topics set` 的选择面板走同一套校验。

## 设计文档

- [CONTEXT.md](CONTEXT.md) — 领域术语表
- [docs/adr/](docs/adr/) — 0001–0013：OKF 合规、Remote 形态、同步策略、两段式 Observer、Bundle 布局、注入默认值、可观测与调参、双模式持久化、配置向导、子代理隔离、include-subagents 开关、注入去重默认开、更名与迁移

## License

MIT
