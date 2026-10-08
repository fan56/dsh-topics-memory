# 上游 durable 演进轨迹与 fork merge 基线（R4）

Ticket: `wayfinder/tickets/004-r4-upstream-roadmap.md`
基线：本仓 git 历史（remote `pi-src` 本地 clone 与 `main` 零差异，即截至 2026-10-08 已 fetch 的上游状态全部在库）。所有引用为 commit sha + 文件:行号，均可现场复核。

## 1. 结论先行（TL;DR）

1. **`packages/durable` 不是"将被上游重写的旧 API"，而是上游唯一现行动力**。pico → pico2 → pico3 → Pico5 是设计淘汰链，Pico5 规格即 `packages/durable/docs/spec.md`（normative），实现包 1–23 已全部完成；被淘汰删除的是旧一代 `packages/agent/src/harness`（AgentHarness），已在 v1.0.0 移除。
2. **上游节奏极快且 API 仍标 Experimental**：v1.0.0（10-01）后 7 天连发 5 个 release（v1.0.1→v1.1.0），v1.0.4 与 v1.1.0 都带 Breaking Changes；`packages/durable` 自 09-18 诞生日起天天有提交。
3. **merge 基线建议：跟 tag 不跟 main 提交，merge 不 rebase**；fork 现在代码 delta 为零，是定基线的最佳时机。
4. **"别抢先做"清单**（§5）：tree navigation/fork、nextRun/resume 队列、subagent 服务化、transcript 历史分页、sessions picker/extensions/images 等实验 demo 缺项、以及 storage 层的 graph 方案——上游文档已把前四项写成自己的 TODO。

## 2. 演进脉络：设计链与代码落地（全部已入 v1.0.0）

### 2.1 设计文档淘汰链（2026-09-09 → 09-24）

| 日期 | commit | 事件 |
|---|---|---|
| 09-09 | `e045ed2f3` | `docs(agent): add pico design drafts`：一次性带入 `pico2.md`（2491 行）、`pico-v3.md`（2113 行）、`pico/`（v2/v3 handoff、usage 等）、`harness.md`（1468 行）、`work-packages/00–09`、`post-wp05-roadmap.md` |
| 09-12/13 | `99a3948c4`、`51f309079` | pico v2 kernel contract 定义并对齐实现 |
| 09-13/14 | `46b66c59a` 等 | pico3 hardened kernel；同期 pico3 review/hardening handoff |
| 09-15 | `56cd5989e` | `docs(agent): replace obsolete Pico prototypes with Pico5 design`——pico/pico2/pico4 原型废弃，Pico5 定为唯一设计 |
| 09-17 | `729d5cb74` | `docs(agent): finalize Pico5 specification set` |
| 09-18 | `080160162` | `feat(durable): move Pico into dedicated package`：设计落成 `packages/durable`；同日 `b5ef419d5` 清理非 Pico5 文档 |
| 09-24 | `7c696c00f`、`481c7232f`、`cbe7cf00b` | Pico5 immutable tracker / JSONL / strict-JSON 收尾，即现存 `packages/durable/docs/pico-v5-*.md` |

**判定**：所谓 "pico2 spike / pico-v3" 是被 Pico5 取代的**旧原型**，不是下一代。`packages/durable/docs/pico-v5-handoff.md:7-8` 明说 "Pico3 is reference material only. Preserve useful behavior, not its capability facades…"；`pico-v5-handoff.md:14`：**"Packages 1–23 are implemented in `packages/durable`"**。Pico5 没有后继规格在途——上游当前做的是给已实现的 Pico5 补后端与硬化，不是重写。

### 2.2 代码落地与产品化（09-28 → v1.1.0）

- 09-28 `3883fcb1f`：openable Harness + registry + conversation config（Package 后续 API 微调开始）。
- 09-29→10-01：Package 16–23 密集实现——first tool turn（`445770e03`）、inbox/reset/usage/conversation view（`47f65f1a3`）、ownership/subagents（`2532a0bef`）、structured concurrency（`03180653c`）、compaction/overflow（`ed0d6b91b`）、extensions（`b56702ad3`）、lifecycle + task graph view（`49683a364`）。
- **v1.0.0（2026-10-01，`a13d35a74`）三连**：
  - `5609b0d6c` `feat(coding-agent): experimental TUI coding agent on pi-durable`——即 `packages/coding-agent/src/experimental/durable/`（8 个文件，runtime/tui/subagent/…），带 `--continue` 崩溃恢复、`/tasks` 面板；
  - `48dd1e2f0` `feat(coding-agent): port the experimental client/server to pi-durable`——session worker 持有 durable Harness + per-session SQLite；
  - `7fd478a2e` `feat(agent): remove the experimental harness from pi-agent-core`——**整棵 `packages/agent/docs/` 在此删除**（pico 全部草稿、harness.md、work-packages/00–08、post-wp05-roadmap.md、mobile-handoff/）。旧一代 durable AgentHarness 至此退场。
- v1.0.1→v1.1.0（10-03→10-07）纯硬化与新后端：provider session identities（`70eceaade`）、Windows flushFile、bounded readers/argv exec（`4748c627a`）、`FileSystem.watch`（`a84510819`）、powershell tool（`68c22123b`）、**context 常驻内存 + Cloudflare Durable Object SQLite 后端**（`da866ada1`）。

### 2.3 旧 roadmap 的定位警示

`post-wp05-roadmap.md`（read via `git show 7fd478a2e^:…`）审计的是**已删除的 AgentHarness**：watchSession stub、JSONL snapshot compaction、RemoteSession 冾突、telemetry/search 缺口等，全部是对着 `packages/agent/src/harness` 与 `session-backends/sqlite-node` 说的。**不可当作现行 backlog**；但主题会复发——watch 主题已在 durable 侧以 `FileSystem.watch`（v1.0.3）重现。看上游下一步，看 `packages/durable/CHANGELOG.md` 的 Unreleased 与 experimental README 的 TODO，不要看死文档。

## 3. 节奏量化

- **Release 频率**：v0.99.0/1（09-29）→ v0.99.2（09-30）→ v1.0.0（10-01）→ v1.0.1（10-03）→ v1.0.2（10-04）→ v1.0.3/v1.0.4（10-05）→ v1.1.0（10-07）。**约 1–2 天一个 tag**。
- **提交量**：`v1.0.0..HEAD` 共 142 commits / 7 天（日均 ~20；含本 fork 自己的 1 个 wayfinder commit），其中 39 个触及 `packages/durable` 或 `coding-agent/src/experimental`；`packages/durable` 自 09-18 诞生至 10-07 的 20 天里有 17 个提交日（单日 1–19 个），无长间隙。
- **API 稳定度**：`packages/durable/package.json` 版本 1.1.0、12 个 export subpath、src 内 TODO 数为 0；但 changelog 显示 v1.0.4（`Storage` 需实现 query `order`、`watch()` permission_denied 语义）与 v1.1.0（`ConversationQuery/EntryQuery/TaskQuery/SubmissionQuery.order`、`TaskRuntime.context()` 改 options 签名）**连发 breaking changes**——Experimental 期的正常形态。
- 方向：Pico5 计划本体完成后，动能在①执行环境硬化（watch/exec/readers/Windows）、②新存储后端（Cloudflare DO）、③性能（context retention 免整卷重扫）、④coding-agent 侧的产品化移植（experimental/services）。

## 4. 上游自己规划的 parity 工作（= "别抢先做" 的依据）

两份上游一手 TODO：

1. `packages/coding-agent/src/experimental/services/README.md`（"TODO — Deferred while the worker moves from the removed AgentHarness to pi-durable"）：
   - **Tree navigation**：`AgentController.navigate()` 被丢；durable 靠 fork 出新 conversation + summary entry + 指向当前 conversation 的指针——上游已给出目标设计；
   - **Next-run queue**：`nextRun()`/`resume()` 被丢；worker 在打开 Session 时自行恢复中断工作；
   - **Subagents**：服务只覆盖 root conversation；暴露 subagent 需 **keyed service instances per conversation**；
   - **Transcript history**：`Transcript` 只含当前 context（最近 reset/compaction 之后）；旧 entries 需要 `Conversation.entries()` 上的 paging 方法。
2. `packages/coding-agent/src/experimental/durable/README.md` 末尾 "Not here"：sessions list 与 resume picker、forks 与 tree navigation、extensions、prompt templates、images、`/login`。

另外 `packages/durable/docs/spec.md:4733-4747` 的 **Non-goals** 是反向信号（上游明确不做）：whole-Session DOM、visible-undurable publication、Session-kernel 事件日志、session-scoped rewindable documents、自动 checkpoint、自动三方 view mount、**CRDT/offline multi-writer merge**、Chord op 的 SQL 翻译、JSONL 全局 compaction、被删 Pico 原型的兼容层、进程内强杀不合作 extension。fork 若碰这些=永久自持，不会与上游撞车，但也拿不到上游跟进。

storage 层唯一的"未来重写"信号在 `packages/durable/docs/chord-delta-findings.md:3-19`：ID 寻址的 graph tracker 实验被否（内存/导入/hydration 成本不可接受），保留 tree/path delta；`chord-delta-findings.md:347-358` 给出"未来重试的要求"。即：**Chord delta 内部表示可能再演化，但接口层（`Op[]`、tree/path delta）是现行约定**，且该层属 `packages/chord` 而非 pi-durable 公开 API。

## 5. "别抢先做"清单（upstream will do it first）

按撞车概率排序：

1. **`experimental/durable` demo 的功能补齐**（sessions picker、forks/tree navigation、extensions、prompt templates、images、`/login`）——该目录 10-01 才诞生、上游正以它为产品化试验田（`70c036211` 已把 task panel 设为默认）。我们若要 parity，先做 stable↔durable 差异的**盘点与适配层**，把 demo 本体的功能演进留给上游。
2. **`AgentController.navigate()` 的 fork+summary+pointer 实现**、**`nextRun()`/resume 语义**、**subagent 的 keyed services 暴露**、**`Conversation.entries()` 历史分页**——四项都是 services README 白纸黑字的 deferred TODO，上游大概率在 durable worker 产品化时逐个实现。
3. **执行环境与工具硬化**（FileSystem.watch、argv exec、bounded readers、powershell、Windows、Cloudflare DO 后端）——一周内连落 6+ commit 的区域，纯属上游主场。
4. **Chord 文档存储的替代表示**（graph tracker 方向）——上游已有完整调查报告与"重来标准"，别替他们重试。
5. **`packages/durable` 公开 API 的兼容层/包装层**——API 每个版本都在 breaking，任何包装都会双倍付 churn 成本；fork 应直接消费 `@earendil-works/pi-durable` 原样 API，升级时跟 changelog 的 Breaking Changes 走。

反向（安全区，上游 non-goals）：CRDT/offline 多写、session 级 rewindable documents、stable↔durable 会话互导（MAP "Not yet specified" 既有议题，上游无此计划）等——做这些不会与上游冲突，但要自担长期维护。

## 6. merge 基线建议

**当前态势**：`feat/durable-coding-agent` = `main` + 1 个 wayfinder 文档 commit（`080bddb1e`），代码 delta 为零；`main` 严格 ff 跟上游（fork 层约定，AGENTS.md:135）。**基线策略现在定，成本最低。**

1. **节奏：跟 release tag，不跟 main 日提交**。理由：tag 约 1–2 天一个但携带整理好的 changelog（Breaking Changes 先读）；main 日均 20 commits 且中间态多。实操：每次同步 = `git fetch upstream` → `main` ff 到最新 tag → merge 进 `feat/durable-coding-agent`。Experimental 期**间隔不要超过一周**（≈3–5 个 tag），否则 breaking 摊销一次处理的成本陡增；等 API 转稳定（changelog 无 Breaking Changes 数个版本）可放宽到双周。
2. **方式：merge，不 rebase**。理由：① fork 已有 ticket 驱动的多分支（research/r1–r3 → merge 回 feat），rebase 会改写已共享历史，且仓规禁 force push（AGENTS.md:72）；② merge commit 天然按 tag 分组，冲突解决逐 tag 可审计，配合 fork 层"上游文件实质改动须在 ticket 登记"（AGENTS.md:139）形成对账记录；③ 上游历史无整理负担，merge 无长期代价。
3. **冲突高危目录**（按风险排序）：
   - `packages/coding-agent/src/experimental/durable/**`——上游 10-01 新建、持续改动，也是我们的主战场。缓解：**新增文件优先于改上游文件**（如我们的 runtime/tui 增强放新文件，靠 export 组合），必须改上游文件时小步 + ticket 登记；
   - `packages/coding-agent/src/experimental/services/**`——`48dd1e2f0` 大改过，navigate/subagent TODO 落地时必动；
   - `packages/durable/src/harness/**`（context.ts/scheduler.ts 在 v1.1.0 各改百行级）——**原则上不改**，缺能力走 extension/hook 面（`ToolExecutionApi`/`HookApi`，v1.1.0 还加了 `.models`），实在要改必须 ticket + 期望尽快上游化；
   - 零冲突区：`docs/research/`、`wayfinder/`、fork 新增目录。
4. **升级仪式**：每次 merge tag 后，diff `packages/durable/CHANGELOG.md` 的 Breaking Changes 段 + `packages/durable/docs/spec.md`（normative，v1.1.0 内改动 14 行）对照我们的使用面；spec 与 `test/chord-guide.test.ts` 同步演进（pico-v5-chord-usage.md:4-5），行为疑义以 spec 为准。
5. **"何时重新评估"**：出现以下信号即回到本 ticket 重审基线——上游新开 pico/Pico6 设计线（目前无）、pi-durable 脱离 Experimental、或 `experimental/durable` 被提升为正式 `pi` 执行路径（那将改变整个 fork 前提）。

## 7. 证据索引

- 设计链 commits：`e045ed2f3`、`99a3948c4`、`46b66c59a`、`56cd5989e`、`729d5cb74`、`080160162`、`b5ef419d5`、`7c696c00f`/`481c7232f`/`cbe7cf00b`
- 落地 commits：`3883fcb1f`、`445770e03`…`49683a364`（Package 16–23）、`5609b0d6c`、`48dd1e2f0`、`7fd478a2e`、`70eceaade`、`4748c627a`、`a84510819`、`68c22123b`、`da866ada1`
- 文档：`packages/durable/docs/spec.md`（4747 行，normative）、`pico-v5-handoff.md:10-14`（Status）、`chord-delta-findings.md:3-19,347-358`、`pico-v5-chord-usage.md`（与 `test/chord-guide.test.ts` 同步）、`packages/durable/CHANGELOG.md`、`packages/coding-agent/src/experimental/services/README.md`（TODO 表）、`packages/coding-agent/src/experimental/durable/README.md`（Not here）
- 已删除（读法 `git show 7fd478a2e^:<path>`）：`packages/agent/docs/{harness.md,pico2.md,pico-v3.md,post-wp05-roadmap.md,work-packages/00–08,mobile-handoff/}`
- 节奏数据：`git tag --sort=-creatordate`；`git rev-list --count v1.0.0..HEAD`（142）；`git rev-list --count v1.0.0..HEAD -- packages/durable packages/coding-agent/src/experimental`（39）；`git log --format=%ad --date=short v1.0.0..HEAD | sort | uniq -c`
