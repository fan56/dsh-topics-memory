# 快道零远程调用红线

Status: accepted（2026-09-26；设计全文 `docs/design/2026-09-25-system-one-integration.md` 红线①）
Amends: 0004（「注入热路径免 LLM」延伸为「热路径零远程调用」）、0014（I1 组装确定性 / I3 可丢弃性不变式）

## 背景

ADR 0004 第 3 条确立注入热路径免 LLM（词法匹配 + `depends` 图游走，毫秒级），ADR 0014 把它收进五不变式：I1 组装确定性（spliced→prompt 同步、无 LLM）、I3 可丢弃性（异步产物永不阻塞会话循环）。每条用户消息的同步检索在 prompt assembly 前必须返回——这条路径上任何一次远程调用，都把每轮首字延迟押在网络与第三方可用性上。生态先行者的教训在先：chancelu/dsh-llmwiki 在注入时序上的坑正是 ADR 0004 立项的动因之一（避开异步分类时序陷阱）。

System One 引入后诱惑具体化了：快道词法门恰是全链路判断力最弱的一环（对拍集 hit 层 38 个词法误放行），最想在快道上直接问一次 jev。

## 决定

**红线：每条用户消息的同步检索（prompt assembly 前必须返回）永不发起任何远程调用**——HTTP/RPC/MCP、一切出网。System One 只进异步 lane：

- 慢车道 rerank：quality lane 产物，下一个 steer message 消费；
- 整理 lane 前置：后台 lane，pair 过滤后才见 LLM；
- 快道 shadow：**仅 shadow**——turn-end lane 异步调用，verdict 只落 `meta/decisions.jsonl`（`lane=fastgate-shadow`），与词法处置的对账由 `agree` 字段离线 join 完成。

ilog 注入记录不动：它在注入时同步构造定稿、追加式不可回填——让 jev verdict 进 ilog 就必须快道同步等远程，直接违反本红线。

## 理由

- 首字延迟包络是毫秒级承诺（ADR 0004 起兑现至今），远程化等于推翻；
- local-only 模式「零网络依赖」的既有承诺随红线自动保持；
- 快道判断力的改进走间接路径：shadow 对账攒证据 → 离线校准 → 灰度转正为异步缝，而不是热路径直改。

## 备选与取舍

- **快道同步问 jev（门禁前置）**：被否——每轮押网络、离线不可用、违反 I1/I3；shadow 覆盖从 0% 攒起，2 周数据后由验收门槛决定是否转正。
- **verdict 回写 ilog**：被否——ilog 注入记录同步定稿、追加式不可回填，回写需要快道同步等远程。

## 后果

- 快道行为与纯本地版本逐字节一致（`jevEnabled` on/off 都一样）——红线不设豁免口。
- shadow 对账数据进 decisions.jsonl，是验收门槛②③④（漏报率、shadow 2 周、ECE）的数据源；R6 类反向分歧（词法放行、jev 落回退线）由 `agree: wouldBlock` 离线保留，不因红线丢失。
- 快道对 jev 的全部收益只能经「异步缝转正」间接兑现；快道自身永远词法。
