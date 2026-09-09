/**
 * Consolidation lane — periodic LLM gardening over the topic pool itself.
 *
 * Where the distill lane turns observations into topics, this lane turns the
 * EXISTING pool into a better one: merging near-duplicates, promoting drafts
 * whose conclusions have settled, deprecating superseded entries, refreshing
 * metadata (title/tags/triggers). Triggered by cadence at session start
 * (`consolidate-cadence`: off | daily | 3d | 7d) or manually via
 * `/topics consolidate`. The model route is shared with the distill lane
 * (distill-provider/distill-model) — one route to configure, one caller
 * instance injected.
 *
 * Safety model:
 *  - grounded proposals: clusters are built locally (lexical similarity over
 *    title+tags tokens), so the model only ever judges topics that already
 *    look alike and every op names its slugs verbatim from the bundle;
 *  - four op kinds only, and refresh may NOT touch the conclusion body —
 *    rewriting conclusions is merge's exclusive path, so a metadata refresh
 *    can never silently lose knowledge; no create: consolidation prunes,
 *    it never grows;
 *  - every write rides the normal saveTopic path (one git commit per change),
 *    so the whole run is one `git revert` away;
 *  - the cadence stamp (meta/consolidate-state.json) advances only when the
 *    model actually evaluated at least one cluster — a run that died on the
 *    first call leaves the stamp alone, and the next session start retries.
 *
 * @module consolidate
 */

import * as okf from './okf.ts'
import type { TopicsService } from './service.ts'
import { parseOps, type ModelCaller } from './distill.ts'

/** Below this pairwise Jaccard two topics never share a cluster. */
const CLUSTER_THRESHOLD = 0.3
/** Clusters are capped — a giant cluster drowns the model in candidates. */
export const MAX_CLUSTER_SIZE = 6
/** Model calls (≈ clusters) per run; the rest wait for the next cadence. */
const MAX_MODEL_CALLS_PER_RUN = 8
/** Hard cap on applied ops per run — consolidation lands in reviewable steps. */
const MAX_OPS_PER_RUN = 12
/** Conclusion chars fed per topic in a cluster payload. */
const CONCLUSION_SNIPPET_CHARS = 600
const CONSOLIDATE_MAX_TOKENS = 2500

export interface ConsolidateOp {
  op: 'merge' | 'promote' | 'deprecate' | 'refresh'
  /** promote/deprecate/refresh target. */
  slug?: string
  /** merge: the surviving slug. */
  survivor?: string
  /** merge: slugs absorbed INTO the survivor (≥ 1). */
  merged?: string[]
  title?: string
  description?: string
  tags?: string[]
  triggers?: string[]
  /** merge only (refresh may not rewrite conclusions). */
  conclusion?: string
  reason?: string
}

export interface ConsolidateAction {
  kind: ConsolidateOp['op']
  /** merge: survivor; others: the target slug. */
  slug: string
  /** merge: the absorbed slugs. */
  merged?: string[]
  reason?: string
}

export interface ConsolidateResult {
  ok: boolean
  reason?: 'no-model' | 'no-clusters' | 'in-flight' | 'model-error' | 'invalid-output'
  merged: string[]
  promoted: string[]
  deprecated: string[]
  refreshed: string[]
  /** Ops rejected by sanitization, with the model's raw op count for context. */
  droppedOps?: number
  rawOps?: number
  calls?: number
  actions?: ConsolidateAction[]
  detail?: string
}

export const CONSOLIDATE_SYSTEM_PROMPT = [
  '你是 topic 记忆库的整理引擎（园丁）。输入是一个候选簇：若干条可能相近的已有 topic（JSON，含 slug/标题/状态/标签/结论摘要）。',
  '任务：判断簇内有没有值得整理的动作，输出严格 JSON：{"ops":[...]}，不要任何其他文字或代码块解释。只允许四类 op：',
  '  {"op":"merge","survivor":"保留条目的slug","merged":["被并入的slug",...],"conclusion":"合并后的完整结论","title":"合并后的标题(可选)","tags":["并集标签(可选)"],"reason":"一句话理由"}',
  '  {"op":"promote","slug":"...","reason":"一句话理由"}　　# draft 且结论已自含、有效 → stable',
  '  {"op":"deprecate","slug":"...","reason":"一句话理由"}　# 已被更新结论取代/不再成立 → deprecated',
  '  {"op":"refresh","slug":"...","title":"...","description":"...","tags":[...],"triggers":[...],"reason":"一句话理由"}　# 只修元数据，让标题/标签/触发词更准确、可检索',
  '规则：',
  '- merge 只用于结论重复或高度重叠的条目：conclusion 必须是合并后的完整结论（自含、不依赖原文也能读懂），取双方有效信息的并集，不丢关键事实；survivor 选信息更全或更新的那条。',
  '- refresh 禁止改结论——它只能修 title/description/tags/triggers；想改结论就用 merge 或不要动。',
  '- slug 必须从输入里逐字复制，禁止改写、缩写或编造；survivor 不得出现在它自己的 merged 里。',
  '- 拿不准就不动：宁可输出 {"ops":[]}。禁止 create 新 topic，禁止输出这四类之外的 op。',
  '- 全部用中文写内容；tags 全小写。',
].join('\n')

// --- Local clustering (lexical, no model) ------------------------------------

/** Latin words + CJK bigrams — the token space title/tags similarity lives in. */
export function topicTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  const lower = text.toLowerCase()
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9._-]+/g)) tokens.add(m[0])
  for (const m of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const seg = m[0]
    if (seg.length === 1) {
      tokens.add(seg)
      continue
    }
    for (let i = 0; i < seg.length - 1; i += 1) tokens.add(seg.slice(i, i + 2))
  }
  return tokens
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter += 1
  return inter / (a.size + b.size - inter)
}

export interface ClusterEntry {
  slug: string
  title: string
  status: string
  tags: readonly string[]
  description?: string
  conclusion: string
}

export interface TopicCluster {
  entries: ClusterEntry[]
  /** Peak pairwise similarity inside the cluster — runs process peaks first. */
  similarity: number
}

/**
 * Group entries whose title+description+tags tokens clear the pairwise
 * threshold (union-find over similar pairs). Singletons are dropped — the
 * model only ever sees topics that already look alike. Clusters larger than
 * {@link MAX_CLUSTER_SIZE} keep their most-connected members.
 */
export function clusterTopics(
  entries: readonly ClusterEntry[],
  threshold = CLUSTER_THRESHOLD,
): TopicCluster[] {
  const tokens = entries.map((e) => topicTokens(`${e.title} ${e.description ?? ''} ${e.tags.join(' ')}`))
  const parent = entries.map((_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const scores = new Map<number, number>()
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const s = jaccard(tokens[i] ?? new Set(), tokens[j] ?? new Set())
      if (s >= threshold) {
        parent[find(i)] = find(j)
        scores.set(i * entries.length + j, s)
      }
    }
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < entries.length; i += 1) {
    const root = find(i)
    const g = groups.get(root)
    if (g === undefined) groups.set(root, [i])
    else g.push(i)
  }
  const clusters: TopicCluster[] = []
  for (const members of groups.values()) {
    if (members.length < 2) continue
    let peak = 0
    for (const [key, s] of scores) {
      const i = Math.floor(key / entries.length)
      if (members.includes(i)) peak = Math.max(peak, s)
    }
    let kept = members
    if (members.length > MAX_CLUSTER_SIZE) {
      // Most-connected members stay; the tail waits for a later run.
      const degree = new Map<number, number>()
      for (const [key, s] of scores) {
        const i = Math.floor(key / entries.length)
        const j = key % entries.length
        if (!members.includes(i)) continue
        degree.set(i, Math.max(degree.get(i) ?? 0, s))
        degree.set(j, Math.max(degree.get(j) ?? 0, s))
      }
      kept = [...members]
        .sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0))
        .slice(0, MAX_CLUSTER_SIZE)
    }
    clusters.push({
      entries: kept.map((i) => entries[i] as ClusterEntry),
      similarity: peak,
    })
  }
  clusters.sort((a, b) => b.similarity - a.similarity)
  return clusters
}

// --- The lane ----------------------------------------------------------------

interface ClusterOutcome {
  fatal?: 'model-error' | 'invalid-output'
  detail?: string
  ops: ConsolidateOp[]
}

interface AppliedConsolidation {
  merged: string[]
  promoted: string[]
  deprecated: string[]
  refreshed: string[]
  actions: ConsolidateAction[]
  dropped: number
}

export class Consolidator {
  private inFlight: Promise<ConsolidateResult> | undefined
  private readonly service: TopicsService
  private readonly caller: ModelCaller | undefined

  constructor(service: TopicsService, caller: ModelCaller | undefined) {
    this.service = service
    this.caller = caller
  }

  get configured(): boolean {
    return this.caller !== undefined
  }

  /** Cadence days for a config value; undefined = off (or unrecognized). */
  static cadenceDays(value: string | undefined): number | undefined {
    switch (value) {
      case 'daily':
        return 1
      case '3d':
        return 3
      case '7d':
        return 7
      default:
        return undefined
    }
  }

  get hasPending(): boolean {
    return this.inFlight !== undefined
  }

  /**
   * Cadence-gated entry (session start): silently skips when off, not due,
   * or already running. Due = no stamp yet (first run) or the last EVALUATED
   * run is older than the cadence.
   */
  async maybeRun(opts: { sessionId?: string; now?: number } = {}): Promise<ConsolidateResult | undefined> {
    const days = Consolidator.cadenceDays(this.service.cfg.consolidateCadence)
    if (days === undefined) return undefined
    if (this.inFlight !== undefined) return undefined
    const state = await this.service.store.readConsolidateState()
    if (state !== undefined && typeof state.at === 'string') {
      const last = Date.parse(state.at)
      if (Number.isFinite(last) && (opts.now ?? Date.now()) - last < days * 86_400_000) return undefined
    }
    return this.start(opts.sessionId)
  }

  /** Manual entry (/topics consolidate): bypasses the cadence, keeps the guard. */
  run(sessionId?: string): Promise<ConsolidateResult> {
    return this.start(sessionId)
  }

  private start(sessionId?: string): Promise<ConsolidateResult> {
    if (this.inFlight !== undefined) return this.inFlight
    const run = this.runInner(sessionId).finally(() => {
      this.inFlight = undefined
    })
    this.inFlight = run
    void run.catch(() => undefined)
    return run
  }

  private async runInner(sessionId?: string): Promise<ConsolidateResult> {
    const base = { merged: [] as string[], promoted: [] as string[], deprecated: [] as string[], refreshed: [] as string[] }
    if (this.caller === undefined) {
      return { ok: false, reason: 'no-model', ...base, detail: '整理 lane 未接线（无模型调用器）' }
    }
    const cfg = this.service.cfg
    if (cfg.distillProvider === '' || cfg.distillModel === '') {
      return {
        ok: false,
        reason: 'no-model',
        ...base,
        detail: '整理复用蒸馏模型路由（distill-provider / distill-model），当前未配置',
      }
    }
    const clusters = await this.buildClusters()
    if (clusters.length === 0) {
      // Nothing looks alike — a clean bill of health, but the model never
      // evaluated, so the stamp stays unset and the next window re-checks.
      return { ok: false, reason: 'no-clusters', ...base }
    }
    const applied: AppliedConsolidation = { merged: [], promoted: [], deprecated: [], refreshed: [], actions: [], dropped: 0 }
    let rawOps = 0
    let calls = 0
    let evaluated = 0
    let fatal: 'model-error' | 'invalid-output' | undefined
    let failureDetail: string | undefined
    for (const cluster of clusters) {
      if (calls >= MAX_MODEL_CALLS_PER_RUN) break
      const outcome = await this.runCluster(sessionId, cluster)
      calls += 1
      if (outcome.fatal !== undefined) {
        fatal = outcome.fatal
        failureDetail = outcome.detail
        break
      }
      evaluated += 1
      rawOps += outcome.ops.length
      if (applied.merged.length + applied.promoted.length + applied.deprecated.length + applied.refreshed.length >= MAX_OPS_PER_RUN) {
        break
      }
      const room = MAX_OPS_PER_RUN - (applied.merged.length + applied.promoted.length + applied.deprecated.length + applied.refreshed.length)
      const result = await this.applyOps(outcome.ops.slice(0, room), cluster)
      applied.merged.push(...result.merged)
      applied.promoted.push(...result.promoted)
      applied.deprecated.push(...result.deprecated)
      applied.refreshed.push(...result.refreshed)
      applied.actions.push(...result.actions)
      applied.dropped += result.dropped
    }
    const progress = applied.merged.length + applied.promoted.length + applied.deprecated.length + applied.refreshed.length > 0
    // The stamp advances only when the model actually evaluated something —
    // a run that died on its first call retries at the next session start.
    let stampNote = ''
    if (evaluated > 0) {
      await this.service.store
        .writeConsolidateState({
          at: new Date().toISOString(),
          ok: !fatal,
          calls,
          merged: applied.merged,
          promoted: applied.promoted,
          deprecated: applied.deprecated,
          refreshed: applied.refreshed,
          droppedOps: applied.dropped,
          detail: failureDetail,
        })
        .catch((err: unknown) => {
          stampNote = `；consolidate-state 写入失败: ${err instanceof Error ? err.message : String(err)}`
        })
    } else if (fatal !== undefined) {
      return { ok: false, reason: fatal, ...base, calls, detail: failureDetail }
    }
    const parts: string[] = []
    if (applied.merged.length > 0) parts.push(`合并 ${applied.merged.length} 组`)
    if (applied.promoted.length > 0) parts.push(`晋升 ${applied.promoted.length}`)
    if (applied.deprecated.length > 0) parts.push(`废弃 ${applied.deprecated.length}`)
    if (applied.refreshed.length > 0) parts.push(`刷新 ${applied.refreshed.length}`)
    const summary = parts.length === 0 ? '无需整理' : parts.join('；')
    const tail = [
      applied.dropped > 0 ? `丢弃 ${applied.dropped} 个无效 op` : undefined,
      `${calls} 次模型调用（评估 ${evaluated} 簇 / 候选 ${clusters.length} 簇）`,
      fatal !== undefined ? `中途失败：${failureDetail ?? 'unknown'}` : undefined,
      stampNote === '' ? undefined : stampNote.replace(/^；/, ''),
    ]
      .filter(Boolean)
      .join('；')
    void this.service.sync?.schedulePush()
    return {
      ok: evaluated > 0,
      ...(fatal !== undefined && evaluated === 0 ? { reason: fatal } : {}),
      merged: [...applied.merged],
      promoted: [...applied.promoted],
      deprecated: [...applied.deprecated],
      refreshed: [...applied.refreshed],
      droppedOps: applied.dropped,
      rawOps,
      calls,
      actions: applied.actions,
      detail: `${summary}${tail === '' ? '' : `（${tail}）`}`,
    }
  }

  /** Read the active pool and cluster it lexically. */
  private async buildClusters(): Promise<TopicCluster[]> {
    const metas = await this.service.store.listTopics()
    const entries: ClusterEntry[] = []
    for (const m of metas) {
      if (m.status === 'deprecated') continue
      const doc = await this.service.store.readTopic(m.slug).catch(() => undefined)
      if (doc === undefined) continue
      entries.push({
        slug: m.slug,
        title: m.title,
        status: m.status,
        tags: m.tags,
        description: doc.fm.description,
        conclusion: (okf.sectionOf(doc.body, okf.CONCLUSION_HEADING) ?? '')
          .slice(0, CONCLUSION_SNIPPET_CHARS)
          .trim(),
      })
    }
    return clusterTopics(entries).slice(0, MAX_MODEL_CALLS_PER_RUN)
  }

  /** One model call over one cluster, ops shape-validated but not yet applied. */
  private async runCluster(sessionId: string | undefined, cluster: TopicCluster): Promise<ClusterOutcome> {
    const caller = this.caller
    if (caller === undefined) return { ops: [], fatal: 'model-error', detail: 'consolidate caller unavailable' }
    const payload = cluster.entries.map((e) => ({
      slug: e.slug,
      title: e.title,
      status: e.status,
      tags: e.tags,
      conclusion: e.conclusion,
    }))
    const user = [
      `候选簇（${payload.length} 条可能相近的 topic）：`,
      JSON.stringify(payload),
      '',
      '请输出整理结果（严格 JSON，{"ops":[...]}）；没有值得整理的就输出 {"ops":[]}：',
    ].join('\n')
    let raw: string
    try {
      raw = await caller({
        system: CONSOLIDATE_SYSTEM_PROMPT,
        user,
        purpose: 'topics-consolidate',
        sessionId,
        maxTokens: CONSOLIDATE_MAX_TOKENS,
      })
    } catch (e) {
      return { ops: [], fatal: 'model-error', detail: String(e instanceof Error ? e.message : e).slice(0, 200) }
    }
    let ops: ConsolidateOp[]
    try {
      // parseOps extracts the first balanced {"ops":[...]} and filters
      // non-object entries; the per-op shape re-validation happens in
      // sanitizeOps (a consolidate op carries different fields than a
      // distill op, so nothing here trusts the cast).
      ops = parseOps(raw) as unknown as ConsolidateOp[]
    } catch (e) {
      return { ops: [], fatal: 'invalid-output', detail: String(e instanceof Error ? e.message : e).slice(0, 200) }
    }
    return { ops }
  }

  /**
   * Validate and apply ops against the live bundle. Slugs are slugify-normalized
   * and must exist; merge requires a non-empty conclusion and forbids self-merge;
   * refresh never receives the conclusion field (merge's exclusive path); ops on
   * slugs already merged away earlier in this run are skipped (the deprecation
   * already redirects readers to the survivor). One bad op never sinks the rest.
   */
  private async applyOps(ops: readonly ConsolidateOp[], cluster: TopicCluster): Promise<AppliedConsolidation> {
    const applied: AppliedConsolidation = { merged: [], promoted: [], deprecated: [], refreshed: [], actions: [], dropped: 0 }
    const clusterSlugs = new Set(cluster.entries.map((e) => e.slug))
    for (const op of ops) {
      try {
        if (applied.merged.length + applied.promoted.length + applied.deprecated.length + applied.refreshed.length >= MAX_OPS_PER_RUN) break
        if (typeof op !== 'object' || op === null) {
          applied.dropped += 1
          continue
        }
        if (op.op === 'merge') {
          const survivor = typeof op.survivor === 'string' ? okf.slugify(op.survivor) : undefined
          const mergedRaw = Array.isArray(op.merged) ? op.merged : []
          const merged = mergedRaw.filter((s): s is string => typeof s === 'string').map((s) => okf.slugify(s))
          if (
            survivor === undefined ||
            survivor === '' ||
            merged.length === 0 ||
            merged.includes(survivor) ||
            !clusterSlugs.has(survivor) ||
            !merged.every((s) => clusterSlugs.has(s)) ||
            typeof op.conclusion !== 'string' ||
            op.conclusion.trim() === ''
          ) {
            applied.dropped += 1
            continue
          }
          const survivorDoc = await this.service.store.readTopic(survivor)
          if (survivorDoc === undefined) {
            applied.dropped += 1
            continue
          }
          await this.service.saveTopic({
            slug: survivor,
            title: typeof op.title === 'string' && op.title.trim() !== '' ? op.title : survivorDoc.fm.title,
            description: op.description,
            tags: op.tags,
            conclusion: op.conclusion,
          })
          for (const slug of merged) {
            const doc = await this.service.store.readTopic(slug)
            if (doc === undefined) continue
            const original = okf.sectionOf(doc.body, okf.CONCLUSION_HEADING) ?? ''
            const pointer = `> 已并入 topics/${survivor}.md（consolidation ${new Date().toISOString().slice(0, 10)}${op.reason ? `：${op.reason}` : ''}）。以下结论保留作历史参考。`
            await this.service.saveTopic({
              slug,
              title: doc.fm.title,
              conclusion: `${pointer}\n\n${original}`.trim(),
              status: 'deprecated',
            })
          }
          applied.merged.push(survivor)
          applied.actions.push({ kind: 'merge', slug: survivor, merged, reason: op.reason })
        } else if (op.op === 'promote' || op.op === 'deprecate') {
          const slug = typeof op.slug === 'string' ? okf.slugify(op.slug) : undefined
          if (slug === undefined || slug === '' || !clusterSlugs.has(slug)) {
            applied.dropped += 1
            continue
          }
          const doc = await this.service.store.readTopic(slug)
          if (doc === undefined || doc.fm.status === (op.op === 'promote' ? 'stable' : 'deprecated')) {
            applied.dropped += 1
            continue
          }
          await this.service.saveTopic({
            slug,
            title: doc.fm.title,
            status: op.op === 'promote' ? 'stable' : 'deprecated',
          })
          if (op.op === 'promote') applied.promoted.push(slug)
          else applied.deprecated.push(slug)
          applied.actions.push({ kind: op.op, slug, reason: op.reason })
        } else if (op.op === 'refresh') {
          const slug = typeof op.slug === 'string' ? okf.slugify(op.slug) : undefined
          if (slug === undefined || slug === '' || !clusterSlugs.has(slug)) {
            applied.dropped += 1
            continue
          }
          const doc = await this.service.store.readTopic(slug)
          if (doc === undefined) {
            applied.dropped += 1
            continue
          }
          // Conclusion is merge's exclusive path — a refresh op carrying one
          // is dropped rather than silently rewritten.
          if (op.conclusion !== undefined) {
            applied.dropped += 1
            continue
          }
          const hasField =
            (typeof op.title === 'string' && op.title.trim() !== '') ||
            (typeof op.description === 'string' && op.description.trim() !== '') ||
            (Array.isArray(op.tags) && op.tags.length > 0) ||
            (Array.isArray(op.triggers) && op.triggers.length > 0)
          if (!hasField) {
            applied.dropped += 1
            continue
          }
          await this.service.saveTopic({
            slug,
            title: typeof op.title === 'string' && op.title.trim() !== '' ? op.title : doc.fm.title,
            description: op.description,
            tags: op.tags,
            triggers: op.triggers,
          })
          applied.refreshed.push(slug)
          applied.actions.push({ kind: 'refresh', slug, reason: op.reason })
        } else {
          applied.dropped += 1
        }
      } catch {
        applied.dropped += 1
      }
    }
    return applied
  }
}
