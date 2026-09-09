# Changelog

## 0.13.1 (2026-09-09)

内置 skill 改名：`dsh-topics-memory` → `dsh-topics-memory-config`（生态统一 `-config` 后缀）。skill 为进程内注册、包外零落盘，升级即自动迁移——更新包并重启 dsh 后新名生效，无手工清理项。

## 0.13.0 (2026-09-08)

随包发布「使用与配置指南」skill（dsh 插件生态统一改造，对齐 dsh-vault / dsh-llm-proxy 同款机制）：

- **内置 skill `dsh-topics-memory`**：`skills/dsh-topics-memory/SKILL.md` 经 `ctx.skills.registerProvider` 随包发布（`inject` 顶层加 `skills` seam），内容为中文使用与配置指南——`topics:` 段全部 23 个键、/topics 命令族速查、`ask_user_question` 首次配置向导（存储模式 / 蒸馏模型路由 / 注入档位 / 自动观察）、pointer/digest 注入形态与排障。模型可按触发词（topics、记忆、蒸馏、llmwiki 等）自动路由读取，用户也能显式唤起。
- **防漂移测试**：`test/skill.test.mjs` 断言 provider 注册形态、frontmatter `description` 与代码内硬编码 `SKILL_DESCRIPTION` 逐字一致（≤500 字符路由预算）、`stripFrontmatter` 的容错语义——指南文案与包内文件不再可能各自漂移。
- **打包与依赖**：`files` 加 `skills`（skill 正文随 npm 包分发）；新增 optional peer `@deepseek-ai/dsh-skill`（`>=0.1.2-rc.1`，devDeps 同步钉版）；现有测试的 mock ctx 补 `skills.registerProvider`。
- **README 修正（en/zh 配置表）**：补齐缺失的 `suppressEcho` / `injectMode` / `qualityLane` 三键；`includeSubagents` 默认值 `true` → `false`（代码自 0.7.0 起即为 false，文档漏改），「已知边界」的同款错误表述一并改正。
## 0.12.0 (2026-09-08)

统计/状态类命令输出全面 markdown 表格化（TUI 对含 GFM 分隔行的命令输出自动切 Markdown 渲染，`/topics list` 的表格已在 0.11.0 验证渲染效果）：

- **`/topics list` 加 `#` 序号列 + 最新优先 + 100 条封顶**：表头变 `| # | Slug | 标题 | 状态 | 标签 | 更新 |`；排序从 slug 序改为 `generated.at` 降序（store 每次写 topic 都重盖该戳，即更新时间；同戳以 slug 稳定）；超过 100 条只显示最新 100 行，末尾以「… 其余 N 个更早的 Topic 未显示（/topics show \<slug\> 直达）」提示，总数仍在表头。
- **`/topics status` 表格化**：`字段/值` 两列表，复合行（draft/stable/deprecated、注入参数、蒸馏路由）语义不变；路径头行与条件行（最近蒸馏 / 上次推送 / 同步错误）保留，仅出错时出现的行仍条件出现。
- **`/topics stats` 表格化**：概览指标进 `指标/值` 表（hit rate、零命中轮、平均命中、预算占用、慢道参与轮、指针打开率、回声抑制，条件行照旧条件出现）；Top-N（Slug/注入次数）与 Near-miss 分布（分数段/次数）各自成表；调参 hint 保留在表外。
- **`/topics history` 表格化**：`Hash/时间/变更/当时的结论` 四列表，无结论以 — 占位，`└` 次行结构并入结论列。
- **`/topics config` 表格化**：`配置项/值` 两列表，键名仍是 displayKey（kebab-case）。
- `/topics show`（文档阅读页）、`/topics graph`（HTML 关系图）、onboard 向导与操作类结果不表格化——它们不是统计清单。
- 测试 262 → 263：list 序号/最新序/截断+溢出提示（102 条夹具，1ms 间隔保证 generated.at 严格递增），status/stats/history 断言随新格式重写。

## 0.11.0 (2026-09-08)

注入价值审计落地（2026-09-08 审计：40% 有帮助率，三大发现各对应一项修复）：

- **修 `topic_open` 的 INVALID_TOOL_OUTPUT（审计发现 #2 的根因）**：宿主工具输出校验把任何含 undefined 值键的对象判为非 lossless JSON；无 description 的 topic 每次 open 都会报错（审计 ②⑦ 的实锤路径）。`openTopic` 现在省略而非以 undefined 传可选字段（description；`topic_history` 的 conclusion 同修），输出以宿主同款 `isJsonValue` 断言钉进测试。
- **`topic_open` slug 归一化（审计 ⑨）**：指针渲染为 `(topics:<slug>)`，模型会整段复制回来当参数；现在经 `unwrapTopicRef` 解包（`topics:` / `topics/` / `.md` 均容错）后再过写路径同款 `slugify` 折叠大小写——只解包不折叠会在大小写敏感的 bundle（Linux）上漏掉已存文件（CI 首轮发版抓到并修复），open 流水记录干净 slug。
- **蒸馏回声抑制（审计发现 #3，新配置 `suppress-echo`，默认 on）**：本会话蒸馏出的 topic 不再回注同会话——provenance 走 observations 日志的 `sessionId → distilledInto`（`TopicsService.echoSlugsSync`，mtime 缓存），快/慢两道都滤，ilog 新增 `echoed` 字段、Top-N 与指针打开率分母均不计回声，`/topics stats` 增「回声抑制」行。
- **慢道 produce 侧排除已携带 slug（审计 dedup×2 空转的根源）**：`dispatch` 新增 `exclude`（会话已注入 ∪ 回声集），候选带先滤后切（过采样 6 补位）——旧路径会把注定被消费侧 dedup 吞掉的候选送进 rerank，白烧一次 aux 调用并产出一个必死的 pending。
- **快慢双包修复**：消费轮中慢道 pick 若恰为快道命中，此前会打包成第二个重复块；现在计入慢道交付（`record.slow` 照记、lane 仍为 mixed）但不再重复渲染。
- **慢道 ttl×1 归因（不改行为）**：pending 产出（turn/end）与下一 spliced 间隔超 10min TTL——交互间隙的正常硬界，非缺陷；过期已入 ilog（`slow-expired-ttl`）。
- **`/topics list` 改 markdown 表格**：列 = Slug（反引号，可直接复制给 show/history）/ 标题 / 状态 / 标签 / 更新（仅日期）；单元格内 `|` 转义、换行拍平，仍按 slug 排序。
- 测试 254 → 262：open 解包/lossless、history lossless、echoSlugsSync 分组与缓存重建、echo 过滤与 ilog、exclude 优先级、慢道 exclude 带过滤、双包单渲染、list 表格精确行断言。

## 0.10.0 (2026-09-08)

退出/启动同步时机改造——消除宿主进出时最长可达数十秒的网络等待（实测本机 git 双程 8s + 退出蒸馏共享 90s 有界窗口）：

- **退出路径本地化**：插件卸载的 disposer 不再执行 `flush()`（pull --rebase + push 全是网络），也不再有退出蒸馏的有界等待；只做一步**本地 meta commit**（observations / injections / distill-state 落盘），窗口从 `EXIT_DISTILL_TIMEOUT_MS = 90s` 收窄为 `EXIT_COMMIT_TIMEOUT_MS = 10s`（只防病理性 git 卡死，正常毫秒级）。被跳过的退出蒸馏改为 fire-and-forget——observations 本就是 write-through 落盘，跑不完也不丢活。
- **启动补推**：`sync.pull()` 在 rebase 成功后检查 `unpushedCount`，>0 即补推——上一次退出推迟的 push 在这里落到远端；失败只记 `lastError`，由后续 debounced flush 或下次启动重试。
- **启动补蒸馏（boot-replay）**：session-start 的 pull 链完成后检查未消化 observations，非空则请求一次蒸馏（`distiller.request` 新增 `boot-replay` 触发原因，含与 observer 回调同构的 trigger-time llm capture）；空池零开销，不健康的模型路由落 distill-state 失败记录。
- 导出常量更名 `EXIT_DISTILL_TIMEOUT_MS` → `EXIT_COMMIT_TIMEOUT_MS`（90_000 → 10_000）。
- **pullRebase 挂上兜底 git 身份**（补全 addAndCommit 已有的既定设计）：rebase 重放本地 commit 需要 committer 身份，无全局 git 配置的环境（CI、新机器）此前会在每次 pull 时失败且冲突列表为空；同时 `sync.pull` 失败信息在无冲突文件时携带 git 输出尾部（原「未知路径」不可诊断）。
- 测试 251 → 254：退出 disposer 不等蒸馏（<慢模型时延即返回）、boot-replay 正（遗留被消化）/反（无积压不发请求）两例、pull 补推（本地领先 + 远端前进 → rebase 后一次推平）；harness 修正为驱动全部 session/event handler（apply 注册两个，此前只驱动第一个）。
- 关联：`docs/design/2026-09-06-sync-robustness-unrelated-history-and-meta.md`（同步健壮性提案）与本次改动正交——该提案管「同步的正确性」（无关历史防御、meta 移出 git），本次管「同步的时机」；退出不再 pull 还顺带减少了 P1 所述静默 abort 死循环的触发点。

## 0.9.0 (2026-09-06)

- depends 双重包裹修复四件套：OKF `unwrapTopicRef` 容错解包（`topics/foo.md` / `[[foo]]` / 包裹一层的引用统一归一）、写路径归一化（`saveTopic`/distill create 落盘前剥包裹）、启动修复（`BundleStore.repairDepends` 扫描存量坏档并回填备份）、冲突标记过滤（`store.setConflicts` 只收 `topics/*.md`，git abort 抓到的 meta 路径不再入 `/topics status`）。
- 检索注入的代码段剥离：inject/digest 渲染不再携带结论正文里的 fenced code block（压预算）。
- 同步健壮性设计提案入库（`docs/design/2026-09-06-sync-robustness-unrelated-history-and-meta.md`，待拍板）。
- 测试 240 → 251。

## 0.8.1 (2026-09-05)

- 退出 flush 纳入有界窗口：卸载时的最终 meta 提交 + 账本 flush 此前是 fire-and-forget，会输给它本要赢的退出竞态；现在与退出蒸馏共享同一个 `settleBounded` 窗口。
- 干净卸载：两份 README 增加「卸载」节（移除命令 + `~/.dsh/topics` / settings 残留清单），boot smoke 增加卸载腿（`dsh plugin remove` 后断言组合树还原），并补上缺失的 `smoke` npm script。

## 0.8.0 (2026-09-03)

- 依赖整体迁到 dsh rc/stable 线（0.1.2-rc.1 闭合，alpha 线退役）：peerDependencies 地板 `dsh-tools`/`dsh-llm`/`dsh-settings`/`dsh-commands`/`dsh-util-values` 由 `>=0.1.2-alpha.4` 提到 `>=0.1.2-rc.1`；devDependencies 15 个 `@deepseek-ai/dsh-*` 精确钉版 `0.1.2-alpha.4` → `0.1.2-rc.1`（cordis/schemastery 不动）。CI 与 release 的 dsh 闭包改为运行时解析 `latest`/`next` 中更新者、永不 `@alpha`（该迁移已在 0.7.0 前的 main 上先行落地，此处一并归档说明）。
- README 支持声明改为 rc/stable-only：`Requires dsh >= 0.1.2-rc.1`，本插件只跟随 dsh RC/stable 线，不再支持 alpha 线（旧声明的「rc 线不再支持」方向相反，已纠正）。

## 0.7.0

双通道注入改造（设计定稿 `docs/design/2026-09-03-dual-channel-injection-v4.md`，ADR 0014，amends 0004/0006/0011）：

- **快道结构门 v0**：数字阈值改作用于 gateScore（剔除 recency），并要求结构证据——强字段（triggers/title/slug）任一命中，或 ≥2 个不同查询词命中正文；tags 不再是强字段。被门挡下的候选以 `gate-blocked` 进 near-misses。tag-boost 总上限 0.45→0.15（共享 tag 不再自行翻阈值，priming 主犯拆除）；recency 降为纯排序 tiebreaker。图扩展豁免结构门。`topic_search` 工具路径不受门限（显式召回优先）。
- **triggers 字段**（OKF 可选 frontmatter）：检索权重最高（×5）、算强字段；distill 的 create ops 产出（prompt 已教）、`topic_save` 可直填、service 更新时保留既有值；旧 bundle 无此字段降级不命中。解析容错：非字符串项过滤而非抛错。
- **pointer 注入形态**（默认）：每条 = `### title [status] (topics:slug score)` + description 一行（缺失回退结论首句），单条 ≤80 tok；总预算 = `min(total-budget, 600)`——旋钮可下调，上界锁 600。`inject-mode: digest` 保留完整旧渲染（300/1500）回退。零命中零注入、injectDedup、预算丢弃不进 registry 等纪律不变。
- **`topic_open` 工具**：按 slug 拉全量结论/待决/建议，首部带 staleness 提示（快照于 generated.at）；调用流水写 `meta/opens.jsonl`，`/topics stats` 增「指针打开率」（opens/注入条目）。
- **慢道质量 lane MVP**（`quality-lane: off | sampled | always`，默认 sampled 1/3）：`turn/end` 触发，数据源只有 observer 的 last-K ring buffer（K=3，深拷贝访问器）；两次串行 aux 调用（复用 distill 路由）——意图查询构建（verbatim priming 从根上消灭，粘贴内容记入 `stripped[]`）→ 词法候选带（关结构门，hits+near-misses）→ LLM 门禁重排放行 0-2 条带 why 行。pending 按 session 存放，下一个 steer message 的 spliced 与快道同预算合并注入，**消费即清**；TTL 10min、turn-lag ≤2、单调用 20s、管线 45s 硬界，过期记 `slow-expired-*`。生命周期：turn/end 产、下一 spliced 消、session/end-seed 与双 disposed 清、turn/start 不动 pending（ADR 0014 生命周期表）。子 agent 会话写死不跑（isDelegated 守卫，不挂 includeSubagents）；distill run in-flight 时让位；sessionLlm 捕获释放守卫纳入慢道 in-flight。
- **shadow 重门**（log-only）：消费时对慢道 picks 按当前输入做词法结构门复判，只记录进 ilog `shadowVerdict` 不拦截（回指短句零强字段命中不被系统性误杀）；P3 数据回填后再议转正。
- **ilog lane 字段族**：`lane: fast|slow|mixed`、`computedAt/consumedAt`（赶上率）、`shadowVerdict[]`、`queryBuild{rawChars,keptChars,stripped[]}`、`slowModel/slowMs`、`slow[]`；`/topics status` 增注入模式与慢道状态行，`/topics stats` 增慢道参与轮与赶上中位时延。
- **doc-unreadable 记账**：命中但文件读不出（解析坏档）的 slug 此前会从 included 与 dropped 双账本消失（v4 设计 §2 疑点），现以 `dropped: [{slug, reason: 'doc-unreadable'}]` 入账。
- **默认值变更**：`includeSubagents` 默认 true → false（ADR 0011 修订；显式配置不受影响）；新增 `inject-mode`（默认 pointer）与 `quality-lane`（默认 sampled）配置键。
- **结构门回放标定**：`scripts/replay-structural-gate.mjs`（只读）遍历存量 injections.jsonl，从 reasons 重构门判定，输出逐条对照与 0.20–0.45 阈值扫描；存量 `tags:` 理由混合 slug+tags 不可拆，按弱字段保守处理。
- ADR 0014 新增（五不变式 + pending 生命周期表 + 结构门/慢道/观测决定）；ADR 0004/0006/0011 标注修订。
- 第四轮 review 修复（APPROVE-WITH-NITS 的七项 P1 全数落地）：`autoInject: off` 时慢道不再产出（否则每个采样轮白烧 2 次 aux 调用、pending 永无人消费）；distill 每轮节拍触发移到 observer turn/end 首个 await 之前（否则 `%15` 撞车场景的慢道让位确定性失效）；慢道管线结算钩子接入 sessionLlm 释放（否则销毁事件落在管线窗口内时捕获条目永久滞留）；消费/过期的 pending 在快道早退路径（roster 清空等）也落 ilog 痕迹（`slow-no-roster`）；过期标记改 `slowExpired` 独立字段——不再被快道恰好注入抢掉可见性，消费过 pending 的轮 `lane` 必落值；`gate-blocked` 的 reasons 随 near-misses 持久化（P3 门槛回放证据）；图扩展衰减改从 gateScore 起算（recency 不得借图通道回流门槛）；manualDistill 的释放守卫统一走共享 helper；测试清理钩子改为容忍在途写盘的重试删除（消灭 `rmSync` ENOTEMPTY 偶发红）。
- 测试 207 → 240：结构门（强/弱字段、recency 界、图扩展豁免、工具路径）、pointer 渲染与预算 clamp、triggers round-trip 与容错、ring buffer K=3、慢道单元（守卫/消费即清/过期/去重/校验/错误遏制）、service 级合并（lane 字段族/shadow/dedup/混合轮/gate-blocked 入账）、index 级 wiring（turn/end 产 → 下一 spliced 消、autoInject off 全关）。

## 0.6.0

- 插件更名：`dsh-llmwiki-memory` → `dsh-topics-memory`（npm 包 `@aiwayds/dsh-llmwiki-memory` → `@aiwayds/dsh-topics-memory`；插件 id、git identity、蒸馏 purpose 标记、关系图标题等同步）。命令族 `/wiki` → `/topics`，settings namespace `llmwiki` → `topics`，数据目录 `~/.dsh/llmwiki` → `~/.dsh/topics`，覆盖环境变量 `DSH_LLMWIKI_HOME` → `DSH_TOPICS_HOME`。OKF 格式的 `[[wikilink]]` 语法与外部项目（zosmaai/pi-llm-wiki、chancelu/dsh-llmwiki 等）提及不受影响。
- 默认数据仓名建议值 `dsh-wiki-memory` → `dsh-topics-data`（延续「数据仓名 ≠ 插件源码仓名」原则，ADR 0002/0009/0013）。
- 发布顺序依赖（ADR 0013）：release.yml 的 `github.repository` gate 改成了新仓名——**必须先 `gh repo rename dsh-topics-memory` 改掉 GitHub 仓名，再推 v\* tag**；改名前推 tag 两个 job 会静默 skip，且已消费的 tag 事件不会因事后改名而重触发（唯一 remedy 是删 tag 重推）。新包发布后对旧包 `npm deprecate @aiwayds/dsh-llmwiki-memory`（message 指向新包名）。
- 一次性自动迁移（ADR 0013，两条路径，均 fail-open）：
  - 数据目录：未设 `$DSH_TOPICS_HOME` 时，若新目录不存在而旧 `~/.dsh/llmwiki` 存在，启动即 rename 旧 → 新；rename 失败回落旧路径继续服务，回落前复查新目录是否已被并发 boot 建出（竞态下必须跟进而非钉死在已被移走的旧路径）。显式设置 `$DSH_TOPICS_HOME` 完全绕过迁移。
  - settings namespace：启动时把旧 `llmwiki` namespace 里用户调过的键（值 ≠ schema 默认值）一次性写入新 `topics` namespace；新 namespace 已有用户配置（含此前迁移结果）即天然幂等不再触发；检测到旧版 dsh-llmwiki-memory 仍在运行（`llmwiki` 已被注册）时打醒目 warn 并跳过迁移，避免双载静默脑裂（ADR 0013）；legacy 读取（注册旧 namespace）与写入的任何异常都只跳过迁移、不影响插件启动。

## 0.5.0 (2026-09-02)

- 吞吐：`distillMaxModelCalls` 默认 3 → 8。预算 3 次时每个 run 只消化 9–14 条观察，清 300 条积压要 20+ 个 run；批循环之下 8 次一轮可消化约 30–40 条（清积压场景的默认值，显式配置不受影响）。
- 观察 GC：被模型实际评估（返回可解析应答）却未被任何 op 消费的观察记一次 failed attempt（`attempts` 计数，store 层 `recordUnconsumed`，与 markDistilled 同一持久化队列），连续 3 次（`OBSERVATION_MAX_ATTEMPTS`）即物理删除（用户已授权删除 lane 明确无法处理的观察数据）。删除数写入 distill-state detail（`gc: dropped N unprocessable observation(s)`）、state 文件 `gcDropped` 字段与 run 结果；删除发生时立即 commit（数据销毁必须 git 可追溯），纯计数沿用 flush 节奏。被消费的观察经 markDistilled 自然退出候选池、不参与计数。
- 会话退出赛跑：插件 disposer 现在等待退出触发的末次蒸馏落盘后再返回——有界等待，上限 90s（挂死的模型调用不会拖住宿主退出；cordis 卸载会 await async disposer）。此前 fire-and-forget 使该路径基本无效：进程退出必然赢下竞速，state 与 marks 常常来不及写。README 已知边界同步更新。
- 新命令 `/wiki distill`：手动触发一次蒸馏 run——复用现有 lane、in-flight 守卫与触发时 llm 捕获（命令所在会话的 agent 作用域实例优先）。输出摘要与 distill state 字段一一对应（标记 N 条 / 新建 X / 更新 Y / GC 回收 Z / reason / detail）；观察池为空直接提示 no-observations、不空跑 lane；未接线、模型未配置、已有 run 在跑均给可读原因。
- 修复蒸馏 100% 失败（NO_ADAPTER 写进 distill-state）的三个根因之一——lane 在无适配器的实例上执行：
  - 触发时按会话捕获真正的 llm 实例（会话事件、`agent/inbox/spliced`、`agent/disposed` payload 在作用域解绑前），按 `sessionId` 传入 lane，并发会话不再互相覆盖。
  - `pickLiveLlm` 预检收紧为「必须探测到匹配路由」：无 `listProviders` 的实例不再被信任（无法证明适配器在场），探测失败仍给可读中文错误（无路由 / 无实例两种场景）。
  - 兜底防线：stream 阶段逃逸的 `NO_ADAPTER`（code 或 message）重抛为可读的双语失败（点名路由与原因），distill-state 不再落裸 `no adapter registered for provider`。
- 修复会话结束触发是死分支：`agent/disposed` 不在 dsh-session 0.1.2-alpha.4 的 `SessionEventMap` 事件全集里，原先挂在 `session/event` 上的 `event.type === 'agent/disposed'` 分支永远不会 fire；`session/end-seed` 只在 restore/resume 时发，被误当「会话结束」。改为订阅真实销毁事件（cordis 独立事件）：`agent/disposed`（payload `{agent}`，AgentRegistry 解绑时发）与 `session/disposed`（payload Session，store detach 时发）都接入 observer 的结束触发（单发去重，两个事件先后到达不重复触发）；`session/end-seed` 回归「恢复边界」语义（重置结束标记，不再触发蒸馏）。注入去重注册表改由真实销毁事件清除。
- 默认 `distillEveryTurns` 20 → 5（实测会话最长 8 轮，旧的每 20 轮 cadence 从未触发；会话结束触发修复后，5 轮给普通会话至少一次会话内蒸馏机会）。
- 修复会话级 llm 捕获的慢性泄漏（常驻宿主进程下 `sessionLlm` 每会话净增一份强引用）：蒸馏 run 结算即释放对应条目，teardown（`agent/disposed` / `session/disposed`）时无 in-flight run 也即时删除；两处删除均带 pending 守卫——不会误删 session-end 蒸馏要用的 payload 捕获，也不会误删本 run 结算窗口内下一轮重新捕获的新条目。
- 修复 YAML round-trip 损坏（生产 3 个 topic 文件各坏 1 行）：块列表项在判定 inline-map 前先做引号感知——成对单/双引号包裹的项视为 quoted 标量并剥离引号，不再被 `- "…: …"` 里的 `: ` 误判成 map；未闭合引号与原有无引号 `- key: value` map 语义不变。补单测覆盖 quoted/round-trip、unquoted-map、未闭合引号容错、全角冒号，以及 `okf.parseTopicDoc` 级别验证含 `id-token: write` 引号列表项的 frontmatter。
- 修复蒸馏批处理活锁（真机实测：每 5 轮精确触发、模型真实执行，但积压 200+ 时单批 40 条观察的 ops 输出超蒸馏模型输出上限，run 失败零 mark → 永远重试同一批判）。runInner 改为有界批循环：
  - 自适应批大小：输出上限失败（finish `max-tokens`/`length`，抛点盖 code 戳 `MAX_TOKENS`）自动减半批次重试（下限 5），同一 run 内即完成「40 败 → 20 成」逃逸，失败批次不再永远占住队头；缩小状态跨 run 保持，配置变更或插件重载才复位（无投机自增，避免每 run 重付一次失败调用）。新配置 `distillBatchSize`（默认 40）。
  - 单 run 模型调用预算：新配置 `distillMaxModelCalls`（默认 3），每次调用（含失败重试）都计数；预算耗尽即停，已成功批次照常 markDistilled，distill state 记 `partial: 已蒸馏标记 N 条观察（K 次模型调用）；…`——部分前进优于零前进。
  - 零消费停机：某批 ops 未消费该批任何观察（head 无法前进，重跑只会重复）即停本轮；`no-ops` / 非 max-tokens 失败同样终止本轮，`no-observations` / `no-ops` / `model-error` / `invalid-output` 语义不变。
- 修复观察零消费缺口（真机实测：蒸馏链路全通但 `marked: 0`、积压零前进——模型返回的 ops 缺失/编造 `observed_ids`，`markDistilled` 无 id 可标，同批观察永远重喂并重复产 topic）：
  - Prompt 硬约束：system prompt 明确要求每个 op 必须带 `observed_ids` 且只能逐字复制本批输入的观察 id（create 填综合依据、update 填修订动因），缺失/为空/含列表外 id 的 op 无效。
  - 执行前清洗：每个 op 的 `observed_ids` 先与本批真实 id 集合求交再执行；清洗后零有效 id 的 op 整体扣住不落 topic（无效 topic 写入正是 marks 无法入账、重跑重复的根源），无效 id 数计入 `filtered N invalid observed_ids`（部分有效时进 run detail）。
  - 一次纠错重试：整批零有效 id 时追加「合法 id 列表 + 逐字回显要求」再调一次模型，计入 `distillMaxModelCalls` 预算（无免预算通道；预算不足直接零消费停机）；重试仍零有效或调用失败 → 走 stalled 停机并在 detail 说明。
- GC 计数语义收紧（审查必改，数据销毁路径）：只有「模型确实给出可解析应答」的批次才计 failed attempt——fedIds 从「取批即记」移到「按 outcome 记」：调用抛错（网络/5xx 的 `model-error`）与输出不可解析（`invalid-output`）的批次不计；输出上限减半重试中尚未评估的批次不计（缩到下限仍溢出、no-ops、stalled、部分消费照常计数）。蒸馏路由未配置时 runInner 入口即以可读 `no-model` 短路（检查放在每次 run 而非接线时，`/wiki set distill-provider` 保持 live 生效）：不取批、不调模型、不记任何 attempt——三个 ECONNREFUSED run 从此不可能物理删除模型从未评估过的数据（此前实测 40 条观察 + 3 次连接拒绝 → 池清零）。
- 会话退出触发与在途 session-end run 互斥：disposer 触发 fake-'dispose' run 前先查 in-flight（`hasAnyPending`），有 run 在跑即跳过本次——此前真实会话的 agent/disposed 末次蒸馏还在跑时，退出 run 会把同一全局队头批次双份喂给模型（双重评估 + attempt 双计）。
- `/wiki distill` 的 manualDistill 在 request 被 decline（in-flight / 未配置）时同步释放本次捕获的 sessionLlm 条目（原来会留下无 settle hook 的无主条目）。
- `store.appendObservation` 改走全局写队列：与 markDistilled / recordUnconsumed 的整文件重写串行化，消除观察 JSONL 的丢更新竞态。
- `/wiki status` 新增「最近蒸馏」摘要行（读 distill-state：成功显示标记数/GC 回收数/时间，失败带 reason）——此前 README 声称 status 可查 distill-state 而 renderStatus 并未读取，属失实声明，现已成真。

- 适配 dsh 宿主 0.1.2-alpha.3，放弃 rc 线兼容（peer 要求 `dsh-llm`/`dsh-tools`/`dsh-settings`/`dsh-commands`/`dsh-util-values` >= 0.1.2-alpha.3；`cordis` ^4.0.2、`schemastery` ^3.18.2；devDeps 精确钉 alpha.3 闭包）：
  - settings 命名空间改字面量 `'llmwiki'`（dsh-settings 0.1.2-alpha.3 删除了模块级 `settingsNamespace()`，注册改类型级品牌校验）；运行时不再 require dsh-settings。
  - 蒸馏 lane 的 LLM seam 对齐 alpha.3 `GenerateOptions`：`deepFreeze` 改从 `@deepseek-ai/dsh-util-values` 动态导入（dsh-llm 不再转发导出）；`purpose` 是封闭联合（仅 `compaction`/`session-title`）与 `sessionId` 为 `Branded<'SessionId'>`（loop 请求路由/回放游标语义），后台蒸馏调用均不再传，插件内 `ModelRequest` seam 保持不变；9d03334 的蒸馏候选预检（pickLiveLlm）与防御性 finish 兼容原样保留，选出的路由走修好的调用形态。
  - observer 对非文本内容块（alpha.3 起子代理后续消息可带 image 块）显式按 text 过滤，并补测试锁定。
  - CI/Release 的真宿主 smoke 改装 `@deepseek-ai/dsh@alpha`（滚动 dist-tag）。
- Known limitation：观察 JSONL 的读取窗口是最新 2000 条，markDistilled / recordUnconsumed 的整文件重写只覆盖窗口内记录——窗口外的历史行会在重写时被截断（存量问题，本批不修）。
- distill-state 写入失败不再被静默吞掉：写入错误追加进 run 结果 detail（`/wiki distill` 输出立即可见）——marks 与 state 写入相互独立，此前写失败时消化照常、state 文件却停在旧值，看起来像「手动 run 从不写 state」。

## 0.3.0 (2026-09-01)

- 蒸馏模型 ask-user 选择流：`/wiki onboard` 的蒸馏一步拆成两问——先问 provider（选项来自 `llm.listProviders()` 的活路由 + 「暂不启用蒸馏（跳过）」，每题 ≤10 个 option），答完再问该 provider 的 model（`llm.listModels()` 目录取前 8，detail 注明共 N 个、Other 手输兜底；provider→model 有依赖，两次独立 ask）。答案写入 pending 批量，经 `resolveModelInfo` 预校验：NO_ADAPTER 阻断并在面板上提示重选（有界重试），非 NO_ADAPTER 失败（模型目录外，可能仍可用）则警告放行（确认面板 detail 标注 ⚠️）。ask 面板或可用模型路由缺失的环境整体退回原文本向导（零新路径）。
- `/wiki set` 交互式设置蒸馏路由：`/wiki set distill-provider` / `distill-model` 不带值且有 ask UI + 可用 llm 目录时弹对应单题面板（distill-model 先读当前 distill-provider 作为目录来源，未配 provider 提示先配）；带值仍走文本路径；取消/空答案零写入。面板选项与 onboard 主流程同级预校验（provider 须在活路由表中，model 经 `resolveModelInfo`——NO_ADAPTER 阻断重选，目录外警告放行）；面板不可用时返回错误提示、不再静默清空键值。
- 修复 `/wiki set distill-model` 混写脏值根源：值形如 `provider model`（空格）或 `provider/model`（斜杠）时自动拆分并同时写入 `distill-provider` + `distill-model` 两个键（输出明确说明写了两个键），纯 model 名只写 `distill-model`；`distill-provider` 只接受单段（拒绝空格/斜杠）。拆分覆盖已有的不同 distill-provider 时输出 ⚠️ 覆盖提示。
- 蒸馏选择面板的 llm 目录改为双源候选：`/wiki onboard` 与 `/wiki set` 依次探测会话级捕获实例与 apply 时 root 实例（与蒸馏 lane 共用同一 probe walker），取第一个 `listProviders()` 非空的实例——root 无适配器不再挡住可用的会话实例；均不可用时按场景提示（无可达实例→「本机未检测到可用模型路由」；有实例但列表空→「llm 服务在，但本机没有已启用的模型 provider」）。
- 修复蒸馏 lane 在已释放会话作用域上的死实例调用：调 stream 前对候选实例（`llmRef.scoped` → `llmRef.root`）做廉价预校验——`listProviders()` 含 route.provider 的第一个实例胜出，作用域已释放（访问即抛）或不含该路由的实例跳过；全部不可用时不再把裸 NO_ADAPTER 写进 distill-state，而是记为 `model-error` 并按场景给可读中文 detail：有实例但均不含该路由→「distill-provider «X» 没有匹配的模型路由（检查拼写或本机 provider 配置），等待下次会话启动重试」；无可达实例→「没有可用的模型服务实例」。
- 防御性兼容 `BlockAssembler.finish` 的字符串/对象两种形状：本机各 dsh-llm 副本与 harness 源码 assembler.ts:185-188 均为 `{kind:'stop'}` 对象，裸字符串形状未在任何已知版本观测到；此兼容未见实际触发，仅防御未来形状漂移。
- 会话级注入去重：新增 `inject-dedup`（默认开）——同会话已实际注入过的 Topic 不再重注（runtime-context 快照与旧内容逐字节相同时不追加、一变旧快照留底，重注近乎纯冗余）。只有真正装箱进上下文的 slug 才记入会话注册表，被 total-budget 丢弃的不算（预算够时仍会注入）；注册表跨轮存活，仅 session/end-seed 与 agent/disposed 清除。被去重挡下的轮次记录 `injected: false` + `why: 'dedup'`，新增可选字段 `deduped` 列出被挡 slug；`/wiki stats` 的 Top-N 不再把被去重的 slug 计入注入数。`/wiki status` 注入旁新增去重状态行。已知取舍：topK 名额被去重占用时不 backfill（不从 near-miss 补位），见 ADR 0012。

## 0.2.1 (2026-09-01)

- 子代理开关：新增 `include-subagents`（默认开，ADR 0011）——wiki 的注入与观察默认同样作用于子代理会话；设为 off 恢复 0.2.0 的隔离语义（子代理不注入、不观察、不触发蒸馏）。topic 工具不受开关影响。

## 0.2.0 (2026-09-01)

- 子代理隔离：delegation depth > 0 的子代理会话不注入、不被观察、不触发蒸馏——记忆职责归父会话；topic 工具仍在全局层，子代理显式 `topic_save` 不拦（写入走串行队列，与父会话并发安全）。
- 配置向导：`/wiki onboard` 直接进入 dsh 原生 ask-user 交互——三块面板（存储模式 → 批量问答：仓库/蒸馏模型/注入档位/自动观察 → 确认写入），跳过=保持现状、关面板=零写入、末步确认才批量 mutate settings；默认仓建议名 `dsh-wiki-memory`（`gh api` 自动探测登录名）。依赖只有 `ctx.userQuestions` seam——TUI 面板 / 浏览器会话 / 飞书卡与 dsh-ask-router 多端竞答自动适配；无 provider 的环境退化为逐条输入向导。
- 默认远端仓库名定为 `dsh-wiki-memory`（ADR 0002/0008 文字同步更正）——原来的 `dsh-llmwiki-memory` 与插件源码仓同名，开同步会撞车。
- 关系可视化：`/wiki graph` 生成自包含 HTML 关系图（手写力导向 SVG、零外部依赖、离线可用）并自动在浏览器打开——状态配色、度数定节点大小、实线 depends/虚线正文链接、拖拽/缩放/平移、悬停高亮邻居与结论详情、搜索与 tag 过滤。
- 知识连接增强：正文 `[[wikilink]]` 与 markdown 链接解析为图边，参与检索的双向图游走；每次写入自动重建 `meta/backlinks.json`；`/wiki show` 追加「反向引用」段（via depends/link）。

## 0.1.0 (2026-08-31)

首个里程碑版本：M1 记忆闭环 + M2 自动 Observer。

### M1 — 记忆闭环

- OKF v0.2 严格合规的 Topic 文档模型（`type: Topic` + Topic Profile：`depends`/`open_questions`/`impact` frontmatter，`# Conclusion`/`# Recommendations` 正文约定，provenance/trust/lifecycle 三族字段）。
- 本地 Bundle（`~/.dsh/llmwiki/`）：一 Topic 一文件、自动 `index.md`、零依赖 YAML 子集、写穿式 git commit（一次结论变更 = 一个 commit）。
- 免 LLM 热路径检索：CJK bigram 分词 + containment 评分 + tag 加权 + `depends` 图游走 + 近因加分；conflicted Topic 降权。
- 同轮注入（`agent/inbox/spliced` seam）：per-topic 摘要 ≤300 token、top-K ≤4、总预算 ≤1.5k，无命中零注入，静态工具教学进 systemPrompt、易变内容走 context 通道。
- Injection Log + `/wiki stats`：hit rate、top-N、near-miss 分布、阈值调参建议。
- GitHub 同步（可选）：单库单 Bundle 单 main，session start 拉取、写穿去抖推送、rebase 冲突标记降权等人解；凭据 `$GITHUB_TOKEN` → `gh auth token`。
- 工具 `topic_save`/`topic_observe`/`topic_search`/`topic_history`；命令 `/wiki status|stats|list|show|history|sync|config|set`。

### M2 — 自动 Observer

- 会话观察：每轮 turn/end 把用户/助手文本捕获为原子观察（尺寸上限可配，可关）。
- 蒸馏 lane：session end + 每 N 轮触发（单飞去重），`ctx.llm.stream` 调用可配模型路由，观察批量蒸馏为 create/update 操作，未消费观察保持待蒸馏。
