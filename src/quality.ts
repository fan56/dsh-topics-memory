/**
 * Slow quality lane (v4 dual-channel design §4.2) — asynchronous, turn-end
 * triggered, LLM-gated injection. Two serial aux calls per run:
 *
 *   1. intent-query build over the observer's last-K ring buffer — kills
 *      verbatim priming at the root (the query is what the model needs, not
 *      what the user typed);
 *   2. lexical candidate band (hits + near-misses, recall-oriented) then an
 *      LLM rerank that releases 0-2 picks, each with a one-line why.
 *
 * Picks rest in a per-session pending slot and inject at the NEXT spliced
 * (steer message), then the slot is gone (消费即清). Hard bounds: per-call
 * 20s, pipeline 45s, pending TTL 10min, turn-lag ≤2. Every failure is
 * contained and silent — I3 (可丢弃性): async products may be missing, never
 * blocking. The lexical re-gate at consumption is SHADOW-ONLY (v4 B3): it
 * records verdicts into ilog and never blocks a pick.
 *
 * @module quality
 */

import type { TopicsService } from './service.ts'
import type { ModelCaller } from './distill.ts'
import { searchTopics } from './retrieval.ts'
import type { RingEntry } from './observer.ts'
import type { QueryBuildShape } from './ilog.ts'

export const PENDING_TTL_MS = 10 * 60_000
/** Hard drift bound: a pending older than this many turn-ends expires. */
export const TURN_LAG_LIMIT = 2
export const CALL_TIMEOUT_MS = 20_000
export const PIPELINE_TIMEOUT_MS = 45_000
/** qualityLane 'sampled' runs on every Nth turn (design default 1/3). */
export const SAMPLED_EVERY = 3

/** Max ring-buffer chars fed to the query build (features budget, not a transcript). */
const RING_CHARS = 6000
/** Candidate band size fed to the rerank. */
const CANDIDATE_LIMIT = 6
/** Over-fetch before the exclude filter, so excluded slugs don't thin the band. */
const CANDIDATE_OVERFETCH = 6

export const QUERY_BUILD_PROMPT = [
  '你是检索查询构建器。输入是最近几轮对话。任务：判断「模型此刻需要什么背景知识」，输出一个用于关键词检索的 query。',
  '只输出一个 JSON 对象，不要任何其他文字：{"needs": true, "query": "3-8 个检索词加一句意图", "ignore": ["被你忽略的内容类型"]}',
  '规则：',
  '- query 给词法检索用：写具体的名词、术语、项目名，不要照抄对话原句。',
  '- 对话里粘贴的日志、代码块、URL、命令输出等大段内容必须忽略，并把类型写进 ignore 数组（如 "粘贴的命令输出"）。',
  '- 没有需要补充背景知识的迹象时输出 {"needs": false}。',
].join('\n')

export const RERANK_PROMPT = [
  '你是注入门禁。输入一个检索 query 和候选 topic 列表。逐个判断候选是否「真的与当前工作相关」。',
  '只输出一个 JSON 对象，不要任何其他文字：{"picks": [{"slug": "候选里的 slug", "why": "一句话说明为什么现在需要它"}]}',
  '规则：',
  '- 最多 2 条，宁缺勿滥；没有真相关的就输出 {"picks": []}。',
  '- why 面向模型自己读：说清这条记忆能帮上当前哪一步。',
  '- slug 必须逐字取自候选列表，禁止编造。',
].join('\n')

export interface PendingInjection {
  items: { slug: string; why: string }[]
  computedAt: string
  /** Observer turnCount when the pending was produced (turn-lag clock). */
  turnId: number
  queryBuild: QueryBuildShape
  model: string
  ms: number
}

export type ConsumeResult = { pending: PendingInjection } | { expired: 'ttl' | 'turn-lag' } | undefined

export interface DispatchInput {
  ring: readonly RingEntry[]
  turnId: number
  /**
   * Slugs the session already carries — injected earlier this session or
   * distilled from its own turns (echo). The candidate band drops them
   * BEFORE the rerank: a pick the fast-lane dedup would silently swallow at
   * consumption is a wasted aux call and a dead pending (2026-09 audit: 2 of
   * the first 3 slow-lane outcomes died exactly this way).
   */
  exclude?: ReadonlySet<string>
}

/** Race `p` against a timeout; `onTimeout` fires so callers can abort upstream work. */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout()
      reject(new Error(`slow-lane call timeout (${ms}ms)`))
    }, ms)
    timer.unref?.()
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** Extract the first balanced JSON object from model output (tolerates fences). */
export function parseJsonObject(raw: string): Record<string, unknown> {
  let text = raw.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  if (fence !== null) text = fence[1].trim()
  const start = text.indexOf('{')
  if (start < 0) throw new Error('no JSON object in output')
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') inString = !inString
    if (inString) continue
    if (ch === '{') depth += 1
    if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const parsed: unknown = JSON.parse(text.slice(start, i + 1))
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
        return parsed as Record<string, unknown>
      }
    }
  }
  throw new Error('unbalanced JSON in output')
}

export class SlowLane {
  private pending = new Map<string, PendingInjection>()
  private inFlight = new Map<string, Promise<void>>()
  private readonly service: TopicsService
  private readonly caller: ModelCaller | undefined
  /**
   * Settle hook: fires when a session's pipeline leaves the in-flight map.
   * The host uses it to re-check the sessionLlm release guards — a disposal
   * that landed mid-pipeline held the entry open for THIS pipeline, and this
   * callback is the only chance to release it afterwards (the distill lane
   * has the same shape via its run.finally).
   */
  private readonly onSettle: (sessionId: string) => void

  constructor(service: TopicsService, caller: ModelCaller | undefined, onSettle: (sessionId: string) => void = () => undefined) {
    this.service = service
    this.caller = caller
    this.onSettle = onSettle
  }

  /** True while the session has a pending slot awaiting the next spliced. */
  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  /** True while the session's produce pipeline is still running (llm-capture guard). */
  hasInFlight(sessionId: string): boolean {
    return this.inFlight.has(sessionId)
  }

  /** Drop the pending slot (session teardown, restore boundary). */
  clear(sessionId: string): void {
    this.pending.delete(sessionId)
  }

  /**
   * Produce a pending slot for the session's next steer message. Fire-and-
   * forget; every guard failure is silent. Policy gates live here (config,
   * sampling, in-flight); host gates (delegation, distill yield) live with
   * the caller, which owns those services.
   */
  dispatch(sessionId: string, input: DispatchInput): void {
    try {
      const cfg = this.service.cfg
      if (cfg.qualityLane !== 'sampled' && cfg.qualityLane !== 'always') return
      if (cfg.qualityLane === 'sampled' && input.turnId % SAMPLED_EVERY !== 0) return
      if (this.caller === undefined || this.inFlight.has(sessionId)) return
      if (input.ring.length === 0) return
      const run = this.produce(sessionId, input).finally(() => {
        this.inFlight.delete(sessionId)
        this.onSettle(sessionId)
      })
      this.inFlight.set(sessionId, run)
      void run.catch(() => undefined)
    } catch {
      // contained — the lane must never break the event handler
    }
  }

  private async produce(sessionId: string, input: DispatchInput): Promise<void> {
    const caller = this.caller
    if (caller === undefined) return
    const started = Date.now()
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), PIPELINE_TIMEOUT_MS)
    deadline.unref?.()
    try {
      const cfg = this.service.cfg
      const ringText = input.ring
        .map((e, i) => {
          const turn = `【轮 ${i + 1}】\n用户: ${e.user}\n助手: ${e.assistant}`
          return turn.length > RING_CHARS / input.ring.length ? turn.slice(0, Math.floor(RING_CHARS / input.ring.length)) : turn
        })
        .join('\n\n')
      const buildRaw = await withTimeout(
        caller({
          system: QUERY_BUILD_PROMPT,
          user: ringText,
          purpose: 'topics-quality',
          sessionId,
          maxTokens: 300,
          signal: controller.signal,
        }),
        CALL_TIMEOUT_MS,
        () => controller.abort(),
      )
      let built: Record<string, unknown>
      try {
        built = parseJsonObject(buildRaw)
      } catch {
        return // unparseable build → no pending, nothing logged, next turn retries
      }
      if (built.needs !== true || typeof built.query !== 'string' || built.query.trim() === '') return
      const query = built.query.trim()
      const stripped = Array.isArray(built.ignore)
        ? built.ignore.filter((s): s is string => typeof s === 'string' && s.trim() !== '').slice(0, 5)
        : []
      const queryBuild: QueryBuildShape = { rawChars: ringText.length, keptChars: query.length, stripped }

      const roster = await this.service.roster().catch(() => [])
      if (roster.length === 0) return
      // Recall-oriented band: gate OFF (the rerank IS this lane's gate);
      // candidates = threshold passers + the near-miss band beneath them.
      const band = searchTopics(query, roster, {
        threshold: this.service.cfg.matchThreshold,
        topK: CANDIDATE_LIMIT + CANDIDATE_OVERFETCH,
        tagBoost: this.service.cfg.tagBoost,
        graphDepth: 0,
        recencyWindowDays: this.service.cfg.recencyWindowDays,
        structuralGate: false,
      })
      const exclude = input.exclude
      const candidates = [...band.hits, ...band.nearMisses]
        .filter((c) => !exclude?.has(c.slug))
        .slice(0, CANDIDATE_LIMIT)
      if (candidates.length === 0) return
      const bySlug = new Map(roster.map((r) => [r.slug, r]))
      const payload = candidates.flatMap((c) => {
        const meta = bySlug.get(c.slug)
        if (meta === undefined) return []
        const conclusionFirst = meta.conclusion.split('\n').find((l) => l.trim() !== '') ?? ''
        return [
          {
            slug: c.slug,
            title: meta.title,
            status: meta.status,
            description: meta.description ?? '',
            conclusion: conclusionFirst.slice(0, 160),
          },
        ]
      })
      if (payload.length === 0) return
      const rerankRaw = await withTimeout(
        caller({
          system: RERANK_PROMPT,
          user: [
            `检索 query：${query}`,
            '',
            `候选 topic（${payload.length} 个）：`,
            JSON.stringify(payload),
          ].join('\n'),
          purpose: 'topics-quality',
          sessionId,
          maxTokens: 400,
          signal: controller.signal,
        }),
        CALL_TIMEOUT_MS,
        () => controller.abort(),
      )
      let reranked: Record<string, unknown>
      try {
        reranked = parseJsonObject(rerankRaw)
      } catch {
        return
      }
      const legal = new Set(payload.map((p) => p.slug))
      const rawPicks = Array.isArray(reranked.picks) ? reranked.picks : []
      const items: { slug: string; why: string }[] = []
      const picked = new Set<string>()
      for (const pick of rawPicks) {
        if (pick === null || typeof pick !== 'object') continue
        const slug = (pick as { slug?: unknown }).slug
        const why = (pick as { why?: unknown }).why
        if (typeof slug !== 'string' || !legal.has(slug)) continue
        if (typeof why !== 'string' || why.trim() === '') continue
        if (picked.has(slug)) continue
        picked.add(slug)
        items.push({ slug, why: why.trim().slice(0, 200) })
        if (items.length >= 2) break
      }
      if (items.length === 0) return
      const route = this.service.cfg
      this.pending.set(sessionId, {
        items,
        computedAt: new Date().toISOString(),
        turnId: input.turnId,
        queryBuild,
        model: `${route.distillProvider}/${route.distillModel}`,
        ms: Date.now() - started,
      })
    } catch {
      // timeouts, aborts, model errors — I3: the async product is simply absent
    } finally {
      clearTimeout(deadline)
    }
  }

  /**
   * Consumption point (the next spliced). Returns the pending exactly once
   * (消费即清) or an expiry reason; `turnId` is the CURRENT observer turn
   * count so the drift bound can judge. Undefined when nothing is pending.
   */
  consume(sessionId: string, turnId: number): ConsumeResult {
    const pending = this.pending.get(sessionId)
    if (pending === undefined) return undefined
    const produced = Date.parse(pending.computedAt)
    if (!Number.isNaN(produced) && Date.now() - produced > PENDING_TTL_MS) {
      this.pending.delete(sessionId)
      return { expired: 'ttl' }
    }
    if (turnId - pending.turnId > TURN_LAG_LIMIT) {
      this.pending.delete(sessionId)
      return { expired: 'turn-lag' }
    }
    this.pending.delete(sessionId)
    return { pending }
  }
}
