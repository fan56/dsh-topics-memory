# dsh-topics-memory

一个 dsh 插件：把「工作 topic 记忆」维护成 OKF 标准（Open Knowledge Format v0.2）的知识 bundle，持久化在 GitHub 私有仓库，本地缓存，利用 git 历史提供结论可追溯性，并在每轮对话前向模型注入相关 Topic。

## Language

### 载体

**Bundle**：
一个 OKF 知识束——Topic 文档加自动生成索引文件构成的目录树，是分发与持久化的完整单元。
_Avoid_: vault（与 dsh-vault 插件的加密备份语义冲突）、knowledge base

**Remote**：
存放 Bundle 的 GitHub 私有仓库，是 Bundle 的权威副本；可选——配置后才启用 GitHub 同步模式。
_Avoid_: vault、backup repo

**Local-only**：
未配置 Remote 时的持久化形态：Bundle 只存在于本地 Cache，本地 git 历史照常，无同步。
_Avoid_: offline mode、standalone

**Cache**：
Bundle 在本地的 git 工作副本，插件的全部读写都发生在 Cache，按同步策略与 Remote 交换。
_Avoid_: local copy、workspace

### 记忆单元

**Topic**：
一个记忆单元，对应一个 `type: Topic` 的 OKF concept 文档，回答「关于某件事我们知道什么」。
_Avoid_: entry、note、memory item

**Topic Profile**：
本插件在 OKF 之上的扩展约定：Topic 的固定 frontmatter 扩展键（`depends`、`open_questions`、`impact`）与约定正文标题（`# Conclusion`、`# Recommendations`）。
_Avoid_: schema、dialect

### Topic 字段

**Name**：
Topic 的人类可读名，落为 frontmatter `title` 与文件名 slug；Name 不可变，改名即新建 Topic。
_Avoid_: 标题、subject

**Depends**：
本 Topic 依赖的其他 Topic 列表（frontmatter `depends`，存 Bundle 相对路径），表达「理解本 Topic 的前提」。
_Avoid_: 依赖树、related（related 走正文 markdown 链接，不占字段）

**Open Questions**：
尚未有结论的问题列表（frontmatter `open_questions`），是 Observer 持续关注的缺口。
_Avoid_: TODO、unknowns

**Conclusion**：
目前的有效结论（正文 `# Conclusion`，配 frontmatter `status` 与 `generated`/`verified`），历史版本由 git 追溯。
_Avoid_: summary、findings

**Impact**：
该结论影响的面（frontmatter `impact`：受影响的 Topic、项目、决策）。
_Avoid_: consequences、side effects

**Recommendations**：
基于结论的可执行建议（正文 `# Recommendations`）。
_Avoid_: suggestions、next steps

### 过程角色

**Observer**：
自动观察会话、沉淀知识、写入 Topic 的机制总称，由显式通道与兜底通道两段式组成。
_Avoid_: watcher、recorder

**Observe**：
主模型在会话中随手记录的原子观察（一条决策、发现或约束），是 Topic 的原料而非成品，等待蒸馏。
_Avoid_: capture、note-taking

**Distill**：
后台 lane 把未蒸馏的 Observe 批量总结成正式 Topic 字段的 LLM 过程，发生在 session end 或每 N 轮。
_Avoid_: summarize、digest

**Injection**：
每轮对话前把相关 Topic 的精炼内容注入模型请求的机制；注入决策走免 LLM 热路径。
_Avoid_: context injection、inject

**Injection Log**：
每轮检索的决策记录：命中 Topic、得分、命中原因、注入与否（含 near-miss）、预算占用；是调参与 stats 聚合的依据。
_Avoid_: usage log、telemetry

**Open**：
模型跟随注入指针、用 `topic_open` 工具读取 Topic 全文的动作。Open 是比命中更强的使用信号——命中只说明「被检索选中」，Open 说明「模型认为值得细读」。
_Avoid_: view、read、click

**UsageBoost**：
近 30 天使用信号（Injection 命中与 Open 按票权折算）对检索得分的加成项，让「实际帮到过对话」的 Topic 更容易被再次选中；它受结构门与上限约束，永不救起零词面相关的条目。
_Avoid_: quality score、popularity、评分
