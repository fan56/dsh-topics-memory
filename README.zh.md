# dsh-topics-memory

[English](README.md) | 中文

一个 dsh 插件：把「工作 topic 记忆」维护成 [OKF 标准（Open Knowledge Format v0.2）](https://github.com/GoogleCloudPlatform/open-knowledge-format)的知识 bundle，持久化在本地 git 仓库（可选同步到 GitHub 私有仓库），利用 git 历史提供结论可追溯性，自动观察会话沉淀知识，并在每轮对话前向模型注入相关 Topic。

> **要求 dsh >= 0.1.7-rc.1** — 本插件只跟随 dsh RC/stable 线（CI 与发版在运行时解析 latest/next 中更新的 dist-tag）。**不再支持 alpha 线。**

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
| `/topics consolidate` | 手动触发一次整理 run：LLM 园丁合并重复/晋升 stable/废弃过时/刷新元数据，逐条 git commit 可回滚 |
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
- 设置页 `dsh-topics-memory` 条目（profile patch）—— 用户覆盖项。注意：重装会静默恢复同步（包括已配置的 `repo`）；想干净重来就先清空该条目。
- 0.5.x → 0.6.x 迁移留下的 `llmwiki:` 旧设置段不会被自动删除；确认无用后手动移除。

彻底清除：先备份 `~/.dsh/topics`，再 `rm -rf ~/.dsh/topics`。

## 配置

首次配置交给 `/topics onboard`；日常微调用 `/topics set <key> <value>`——0.1.7+ 宿主上写设置页 `dsh-topics-memory` 条目（profile patch），全部键 volatile 免重启即时生效。从 0.1.7 之前升级：旧 `settings.yaml` 里的 `topics:` 段会在下次插件 boot 时一次性自动迁入新条目（审计档在 `~/.dsh/storages/dsh-topics-memory/legacy-import.json`）。全部键与默认值：

| 键 | 默认 | 说明 |
|---|---|---|
| `repo` | 空（local-only） | GitHub 同步仓 `owner/name`；建议 `dsh-topics-data`；置空回 local-only |
| `autoInject` | `true` | 每轮注入总开关 |
| `injectDedup` | `true` | 会话级注入去重：本会话已实际注入过的 Topic 不重注（会话结束清空注册表；被预算丢弃的仍可注入；被去重占用的 topK 名额不回填）——见 ADR 0012 |
| `suppressEcho` | `true` | 蒸馏回声抑制：本会话蒸馏出的 Topic 不回注同会话（provenance 记入 observations 日志的 `sessionId → distilledInto`） |
| `topK` | `4` | 每轮最多注入的 Topic 数 |
| `perTopicBudget` | `300` | 单 Topic 摘要 token 预算 |
| `totalBudget` | `1500` | 每轮注入总预算 |
| `matchThreshold` | `0.3` | 命中阈值；按 `/topics stats` 的 near-miss 证据调 |
| `tagBoost` | `0.15` | tag 命中加成（多次命中的总上限也为此值） |
| `injectMode` | `pointer` | 注入形态：pointer（轻指针，单条 ≤80 tok，`topic_open` 拉全文；总预算上界锁 600）／digest（完整摘要渲染，per-topic 300 / 总 1500） |
| `qualityLane` | `sampled` | 慢道质量 lane：`off`／`sampled`（1/3 轮触发）／`always`；`turn/end` 产出、下一轮注入消费（消费即清），子代理会话写死不跑 |
| `graphDepth` | `2` | `depends` 图双向游走深度（0 关闭） |
| `recencyWindowDays` | `7` | 近因加分窗口（+0.2） |
| `autoObserve` | `true` | 每轮自动抓原子观察 |
| `includeSubagents` | `false` | 注入与观察是否作用于子代理会话（ADR 0011；0.7.0 起默认 off）；`off` = 子代理整体跳过 |
| `observationMaxChars` | `2000` | 每侧每轮观察截断长度 |
| `distillProvider` / `distillModel` | 空（蒸馏关闭） | 蒸馏 lane 模型路由，两者都设置才启用。有 UI 时 `/topics set distill-provider` / `distill-model` 不带值会弹选择面板（provider 列表 → 该 provider 的模型目录）；带值时 `distill-model` 支持 `provider model` 或 `provider/model` 混写自动拆成两个键 |
| `distillEveryTurns` | `5` | 长 session 每 N 轮触发一次蒸馏 |
| `distillOnSessionEnd` | `true` | session 结束时蒸馏一次 |
| `distillBatchSize` | `40` | 每次蒸馏模型调用携带的观察条数。遇输出上限（`max-tokens`）失败自动减半重试（下限 5），失败批次不再活锁积压；缩小状态跨 run 保持，直到插件重载或配置变更。注意：`/topics set distillBatchSize` 重设为同值不触发复位，需设为不同值或重载插件 |
| `distillMaxModelCalls` | `8` | 单次蒸馏 run 的模型调用预算，含 ops 未回显有效 `observed_ids` 时的纠错重试（至多一次，预算放不下即零消费停机）。预算耗尽即停，已成功的批次照常 markDistilled（部分前进优于零前进），distill state 记 `partial: …` |
| `consolidateCadence` | `daily` | 整理 lane 节拍：`daily`/`3d`/`7d`/`off`。会话启动时检查上次整理时间（`meta/consolidate-state.json`），到期即在后台自动跑 LLM 园丁（复用蒸馏模型路由）：本地词面聚类只送「长得像」的候选簇，四类动作 merge/promote/deprecate/refresh，越权 op 一律丢弃；模型调用失败不推进节拍，下次启动重试 |
| `deprecatedTtlDays` | `15` | deprecated 条目超过 N 天在会话启动时自动删除（本地规则不依赖模型，逐条 git commit 可回溯找回）；`0` 关闭清扫 |
| `usageBoost` | `0.15` | 使用加成（ADR 0015）：近 30 天被注入命中/点开过的 Topic 检索加分（计入门槛分、帽 0.2、零词面相关不加、结构门不豁免）；`0` 关闭 |
| `pushDebounceSeconds` | `45` | GitHub 模式去抖推送间隔 |
| `jevEnabled` | `false` | System One 决策层总开关（实验）：`false` = 零行为变化——见下节 |
| `jevBackend` | `zen` | 决策端点：`zen`（免费）/ `native` / `openrouter` |
| `jevModel` | 空（按 backend：`jev-1.13-free` / `jev-1.13.0` / `typesafe/jev-1.13`） | 版本钉定的决策模型；升级是显式动作 |
| `jevTimeoutMs` | `3000` | 单次决策请求超时；单发不重试 |
| `jevSecretFile` | 无 | 出网 secret gate 的外部清单路径；热更换路径即重读 |
| `jevDebug` | 关 | 诊断日志开关（走宿主 logger，默认静默） |

## System One 决策层（实验，default off）

架在异步 lane 上的可选决策层，由 System One typed-decision 模型（jev）驱动：慢车道 rerank 候选改批量 noul 打分（替换 LLM rerank）、整理 lane 的 merge 候选对在 LLM 园丁接手前先做前置过滤、快道词法门由 turn-end lane 做影子对账。每个判定都过概率门控，任何失败——超时、网络错、坏答案——一律回退到今天的纯本地行为（fail-open 硬编码，无开关键）。注入热路径永不发起远程调用（ADR 0016–0019；设计文档：`docs/design/2026-09-25-system-one-integration.md`）。默认关闭：`jevEnabled: false` 即零行为变化。

### 键

| 键 | 默认 | 说明 |
|---|---|---|
| `jevEnabled` | `false` | 总开关（灰度：default off → shadow → opt-in per profile → 默认开观察）；`false` 连统计一起停 |
| `jevBackend` | `zen` | `zen`（免费）/ `native` / `openrouter` |
| `jevModel` | 空串哨兵 | 调用时按 backend 解析：`jev-1.13-free`（zen）/ `jev-1.13.0`（native）/ `typesafe/jev-1.13`（openrouter）——钉版本号，永不指向别名 |
| `jevTimeoutMs` | `3000` | 单请求超时；单发 `AbortSignal.timeout` 不重试（lane 的下一节拍自然重试） |
| `jevSecretFile` | 无 | 外部 secret 清单路径；启动加载一次，热更换路径即重读 |

### key 配置

| Backend | key 来源 |
|---|---|
| `zen`（默认，免费） | `JEV_ZEN_API_KEY` env，或 macOS 钥匙串服务 `opencode-zen-inference`（默认回退——零配置） |
| `native` | `TYPESAFE_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY`；钥匙串服务 `openrouter-inference` 需显式 `JEV_KEYCHAIN` |

dsh 会清洗插件环境里匹配 `KEY|PASSWORD|SECRET|TOKEN` 的 ambient 变量，shell 里 export 的 key 到不了插件——请走 profile patch 的 `env:` 块显式透传，或用钥匙串（`JEV_KEYCHAIN` / zen 默认服务；都不匹配清洗规则）完全避开文件落 key：

```yaml
# ~/.dsh/cordis.patch.yml — 并入你的 profile patch。!!js 表达式让 key 不落文件
# （与 dsh-jev-mcp 同款约定）。
- insert:
    - id: dsh-topics-memory
      name: '@aiwayds/dsh-topics-memory'
      env:
        JEV_ZEN_API_KEY: !!js process.env.JEV_ZEN_API_KEY ?? ''
        # native:     TYPESAFE_API_KEY: !!js process.env.TYPESAFE_API_KEY ?? ''
        # openrouter: OPENROUTER_API_KEY: !!js process.env.OPENROUTER_API_KEY ?? ''
        #   另加 JEV_KEYCHAIN: 'openrouter-inference'
        #   （zen 无需 JEV_KEYCHAIN——无 env key 时自动读默认钥匙串服务）
```

### 阈值（rerank / merge pair）

| 档 | rerank（慢车道） | merge pair（整理前置） | 动作 |
|---|---|---|---|
| 采纳 | noul ≥ 0.60 | ≥ 0.50 | 进 picks / 送 LLM 生成 |
| 记录带 | 0.10 – 0.60 | 0.15 – 0.50 | 只落 decisions.jsonl，不影响行为 |
| 回退 | < 0.10 | < 0.15 | 强否决，回退词法/现状行为 |

绝对线绑定批量协议（换协议必须重扫）。三缝失败回退行为见 ADR 0018。判定与调用明细落 `meta/decisions.jsonl`（本地 only，脱敏——绝不存 state 原文）。


### 延迟基准（2026-09-26 实测，Apple M5，typesafe `native` 后端，jev-1.13.0）

真实负载基准 + 沙箱实跑——用来选 `jevTimeoutMs`。各 source 形状与负载不同，除注明外均为同一 8 候选 shadow 批量：

| 来源 | 形状 | p50 | p90 | max | n |
|---|---|---|---|---|---|
| 空载基准（顺序发） | 8 问批量 | 742 ms | 1290 ms | 1461 ms | 10 |
| 空载基准（顺序发） | 单问 | 367 ms | — | 925 ms | 5 |
| 阈值扫描（09-25） | 20 问批量 | 均值 1760 ms | — | 8470 ms | 16 |
| 真机 headless 轮 | 8 问批量，**与主模型流式并发** | 327–5698 ms | — | 10619 ms | 3 |

关键读数：空载路径远低于 3000 ms 默认线（p90 约 2× 余量）；但真机轮的 shadow 调用与主模型的流式响应共享网络——上表 10.6 s 离群值正是在这个位置观测到的。超时即 fail-open：该批数据丢弃（慢车道回退旧 LLM rerank），**紧超时损失的是 shadow 数据，不是正确性**。默认 3000 保持不变；除非 `decisions.jsonl` 显示 `timeout` 占比持续 >5%（`/topics status` 的 30 天摘要会露出），弱网用户可自行上调 `jevTimeoutMs`。`zen` 与 `openrouter` 本次未实测——开启后你自己 decisions.jsonl 的 latency 列就是你网络的真值。

## Acknowledgements

本项目的形态直接受以下项目的启发与支撑：

- **[zosmaai/pi-llm-wiki](https://github.com/zosmaai/pi-llm-wiki)** — pi 上的原生 OKF v0.2 知识库扩展，本项目的直接灵感来源。其两段式观察（便宜的原子观察 + 后台蒸馏）、缓存安全注入（易变内容不进 system prompt）、分层 vault 与 ownership 模型都被本设计吸收。
- **[GoogleCloudPlatform/open-knowledge-format](https://github.com/GoogleCloudPlatform/open-knowledge-format)** — Open Knowledge Format (OKF) v0.2 规范，本项目 Bundle 格式严格遵循的标准。
- **[Karpathy 的 LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** — 整个 LLM 维护个人知识库方法论 的起点。
- **[fan56/pi-topic-memory](https://github.com/fan56/pi-topic-memory)** — 同作者的前作：pi 上的工作 topic 台账与静默注入扩展，其热路径免 LLM 匹配与注入时序经验是本项目的直接技术前身。
- **[chancelu/dsh-llmwiki](https://github.com/chancelu/dsh-llmwiki)** — dsh 生态的同类先例，本项目的同轮注入 seam（`agent/inbox/spliced` + `systemPrompt.context()`）沿用了它在真实 dsh 上验证过的机制。

## 已知边界

- **子代理默认不参与记忆，可整体打开**：默认（`include-subagents` off，0.7.0 起）delegation depth > 0 的子代理会话被整体跳过——不注入、不观察、不触发蒸馏；`/topics set include-subagents on` 后注入与观察同样作用于子代理会话。topic 工具始终在全局层（子代理显式 `topic_save` 不受开关影响）。跨进程子代理（claude-code/codex 等 provider）本就不加载本插件。
- **退出路径本地化（0.10.0）**：插件 disposer 只做一步本地 git commit（meta 侧车文件：observations / injections / distill state），不再等待任何网络——没有 pull、没有 push、没有模型调用，宿主退出不再支付 git 双程与有界蒸馏等待（旧的 90s 上限移除，仅保留 10s 兜底以防病理性 git 卡死）。退出蒸馏触发改为 fire-and-forget；已有 session-end run 在跑时整体跳过（否则同一全局队头批次会被双份喂给模型）。跳过不丢活：observations 本就 write-through 落盘，推迟的 push 由下次启动的 pull 补推，被跳过的蒸馏同样由下次启动回放（boot-replay）。`meta/distill-state.json` 记录每次 lane 的结局，`/topics status` 可查。
- **观察 GC（三振删除）**：被模型实际评估（返回了可解析应答，无论内容有无价值）却未被任何 op 消费的观察记一次 failed attempt，连续 3 次即物理删除（用户已明确授权删除 lane 确实无法处理的原始观察）。模型从未评估过的批次永不计数：基础设施失败（网络错误、蒸馏路由未配置 → 可读 `no-model` 短路）与输出不可解析（`invalid-output`）豁免；输出上限减半重试中的批次只有到达裁决（成功 / 触底 / stalled / 明确跳过）才计一次。删除立即 commit（数据销毁 git 可追溯），纯计数沿用 flush 节奏。
- **配置读取时机**：`/topics set` 与 profile patch 修改在下次会话启动后生效最稳（dsh 0.1.7 起 settings 文档即 profile patch；旧 settings.yaml 导入一次后改名）。
- **蒸馏选模型**：`/topics onboard` 的蒸馏一步拆成两问（先 provider 后 model，模型列表取自该 provider 的目录），选完经 `resolveModelInfo` 预校验——provider 无活路由会阻断重选，模型目录校验非 NO_ADAPTER 失败（目录外，可能仍可用）则警告但放行；无 ask UI 或无可用模型路由的环境自动退回文本输入。`/topics set` 的选择面板走同一套校验。

## 设计文档

- [CONTEXT.md](CONTEXT.md) — 领域术语表
- [docs/adr/](docs/adr/) — 0001–0019：OKF 合规、Remote 形态、同步策略、两段式 Observer、Bundle 布局、注入默认值、可观测与调参、双模式持久化、配置向导、子代理隔离、include-subagents 开关、注入去重默认开、更名与迁移、双通道注入、使用加成、决策层直连 HTTP、快道零远程红线、fail-open 硬编码、secret gate 内嵌

## License

MIT
