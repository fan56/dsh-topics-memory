/**
 * Injection log (ADR 0007) — one record per retrieval round, no conversation
 * text, only features and decisions. Aggregations power `/topics stats` and the
 * near-miss evidence that makes threshold tuning measurable.
 *
 * @module ilog
 */

/** Shadow re-gate verdict for one slow-lane pick (log-only, never blocks — v4 B3). */
export interface ShadowVerdict {
  slug: string
  pass: boolean
  why: string
}

/** Slow-lane query-build shape audit (v4 §4.3): priming evidence, no content. */
export interface QueryBuildShape {
  rawChars: number
  keptChars: number
  /** Content categories the query build dropped (e.g. pasted dumps). */
  stripped: string[]
}

/** One slow-lane pointer that entered (or was budgeted out of) the context. */
export interface SlowItem {
  slug: string
  why: string
}

export interface InjectionRecord {
  at: string
  sessionId?: string
  /** Query shape: token count and a bounded sample (features, not content). */
  queryTokenCount: number
  querySample?: string
  rosterSize: number
  hits: { slug: string; score: number; reasons: string[]; viaGraph: boolean; strong?: boolean; bodyHits?: number }[]
  nearMisses: { slug: string; score: number; reasons?: string[] }[]
  injected: boolean
  why?: string
  dropped?: { slug: string; reason: string }[]
  /** Slugs blocked this round by session-level injection dedup (never assembled). */
  deduped?: string[]
  /** Slugs blocked this round as 蒸馏回声 (distilled from this session's own turns). */
  echoed?: string[]
  usedTokens?: number
  // ---- v4 lane field family (§4.3) — absent on pure fast-lane rounds ----
  /** fast = lexical pointers only; slow = async picks only; mixed = both. */
  lane?: 'fast' | 'slow' | 'mixed'
  /** Slow lane: the consumed pending died at its hard bounds (TTL / turn-lag). */
  slowExpired?: 'ttl' | 'turn-lag'
  /** Slow lane: when the pending was computed (turn/end) and consumed (spliced). */
  computedAt?: string
  consumedAt?: string
  /** Log-only lexical re-gate verdicts taken at consumption time. */
  shadowVerdict?: ShadowVerdict[]
  queryBuild?: QueryBuildShape
  /** Slow-lane model route (`provider/model`) and pipeline wall time in ms. */
  slowModel?: string
  slowMs?: number
  /** Slow-lane pointers this round, in delivery order. */
  slow?: SlowItem[]
}

export interface AggregateStats {
  rounds: number
  injectedRounds: number
  hitRate: number
  zeroHitRounds: number
  avgHitsPerRound: number
  topTopics: { slug: string; count: number }[]
  nearMissHistogram: { bucket: string; count: number }[]
  avgBudgetUtilization: number
}

export function aggregateStats(records: readonly InjectionRecord[]): AggregateStats {
  const rounds = records.length
  let injectedRounds = 0
  let zeroHitRounds = 0
  let hitsSum = 0
  let budgetSamples = 0
  let budgetSum = 0
  const topicCounts = new Map<string, number>()
  const buckets = new Map<string, number>()
  for (const r of records) {
    if (r.injected) injectedRounds += 1
    if (r.hits.length === 0) zeroHitRounds += 1
    hitsSum += r.hits.length
    if (typeof r.usedTokens === 'number' && r.usedTokens > 0) {
      budgetSamples += 1
      budgetSum += r.usedTokens
    }
    // topTopics feeds 「Top-N 被注入 Topic」— deduped/echoed hits were NOT
    // injected, so they must not inflate the per-slug injection counts.
    // Retrieval-shape metrics above (hits/rounds, zero-hit rounds) keep
    // counting raw hits.
    const deduped = r.deduped === undefined ? undefined : new Set(r.deduped)
    const echoed = r.echoed === undefined ? undefined : new Set(r.echoed)
    for (const h of r.hits) {
      if (deduped?.has(h.slug) || echoed?.has(h.slug)) continue
      topicCounts.set(h.slug, (topicCounts.get(h.slug) ?? 0) + 1)
    }
    for (const nm of r.nearMisses) {
      const bucket = nmBucket(nm.score)
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
    }
  }
  const topTopics = [...topicCounts.entries()]
    .map(([slug, count]) => ({ slug, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
  const nearMissHistogram = [...buckets.entries()]
    .sort((a, b) => bucketOrder(a[0]) - bucketOrder(b[0]))
    .map(([bucket, count]) => ({ bucket, count }))
  return {
    rounds,
    injectedRounds,
    hitRate: rounds === 0 ? 0 : Math.round((injectedRounds / rounds) * 1000) / 1000,
    zeroHitRounds,
    avgHitsPerRound: rounds === 0 ? 0 : Math.round((hitsSum / rounds) * 100) / 100,
    topTopics,
    nearMissHistogram,
    avgBudgetUtilization: budgetSamples === 0 ? 0 : Math.round((budgetSum / budgetSamples) * 100) / 100,
  }
}

function nmBucket(score: number): string {
  const floor = Math.floor(score * 20) / 20
  return `${floor.toFixed(2)}–${(floor + 0.05).toFixed(2)}`
}

function bucketOrder(label: string): number {
  return Number(label.split('–')[0])
}

/** Bounded sample of the query kept for debugging — words only, max 40 chars. */
export function querySample(query: string): string {
  const words = query.replace(/\s+/g, ' ').trim()
  return words.length <= 40 ? words : `${words.slice(0, 40)}…`
}
