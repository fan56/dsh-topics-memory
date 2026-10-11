/**
 * TopicsService — the facade shared by tools, commands, the injection seam,
 * and the distill lane. Owns the roster cache (mtime-keyed, pi-topic-memory
 * lesson #3: never re-parse unchanged files on the hot path).
 *
 * @module service
 */

import { readFile, stat } from 'node:fs/promises'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as okf from './okf.ts'
import { searchTopics, scoreTopic, passesGate, tokenize, sanitizeQuery, loadEmbeddingIndex, rerankNearFloor, ensureIndexFresh, saveEmbeddingIndex, type EmbeddingIndex, type RetrievableTopic, type RetrievalConfig, type SearchOutcome, type ScoredTopic } from './retrieval.ts'
import { assembleInjection, assemblePointer, assemblePackage, lessonEntryText, lessonSourceTag, POINTER_PER_TOPIC, POINTER_TOTAL, type AssembleResult, type DigestInput, type LessonPointerInput, type PackageCandidate, type PackageInput, type PackageResult, type SlowPointerInput } from './digest.ts'
import { embedTexts, embedQuerySync, embedderWith, resolveEmbedModel } from './embedding.ts'
import { currentWorkspaceId, resolveBundleRoot } from './paths.ts'
import type { BundleStore, Observation, SaveResult } from './store.ts'
import type { TopicsConfigValue } from './config.ts'
import { aggregateStats, querySample, aggregateUsage, aggregateZeroOpen, ZERO_OPEN_TAIL, USAGE_WINDOW_DAYS, attributeOpen, OPEN_ATTRIBUTION_TAIL, type AggregateStats, type InjectionRecord, type OpenRecord, type QueryBuildShape, type ShadowVerdict, type SlowItem, type SlowOutcome, type UsageSignal } from './ilog.ts'
import { recordPipelineEvent } from './pipeline-events.ts'
import { fileHistory, fileAtRev } from './git.ts'
import type { Sync } from './sync.ts'

interface CacheEntry {
  mtimeMs: number
  size: number
  doc: okf.TopicDoc
  slug: string
}

/** Tolerant JSONL line read: undefined = unreadable file. Unlike an empty
 *  array, undefined tells the caller to fail open AND skip caching — a
 *  successful stat paired with a failed read must not freeze an empty
 *  snapshot into the cache until the next append. */
function readLogLinesSync(file: string): string[] | undefined {
  try {
    return readFileSync(file, 'utf8').split('\n')
  } catch {
    return undefined
  }
}

/** Parse already-split lines back-to-front, keeping the last `tail` parsed
 *  records in order: blanks and torn JSON lines are skipped (and never
 *  consume tail budget), so a torn tail line cannot crowd out a good one.
 *  Shared by the usage/zero-open cache — one tail parse feeds both. */
function parseJsonlLinesSync<T>(lines: readonly string[], tail = Number.POSITIVE_INFINITY): T[] {
  const out: T[] = []
  for (let i = lines.length - 1; i >= 0 && out.length < tail; i -= 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      continue // torn tail line
    }
  }
  out.reverse()
  return out
}

export interface RetrieveOutcome {
  outcome: SearchOutcome
  injection: AssembleResult
  /** Roster was empty or injection disabled — no record written for pure no-ops. */
  recorded: boolean
}

/**
 * Slow-lane payload handed to the hot path at consumption time (v4 §4.2).
 * `items` are the rerank picks (0-2, why lines included); metadata feeds the
 * ilog lane field family. The hot path resolves titles, filters dedup,
 * renders, and takes the log-only shadow verdicts.
 */
export interface SlowDelivery {
  items: readonly { slug: string; why: string }[]
  computedAt: string
  queryBuild: QueryBuildShape
  model: string
  ms: number
  /** Producing run's disposition (A4 全留痕) — copied into ilog.slowOutcome. */
  outcome?: SlowOutcome
}

// ---------------------------------------------------------------------------
// B-line dual-write seams (卷二 §6.2 MJ-5): the new repo's ONLY write surface
// into the bundle (禁直写 bundle 文件). Both audit the caller identity
// (opts.actor required) into meta/pipeline-events.jsonl.
// ---------------------------------------------------------------------------

/**
 * One structured observation from the new repo's signal layer (B1 §2.1
 * whitelist): FEATURES ONLY, never conversation text (红线⑤). Unknown caller
 * fields cannot pass — the whitelist copy in feedObservations is the gate.
 */
export interface StructuredObservation {
  /** Signal type from the B1 closed list (`tool-error`, `turn-end-negative`,
   *  `unused-injection`, `repeat-call`, `interruption-pair`, `jev-calibration`). */
  type: string
  /** ISO instant; defaults to now. */
  at?: string
  sessionId?: string
  /** Bounded scalar feature fields (toolName/errorName/count/band/...). */
  detail?: Record<string, string | number | boolean>
}

export interface FeedResult {
  accepted: number
  duplicates: number
  rejected: number
  ids: string[]
  /** Present when the call itself was refused (missing/blank actor). */
  error?: 'unauthorized'
}

export interface StoreResult {
  ok: boolean
  slug: string
  /** Refusal reason; absent on success. */
  reason?: 'unauthorized' | 'not-found' | 'not-a-lesson' | 'invalid-state'
  /** confidence before the transition (when the lesson was read). */
  from?: okf.LessonConfidence
  /** removed only: bundle-relative archive path (git-revertable). */
  archivedTo?: string
  committed?: boolean
}

export class TopicsService {
  private cache = new Map<string, CacheEntry>()
  /** mtime-keyed parse of the observations log, grouped by session. */
  private echoCache: { mtimeMs: number; size: number; bySession: Map<string, Set<string>> } | undefined
  /** Single shared cache over the two feedback JSONL logs (S2): the key is
   *  the (mtime,size) quartet of injections.jsonl + opens.jsonl, one read
   *  and one tail parse feed BOTH aggregates — usageSignalsSync and
   *  zeroOpenSlugsSync used to each keep a full-parse cache of their own.
   *  Invalidation stays append-driven: the store only ever appends, so any
   *  write moves mtime+size. Never populated when a read failed (N1). */
  private logSignalsCache:
    | {
        injMs: number
        injSize: number
        opensMs: number
        opensSize: number
        signals: Map<string, UsageSignal>
        zeroOpenSlugs: ReadonlySet<string>
      }
    | undefined
  readonly store: BundleStore
  private readonly getConfig: () => TopicsConfigValue
  readonly sync?: Sync

  constructor(store: BundleStore, getConfig: () => TopicsConfigValue, sync?: Sync) {
    this.store = store
    this.getConfig = getConfig
    this.sync = sync
  }

  get cfg(): TopicsConfigValue {
    return this.getConfig()
  }

  get githubMode(): boolean {
    return this.cfg.repo !== ''
  }

  /** All retrievable topics with conclusion text, mtime-cached. */
  async roster(): Promise<RetrievableTopic[]> {
    let files: string[]
    try {
      files = (await this.store.listTopics()).map((m) => `${m.slug}.md`)
    } catch {
      return []
    }
    const out: RetrievableTopic[] = []
    for (const file of files) {
      const path = join(this.store.topicsDir(), file)
      let st
      try {
        st = await stat(path)
      } catch {
        continue
      }
      const cached = this.cache.get(file)
      let entry = cached
      if (cached === undefined || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
        try {
          const doc = okf.parseTopicDoc(await readFile(path, 'utf8'))
          entry = { mtimeMs: st.mtimeMs, size: st.size, doc, slug: file.slice(0, -3) }
          this.cache.set(file, entry)
        } catch {
          this.cache.delete(file)
          continue
        }
      }
      if (entry === undefined) continue
      const doc = entry.doc
      // Deprecated topics are retired knowledge (consolidation merges and
      // manual deprecations) — they must not rank, inject, or feed the
      // depends-graph walk, or a merged-away entry would keep competing
      // with its survivor for the injection budget.
      if (doc.fm.status === 'deprecated') continue
      // Lesson-kind entries (B2) never ride the topic pipeline — they have
      // their own gate (lessonInject), confidence rule and scope filter in
      // lessonsSync(). Gate-independent separation: even with lessonInject
      // off, a hint lesson must not leak through the topic lexical lane.
      if (okf.topicKindOf(doc.fm.type) === 'lesson') continue
      out.push({
        slug: entry.slug,
        title: doc.fm.title,
        description: doc.fm.description,
        status: doc.fm.status,
        tags: doc.fm.tags,
        triggers: doc.fm.triggers,
        depends: doc.fm.depends,
        links: okf.bodyLinkSlugs(doc.body),
        generatedAt: doc.fm.generated.at,
        conclusion: okf.sectionOf(doc.body, okf.CONCLUSION_HEADING) ?? '',
      })
    }
    return out
  }

  /** Drop the roster cache (tests, bulk external edits). */
  invalidate(): void {
    this.cache.clear()
    this.echoCache = undefined
    this.logSignalsCache = undefined
  }

  /**
   * Slugs distilled from THIS session's own turns — the echo set (2026-09
   * audit finding #3: a topic distilled from in-session knowledge injected
   * back into the same session is a lagging echo of what the model already
   * said, occasionally stale enough to contradict the newer in-session
   * conclusion). Provenance is durable in the observations log: each line
   * carries `sessionId` and, once distilled, `distilledInto`. Sync read on
   * the injection hot path, mtime-cached like the roster.
   */
  echoSlugsSync(sessionId: string): Set<string> {
    const file = join(this.store.metaDir(), 'observations.jsonl')
    let st
    try {
      st = statSync(file)
    } catch {
      return new Set()
    }
    let bySession = this.echoCache
    if (bySession === undefined || bySession.mtimeMs !== st.mtimeMs || bySession.size !== st.size) {
      bySession = { mtimeMs: st.mtimeMs, size: st.size, bySession: new Map() }
      try {
        const lines = readFileSync(file, 'utf8').split('\n')
        for (const line of lines) {
          if (line.trim() === '') continue
          let obs: { sessionId?: unknown; distilled?: unknown; distilledInto?: unknown }
          try {
            obs = JSON.parse(line)
          } catch {
            continue // torn tail line
          }
          if (obs.distilled !== true || typeof obs.sessionId !== 'string' || !Array.isArray(obs.distilledInto)) continue
          let set = bySession.bySession.get(obs.sessionId)
          if (set === undefined) {
            set = new Set()
            bySession.bySession.set(obs.sessionId, set)
          }
          for (const slug of obs.distilledInto) {
            if (typeof slug === 'string' && slug !== '') set.add(okf.slugify(slug))
          }
        }
      } catch {
        return new Set() // unreadable log: fail open (no suppression)
      }
      this.echoCache = bySession
    }
    return bySession.bySession.get(sessionId) ?? new Set()
  }

  /**
   * Usage signals (ADR 0015): mtime-cached aggregate over the injection log
   * and the opens log, rolling USAGE_WINDOW_DAYS. Synchronous like
   * echoSlugsSync — the retrieval hot path is sync — and cheap when warm:
   * a fresh cache costs two stat() calls, one read of each log, and feeds
   * the zero-open set from the same parse. Unreadable logs fail open to an
   * empty map (no boost), never an error.
   */
  usageSignalsSync(): Map<string, UsageSignal> {
    return this.logSignalsSync().signals
  }

  /**
   * Zero-open slug set for the decay (v5): the shared aggregateZeroOpen
   * rule over the injection tail and the whole opens log (compacted, so a
   * full read stays small). Shares one cache and one parse with
   * usageSignalsSync; unreadable logs fail open to an empty set (no
   * decay), never an error. Only called when zeroOpenDecay is on.
   */
  zeroOpenSlugsSync(): ReadonlySet<string> {
    return this.logSignalsSync().zeroOpenSlugs
  }

  /**
   * The one shared feedback-log read behind both signals: stat both files
   * (mtime+size quartet key), parse the injections TAIL only
   * (ZERO_OPEN_TAIL rounds comfortably cover both 30-day windows) and the
   * opens log whole (the zero-open rule is whole-history), then feed the
   * two pure aggregates from that single parse. A failed read still fails
   * open to empty inputs but NEVER populates the cache (N1) — otherwise a
   * stat-success/read-failure race would freeze an empty snapshot until
   * the next append.
   */
  private logSignalsSync(): { signals: Map<string, UsageSignal>; zeroOpenSlugs: ReadonlySet<string> } {
    const injFile = join(this.store.metaDir(), 'injections.jsonl')
    const opensFile = join(this.store.metaDir(), 'opens.jsonl')
    const statOf = (file: string): { mtimeMs: number; size: number } => {
      try {
        const st = statSync(file)
        return { mtimeMs: st.mtimeMs, size: st.size }
      } catch {
        return { mtimeMs: 0, size: 0 }
      }
    }
    const injSt = statOf(injFile)
    const opensSt = statOf(opensFile)
    const cached = this.logSignalsCache
    if (
      cached !== undefined &&
      cached.injMs === injSt.mtimeMs &&
      cached.injSize === injSt.size &&
      cached.opensMs === opensSt.mtimeMs &&
      cached.opensSize === opensSt.size
    ) {
      return cached
    }
    const injLines = readLogLinesSync(injFile)
    const opensLines = readLogLinesSync(opensFile)
    const injections = parseJsonlLinesSync<InjectionRecord>(injLines ?? [], ZERO_OPEN_TAIL)
    const opens = parseJsonlLinesSync<OpenRecord>(opensLines ?? [])
    const now = Date.now()
    const signals = aggregateUsage(injections, opens, USAGE_WINDOW_DAYS, now)
    const zeroOpenSlugs: ReadonlySet<string> = new Set(aggregateZeroOpen(injections, opens, now).keys())
    if (injLines !== undefined && opensLines !== undefined) {
      this.logSignalsCache = {
        injMs: injSt.mtimeMs,
        injSize: injSt.size,
        opensMs: opensSt.mtimeMs,
        opensSize: opensSt.size,
        signals,
        zeroOpenSlugs,
      }
    }
    return { signals, zeroOpenSlugs }
  }

  /**
   * zeroOpenDecay fields for scoring calls: empty when the gate is off —
   * no file reads, zero behavior change — and the shared mtime-cached set
   * when on. Spread into every searchTopics/scoreTopic cfg that already
   * carries the usage signals (injection paths + explicit topic_search;
   * the slow lane's recall band stays untouched, mirroring usageBoost).
   */
  private zeroOpenCfg(): Pick<RetrievalConfig, 'zeroOpenDecay' | 'zeroOpenSlugs'> {
    if (this.cfg.zeroOpenDecay !== true) return {}
    return { zeroOpenDecay: true, zeroOpenSlugs: this.zeroOpenSlugsSync() }
  }

  /** mtime-cached view of meta/embeddings.json (sync read — hot-lane caller).
   *  Missing/corrupt index = {} → the reranker degrades to lexical order. */
  private embedIndexCache: { mtimeMs: number; size: number; index: EmbeddingIndex } | undefined

  private embeddingIndexCacheGet(): EmbeddingIndex {
    const root = resolveBundleRoot()
    const file = join(root, 'meta', 'embeddings.json')
    try {
      const st = statSync(file)
      if (this.embedIndexCache !== undefined && this.embedIndexCache.mtimeMs === st.mtimeMs && this.embedIndexCache.size === st.size) {
        return this.embedIndexCache.index
      }
      const index = loadEmbeddingIndex(root)
      this.embedIndexCache = { mtimeMs: st.mtimeMs, size: st.size, index }
      return index
    } catch {
      return this.embedIndexCache?.index ?? {}
    }
  }

  /** Shadow bypass ledger (spec §8.3): one line per shadow round — feature
   *  fields only, never query text (jev-log discipline). Silent on failure;
   *  512KB truncation keeps the newest three quarters. Shared by the package
   *  shadow (meta/package-shadow.jsonl) and the lesson shadow (B2,
   *  meta/lesson-shadow.jsonl). */
  private appendShadowLedger(file: string, entry: Record<string, unknown>): void {
    try {
      let lines: string[] = []
      try {
        const st = statSync(file)
        const all = readFileSync(file, 'utf8').split('\n').filter((l) => l !== '')
        // Append, never clobber: existing lines are always carried forward;
        // compaction (keep newest 3/4) only bites past the 512KB cap.
        lines = st.size > 512 * 1024 ? all.slice(Math.floor(all.length / 4)) : all
      } catch { /* first write */ }
      lines.push(JSON.stringify(entry))
      writeFileSync(file, lines.join('\n') + '\n')
    } catch { /* ledger must never break the lane */ }
  }

  private packageShadowLedgerPath(): string {
    return join(resolveBundleRoot(), 'meta', 'package-shadow.jsonl')
  }

  private lessonShadowLedgerPath(): string {
    return join(resolveBundleRoot(), 'meta', 'lesson-shadow.jsonl')
  }

  /** Boot-time embedding index maintenance (spec §3: boot 校验+增量重建).
   *  Provider '' or packageMode off → no-op (default-off byte-for-byte).
   *  Full-roster embed on rebuild (A1 §5: ~9.5s for 137 topics). */
  async refreshEmbeddingIndex(): Promise<void> {
    const provider = (this.cfg.embeddingProvider ?? '').trim()
    if (provider === '' || this.cfg.packageMode === undefined || this.cfg.packageMode === 'off') return
    const embedder = embedderWith({ provider, model: this.cfg.embeddingModel })
    const topics = await this.roster()
    const root = resolveBundleRoot()
    const index = loadEmbeddingIndex(root)
    const stale = ensureIndexFresh(index, topics, embedder)
    if (stale.length === 0) return
    const docs = await Promise.all(stale.map(async (slug) => (await this.readDoc(slug)) ?? ''))
    const texts = stale.map((slug, i) => `${slug}\n${docs[i] ?? ''}`)
    const r = await embedTexts(texts, { provider, model: this.cfg.embeddingModel })
    if (!r.ok) return
    const next: EmbeddingIndex = { ...index }
    stale.forEach((slug, i) => {
      const vec = r.vectors[i]
      if (vec !== undefined) next[slug] = { model: r.model, dim: vec.length, vec }
    })
    saveEmbeddingIndex(root, next)
    this.embedIndexCache = undefined
  }

  /**
   * Full retrieval round: search → assemble → log (ADR 0006/0007). The
   * injection record is written even for zero-hit rounds — the hit-rate
   * denominator must count every round (near-miss evidence).
   */
  async retrieve(query: string, sessionId?: string): Promise<RetrieveOutcome> {
    const cfg = this.cfg
    const roster = await this.roster()
    if (!cfg.autoInject || query.trim() === '' || roster.length === 0) {
      return {
        outcome: { hits: [], nearMisses: [], rosterSize: roster.length },
        injection: { text: '', usedTokens: 0, included: [], dropped: [] },
        recorded: false,
      }
    }
    const conflicts = await this.store.getConflicts()
    const outcome = searchTopics(query, roster, {
      threshold: cfg.matchThreshold,
      topK: cfg.topK,
      tagBoost: cfg.tagBoost,
      graphDepth: cfg.graphDepth,
      recencyWindowDays: cfg.recencyWindowDays,
      conflicts,
      usageBoost: cfg.usageBoost,
      usage: this.usageSignalsSync(),
      ...this.zeroOpenCfg(),
    })
    const bySlug = new Map(roster.map((r) => [r.slug, r]))
    const entries: DigestInput[] = []
    for (const hit of outcome.hits) {
      const topic = bySlug.get(hit.slug)
      if (topic === undefined) continue
      const doc = await this.readDoc(hit.slug)
      if (doc !== undefined) entries.push({ slug: hit.slug, doc, hit })
    }
    const injection =
      cfg.injectMode !== 'digest'
        ? assemblePointer(entries, { perTopicBudget: POINTER_PER_TOPIC, totalBudget: Math.min(cfg.totalBudget, POINTER_TOTAL) })
        : assembleInjection(entries, {
            perTopicBudget: cfg.perTopicBudget,
            totalBudget: cfg.totalBudget,
          })
    const record: InjectionRecord = {
      at: new Date().toISOString(),
      queryTokenCount: tokenize(query).length,
      querySample: querySample(query),
      rosterSize: outcome.rosterSize,
      hits: outcome.hits.map((h) => ({ slug: h.slug, score: h.score, reasons: h.reasons, viaGraph: h.viaGraph })),
      nearMisses: outcome.nearMisses.map((h) => ({ slug: h.slug, score: h.score })),
      injected: injection.text !== '',
      usedTokens: injection.usedTokens,
    }
    if (sessionId !== undefined) record.sessionId = sessionId
    if (injection.text === '' && outcome.hits.length > 0) record.why = 'below-budget-or-dropped'
    if (inclusionDropped(injection)) record.dropped = injection.dropped
    await this.store.appendInjectionRecord(record)
    return { outcome, injection, recorded: true }
  }

  /**
   * SYNCHRONOUS hot path for same-turn injection (the chancelu lesson):
   * `agent/inbox/spliced` dispatches before prompt assembly and the context
   * provider reads the assembled text synchronously — an async retrieval
   * would always lose the race and inject nothing. Reads files with sync fs
   * behind the mtime cache; the log record is written fire-and-forget.
   *
   * `dedup.exclude` (session-level injection dedup) filters hits AND slow
   * picks before assembly; excluded slugs are reported back as `deduped`
   * (and logged as `record.deduped`), never packed. `dedup.echo` (蒸馏回声,
   * v4 audit) filters the same way but reports separately as `echoed` /
   * `record.echoed`: slugs distilled from THIS session's own turns.
   * `included` mirrors the fast pointers that entered the context and
   * `slowIncluded` the slow ones — only these may be marked as injected by
   * the caller; budget-dropped slugs stay injectable later.
   *
   * `slow` (v4 §4.2) carries the consumed pending when one exists: picks are
   * packed after the fast pointers under the same budget, take log-only
   * shadow re-gate verdicts against the CURRENT query (B3: record, never
   * block), and fill the record's lane field family. A pick the fast lane
   * already delivers THIS round is counted as slow-delivered (it entered the
   * context) but not packed twice.
   */
  retrieveSync(query: string, sessionId?: string, dedup?: { exclude?: ReadonlySet<string>; echo?: ReadonlySet<string> }, slow?: SlowDelivery, slowExpired?: 'ttl' | 'turn-lag'): { text: string; outcome: SearchOutcome; deduped: string[]; echoed: string[]; included: string[]; slowIncluded: string[]; lessonIncluded: string[] } {
    const cfg = this.cfg
    const roster = this.rosterSync()
    const empty: SearchOutcome = { hits: [], nearMisses: [], rosterSize: roster.length }
    // Lesson gate (B2): established lessons are INDEPENDENT of the topic
    // roster — a lesson-only bundle still injects lessons. The roster read is
    // shared with the matching block below; gate off → no read at all.
    const lessonGate: 'shadow' | 'on' | undefined =
      cfg.lessonInject === 'shadow' || cfg.lessonInject === 'on' ? cfg.lessonInject : undefined
    const lessonRoster = lessonGate !== undefined ? this.lessonsSync() : []
    if (!cfg.autoInject || query.trim() === '' || (roster.length === 0 && lessonRoster.length === 0)) {
      // A consumed/expired pending must always leave an ilog trace (ADR 0014:
      // 过期/消费都写 ilog) — even when the fast path early-returns here
      // because the roster vanished between production and consumption.
      if (cfg.autoInject && query.trim() !== '' && (slow !== undefined || slowExpired !== undefined)) {
        const trace: InjectionRecord = {
          at: new Date().toISOString(),
          queryTokenCount: tokenize(query).length,
          querySample: querySample(query),
          rosterSize: roster.length,
          hits: [],
          nearMisses: [],
          injected: false,
          why: slowExpired !== undefined ? `slow-expired-${slowExpired}` : 'slow-no-roster',
          lane: 'slow',
        }
        if (sessionId !== undefined) trace.sessionId = sessionId
        if (slowExpired !== undefined) trace.slowExpired = slowExpired
        if (slow !== undefined) {
          trace.computedAt = slow.computedAt
          trace.queryBuild = slow.queryBuild
          trace.slowModel = slow.model
          trace.slowMs = slow.ms
          trace.slow = []
        }
        void this.store.appendInjectionRecord(trace).catch(() => undefined)
      }
      return { text: '', outcome: empty, deduped: [], echoed: [], included: [], slowIncluded: [], lessonIncluded: [] }
    }
    // A-line gate (A3/A4): query cleaning + package + semantic rerank ride
    // behind packageMode (default off = byte-for-byte legacy path).
    const pkgMode: 'shadow' | 'on' | undefined =
      cfg.packageMode === 'shadow' || cfg.packageMode === 'on' ? cfg.packageMode : undefined
    const effectiveQuery = pkgMode !== undefined ? sanitizeQuery(query) : query
    const conflicts = this.store.getConflictsSync()
    const outcome = searchTopics(effectiveQuery, roster, {
      threshold: cfg.matchThreshold,
      topK: cfg.topK,
      tagBoost: cfg.tagBoost,
      graphDepth: cfg.graphDepth,
      recencyWindowDays: cfg.recencyWindowDays,
      conflicts,
      usageBoost: cfg.usageBoost,
      usage: this.usageSignalsSync(),
      ...this.zeroOpenCfg(),
    })
    // ---- A-line semantic rerank (A4 决议 2, spec §3.1) ----
    // Reorder ONLY the 0.20–0.30 nearFloor band (the 93% near-miss mass);
    // thresholds/gateScore/hits untouched. Any failure degrades to the
    // original order — the fast lane never blocks on the semantic layer.
    let nearFloorRerank: { reranked: boolean; passthroughReason?: string; orderBefore: string[]; orderAfter: string[] } | undefined
    if (pkgMode !== undefined) {
      const bandLo = 0.2
      const band = outcome.nearMisses.filter((h) => h.score >= bandLo && h.score < cfg.matchThreshold)
      const orderBefore = band.map((h) => h.slug)
      if (band.length > 1) {
        const index = this.embeddingIndexCacheGet()
        const models = new Set(Object.values(index).map((e) => e.model))
        const embedModel = resolveEmbedModel(cfg.embeddingModel)
        if (models.size <= 1 && (models.size === 0 || models.has(embedModel))) {
          const qv = embedQuerySync(effectiveQuery, { provider: cfg.embeddingProvider, model: cfg.embeddingModel })
          const rr = rerankNearFloor(effectiveQuery, qv.ok ? qv.vector : null, band, index)
          if (rr.reranked) {
            const inBand = (h: { score: number }) => h.score >= bandLo && h.score < cfg.matchThreshold
            const rrSlugs = new Set(rr.hits.map((h) => h.slug))
            const merged = [...rr.hits, ...band.filter((h) => !rrSlugs.has(h.slug))]
            let mi = 0
            outcome.nearMisses = outcome.nearMisses.map((h) => (inBand(h) ? merged[mi++]! : h))
            nearFloorRerank = { reranked: true, orderBefore, orderAfter: merged.map((h) => h.slug) }
          } else {
            nearFloorRerank = { reranked: false, passthroughReason: rr.passthroughReason, orderBefore, orderAfter: orderBefore }
          }
        }
      }
    }
    const exclude = dedup?.exclude
    const echo = dedup?.echo
    const deduped = exclude === undefined ? [] : outcome.hits.filter((h) => exclude.has(h.slug)).map((h) => h.slug)
    const echoed: string[] = []
    const bySlug = new Map(roster.map((r) => [r.slug, r]))
    const entries: DigestInput[] = []
    const unreadable: string[] = []
    for (const hit of outcome.hits) {
      if (exclude?.has(hit.slug)) continue
      if (echo?.has(hit.slug)) {
        echoed.push(hit.slug)
        continue
      }
      const doc = this.readDocSync(hit.slug)
      if (doc === undefined) {
        // The hit has no readable doc — without this accounting it used to
        // vanish from `included` AND `dropped` (v4 design §2 疑点).
        unreadable.push(hit.slug)
        continue
      }
      entries.push({ slug: hit.slug, doc, hit })
    }
    // ---- Lesson gate (B2, spec 卷一 §6.3): established lessons only (MJ-3:
    // hint never injects), trigger-channel match = 条件命中 (triggers carry
    // the condition), top-1 by score. No hit → no lesson (教训不撒背景网).
    // dedup/echo follow the same rules as topics. ----
    let lessonMatch: { pointer: LessonPointerInput; reasons: string[]; conclusion: string } | undefined
    if (lessonGate !== undefined && lessonRoster.length > 0) {
      const qTokens = new Set(tokenize(effectiveQuery))
      let best: { l: (typeof lessonRoster)[number]; v: ScoredTopic } | undefined
      for (const l of lessonRoster) {
        if (exclude?.has(l.slug)) {
          if (!deduped.includes(l.slug)) deduped.push(l.slug)
          continue
        }
        if (echo?.has(l.slug)) {
          if (!echoed.includes(l.slug)) echoed.push(l.slug)
          continue
        }
        const v = scoreTopic(qTokens, l, {
          threshold: cfg.matchThreshold,
          topK: cfg.topK,
          tagBoost: cfg.tagBoost,
          graphDepth: 0,
          recencyWindowDays: cfg.recencyWindowDays,
          conflicts,
          structuralGate: true,
          usageBoost: cfg.usageBoost,
          usage: this.usageSignalsSync(),
          ...this.zeroOpenCfg(),
        })
        if (!v.reasons.some((r) => r.startsWith('triggers:'))) continue
        if (best === undefined || v.score > best.v.score) best = { l, v }
      }
      if (best !== undefined) {
        lessonMatch = {
          pointer: {
            slug: best.l.slug,
            title: best.l.title,
            status: best.l.status,
            description: best.l.description,
            score: best.v.score,
            source: best.l.source,
          },
          reasons: best.v.reasons,
          conclusion: best.l.conclusion,
        }
      }
    }
    // MJ-C combination matrix: lesson injection does not depend on the A3
    // package gray-release. While the emitted shape is a flat list (digest
    // mode, pointer mode without the package, AND the package-shadow legacy
    // emit), lessons ride it as flat entries with the source marker; only a
    // live package (packageMode on) gives them the direct-layer priority seat.
    const lessonFlat: LessonPointerInput[] | undefined =
      lessonGate === 'on' && lessonMatch !== undefined ? [lessonMatch.pointer] : undefined
    // ---- Slow-lane merge (log-only shadow gate; consumption bookkeeping) ----
    const slowPointers: SlowPointerInput[] = []
    const slowDelivered: SlowItem[] = []
    const shadow: ShadowVerdict[] = []
    let slowIncluded: string[] = []
    const consumedAt = new Date().toISOString()
    if (slow !== undefined) {
      const queryTokens = new Set(tokenize(effectiveQuery))
      for (const item of slow.items) {
        if (exclude?.has(item.slug)) {
          if (!deduped.includes(item.slug)) deduped.push(item.slug)
          continue
        }
        if (echo?.has(item.slug)) {
          if (!echoed.includes(item.slug)) echoed.push(item.slug)
          continue
        }
        const meta = bySlug.get(item.slug)
        if (meta === undefined) continue // vanished between production and consumption
        if (entries.some((e) => e.slug === item.slug)) {
          // The fast lane delivers the same slug THIS round — the content
          // enters the context exactly once (never packed twice), and the
          // pick still counts as delivered for the lane bookkeeping.
          slowDelivered.push({ slug: item.slug, why: item.why })
          continue
        }
        const verdict = scoreTopic(queryTokens, meta, {
          threshold: cfg.matchThreshold,
          topK: cfg.topK,
          tagBoost: cfg.tagBoost,
          graphDepth: cfg.graphDepth,
          recencyWindowDays: cfg.recencyWindowDays,
          conflicts,
          structuralGate: true,
          usageBoost: cfg.usageBoost,
          usage: this.usageSignalsSync(),
          ...this.zeroOpenCfg(),
        })
        shadow.push({
          slug: item.slug,
          pass: passesGate(verdict),
          why: verdict.strong ? `strong:${verdict.reasons[0] ?? 'field'}` : `body-hits:${verdict.bodyHits}`,
        })
        slowPointers.push({
          slug: item.slug,
          title: meta.title,
          status: meta.status,
          description: meta.description,
          why: item.why,
        })
      }
    }
    const pointerMode = cfg.injectMode !== 'digest'
    // Pointer budget: per-entry fixed at the design's 80, total clamped to the
    // fast-lane upper bound of 600 (I4) — totalBudget stays tunable downward.
    let packageSkipped = false
    let packageShadow: PackageResult | null | undefined
    let injection: AssembleResult
    if (!pointerMode) {
      injection = assembleInjection(entries, { perTopicBudget: cfg.perTopicBudget, totalBudget: cfg.totalBudget }, slowPointers, lessonFlat)
    } else if (pkgMode === undefined) {
      injection = assemblePointer(entries, { perTopicBudget: POINTER_PER_TOPIC, totalBudget: Math.min(cfg.totalBudget, POINTER_TOTAL) }, slowPointers, lessonFlat)
    } else {
      // A-line relevance package (A3, spec §2): direct = lexical hits,
      // neighborhood = graph hits + slow picks, weak = reranked band head.
      const budget = { perTopicBudget: POINTER_PER_TOPIC, totalBudget: Math.min(cfg.totalBudget, POINTER_TOTAL) }
      const legacy = assemblePointer(entries, budget, slowPointers, lessonFlat)
      const direct: PackageCandidate[] = []
      const neighborhood: PackageCandidate[] = []
      for (const e of entries) {
        const meta = bySlug.get(e.slug)
        const cand: PackageCandidate = {
          slug: e.slug,
          title: meta?.title ?? e.slug,
          status: meta?.status ?? 'draft',
          description: meta?.description,
          conclusion: firstContentLine(e.doc.body),
          score: e.hit.score,
          reasons: e.hit.reasons,
          via: e.hit.viaGraph ? 'graph' : undefined,
        }
        ;(e.hit.viaGraph ? neighborhood : direct).push(cand)
      }
      // Lesson priority seat (B2, spec 卷一 §6.3): 主层 ≤2 席中命中 lesson
      // 至少 1 席 — sorts first and is exempt from the direct-seat cap
      // (budget-bound). Only on the LIVE package leg; the legacy emit above
      // carries the flat lesson entry instead (MJ-C).
      if (lessonFlat !== undefined && lessonMatch !== undefined) {
        direct.unshift({
          slug: lessonMatch.pointer.slug,
          title: lessonMatch.pointer.title,
          status: lessonMatch.pointer.status,
          description: lessonMatch.pointer.description,
          conclusion: firstContentLine(lessonMatch.conclusion),
          score: lessonMatch.pointer.score,
          reasons: lessonMatch.reasons,
          prioritySeat: true,
          sourceTag: lessonSourceTag(lessonMatch.pointer.source),
        })
      }
      for (const sp of slowPointers) {
        neighborhood.push({ slug: sp.slug, title: sp.title, status: sp.status, description: sp.description, score: 0, reasons: [], via: 'slow-pick' })
      }
      const weak = outcome.nearMisses
        .filter((h) => h.score >= 0.2 && h.score < cfg.matchThreshold)
        .slice(0, 2)
        .map((h) => {
          const meta = bySlug.get(h.slug)
          return { slug: h.slug, title: meta?.title ?? h.slug, status: meta?.status ?? 'draft', score: h.score, reasons: h.reasons, via: 'weak' }
        })
      const usage = this.usageSignalsSync()
      const usageBySlug = new Map<string, number>([...usage].map(([slug, sig]) => [slug, sig.opens * 3 + sig.hits]))
      const pkgInput: PackageInput = { query: effectiveQuery, queryTokens: tokenize(effectiveQuery), direct, neighborhood, weak, usageBySlug }
      const pkg = assemblePackage(pkgInput)
      if (pkgMode === 'shadow') {
        packageShadow = pkg
        injection = legacy
      } else if (pkg === null) {
        // Trivial-query downgrade (A3 决议 5): emit nothing, log the why.
        packageSkipped = true
        injection = { text: '', usedTokens: 0, included: [], dropped: [] }
      } else {
        const slowSet = new Set(slowPointers.map((sp) => sp.slug))
        injection = {
          text: pkg.text,
          usedTokens: pkg.usedTokens,
          included: pkg.included,
          dropped: pkg.dropped,
          slowIncluded: pkg.included.filter((slug) => slowSet.has(slug)),
        }
      }
    }
    slowIncluded = injection.slowIncluded ?? []
    for (const pointer of slowPointers) {
      if (slowIncluded.includes(pointer.slug)) slowDelivered.push({ slug: pointer.slug, why: pointer.why })
    }
    // ---- Lesson gate accounting (B2): what entered the context, the shadow
    // bypass ledger (meta/lesson-shadow.jsonl — lesson seat vs no-lesson
    // emitted disposition, same discipline as the package shadow), and the
    // record fields (absent when the gate is off or nothing matched). ----
    const lessonIncluded: string[] =
      lessonGate === 'on' && lessonMatch !== undefined
        ? injection.lessonIncluded ?? (injection.included.includes(lessonMatch.pointer.slug) ? [lessonMatch.pointer.slug] : [])
        : []
    const record: InjectionRecord = {
      at: new Date().toISOString(),
      queryTokenCount: tokenize(effectiveQuery).length,
      querySample: querySample(effectiveQuery),
      rosterSize: outcome.rosterSize,
      hits: outcome.hits.map((h) => ({ slug: h.slug, score: h.score, reasons: h.reasons, viaGraph: h.viaGraph, strong: h.strong, bodyHits: h.bodyHits })),
      // Reasons ride along: the gate-blocked marker is the replay evidence
      // the P3 threshold decision needs (ADR 0014).
      nearMisses: outcome.nearMisses.map((h) => ({ slug: h.slug, score: h.score, reasons: h.reasons })),
      injected: injection.text !== '',
      usedTokens: injection.usedTokens,
    }
    if (sessionId !== undefined) record.sessionId = sessionId
    if (deduped.length > 0) record.deduped = deduped
    if (echoed.length > 0) record.echoed = echoed
    if (packageSkipped) record.why = 'package-skipped-trivial'
    if (unreadable.length > 0) {
      record.dropped = [...(record.dropped ?? []), ...unreadable.map((slug) => ({ slug, reason: 'doc-unreadable' }))]
    }
    if (pkgMode === 'shadow' && pointerMode) {
      this.appendShadowLedger(this.packageShadowLedgerPath(), {
        at: record.at,
        ...(sessionId !== undefined ? { sessionId } : {}),
        queryTokenCount: record.queryTokenCount,
        emitted: { tokens: injection.usedTokens, included: injection.included },
        package:
          packageShadow === undefined
            ? null
            : packageShadow === null
              ? { skipped: 'trivial-or-empty' }
              : { tokens: packageShadow.usedTokens, included: packageShadow.included, layers: packageShadow.layers },
        nearFloorRerank: nearFloorRerank ?? null,
      })
    }
    if (lessonGate === 'shadow' && lessonMatch !== undefined) {
      const rendered = lessonEntryText(lessonMatch.pointer, POINTER_PER_TOPIC)
      const budgetTotal = pointerMode ? Math.min(cfg.totalBudget, POINTER_TOTAL) : cfg.totalBudget
      this.appendShadowLedger(this.lessonShadowLedgerPath(), {
        at: record.at,
        ...(sessionId !== undefined ? { sessionId } : {}),
        queryTokenCount: record.queryTokenCount,
        lessonInject: 'shadow',
        lessons: [
          {
            slug: lessonMatch.pointer.slug,
            score: lessonMatch.pointer.score,
            source: lessonMatch.pointer.source,
            entryTokens: rendered.usedTokens,
            wouldFit: injection.usedTokens + rendered.usedTokens <= budgetTotal,
          },
        ],
        emitted: { tokens: injection.usedTokens, included: injection.included },
      })
    }
    if (lessonGate !== undefined && lessonMatch !== undefined) {
      record.lessonInject = lessonGate
      record.lessons = [
        {
          slug: lessonMatch.pointer.slug,
          score: lessonMatch.pointer.score,
          source: lessonMatch.pointer.source,
          included: lessonIncluded.length > 0,
        },
      ]
    }
    if (slow !== undefined) {
      if (slow.outcome !== undefined) record.slowOutcome = slow.outcome
      // Any round whose pending was consumed is a slow-participating round —
      // lane never stays undefined when the lane family is present (a
      // delivered pick with fast pointers is 'mixed'; a consumed-but-empty
      // round beside fast pointers stays 'fast'; everything else 'slow').
      record.lane = slowDelivered.length > 0 ? (injection.included.length > 0 ? 'mixed' : 'slow') : injection.included.length > 0 ? 'fast' : 'slow'
      record.computedAt = slow.computedAt
      record.consumedAt = consumedAt
      if (shadow.length > 0) record.shadowVerdict = shadow
      record.queryBuild = slow.queryBuild
      record.slowModel = slow.model
      record.slowMs = slow.ms
      record.slow = slowDelivered
    }
    if (slowExpired !== undefined) {
      // Expiry is recorded INDEPENDENT of whether the fast lane injected —
      // the 赶上率 denominator must not lose rounds to a coincidental hit.
      record.slowExpired = slowExpired
      if (record.lane === undefined) record.lane = injection.text !== '' ? 'fast' : 'slow'
    }
    if (injection.text === '' && (outcome.hits.length > 0 || slowPointers.length > 0)) {
      // All hits deduped is a different story than a budget squeeze — say so.
      record.why = deduped.length === outcome.hits.length && outcome.hits.length > 0 ? 'dedup' : 'below-budget-or-dropped'
    } else if (injection.text === '' && slowExpired !== undefined) {
      // The pending died at its hard bounds (TTL / turn-lag) without ever
      // being delivered — the denominator the 赶上率 needs (v4 B4).
      record.why = `slow-expired-${slowExpired}`
    }
    if (slowExpired !== undefined && injection.text === '') record.lane = 'slow'
    if (injection.dropped.length > 0) record.dropped = [...(record.dropped ?? []), ...injection.dropped]
    void this.store.appendInjectionRecord(record).catch(() => undefined)
    return { text: injection.text, outcome, deduped, echoed, included: injection.included, slowIncluded, lessonIncluded }
  }

  /**
   * topic_open tool path (v4 §4.1): full conclusion / open questions /
   * recommendations plus the staleness notice timestamp (fm.generated.at —
   * the store stamps it on every write, so it IS the last-updated instant).
   * Logs an open record for the pointer-open-rate stat.
   */
  async openTopic(rawSlug: string, sessionId?: string): Promise<{
    found: boolean
    slug: string
    title?: string
    status?: okf.TopicStatus
    updatedAt?: string
    description?: string
    conclusion?: string
    openQuestions?: string[]
    recommendations?: string
  }> {
    // Pointers render slugs as `(topics:<slug>)` and models copy that whole
    // token back as the argument — unwrap every `topics:`/`topics/` wrap the
    // same way the depends edges do (audit ⑨: the wrapped form read as a
    // missing topic). Then CANONICALIZE with the save path's own slugify:
    // unwrap alone is case-preserving, and on a case-sensitive filesystem
    // (Linux bundles) an uppercase-carrying argument would miss the file the
    // save path wrote under its folded slug (CI-caught, v0.11.0 round 1).
    const slug = okf.slugify(okf.unwrapTopicRef(rawSlug))
    const doc = slug === '' ? undefined : await this.store.readTopic(slug).catch(() => undefined)
    if (doc === undefined) return { found: false, slug }
    // Awaited (tool path, not hot): a settled write makes the pointer-open
    // stat reliable; a failed log write must not fail the tool. Source
    // attribution rides the same write: a cheap injections-tail scan decides
    // pointer vs search and, for pointers, carries the hit score and the
    // open→injection lag (ilog.attributeOpen).
    const at = new Date().toISOString()
    const attribution = await this.attributeOpen(slug, sessionId, Date.parse(at))
    await this.store
      .appendOpenRecord({ slug, at, ...(sessionId !== undefined ? { sessionId } : {}), ...attribution })
      .catch(() => undefined)
    // Optional fields are OMITTED, never present-as-undefined: the host's
    // tool-output validation rejects any object carrying an undefined-valued
    // key as non-lossless JSON (INVALID_TOOL_OUTPUT; audit ②⑦ — topics
    // without a description made every open of them fail).
    const found: {
      found: boolean
      slug: string
      title: string
      status: okf.TopicStatus
      updatedAt: string
      description?: string
      conclusion: string
      openQuestions: string[]
      recommendations: string
    } = {
      found: true,
      slug,
      title: doc.fm.title,
      status: doc.fm.status,
      updatedAt: doc.fm.generated.at,
      conclusion: okf.sectionOf(doc.body, okf.CONCLUSION_HEADING) ?? '',
      openQuestions: doc.fm.open_questions,
      recommendations: okf.sectionOf(doc.body, okf.RECOMMENDATIONS_HEADING) ?? '',
    }
    if (doc.fm.description !== undefined) found.description = doc.fm.description
    return found
  }

  /**
   * Resolve the open's source attribution: the injections tail (bounded by
   * OPEN_ATTRIBUTION_TAIL) scanned for a same-session hit within the
   * attribution window. Read failures degrade to 'search' — attribution is
   * telemetry, never a blocker.
   */
  private async attributeOpen(slug: string, sessionId: string | undefined, nowMs: number): Promise<{ source: 'pointer' | 'search'; score?: number; sinceInjectionMs?: number }> {
    if (sessionId === undefined) return { source: 'search' }
    const tail = await this.store.readInjectionRecords(OPEN_ATTRIBUTION_TAIL).catch(() => [])
    return attributeOpen(tail, slug, sessionId, nowMs)
  }

  /** Sync roster read (same mtime cache as roster()). */
  rosterSync(): RetrievableTopic[] {
    let files: string[]
    try {
      files = readdirSync(this.store.topicsDir())
    } catch {
      return []
    }
    const out: RetrievableTopic[] = []
    for (const file of files) {
      if (!file.endsWith('.md') || file === 'index.md') continue
      const path = join(this.store.topicsDir(), file)
      let st
      try {
        st = statSync(path)
      } catch {
        continue
      }
      const cached = this.cache.get(file)
      let entry = cached
      if (cached === undefined || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
        try {
          const doc = okf.parseTopicDoc(readFileSync(path, 'utf8'))
          entry = { mtimeMs: st.mtimeMs, size: st.size, doc, slug: file.slice(0, -3) }
          this.cache.set(file, entry)
        } catch {
          this.cache.delete(file)
          continue
        }
      }
      if (entry === undefined) continue
      const doc = entry.doc
      // Same retirement rule as roster(): deprecated knowledge never injects.
      if (doc.fm.status === 'deprecated') continue
      // Same lesson separation as roster() (B2): lessons inject only through
      // the lessonInject gate, never the topic lane.
      if (okf.topicKindOf(doc.fm.type) === 'lesson') continue
      out.push({
        slug: entry.slug,
        title: doc.fm.title,
        description: doc.fm.description,
        status: doc.fm.status,
        tags: doc.fm.tags,
        triggers: doc.fm.triggers,
        depends: doc.fm.depends,
        links: okf.bodyLinkSlugs(doc.body),
        generatedAt: doc.fm.generated.at,
        conclusion: okf.sectionOf(doc.body, okf.CONCLUSION_HEADING) ?? '',
      })
    }
    return out
  }

  /** Established, scope-passing lesson entries (B2, spec 卷一 §6.3) — sync,
   *  sharing the roster's mtime cache. Injection reads ONLY established
   *  lessons here (MJ-3: hint 仅供审批队列展示，永不注入); scope filter =
   *  workspace lessons must carry the current workspace id (MJ-2); scope=global
   *  and legacy entries without a workspaceId pass (fail-open — the filter's
   *  default is permissive, the confidence gate is the hard one). */
  lessonsSync(): (RetrievableTopic & { confidence: okf.LessonConfidence; source: okf.LessonSource; scope: okf.LessonScope; workspaceId?: string })[] {
    const ws = currentWorkspaceId()
    let files: string[]
    try {
      files = readdirSync(this.store.topicsDir())
    } catch {
      return []
    }
    const out: (RetrievableTopic & { confidence: okf.LessonConfidence; source: okf.LessonSource; scope: okf.LessonScope; workspaceId?: string })[] = []
    for (const file of files) {
      if (!file.endsWith('.md') || file === 'index.md') continue
      const path = join(this.store.topicsDir(), file)
      let st
      try {
        st = statSync(path)
      } catch {
        continue
      }
      const cached = this.cache.get(file)
      let entry = cached
      if (cached === undefined || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
        try {
          const doc = okf.parseTopicDoc(readFileSync(path, 'utf8'))
          entry = { mtimeMs: st.mtimeMs, size: st.size, doc, slug: file.slice(0, -3) }
          this.cache.set(file, entry)
        } catch {
          this.cache.delete(file)
          continue
        }
      }
      if (entry === undefined) continue
      const fm = entry.doc.fm
      if (okf.topicKindOf(fm.type) !== 'lesson') continue
      // Confidence 事实源：established ⇄ stable；deprecated 已被上面的通用
      // 退休规则挡住，这里再兜一层（hint↔draft 永不注入）。
      if (fm.confidence !== 'established' || fm.status === 'deprecated') continue
      if (fm.scope === 'workspace' && fm.workspaceId !== undefined && fm.workspaceId !== ws) continue
      out.push({
        slug: entry.slug,
        title: fm.title,
        description: fm.description,
        status: fm.status,
        tags: fm.tags,
        triggers: fm.triggers,
        depends: fm.depends,
        links: okf.bodyLinkSlugs(entry.doc.body),
        generatedAt: fm.generated.at,
        conclusion: okf.sectionOf(entry.doc.body, okf.CONCLUSION_HEADING) ?? '',
        confidence: fm.confidence,
        source: fm.source ?? 'manual',
        scope: fm.scope ?? 'workspace',
        ...(fm.workspaceId !== undefined ? { workspaceId: fm.workspaceId } : {}),
      })
    }
    return out
  }

  private readDocSync(slug: string): okf.TopicDoc | undefined {
    try {
      return okf.parseTopicDoc(readFileSync(join(this.store.topicsDir(), `${slug}.md`), 'utf8'))
    } catch {
      return undefined
    }
  }

  private async readDoc(slug: string): Promise<okf.TopicDoc | undefined> {
    try {
      return await this.store.readTopic(slug)
    } catch {
      return undefined
    }
  }

  /** topic_save tool path: create or update with actor stamping. `kind:
   *  'lesson'` (B2 data plane) switches the OKF type to Lesson and stamps the
   *  lesson frontmatter (scope/confidence/source/workspaceId) with the
   *  confidence↔status derivation (hint↔draft, established↔stable —
   *  confidence is the fact source). */
  async saveTopic(input: {
    title: string
    description?: string
    tags?: string[]
    triggers?: string[]
    depends?: string[]
    openQuestions?: string[]
    impact?: string[]
    /** A2 semantic-link targets; store.saveTopic lands them as body wikilinks. */
    links?: string[]
    status?: okf.TopicStatus
    conclusion?: string
    recommendations?: string
    source?: 'model' | 'distill'
    slug?: string
    /** B2 lesson data plane: entry kind (default topic). */
    kind?: okf.TopicKind
    scope?: okf.LessonScope
    confidence?: okf.LessonConfidence
    /** Lesson provenance (input.source above is the tool-path tag). */
    lessonSource?: okf.LessonSource
  }): Promise<SaveResult & { slug: string }> {
    const now = new Date().toISOString()
    const existing = input.slug !== undefined ? await this.store.readTopic(input.slug) : undefined
    let body = existing?.body ?? ''
    if (input.conclusion !== undefined && input.conclusion !== '') {
      body = okf.setSection(body, okf.CONCLUSION_HEADING, input.conclusion)
    } else if (existing === undefined) {
      body = okf.setSection(body, okf.CONCLUSION_HEADING, input.description ?? input.title)
    }
    if (input.recommendations !== undefined && input.recommendations !== '') {
      body = okf.setSection(body, okf.RECOMMENDATIONS_HEADING, input.recommendations)
    }
    const baseSlug = input.slug ?? okf.slugify(input.title)
    const slug = existing === undefined ? await this.store.uniqueSlug(baseSlug) : okf.slugify(input.slug ?? baseSlug)
    const isLesson = input.kind === 'lesson' || (existing !== undefined && okf.topicKindOf(existing.fm.type) === 'lesson')
    // store.saveTopic stamps generated {by, at} itself (write-through actor).
    const fm: okf.TopicFrontmatter = {
      type: isLesson ? okf.kindTypeValue('lesson') : okf.kindTypeValue('topic'),
      title: input.title,
      tags: dedupeLower(input.tags ?? existing?.fm.tags ?? []),
      // normalizeDependsEntry, never bare slugToPath: the preserved-on-update
      // fallback feeds already-canonical `topics/<slug>.md` entries back in,
      // and wrapping those again stacked one layer per save (the double-wrap
      // bug repaired on startup by BundleStore.repairDepends).
      depends: dedupePaths((input.depends ?? existing?.fm.depends ?? []).map(okf.normalizeDependsEntry)),
      open_questions: input.openQuestions ?? existing?.fm.open_questions ?? [],
      impact: input.impact ?? existing?.fm.impact ?? [],
      status: input.status ?? existing?.fm.status ?? 'draft',
      generated: existing?.fm.generated ?? { by: 'pending', at: now },
    }
    if (input.description !== undefined && input.description !== '') fm.description = input.description
    // Triggers pass through on create; on update the caller's value wins, else
    // the stored list survives (same preserve-on-update semantics as tags).
    const triggers = sanitizeTriggers(input.triggers ?? existing?.fm.triggers ?? [])
    if (triggers.length > 0) fm.triggers = triggers
    if (isLesson) {
      // B2 frontmatter (spec 卷一 §6.2): preserve-on-update like tags; the
      // workspace id is stamped AT WRITE TIME (MJ-2, cwd hash) and survives
      // updates; confidence is the FACT source → status derives from it,
      // except a deprecated lesson stays deprecated unless confidence is
      // explicitly re-driven (no silent revival through topic_save).
      fm.scope = input.scope ?? existing?.fm.scope ?? 'workspace'
      fm.confidence = input.confidence ?? existing?.fm.confidence ?? 'hint'
      fm.source = input.lessonSource ?? existing?.fm.source ?? 'manual'
      if (fm.scope === 'workspace') {
        const wsid = existing?.fm.workspaceId ?? currentWorkspaceId()
        if (wsid !== undefined) fm.workspaceId = wsid
      } else {
        delete fm.workspaceId
      }
      fm.status =
        existing?.fm.status === 'deprecated' && input.confidence === undefined
          ? 'deprecated'
          : okf.deriveLessonStatus(fm.confidence)
    }
    if (existing !== undefined && existing.fm.verified !== undefined) fm.verified = existing.fm.verified
    const result = await this.store.saveTopic(
      { slug, doc: { fm, body }, links: input.links },
      {
        message: existing === undefined ? `topics(${isLesson ? 'lesson' : 'topic'}): create ${slug}` : `topics(${isLesson ? 'lesson' : 'topic'}): update ${slug}`,
        created: existing === undefined,
      },
    )
    this.invalidate()
    void this.sync?.schedulePush()
    return { ...result, slug: result.slug }
  }

  async observe(input: { kind: Observation['kind']; text: string; sessionId?: string; source?: 'model' | 'auto' }): Promise<Observation> {
    return this.store.appendObservation({ kind: input.kind, source: input.source ?? 'model', text: input.text, sessionId: input.sessionId })
  }

  // -------------------------------------------------------------------------
  // Dual-write seams (卷二 §6.2 MJ-5) — the new repo's only write surface.
  // Both run behind the store lock / index recompute; both audit the caller
  // identity (opts.actor REQUIRED — a blank actor refuses the whole call and
  // lands a `seam-*` audit row) into meta/pipeline-events.jsonl.
  // -------------------------------------------------------------------------

  /**
   * ① 观察投喂: structured observations (B1 §2.1 whitelist, FEATURES ONLY —
   * 对话原文禁入, 红线⑤) appended to the observations stream with the `fed`
   * provenance marker and `kind: 'signal'`; each line carries `by: actor`.
   * The whitelist copy drops unknown caller fields, caps detail entries and
   * string sizes, and renders a sorted feature line as the observation text.
   * Duplicates (same type+session+detail in the recent tail) are counted, not
   * appended (重复观察由原仓去重). Fail-soft: one malformed entry is counted
   * as rejected, never sinks the batch.
   */
  async feedObservations(obs: readonly StructuredObservation[], opts: { actor: string }): Promise<FeedResult> {
    const actor = typeof opts?.actor === 'string' ? opts.actor.trim() : ''
    const total = Array.isArray(obs) ? obs.length : 0
    if (actor === '') {
      await recordPipelineEvent(this.store.root, {
        at: new Date().toISOString(),
        kind: 'seam-observations-fed',
        detail: { actor: '<missing>', accepted: 0, duplicates: 0, rejected: total, refused: true },
      })
      return { accepted: 0, duplicates: 0, rejected: total, ids: [], error: 'unauthorized' }
    }
    const accepted: string[] = []
    let duplicates = 0
    let rejected = 0
    // Dedup window: the recent observation tail — the signal layer may retry
    // on its own fail-open local queue (spec 卷二 §2.1) and identical feature
    // tuples must not double-distill.
    const recent = await this.store.allObservations(500)
    const seenKeys = new Set(recent.map((o) => observationKey(o.kind, o.source, o.sessionId, o.text)))
    for (const raw of obs) {
      const clean = sanitizeStructuredObservation(raw)
      if (clean === undefined) {
        rejected += 1
        continue
      }
      const text = renderFeatureLine(clean)
      const key = observationKey('signal', 'fed', clean.sessionId, text)
      if (seenKeys.has(key)) {
        duplicates += 1
        continue
      }
      seenKeys.add(key)
      const saved = await this.store.appendObservation({
        kind: 'signal',
        source: 'fed',
        text,
        sessionId: clean.sessionId,
        by: actor,
      })
      accepted.push(saved.id)
    }
    await recordPipelineEvent(this.store.root, {
      at: new Date().toISOString(),
      kind: 'seam-observations-fed',
      detail: { actor, accepted: accepted.length, duplicates, rejected },
    })
    return { accepted: accepted.length, duplicates, rejected, ids: accepted }
  }

  /**
   * ② lesson 状态变更 (B2/卷二 §6.2): hint→established / →deprecated /
   * →removed. established flips confidence (the FACT source) and derives
   * status (established↔stable); deprecated flips status only (the TTL sweep
   * owns the rest); removed = archive FIRST (byte-exact copy to
   * `archive/lessons/` inside the bundle, git-revertable — 红线④) then out of
   * the roster, one commit. Each call lands a `seam-lesson-status` audit row.
   */
  async setLessonStatus(slug: string, to: 'established' | 'deprecated' | 'removed', opts: { actor: string }): Promise<StoreResult> {
    const actor = typeof opts?.actor === 'string' ? opts.actor.trim() : ''
    const clean = okf.slugify(slug ?? '')
    const audit = async (ok: boolean, reason?: string, extra?: Record<string, string | number | boolean>): Promise<void> => {
      await recordPipelineEvent(this.store.root, {
        at: new Date().toISOString(),
        kind: 'seam-lesson-status',
        detail: { actor: actor === '' ? '<missing>' : actor, slug: clean, to, ok, ...(reason !== undefined ? { reason } : {}), ...(extra ?? {}) },
      })
    }
    if (actor === '') {
      await audit(false, 'unauthorized')
      return { ok: false, slug: clean, reason: 'unauthorized' }
    }
    if (to !== 'established' && to !== 'deprecated' && to !== 'removed') {
      await audit(false, 'invalid-state')
      return { ok: false, slug: clean, reason: 'invalid-state' }
    }
    const doc = await this.store.readTopic(clean).catch(() => undefined)
    if (doc === undefined) {
      await audit(false, 'not-found')
      return { ok: false, slug: clean, reason: 'not-found' }
    }
    if (okf.topicKindOf(doc.fm.type) !== 'lesson') {
      await audit(false, 'not-a-lesson')
      return { ok: false, slug: clean, reason: 'not-a-lesson' }
    }
    const from = doc.fm.confidence ?? 'hint'
    if (to === 'removed') {
      const r = await this.store.archiveLesson(clean, {
        message: `topics(lesson): remove ${clean} (archive-first, by ${actor})`,
      })
      if (r === undefined) {
        await audit(false, 'not-found')
        return { ok: false, slug: clean, reason: 'not-found' }
      }
      await audit(true, undefined, { archivedTo: r.archivedTo, committed: r.committed })
      this.invalidate()
      return { ok: true, slug: clean, from, archivedTo: r.archivedTo, committed: r.committed }
    }
    if (to === 'established') doc.fm.confidence = 'established'
    doc.fm.status = to === 'established' ? okf.deriveLessonStatus('established') : 'deprecated'
    const result = await this.store.saveTopic(
      { slug: clean, doc },
      { message: `topics(lesson): ${to} ${clean} (by ${actor})`, actor },
    )
    this.invalidate()
    void this.sync?.schedulePush()
    await audit(true, undefined, { committed: result.committed })
    return { ok: true, slug: clean, from, committed: result.committed }
  }

  async search(query: string, topK?: number): Promise<SearchOutcome> {
    const cfg = this.cfg
    return searchTopics(query, await this.roster(), {
      threshold: cfg.matchThreshold,
      topK: topK ?? Math.max(cfg.topK, 8),
      tagBoost: cfg.tagBoost,
      graphDepth: cfg.graphDepth,
      recencyWindowDays: cfg.recencyWindowDays,
      // Explicit tool: the model asked for recall, so the injection-only
      // structural gate must not hide results.
      structuralGate: false,
      conflicts: await this.store.getConflicts(),
      usageBoost: cfg.usageBoost,
      usage: this.usageSignalsSync(),
      ...this.zeroOpenCfg(),
    })
  }

  async history(slug: string, limit = 20): Promise<{ entries: { hash: string; date: string; message: string; conclusion?: string }[] }> {
    if (!(await this.store.hasGit())) return { entries: [] }
    const path = `topics/${okf.slugify(slug)}.md`
    const log = await fileHistory(this.store.root, path, limit)
    const entries: { hash: string; date: string; message: string; conclusion?: string }[] = []
    for (const e of log) {
      const raw = await fileAtRev(this.store.root, path, e.hash)
      let conclusion: string | undefined
      if (raw !== undefined) {
        try {
          conclusion = firstLine(okf.sectionOf(okf.parseTopicDoc(raw).body, okf.CONCLUSION_HEADING) ?? '')
        } catch {
          conclusion = undefined
        }
      }
      entries.push({ hash: e.hash.slice(0, 10), date: e.date, message: e.message, conclusion })
    }
    return { entries }
  }

  async stats(): Promise<AggregateStats> {
    return aggregateStats(await this.store.readInjectionRecords())
  }
}

function inclusionDropped(injection: AssembleResult): boolean {
  return injection.dropped.length > 0
}

// --- feedObservations whitelist machinery (B-line seam ①) -------------------
// jev/log REDACTION + pipeline-events discipline: whitelist copy on write,
// bounded scalar features only — 对话原文（tool arguments、message content）
// 结构上进不来（红线⑤）。

const SEAM_TYPE_MAX_CHARS = 64
const SEAM_SESSION_MAX_CHARS = 128
const SEAM_DETAIL_MAX_ENTRIES = 16
const SEAM_DETAIL_KEY_MAX_CHARS = 64
const SEAM_DETAIL_VALUE_MAX_CHARS = 256

/** Whitelist copy of one structured observation; undefined = reject. A raw
 *  entry whose detail existed but sanitizes to EMPTY (object/array smuggle,
 *  garbage values) is rejected outright — a type with no survivable features
 *  is a malformed signal, not a featureless one. */
function sanitizeStructuredObservation(raw: StructuredObservation): StructuredObservation | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  if (typeof raw.type !== 'string' || raw.type.trim() === '') return undefined
  const out: StructuredObservation = { type: raw.type.trim().slice(0, SEAM_TYPE_MAX_CHARS) }
  if (typeof raw.at === 'string' && raw.at !== '') out.at = raw.at
  if (typeof raw.sessionId === 'string' && raw.sessionId !== '') out.sessionId = raw.sessionId.slice(0, SEAM_SESSION_MAX_CHARS)
  const hadDetail = raw.detail !== undefined && typeof raw.detail === 'object' && !Array.isArray(raw.detail)
  if (hadDetail) {
    const detail: Record<string, string | number | boolean> = {}
    for (const [k, v] of Object.entries(raw.detail as Record<string, unknown>)) {
      if (Object.keys(detail).length >= SEAM_DETAIL_MAX_ENTRIES) break
      if (typeof v === 'string') {
        if (v !== '') detail[k.slice(0, SEAM_DETAIL_KEY_MAX_CHARS)] = v.slice(0, SEAM_DETAIL_VALUE_MAX_CHARS)
      } else if (typeof v === 'number') {
        if (Number.isFinite(v)) detail[k.slice(0, SEAM_DETAIL_KEY_MAX_CHARS)] = v
      } else if (typeof v === 'boolean') {
        detail[k.slice(0, SEAM_DETAIL_KEY_MAX_CHARS)] = v
      }
    }
    if (Object.keys(detail).length === 0) return undefined
    out.detail = detail
  }
  return out
}

/** Sorted feature line as the observation text: `[type] k=v k=v` — stable
 *  (dedup-keyable), feature-only, bounded. */
function renderFeatureLine(o: StructuredObservation): string {
  const parts = Object.keys(o.detail ?? {})
    .sort()
    .map((k) => `${k}=${String((o.detail as Record<string, string | number | boolean>)[k])}`)
  return `[${o.type}]${parts.length > 0 ? ` ${parts.join(' ')}` : ''}`.slice(0, 512)
}

/** Dedup key over the stored observation identity (kind/source/session/feature
 *  line) — candidates key the same way they are stored. */
function observationKey(kind: string, source: string, sessionId: string | undefined, text: string): string {
  return `${kind}|${source}|${sessionId ?? ''}|${text}`
}

function firstLine(text: string): string {
  return firstParagraphOf(text)
}

function firstParagraphOf(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t !== '') return t
  }
  return ''
}

function dedupeLower(tags: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tags) {
    const key = t.trim().toLowerCase()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    if (p === '' || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

function firstContentLine(doc: string): string {
  for (const line of doc.split('\n')) {
    const t = line.trim()
    if (t === '' || t.startsWith('#')) continue
    return t.slice(0, 200)
  }
  return ''
}

function sanitizeTriggers(triggers: readonly string[]): string[] {
  const out: string[] = []
  for (const t of triggers) {
    if (typeof t !== 'string') continue
    const key = t.trim()
    if (key === '') continue
    out.push(key)
  }
  return out
}
