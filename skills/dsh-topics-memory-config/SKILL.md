---
name: dsh-topics-memory-config
description: "dsh 记忆插件（@aiwayds/dsh-topics-memory）使用与配置指南。凡涉及 dsh 记忆/话题库/GitHub 同步/蒸馏/整理，或要配置 topics 段时先读本指南：settings.yaml 顶层 `topics:` 段全部键（repo/autoInject/topK/注入预算/蒸馏/整理/观察/图游走等）、/topics 命令族（onboard/status/distill/consolidate/stats/list/show/history/graph/sync/config/set）、首次配置 ask_user_question 向导（local-only 或绑 GitHub 仓、蒸馏模型路由、注入档位、自动观察）、注入形态 pointer/digest、legacy llmwiki 段自动迁移。触发词：topics、记忆、topic、蒸馏、distill、整理、consolidate、合并重复、deprecatedTtl、autoInject、记忆库、llmwiki、include-subagents。"
---

# dsh-topics-memory 使用指南（工作记忆 / 蒸馏 / 注入）

> dsh 插件：把会话中的「问题/结论/影响/依赖」蒸馏成结构化 topic，按相关度每轮回注上下文，
> 可选同步 GitHub 私有仓跨机共享。记忆是编辑出来的不是攒出来的——一个 topic 只记四件事
> （起始问题、结论、影响、依赖），过程属于 session，结束就随它去。

## 配置入口（settings.yaml 顶层 `topics:` 段）

在 `~/.dsh/settings.yaml` 写顶层 `topics:` 段（只写非默认值即可）：

| 键 | 默认 | 作用 |
|---|---|---|
| `repo` | 空（local-only） | GitHub 同步仓 `owner/name`；空 = local-only（数据在 `~/.dsh/topics`，`$DSH_TOPICS_HOME` 可覆盖）；建议仓库名 `dsh-topics-data`（与插件源码仓区分） |
| `autoInject` | `true` | 每轮注入总开关 |
| `injectDedup` | `true` | 会话级注入去重：本会话已实际注入过的 topic 不重注 |
| `suppressEcho` | `true` | 蒸馏回声抑制：本会话蒸馏出的 topic 不回注同会话 |
| `topK` | `4` | 每轮最多注入条数 |
| `perTopicBudget` | `300` | 单 topic 摘要 token 预算（digest 形态用；pointer 形态单条 ≤80 tok） |
| `totalBudget` | `1500` | 每轮注入总预算（digest 形态用；pointer 形态上界锁 600，旋钮可下调） |
| `matchThreshold` | `0.3` | 命中阈值；按 `/topics stats` 的 near-miss 证据调 |
| `tagBoost` | `0.15` | tag 命中加成（多次命中的总上限也为此值） |
| `injectMode` | `pointer` | 注入形态：pointer（轻指针，单条 ≤80 tok，`topic_open` 拉全文）／digest（完整摘要 300/1500） |
| `qualityLane` | `sampled` | 慢道质量 lane：off／sampled（1/3 轮）／always |
| `graphDepth` | `2` | `depends` 图双向游走深度（0 关闭） |
| `recencyWindowDays` | `7` | 近因加分窗口（+0.2） |
| `autoObserve` | `true` | 每轮自动抓原子观察（`topic_observe` 之外的后台捕获） |
| `includeSubagents` | `false` | 注入与观察是否作用于子代理会话；off 时子代理整体跳过（慢道写死不跑） |
| `observationMaxChars` | `2000` | 每侧每轮观察截断长度 |
| `distillEveryTurns` | `5` | 长 session 每 N 轮触发一次蒸馏 |
| `distillOnSessionEnd` | `true` | session 结束时蒸馏一次 |
| `distillProvider` / `distillModel` | 空（蒸馏关闭） | 蒸馏模型路由，两者都非空才启用 |
| `distillBatchSize` | `40` | 每次蒸馏模型调用携带的观察条数（输出上限失败自动减半，下限 5） |
| `distillMaxModelCalls` | `8` | 单次蒸馏 run 的模型调用预算（预算耗尽即停，已成功批次保留标记） |
| `consolidateCadence` | `daily` | 整理 lane 节拍：daily／3d／7d／off。会话启动时检查上次整理时间，到期即在后台跑 LLM 园丁（复用蒸馏模型路由）：合并重复、晋升 stable、废弃过时、刷新元数据；off 关闭 |
| `deprecatedTtlDays` | `15` | deprecated 条目超过 N 天在会话启动时自动删除（本地规则不依赖模型，逐条 git commit 可回溯找回）；0 关闭清扫 |
| `pushDebounceSeconds` | `45` | GitHub 模式去抖推送间隔 |

- 全部键都可用 `/topics set <键> <值>` 运行时写回同段（即时校验：boolean 用 on|off、
  inject-mode 限 pointer|digest、quality-lane 限 off|sampled|always、repo 须形如 owner/name；
  distill-model 支持 `provider model` 或 `provider/model` 混写，自动拆成两个键）。
  `/topics config` 看当前生效值；配置修改在下次会话启动后生效最稳。

## 交互式配置向导（ask_user_question）

用户说「帮我配置记忆 / 配置 topics」时优先引导跑 `/topics onboard`——dsh 原生 ask-user
面板逐题收集（每题展示当前值，末步确认面板列出全部写入项，确认才写入；无 ask UI 的环境
自动退化为逐条输入向导）：

1. **存储模式**：local-only（推荐，零配置零凭据，数据只在 `~/.dsh/topics`）／
   GitHub 同步（`owner/name` 私有仓，写穿 + 去抖推送，跨机共享；默认建议
   `<gh登录名>/dsh-topics-data`）。
2. **蒸馏模型**：跳过（先不启用，观察只积累，随时可开）／指定 provider → 该 provider 目录下的
   model（两键都非空才启用；选完经路由预校验，provider 无活路由阻断重选）。
3. **注入档位**：保守（topK 2 · 800 tok）／标准（topK 4 · 1.5k tok，默认）／放量（topK 6 · 2.5k tok）。
4. **自动观察**：保持开（推荐，随手聊就被记录）／关闭（只手动 topic_save / topic_observe）。

GitHub 模式凭据走 `$GITHUB_TOKEN` 或已登录的 gh CLI（`gh auth status` 检查；登录本身
不在插件职责内，缺凭据先解决这一步）。

## 命令速查

| 命令 | 作用 |
|------|------|
| `/topics onboard` | 交互式配置向导（ask-user 面板，末步确认才写入） |
| `/topics status` | bundle 健康：topic 数、观察积压、冲突、最近蒸馏、同步状态 |
| `/topics distill` | 手动触发一次蒸馏 run（复用现有 lane 与 in-flight 守卫） |
| `/topics consolidate` | 手动触发一次整理 run：LLM 园丁合并重复/晋升/废弃/刷新元数据，逐条 git commit 可回滚 |
| `/topics stats` | 注入统计：hit rate、Top-N、near-miss 分布与调参建议 |
| `/topics list` | 表格列出全部 Topic（带序号、最新优先、100 条封顶） |
| `/topics show <slug>` | Topic 全文阅读页 + 反向引用（谁引用了我、怎么引用） |
| `/topics history <slug>` | 结论变更史（git log 工具化，表格化输出） |
| `/topics graph` | 生成关系图网页并自动在浏览器打开 |
| `/topics sync [pull\|push]` | GitHub 模式手动同步（默认自动） |
| `/topics config` | 当前生效配置（表格化输出） |
| `/topics set <键> <值>` | 运行时写回配置（校验见上）；distill-provider / distill-model 不带值弹选择面板 |

## 排障

1. **注入太多/太吵**：下调 top-K、抬高 match-threshold 或压 total-budget；先看
   `/topics stats` 的 near-miss 分布再动手，调参看证据不拍脑袋。
2. **蒸馏没跑**：distill-provider 与 distill-model 必须**同时非空**（缺一即闲置）；长会话看
   distill-every-turns 节拍、会话结束看 distill-on-session-end；`/topics distill` 手动触发
   会给可读原因（no-model / in-flight / no-observations）。
3. **整理 lane**：`consolidate-cadence`（daily/3d/7d，默认 daily，off 关闭）到期后在会话启动
   时后台跑，复用蒸馏模型路由（未配蒸馏模型则闲置）；本地词面聚类只把「长得像」的 topic
   送模型，四类动作（merge/promote/deprecate/refresh）都逐条 git commit，`/topics consolidate`
   手动立即跑，`/topics status` 看最近整理，不满意 `git revert` 即回滚。被合并条目标
   deprecated 且不再参与注入。
4. **GitHub 同步**：repo 须形如 owner/name；推送有 push-debounce-seconds 去抖；退出只做
   本地 commit 不等网络，推迟的 push 由下次启动 pull 后补推；rebase 冲突的 topic 降权标记，
   `/topics status` 可查。
5. **旧版 llmwiki 段自动迁移**：0.5.x 的 `llmwiki:` 设置段与 `~/.dsh/llmwiki` 数据目录在
   首次启动时自动迁移到 `topics` / `~/.dsh/topics`，无需手工；旧插件还在运行时会警告跳过
   （防双载脑裂），先从 profile 移除旧包。
