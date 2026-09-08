# 同步策略：写穿 + 去抖推送

Status: accepted

Cache 上每次 Topic 写入立即本地 commit（一次结论变更 = 一个 commit，git 历史粒度对齐结论变更粒度）；push 去抖 30–60s 合并推送，session 结束强制 flush。session 启动与每次 push 前执行 `pull --rebase`。断网不阻塞：commit 照常落本地，push 后台重试。

> **0.10.0 修订**：「session 结束强制 flush」回收到本 ADR 的原始意图——断网不阻塞。卸载 disposer 只做本地 meta commit，push 推迟到下次 session 启动的 pull 之后补推；distill 积压同理由启动回放消化。实现曾在 0.8.x 一度把退出路径拉回网络等待（exit flush + 有界蒸馏窗口），现已移除。

## Considered Options

- 会话边界同步（否决）：网络调用最少，但崩溃/断电丢一整会话，长跑会话中途变更迟迟不上远端——对不起「git 可追溯」的动机。
- 手动 `/wiki sync`（否决）：与自动 observe 入库矛盾，机器写的留在本地等于换机即丢。

## Consequences

- rebase 冲突不做自动智能合并：冲突 Topic 标记 `conflicted`，注入降权并提示模型「此条有未合并冲突」，等人工解决。一 Topic 一文件 + 单 main 下真冲突应极罕见。
- push 失败是常态路径而非异常：远端为最终一致，本地 commit 是持久性的事实来源。
