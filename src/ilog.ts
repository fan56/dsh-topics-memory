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

/**
 * One topic_open event (pointer-open log, v4 §4.3). Everything beyond
 * `slug`/`at` is optional and late-added: older lines carry only the
 * original pair, and every reader must tolerate the rest being absent.
 */
export interface OpenRecord {
  slug: string
  at: string
  /** Session that issued the topic_open, when the host surface exposed one. */
  sessionId?: string
  /** Attribution: opened off an injected pointer, or off a topic_search hit. */
  source?: 'pointer' | 'search'
  /** Retrieval score of the matched injection hit (source='pointer' only). */
  score?: number
  /** open time − the matched injection record's at, in ms (source='pointer' only). */
  sinceInjectionMs?: number
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

/** Rolling usage-signal window (ADR 0015) — days of Injection/Open history. */
export const USAGE_WINDOW_DAYS = 30

export interface UsageSignal {
  hits: number
  opens: number
}

/**
 * Usage signals per slug over a rolling window (ADR 0015): an injection hit
 * (truly assembled, not deduped/echoed/dropped) counts 1, a topic_open counts
 * 3 — the model chose to read the full text, the strongest "this helped"
 * evidence available. Downstream, only PRESENCE matters (the boost is a
 * fixed capped bonus, never linear in votes); the counts exist for the
 * consolidation payload, where "0 vs many" is the gardening evidence.
 */
export function aggregateUsage(
  injections: readonly InjectionRecord[],
  opens: readonly { slug: string; at: string }[],
  windowDays: number,
  now: number,
): Map<string, UsageSignal> {
  const cutoff = now - windowDays * 86_400_000
  const out = new Map<string, UsageSignal>()
  const bump = (slug: string, kind: keyof UsageSignal): void => {
    if (slug === '') return
    const entry = out.get(slug) ?? { hits: 0, opens: 0 }
    entry[kind] += 1
    out.set(slug, entry)
  }
  for (const record of injections) {
    const at = Date.parse(record.at)
    if (!Number.isFinite(at) || at < cutoff) continue
    if (record.injected !== true) continue
    const excluded = new Set<string>([
      ...(record.deduped ?? []),
      ...(record.echoed ?? []),
      ...(record.dropped ?? []).map((d) => d.slug),
    ])
    for (const hit of record.hits) {
      if (excluded.has(hit.slug)) continue
      bump(hit.slug, 'hits')
    }
    for (const slow of record.slow ?? []) bump(slow.slug, 'hits')
  }
  for (const open of opens) {
    const at = Date.parse(open.at)
    if (!Number.isFinite(at) || at < cutoff) continue
    bump(open.slug, 'opens')
  }
  return out
}

// ---------------------------------------------------------------------
// Injection-vs-open metrics (v5) — open enrichment attribution + the
// /topics stats panel aggregate. All pure: file I/O stays in store/service.
// ---------------------------------------------------------------------

/** How many tail injection records the cheap open attribution scans. */
export const OPEN_ATTRIBUTION_TAIL = 50
/** An injected pointer stays attributable for 48h (a work session's span). */
export const OPEN_ATTRIBUTION_WINDOW_MS = 48 * 3_600_000

/**
 * Cheap source attribution for one open event: scan the injection tail
 * (newest first) for a same-session record within the attribution window
 * whose RAW hits array contains the slug — deduped/echoed hits count too,
 * the model saw the pointer candidate either way. A match attributes
 * `pointer` with that hit's score and the open→injection lag; anything
 * else (no session id, other session, expired, never injected) is `search`.
 */
export function attributeOpen(
  injections: readonly InjectionRecord[],
  slug: string,
  sessionId: string | undefined,
  nowMs: number,
): { source: 'pointer' | 'search'; score?: number; sinceInjectionMs?: number } {
  if (sessionId === undefined) return { source: 'search' }
  for (let i = injections.length - 1; i >= 0; i -= 1) {
    const record = injections[i]
    if (record.sessionId !== sessionId) continue
    const atMs = Date.parse(record.at)
    if (!Number.isFinite(atMs) || nowMs - atMs > OPEN_ATTRIBUTION_WINDOW_MS) continue
    const hit = record.hits.find((h) => h.slug === slug)
    if (hit === undefined) continue
    return { source: 'pointer', score: hit.score, sinceInjectionMs: Math.max(0, nowMs - atMs) }
  }
  return { source: 'search' }
}

/** Score bands for the open-rate-by-score cut of the stats panel. */
export const SCORE_BANDS: readonly { label: string; lo: number; hi: number }[] = [
  { label: '[0.3,0.5)', lo: 0.3, hi: 0.5 },
  { label: '[0.5,1)', lo: 0.5, hi: 1 },
  { label: '[1,2)', lo: 1, hi: 2 },
  { label: '[2,5)', lo: 2, hi: 5 },
  { label: '[5,∞)', lo: 5, hi: Number.POSITIVE_INFINITY },
]

/** Zero-open listing threshold: injections at or above this with zero opens. */
export const ZERO_OPEN_MIN_INJECTIONS = 5
/** Rolling window of the zero-open rule: only rendered injections inside it count. */
export const ZERO_OPEN_WINDOW_DAYS = 30
/** Injection-tail rows the decay read scans — a bound comfortably covering
 *  the 30-day window at observed round volumes. */
export const ZERO_OPEN_TAIL = 500

/**
 * Slugs that truly rendered in one round, in delivery order: raw hits minus
 * the round's exclusions (deduped/echoed/dropped were never assembled), plus
 * delivered slow pointers; a slug the fast lane already delivered counts
 * once even when the slow lane also reports it delivered ("not packed
 * twice"). Scores ride along from the fast hit only — slow pointers carry
 * no lexical score. Shared by the stats panel and the zero-open rule.
 */
export function renderedPointers(record: InjectionRecord): { slug: string; score?: number }[] {
  const excluded = new Set<string>([
    ...(record.deduped ?? []),
    ...(record.echoed ?? []),
    ...(record.dropped ?? []).map((d) => d.slug),
  ])
  const seen = new Set<string>()
  const out: { slug: string; score?: number }[] = []
  for (const h of record.hits) {
    if (excluded.has(h.slug) || seen.has(h.slug)) continue
    seen.add(h.slug)
    out.push({ slug: h.slug, score: h.score })
  }
  for (const s of record.slow ?? []) {
    if (seen.has(s.slug)) continue
    seen.add(s.slug)
    out.push({ slug: s.slug })
  }
  return out
}

/**
 * Zero-open slug set — the single shared 零打开高频 rule (v5): slugs whose
 * truly-rendered pointer count within the rolling ZERO_OPEN_WINDOW_DAYS
 * reaches ZERO_OPEN_MIN_INJECTIONS while the WHOLE open log has never
 * recorded an open (wide scope — an open long after the last injection
 * still disqualifies). Returns slug → windowed rendered-pointer count for
 * the qualifying slugs; `/topics stats` (the panel's zero-open list) and
 * the retrieval decay (`zeroOpenDecay`) both consume this one
 * implementation. Records with unparsable `at` cannot prove window
 * membership and are skipped (same tolerance as aggregateUsage).
 */
export function aggregateZeroOpen(
  injections: readonly InjectionRecord[],
  opens: readonly { slug: string }[],
  nowMs: number,
): Map<string, number> {
  const cutoff = nowMs - ZERO_OPEN_WINDOW_DAYS * 86_400_000
  const counts = new Map<string, number>()
  for (const record of injections) {
    const at = Date.parse(record.at)
    if (!Number.isFinite(at) || at < cutoff) continue
    for (const p of renderedPointers(record)) {
      counts.set(p.slug, (counts.get(p.slug) ?? 0) + 1)
    }
  }
  const opened = new Set(opens.map((o) => o.slug))
  const out = new Map<string, number>()
  for (const [slug, n] of counts) {
    if (n >= ZERO_OPEN_MIN_INJECTIONS && !opened.has(slug)) out.set(slug, n)
  }
  return out
}

export interface OpenTopicRow {
  slug: string
  /** Truly rendered pointers for this slug (deduped/echoed/dropped excluded). */
  injections: number
  /** Opens attributed by slug over the whole open log (wide scope, by design). */
  opens: number
  openRate: number
}

export interface OpenBandRow {
  label: string
  /** Rendered fast pointers whose hit score falls in this band. */
  pointers: number
  /** Pointer-sourced opens whose attributed score falls in this band. */
  opens: number
  openRate: number
}

export interface OpenPanelStats {
  /** Rendered pointer entries across the window: hits − deduped − echoed − dropped, plus slow pointers (same-slug fast+slow pairs counted once). */
  pointerEntries: number
  /** Opens with at ≥ the earliest round in the window (numerator/denominator alignment). */
  opensInWindow: number
  openRate: number
  topics: OpenTopicRow[]
  zeroOpen: { slug: string; injections: number }[]
  zeroOpenTotal: number
  pointerOpens: number
  searchOpens: number
  /** False when no open record carries a source field (pre-enrichment data). */
  hasSourceData: boolean
  bands: OpenBandRow[]
}

/**
 * Aggregate the injection-vs-open panel from the two JSONL windows. The
 * per-topic/band denominators count only pointers that truly rendered
 * (deduped/echoed/dropped excluded — same exclusion family as
 * aggregateUsage); the header numerator only counts opens that fall inside
 * the injection window, so an old open log can no longer inflate the rate
 * against a fresh injection window. Opens per slug stay wide-scope (the
 * model may open a topic long after its last injection). The zero-open
 * list shares the decay's rule: rendered injections counted within the
 * rolling 30-day window (anchored at the newest round), opens wide-scope.
 */
export function aggregateOpenPanel(
  injections: readonly InjectionRecord[],
  opens: readonly OpenRecord[],
): OpenPanelStats {
  // Numerator window: the earliest round represented in the denominator;
  // the zero-open anchor is the newest round — the panel describes the log
  // window it was fed, so a stale log still shows its霸榜 evidence.
  let windowStart = Number.POSITIVE_INFINITY
  let windowEnd = Number.NEGATIVE_INFINITY
  for (const r of injections) {
    const atMs = Date.parse(r.at)
    if (!Number.isFinite(atMs)) continue
    if (atMs < windowStart) windowStart = atMs
    if (atMs > windowEnd) windowEnd = atMs
  }
  const topicCounts = new Map<string, number>()
  const bandPointers = new Array<number>(SCORE_BANDS.length).fill(0)
  let pointerEntries = 0
  for (const r of injections) {
    // renderedPointers keeps the entry/per-topic counts honest: excluded
    // slugs never counted, a fast+slow pair for the same slug counted once.
    for (const p of renderedPointers(r)) {
      pointerEntries += 1
      topicCounts.set(p.slug, (topicCounts.get(p.slug) ?? 0) + 1)
      const score = p.score
      if (score === undefined) continue
      const bi = SCORE_BANDS.findIndex((b) => score >= b.lo && score < b.hi)
      if (bi >= 0) bandPointers[bi] += 1
    }
  }
  const opensBySlug = new Map<string, number>()
  const bandOpens = new Array<number>(SCORE_BANDS.length).fill(0)
  let pointerOpens = 0
  let searchOpens = 0
  let hasSourceData = false
  let opensInWindow = 0
  for (const o of opens) {
    opensBySlug.set(o.slug, (opensBySlug.get(o.slug) ?? 0) + 1)
    if (o.source === 'pointer' || o.source === 'search') hasSourceData = true
    if (o.source === 'pointer') pointerOpens += 1
    else if (o.source === 'search') searchOpens += 1
    if (o.source === 'pointer' && typeof o.score === 'number') {
      const score = o.score
      const bi = SCORE_BANDS.findIndex((b) => score >= b.lo && score < b.hi)
      if (bi >= 0) bandOpens[bi] += 1
    }
    const atMs = Date.parse(o.at)
    // An open joins the windowed numerator unless it is provably older than
    // the window's earliest round (unparsable stamps cannot prove either way).
    if (!(Number.isFinite(windowStart) && Number.isFinite(atMs) && atMs < windowStart)) opensInWindow += 1
  }
  const rate = (num: number, den: number): number => (den === 0 ? 0 : Math.min(1, num / den))
  const topics: OpenTopicRow[] = [...topicCounts.entries()]
    .map(([slug, injections]) => {
      const opens = opensBySlug.get(slug) ?? 0
      return { slug, injections, opens, openRate: rate(opens, injections) }
    })
    .sort((a, b) => b.injections - a.injections || a.slug.localeCompare(b.slug))
  // Zero-open cut: the shared 30-day rule (aggregateZeroOpen), anchored at
  // the newest round so window semantics match the decay's rolling window
  // without growing a time-bomb dependency on the wall clock.
  const zeroOpenCounts =
    windowEnd === Number.NEGATIVE_INFINITY ? new Map<string, number>() : aggregateZeroOpen(injections, opens, windowEnd)
  const zeroOpenAll = [...zeroOpenCounts.entries()]
    .map(([slug, injections]) => ({ slug, injections }))
    .sort((a, b) => b.injections - a.injections || a.slug.localeCompare(b.slug))
  return {
    pointerEntries,
    opensInWindow,
    openRate: rate(opensInWindow, pointerEntries),
    topics: topics.slice(0, 10),
    zeroOpen: zeroOpenAll.slice(0, 10).map((t) => ({ slug: t.slug, injections: t.injections })),
    zeroOpenTotal: zeroOpenAll.length,
    pointerOpens,
    searchOpens,
    hasSourceData,
    bands: SCORE_BANDS.map((b, i) => ({
      label: b.label,
      pointers: bandPointers[i],
      opens: bandOpens[i],
      openRate: rate(bandOpens[i], bandPointers[i]),
    })),
  }
}
