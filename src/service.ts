/**
 * TopicsService — the facade shared by tools, commands, the injection seam,
 * and the distill lane. Owns the roster cache (mtime-keyed, pi-topic-memory
 * lesson #3: never re-parse unchanged files on the hot path).
 *
 * @module service
 */

import { readFile, stat } from 'node:fs/promises'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as okf from './okf.ts'
import { searchTopics, scoreTopic, passesGate, tokenize, type RetrievableTopic, type SearchOutcome } from './retrieval.ts'
import { assembleInjection, assemblePointer, POINTER_PER_TOPIC, POINTER_TOTAL, type AssembleResult, type DigestInput, type SlowPointerInput } from './digest.ts'
import type { BundleStore, Observation, SaveResult } from './store.ts'
import type { TopicsConfigValue } from './config.ts'
import { aggregateStats, querySample, aggregateUsage, USAGE_WINDOW_DAYS, type AggregateStats, type InjectionRecord, type QueryBuildShape, type ShadowVerdict, type SlowItem, type UsageSignal } from './ilog.ts'
import { fileHistory, fileAtRev } from './git.ts'
import type { Sync } from './sync.ts'

interface CacheEntry {
  mtimeMs: number
  size: number
  doc: okf.TopicDoc
  slug: string
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
}

export class TopicsService {
  private cache = new Map<string, CacheEntry>()
  /** mtime-keyed parse of the observations log, grouped by session. */
  private echoCache: { mtimeMs: number; size: number; bySession: Map<string, Set<string>> } | undefined
  private usageCache: {
    injMs: number
    injSize: number
    opensMs: number
    opensSize: number
    signals: Map<string, UsageSignal>
  } | undefined
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
    this.usageCache = undefined
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
   * a fresh cache costs two stat() calls. Unreadable logs fail open to an
   * empty map (no boost), never an error.
   */
  usageSignalsSync(): Map<string, UsageSignal> {
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
    const cached = this.usageCache
    if (
      cached !== undefined &&
      cached.injMs === injSt.mtimeMs &&
      cached.injSize === injSt.size &&
      cached.opensMs === opensSt.mtimeMs &&
      cached.opensSize === opensSt.size
    ) {
      return cached.signals
    }
    const parseLines = <T>(file: string): T[] => {
      const out: T[] = []
      try {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (line.trim() === '') continue
          try {
            out.push(JSON.parse(line) as T)
          } catch {
            continue // torn tail line
          }
        }
      } catch {
        // unreadable log: contribute nothing
      }
      return out
    }
    const signals = aggregateUsage(
      parseLines(injFile),
      parseLines(opensFile),
      USAGE_WINDOW_DAYS,
      Date.now(),
    )
    this.usageCache = {
      injMs: injSt.mtimeMs,
      injSize: injSt.size,
      opensMs: opensSt.mtimeMs,
      opensSize: opensSt.size,
      signals,
    }
    return signals
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
  retrieveSync(query: string, sessionId?: string, dedup?: { exclude?: ReadonlySet<string>; echo?: ReadonlySet<string> }, slow?: SlowDelivery, slowExpired?: 'ttl' | 'turn-lag'): { text: string; outcome: SearchOutcome; deduped: string[]; echoed: string[]; included: string[]; slowIncluded: string[] } {
    const cfg = this.cfg
    const roster = this.rosterSync()
    const empty: SearchOutcome = { hits: [], nearMisses: [], rosterSize: roster.length }
    if (!cfg.autoInject || query.trim() === '' || roster.length === 0) {
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
      return { text: '', outcome: empty, deduped: [], echoed: [], included: [], slowIncluded: [] }
    }
    const conflicts = this.store.getConflictsSync()
    const outcome = searchTopics(query, roster, {
      threshold: cfg.matchThreshold,
      topK: cfg.topK,
      tagBoost: cfg.tagBoost,
      graphDepth: cfg.graphDepth,
      recencyWindowDays: cfg.recencyWindowDays,
      conflicts,
      usageBoost: cfg.usageBoost,
      usage: this.usageSignalsSync(),
    })
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
    // ---- Slow-lane merge (log-only shadow gate; consumption bookkeeping) ----
    const slowPointers: SlowPointerInput[] = []
    const slowDelivered: SlowItem[] = []
    const shadow: ShadowVerdict[] = []
    let slowIncluded: string[] = []
    const consumedAt = new Date().toISOString()
    if (slow !== undefined) {
      const queryTokens = new Set(tokenize(query))
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
    const injection = pointerMode
      ? assemblePointer(entries, { perTopicBudget: POINTER_PER_TOPIC, totalBudget: Math.min(cfg.totalBudget, POINTER_TOTAL) }, slowPointers)
      : assembleInjection(entries, { perTopicBudget: cfg.perTopicBudget, totalBudget: cfg.totalBudget }, slowPointers)
    slowIncluded = injection.slowIncluded ?? []
    for (const pointer of slowPointers) {
      if (slowIncluded.includes(pointer.slug)) slowDelivered.push({ slug: pointer.slug, why: pointer.why })
    }
    const record: InjectionRecord = {
      at: new Date().toISOString(),
      queryTokenCount: tokenize(query).length,
      querySample: querySample(query),
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
    if (unreadable.length > 0) {
      record.dropped = [...(record.dropped ?? []), ...unreadable.map((slug) => ({ slug, reason: 'doc-unreadable' }))]
    }
    if (slow !== undefined) {
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
    return { text: injection.text, outcome, deduped, echoed, included: injection.included, slowIncluded }
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
    // stat reliable; a failed log write must not fail the tool.
    await this.store
      .appendOpenRecord({ slug, at: new Date().toISOString(), ...(sessionId !== undefined ? { sessionId } : {}) })
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

  /** topic_save tool path: create or update with actor stamping. */
  async saveTopic(input: {
    title: string
    description?: string
    tags?: string[]
    triggers?: string[]
    depends?: string[]
    openQuestions?: string[]
    impact?: string[]
    status?: okf.TopicStatus
    conclusion?: string
    recommendations?: string
    source?: 'model' | 'distill'
    slug?: string
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
    // store.saveTopic stamps generated {by, at} itself (write-through actor).
    const fm: okf.TopicFrontmatter = {
      type: 'Topic',
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
    if (existing !== undefined && existing.fm.verified !== undefined) fm.verified = existing.fm.verified
    const result = await this.store.saveTopic(
      { slug, doc: { fm, body } },
      { message: existing === undefined ? `topics(topic): create ${slug}` : `topics(topic): update ${slug}`, created: existing === undefined },
    )
    this.invalidate()
    void this.sync?.schedulePush()
    return { ...result, slug: result.slug }
  }

  async observe(input: { kind: Observation['kind']; text: string; sessionId?: string; source?: 'model' | 'auto' }): Promise<Observation> {
    return this.store.appendObservation({ kind: input.kind, source: input.source ?? 'model', text: input.text, sessionId: input.sessionId })
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
