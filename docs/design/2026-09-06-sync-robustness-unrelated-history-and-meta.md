# 同步健壮性改造方案：无关历史防御与 meta 文件同步策略（提案）

> 状态：**提案，待拍板**。2026-09-06 由真实事故驱动：本机 topics bundle 与远端（fan56/dsh-wiki-memory）谱系断裂 3 天（09-04 起 pull 全 abort、push 永不到达），当日已手工解锁（rebase --onto + JSONL 并集，见 §1 案例三），但插件层对同类故障仍然裸奔。
> 日期：2026-09-06。关联：ADR 0003（bundle git 化、pull/push 纪律）、ADR 0013（rename 迁移——案例二的直接成因）。本次发版已并入的止血项：`store.setConflicts` 过滤非 topic 路径（P3）、depends 形态容错与启动修复（okf `unwrapTopicRef` / `BundleStore.repairDepends`）。

## 0. TL;DR

同步层的三个结构缺陷在三天里造成三次真实 wedged：

1. **无关历史不设防**——`pullRebase` 不区分「真内容冲突」和「谱系断裂」，后者表现为每次会话启动静默 abort 的死循环，用户侧唯一可见症状是 `/topics status` 里一条来自 conflicts.json 的垃圾路径；
2. **meta 文件随谱系同步**——observations/injections/opens 是 per-machine 诊断日志，却被 git 谱系要求双侧机器「合并」，而它们被双侧追加+整文件重写（markDistilled、compaction），rebase 必撞；
3. **派生文件入谱系**——index.md / backlinks.json 双侧都会重建，跨机必冲突。

推荐组合：**P1 pullRebase 增加无关历史探测（fail-loud + 结构化错误）+ `/topics sync repair` 人工引导**；**P2 meta/*.jsonl 与 derived 文件移出 git 追踪（per-machine 定位）**；P3 已修。两项都不动 push 侧纪律。

## 1. 事故史（全部有据可查）

| # | 日期 | 根因 | 症状 | 终局 |
|---|------|------|------|------|
| 一 | 09-01 | 双 init：插件自建本地仓（root 2d5f06f）+ 仓库外另一身份手工 init 推送远端（root 404cd58）→ 无关历史 | `pull --rebase` 死循环 7 次（reflog 证据）；`/topics status` 显示「冲突：index.md」（实为 conflicts.json 记账，非 git 冲突） | 09-02 用户批准 force push 对齐（见 topic：`dsh-llmwiki-同步冲突根因远端-init-与本地历史无共同祖先`） |
| 二 | 09-03 | ADR 0013 rename 迁移重建 bundle（新 root 404cd58）→ 再次与远端无关 | 09-04 06:32 起 pull 全 abort（reflog）；本地 34 提交从未推出；远端被**另一台机器**继续推进（geo/spring-data-redis 系列，+28 提交） | 09-06 手工解锁：`rebase --onto origin/main --root`，meta JSONL 并集（id 去重、按 `at` 排序），5 个空重放提交 skip，本地 29 提交 + 2 修复提交全部推上 |
| 三 | 09-06（解锁中发现） | 另一台机器自己的冲突处理把带 `<<<<<<<` 标记的内容留在了蒸馏产物正文里 | 数据卫生问题（无功能影响） | 本机侧无需处理；证实**多机写入是真实常态**，不是理论场景 |

案例二的手工解锁全程可复盘：备份于 `/tmp/topics-backup-preunlock`；本地/远端 topic 文件零交集（交集仅 6 个 meta/派生文件）是重放可行的前提，属运气而非设计。

## 2. 问题清单与代码接缝

### P1 无关历史不设防（高）

- 接缝：`git.ts:157-172 pullRebase`——失败后 `diff --name-only --diff-filter=U` 收集冲突路径即 abort；`sync.ts:55-73 pull()` 把 `conflicted` 原样入库。
- 缺陷：`git merge-base HEAD origin/main` 为空（谱系断裂）与「远端改了我改过的文件」（真冲突）走同一条失败路径。前者 rebase 重放本地全部历史，怎么解都解不完；插件唯一的应对是 abort + 记账 + 下次再来，形成静默死循环。
- 次生污染：conflicts.json 记账的是 abort 时未合并路径（含 `meta/observations.jsonl` 这类非 topic 路径）——**本发版已在 `store.setConflicts` 过滤**，但「把失败原因显示为一条冲突路径」的语义混乱仍在。

### P2 meta JSONL 随谱系同步（高）

- 接缝：`store.ts` observations/injections/opens 三个 JSONL 的 append / 整文件重写（`markDistilled`、`compactInjectionsIfNeeded`）；`sync.commitMeta` 定期提交整个 `meta/`。
- 缺陷：JSONL 是 per-machine 诊断日志（本机的注入轮次、本机的观察流），却要求跨机 git 合并。双侧都在文件尾追加 → 每次跨机 pull/push 都是 rebase 雷区；`markDistilled`/compaction 的整文件重写更使三方合并必然失真。本次解锁的 516 行并集里两台机器的观察已混在一起，无法区分归属。
- 案例一的「远端 init」正是有人在仓库外手工 init 推送造成谱系断裂——meta 越重，断裂的修复成本越高。

### P3 conflicts.json 记账污染（已修，随本发版）

`store.setConflicts` 现在只收 `topics/*.md`；`git diff --diff-filter=U` 抓到的 meta 路径不再入库，`/topics status` 不再显示伪冲突。存量垃圾由下一次成功 pull 的清账路径（`sync.ts:67-68`）或手工置空处理。

### P4 派生文件入谱系（中）

index.md / backlinks.json 由每次 topic 写入在本机重建（write-through，ADR 0003），跨机必然冲突。本次手工解锁的策略是「重放时取本地、落地后由 `repairDepends` 触发整体重建」，属一次性绕过，非机制。

### P5 空重放提交（低，不单独立项）

谱系对齐类操作会产生空重放提交（本次 5 个，`rebase --skip` 处理）。P1 的探测 + 人工一次性对齐落地后，插件自身的 pull 不再需要处理此形态。

## 3. 方案

### P1：pullRebase 无关历史探测 + repair 引导（推荐 A）

**A（推荐）**：`pullRebase` 在失败路径先查 `git merge-base HEAD <remote-branch>`——为空则返回结构化结果 `{ ok: false, kind: 'unrelated-histories' }` 而非 `conflicted` 列表；`sync.pull()` 把它翻译成可操作的错误信息（`/topics status` 的同步错误行 + `/topics sync` 输出）：说明「本地与远端无共同祖先，需要一次性对齐」并给出两条人工路径（以远端为准 rebase 采纳 / 以本地为准 force push，**均需用户拍板**，插件绝不自动 force）。
**B（否决）**：自动 `merge --allow-unrelated-histories`——等于让插件自动做「保留谁的记忆」这个破坏性决定，案例一/二的教训是这类决定必须人工拍板。

### P2：meta 文件移出 git 谱系（推荐 B）

**B（推荐）**：`meta/observations.jsonl`、`injections.jsonl`、`opens.jsonl`、`distill-state.json`、`backlinks.json` 加入 bundle 的 `.gitignore`（`git rm --cached` 一次性迁移提交）。依据：这些是 per-machine 诊断/派生数据，跨机合并既无语义（两台机器的观察流混为一谈）也不可三方合并（整文件重写）。`ensure()` 已具备缺失重建能力（index/backlinks），distill-state/conflicts 缺省即空，均无需迁移逻辑。代价：`/topics stats` 等口径变为「本机口径」——本就应该是本机口径。
**A（备选）**：`.gitattributes` 对 `meta/*.jsonl` 标 `merge=union`——改动最小，但只在「冲突时」并集，`markDistilled` 的非冲突整文件重写仍会静默丢对侧行，且去重/排序仍需应用层兜底。不推荐作为终态，可作为 B 落地前的临时减压。
**C（开放问题挂起）**：`meta/<host>/*.jsonl` 按机器分目录——若未来产品语义要求「观察（蒸馏原料）跨机漫游」，选这条；前提是先回答开放问题 §5-1。

### P4：随 P2 一并解决

index.md / backlinks.json 一并 `git rm --cached`；缺失时 `ensure()` 重建（已实现）。bundle 里真正需要跨机的只剩 `topics/*.md` + `index.md`（要不要连 index 一起退场见 §5-3）。

## 4. 迁移与兼容

- P1：纯代码，无数据迁移；对已对齐的 bundle 无感（merge-base 非空走原路径）。
- P2：需要一次性迁移提交（`git rm --cached meta/*.jsonl …` + `.gitignore`）；已发旧版本插件 pull 到该提交不受影响（git 层行为）。多机场景需两台机器都升级后再做迁移提交，否则未升级侧会把 meta 文件重新加回追踪——迁移提交信息里写明这一点。
- 回滚：bundle 自身 git 化，`git revert` 迁移提交即可恢复追踪。

## 5. 开放问题（拍板时一并定）

1. **观察流的产品语义**：蒸馏原料（observations）要不要跨机漫游？漫游 → P2 选 C；本机自产自销 → 选 B。当前实际使用（516 行两机混合）是 B 未落地前的意外态，不是设计态。
2. **force push 的合规出口**：案例一、二的修复最终都是人工 force push。要不要在 `/topics sync` 提供 `repair --force-with-lease` 一类引导命令（保留远端不被覆盖的安全检查），还是维持「用户自己敲 git」？
3. **index.md 的去留**：若 P2 落地，index.md 是唯一的 bundle 内派生文件——退场（ensure 现场重建，bundle 只剩知识本身）或保留（人类浏览 GitHub 仓库时有用）。
