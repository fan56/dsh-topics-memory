# 使用信号回路：usageBoost 检索加成 + 整理 lane 使用统计

日期：2026-09-09。决策记录：ADR 0015。状态：设计定稿，未实现。

## 目标与非目标

**目标**：把 ilog 里已经免费积累的行为数据（Injection Log + opens）接回两处消费点——检索排序、整理 lane 的提案证据。

**非目标**：静态质量分；`/topics stats` 的 boost 可视化（Top-N 已是等价信息）；慢道 rerank 的特殊处理（boost 经 searchTopics 自然影响候选带，无需改 quality.ts）。

## 一、使用信号聚合（ilog.ts / service.ts）

### 数据源与票权

| 信号 | 来源 | 票权 | 判定 |
|---|---|---|---|
| Injection 命中 | `meta/injections.jsonl` | 1 | `record.hits` 含该 slug，且 `record.injected === true`，且不在 `deduped` / `echoed` / `dropped` |
| topic_open | `meta/opens.jsonl` | 3 | 每条 open 记录计 3 票 |

慢道 pick（`slow` 字段）同为真装配，计入注入命中。窗口：滚动 30 天（`record.at` / open `at` ≥ now − 30d）。

### 新聚合函数（ilog.ts，纯函数）

```ts
/** slug → { hits, opens }，滚动 windowDays 天。 */
export function aggregateUsage(
  injections: readonly InjectionRecord[],
  opens: readonly { slug: string; at: string }[],
  windowDays: number,
  now: number,
): Map<string, { hits: number; opens: number }>
```

### 带缓存的读取（service.ts）

`usageSignals(): Map<string, { hits; opens }>`——echoSlugsSync 同款模式：缓存 keyed by 两个文件的 `mtimeMs + size`，任一变化即重聚合。检索热路径（同步）可安全调用：2000 条 JSONL 的 parse + 聚合为毫秒级，且被缓存摊薄。

## 二、检索接线（retrieval.ts / config.ts）

### 配置

`usageBoost: z.number().default(0.15)`——`/topics set usage-boost <n>`（非负数，同 matchThreshold case），`0` 关闭。

### searchTopics 变更

options 增 `usageBoost: number` 与 `usage?: ReadonlyMap<string, { hits; opens }>`。打分处（recency 之前）：

```ts
// ADR 0015: gate-scoped but double-locked — capped below the threshold and
// never granted to a zero-lexical candidate.
if (cfg.usageBoost > 0 && score > 0) {
  const u = usage?.get(c.slug)
  if (u !== undefined && (u.hits > 0 || u.opens > 0)) {
    score += Math.min(cfg.usageBoost, USAGE_BOOST_CAP) // cap = 0.2 < threshold 0.3
  }
}
```

要点：

- **进 gateScore**（门槛数字分），与 ADR 0014 的「recency 只作 tiebreaker」不同层——usage 受结构门+帽双锁，recency 没有。
- **结构门不豁免**：强字段/正文证据要求照旧，boost 只垫数字分。
- `gateScore` 的文档注释更新：「剔除 recency、含 usageBoost 的门槛分」。
- 票数只作**资格判定**（>0 有无），不做线性放大——票多不加分，防热门条目无界膨胀。
- 命中条目的 `reasons` 数组追加 `usage`（回放证据可见，`/topics stats` 的 near-miss 分析无需改动即可看到 boost 是否参与）。

### 冷启动

无 IL / opens 数据 → usage 全空 → 行为与现状逐字节一致。

## 三、整理 lane 接线（consolidate.ts）

`buildClusters()` 的每条 payload 增加：

```json
{ "slug": "...", "title": "...", "status": "...", "tags": [...],
  "conclusion": "...", "injections30d": 12, "opens30d": 3 }
```

来源：与检索侧同一个 `service.usageSignals()`（同口径同缓存）。无数据的键省略字段（省 token）。

### SYSTEM_PROMPT 追加护栏

```
'- payload 里的 injections30d/opens30d 是该 topic 近 30 天被注入命中的次数与被点开的次数：0 表示近期从未被检索命中，可作为 deprecate 或 refresh（修命名/标签）的支持证据；但不要仅凭零使用就 deprecate——新条目和小众但关键的条目也会零命中。'
```

动机呼应：命名漂移的条目（旧包名 slug）正是「零使用 + 词面弱」的典型，refresh op 是它们的第一出路。

## 四、测试计划

1. `aggregateUsage`：票权（open=3）、30 天窗口边界（恰好 30 天前算不算——算，`>=`）、deduped/echoed/dropped 排除、slow 计入。
2. `usageSignals` 缓存：mtime 未变不重读、变化后重读。
3. `searchTopics`：boost 垫过阈值的弱词面条目入选且 reasons 含 `usage`；词面 0 不加；帽 0.2（配置 0.5 生效仍 0.2）；usageBoost=0 行为与现状一致。
4. consolidate payload：字段存在、无数据省略；prompt 断言护栏句。
5. 冷启动逐字节一致性：空 IL 下同一 query 的命中集与无 usageBoost 完全相同。

## 五、落地顺序

1. ilog.ts 聚合纯函数 + 测试
2. service.ts usageSignals 缓存 + 测试
3. retrieval.ts 接线 + config 键 + 测试
4. consolidate.ts payload + prompt + 测试
5. SKILL.md / README×2 / CHANGELOG（并入 0.14.0，未发版）
