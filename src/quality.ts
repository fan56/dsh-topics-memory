/**
 * Slow quality lane (v4 dual-channel design §4.2) — asynchronous, turn-end
 * triggered, LLM-gated injection. Two serial aux calls per run:
 *
 *   1. intent-query build over the observer's last-K ring buffer — kills
 *      verbatim priming at the root (the query is what the model needs, not
 *      what the user typed);
 *   2. lexical candidate band (hits + near-misses, recall-oriented) then a
 *      rerank that releases 0-2 picks, each with a one-line why. With
 *      `jevEnabled` on (design 2026-09-25 §2) the rerank is a batched System
 *      One noul request, probability-band gated; any failure fails open to the
 *      legacy LLM rerank below. The same trigger also runs the fastgate
 *      SHADOW (zero behavior, decisions.jsonl only).
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
import type { TopicsConfigValue } from './config.ts'
import { jevAsk } from './jev/client.ts'
import type { JevAskConfig, JevQuestion } from './jev/client.ts'
import { band as jevBand } from './jev/thresholds.ts'
import type { JevBand } from './jev/thresholds.ts'
import { digestFor, logVerdicts } from './jev/log.ts'
import type { JevVerdictRecord } from './jev/log.ts'

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
/** Fastgate shadow cap (design §2 row 3): topK hits + near-misses, ≤8 questions. */
export const FASTGATE_MAX_QUESTIONS = 8

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

// ---- jev (System One) decision branch, design 2026-09-25 §2 rows 1+3 ----
//
// When jevEnabled is on, the rerank step asks the decision model instead of
// the generative LLM: one batched noul request over the candidate band, the
// calibrated bands (jev/thresholds: adopt ≥ 0.60 / record 0.10–0.60 / veto
// < 0.10) decide the picks, and every candidate lands in decisions.jsonl.
// Any failure falls open to the RERANK_PROMPT path below (red line ②).
// The fastgate shadow audits the fast lane's OWN lexical disposition from the
// same sampled turn-end trigger — zero behavior, decisions.jsonl only.

/** The candidate slice the jev questions see (content-bearing metadata). */
interface JevCandidate {
  slug: string
  title: string
  status: string
  tags?: readonly string[]
  description?: string
  conclusion: string
}

/**
 * §6.2 state for one batch: the round's query plus the task frame. Shared by
 * the rerank and the fastgate shadow so both seams speak ONE batch protocol —
 * the calibrated bands are protocol-bound (design §5), a second state shape
 * would need its own sweep.
 */
export function jevState(query: string): string {
  return `检索 query：${query}\n任务背景：模型正在推进当前会话的工作，需要判断哪些长期记忆 topic 值得注入上下文作参考。`
}

/** Per-candidate question: full candidate inline (title/tags/conclusion
 *  excerpt), RERANK_PROMPT's rendering style but compact. */
function candidateInstructions(c: JevCandidate): string {
  const tags = c.tags !== undefined && c.tags.length > 0 ? `，标签: ${c.tags.join('/')}` : ''
  const desc = c.description !== undefined && c.description.trim() !== '' ? ` ${c.description.trim().slice(0, 80)}` : ''
  return `候选 topic「${c.title}」（slug: ${c.slug}，状态: ${c.status}${tags}）。${desc}结论摘录：${c.conclusion.slice(0, 160)}。该候选与当前 query 对应的工作真的相关、值得注入模型上下文吗？`
}

/** Two-sided criteria built from the candidate content (calibration protocol:
 *  single-sided instructions measurably degrade). */
function candidateCriteria(c: JevCandidate): { true: string; false: string } {
  return {
    true: `相关——「${c.title}」的记忆对当前工作有实质帮助，应该注入作参考`,
    false: `无关——「${c.title}」与当前工作没有实质交集，注入只是噪音，不应该注入`,
  }
}

/** The noul probability of one answer; undefined when the answer is not a
 *  usable number in [0,1] (a 坏答案 — fail-open for the caller). */
function noulProbability(answer: unknown): number | undefined {
  if (answer === null || typeof answer !== 'object') return undefined
  const p = (answer as { noul?: unknown }).noul
  return typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1 ? p : undefined
}

/** The config slice jevAsk needs, tolerating bare harnesses (§4: consumers
 *  treat undefined as the documented default). */
function jevConfigOf(cfg: TopicsConfigValue): JevAskConfig {
  return {
    jevBackend: cfg.jevBackend ?? 'zen',
    jevModel: cfg.jevModel ?? '',
    jevTimeoutMs: typeof cfg.jevTimeoutMs === 'number' && cfg.jevTimeoutMs > 0 ? cfg.jevTimeoutMs : 3000,
    jevSecretFile: cfg.jevSecretFile ?? '',
  }
}

/** The lexical disposition the fast lane recorded for one candidate — the
 *  agree-reconciliation key (§6.2; retrieval.ts hits/nearMisses split). */
export type FastGateDisposition = 'hit' | 'nearFloor' | 'gate-blocked'

export interface FastGateCandidate {
  slug: string
  disposition: FastGateDisposition
}

export interface FastGateShadowInput {
  /** The fast-lane round's query (the claimed text), captured at spliced. */
  query: string
  /** hits + near-misses of that round, with their lexical dispositions. */
  candidates: readonly FastGateCandidate[]
  /** Observer turn count at the trigger — the sampled-cadence clock. */
  turnId: number
}

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
  /** Same-session shadow serialization — a second trigger never overlaps. */
  private shadowInFlight = new Map<string, Promise<void>>()
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
    this.shadowInFlight.delete(sessionId)
  }

  /**
   * Fastgate shadow (design §2 row 3): fire-and-forget on the SAME sampled
   * turn-end trigger as the slow lane, zero behavior — verdicts land only in
   * decisions.jsonl, reconciled against the lexical disposition. Needs no LLM
   * caller, so it also runs on turns where the slow lane itself yields (distill
   * in flight, no model configured). `dispatch()`'s own guards (lane mode,
   * sampled cadence) are mirrored here so both seams share one cadence.
   */
  dispatchFastGateShadow(sessionId: string, input: FastGateShadowInput): void {
    try {
      const cfg = this.service.cfg
      if (cfg.jevEnabled !== true) return
      if (cfg.qualityLane !== 'sampled' && cfg.qualityLane !== 'always') return
      if (cfg.qualityLane === 'sampled' && input.turnId % SAMPLED_EVERY !== 0) return
      if (input.query.trim() === '' || input.candidates.length === 0) return
      if (this.shadowInFlight.has(sessionId)) return // never overlap shadows
      // Serialize behind a same-session produce pipeline (rerank 完成后);
      // standalone when no pipeline is running (无慢道任务时独立跑).
      const prior = this.inFlight.get(sessionId) ?? Promise.resolve()
      const run = prior.then(() => this.fastGateShadow(input)).finally(() => {
        this.shadowInFlight.delete(sessionId)
      })
      this.shadowInFlight.set(sessionId, run)
      void run.catch(() => undefined)
    } catch {
      // contained — the shadow must never break the event handler
    }
  }

  /** Shadow body: resolve candidate content from the roster, one batched noul
   *  request, verdict rows only. A jevAsk failure leaves just its auto-written
   *  call row — there is no legacy path to fall back to, and nothing to gate. */
  private async fastGateShadow(input: FastGateShadowInput): Promise<void> {
    const roster = await this.service.roster().catch(() => [])
    const bySlug = new Map(roster.map((r) => [r.slug, r]))
    const state = jevState(input.query)
    const questions: Record<string, JevQuestion> = {}
    const metas: { qid: string; slug: string; instructions: string; disposition: FastGateDisposition }[] = []
    for (const cand of input.candidates.slice(0, FASTGATE_MAX_QUESTIONS)) {
      const meta = bySlug.get(cand.slug)
      if (meta === undefined) continue // vanished between retrieval and the shadow
      const qid = `c${metas.length + 1}`
      const instructions = candidateInstructions(meta)
      questions[qid] = { type: 'noul', instructions, criteria: candidateCriteria(meta) }
      metas.push({ qid, slug: cand.slug, instructions, disposition: cand.disposition })
    }
    if (metas.length === 0) return
    const result = await jevAsk({
      state,
      questions,
      config: jevConfigOf(this.service.cfg),
      lane: 'fastgate-shadow',
      fallback: false, // pure shadow — no behavior to fall back
    })
    if (!result.ok) return
    const at = new Date().toISOString()
    const recs: JevVerdictRecord[] = []
    for (const m of metas) {
      const probability = noulProbability(result.answers[m.qid])
      if (probability === undefined) continue // unparseable answer: no fabricated row
      const b = jevBand(probability, 'rerank')
      // agree reconciliation (§6.2): the ilog disposition, with wouldBlock for
      // the reverse disagreement (lexical let it through, jev lands in the veto
      // band — the other half of the calibration goldmine).
      const agree: JevVerdictRecord['agree'] = m.disposition === 'hit' && b === 'fallback' ? 'wouldBlock' : m.disposition
      recs.push({
        at,
        lane: 'fastgate-shadow',
        questionId: m.qid,
        qtype: 'noul',
        ref: `slug:${m.slug}`,
        digest: digestFor(state, m.qid, m.instructions),
        probability,
        band: b,
        agree,
      })
    }
    await logVerdicts(recs)
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
      // ---- jev batch rerank (design §2 row 1) — replaces the LLM rerank ----
      // One batched noul request over the whole band; the calibrated bands
      // decide the picks. A settled jev round is FINAL here (picks or none) —
      // only a jev FAILURE (jevRerank → undefined) falls open to the legacy
      // LLM rerank below (§3.2: 本轮回退旧 LLM rerank, picks 照常产出).
      if (this.service.cfg.jevEnabled === true) {
        const jevItems = await this.jevRerank(query, payload)
        if (jevItems !== undefined) {
          if (jevItems.length > 0) this.settlePending(sessionId, input, jevItems, queryBuild, started)
          return
        }
      }
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
      this.settlePending(sessionId, input, items, queryBuild, started)
    } catch {
      // timeouts, aborts, model errors — I3: the async product is simply absent
    } finally {
      clearTimeout(deadline)
    }
  }

  /** One pending slot per settled pipeline (the 0-2 picks + lane metadata). */
  private settlePending(sessionId: string, input: DispatchInput, items: { slug: string; why: string }[], queryBuild: QueryBuildShape, started: number): void {
    const route = this.service.cfg
    this.pending.set(sessionId, {
      items,
      computedAt: new Date().toISOString(),
      turnId: input.turnId,
      queryBuild,
      model: `${route.distillProvider}/${route.distillModel}`,
      ms: Date.now() - started,
    })
  }

  /**
   * The jev rerank (design §2 row 1): one batched noul request over the whole
   * candidate band; per-candidate verdict rows (agree: 'n/a' — no lexical
   * disposition applies on this seam). Gate: adopt band (≥ 0.60) ranked by
   * probability, top 2 (the 0-2 picks semantics); record band only logs;
   * fallback band (< 0.10) is a hard veto.
   *
   * Returns undefined on ANY failure — jevAsk !ok (timeout / network / gate /
   * bad shape) or an unparseable probability (坏答案) — so the caller fails
   * open to the legacy LLM rerank (red line ②; the call-layer row already
   * carries fallback=true via jevAsk's flag).
   */
  private async jevRerank(query: string, payload: JevCandidate[]): Promise<{ slug: string; why: string }[] | undefined> {
    const state = jevState(query)
    const questions: Record<string, JevQuestion> = {}
    const metas: { qid: string; slug: string; instructions: string }[] = []
    for (const [i, c] of payload.entries()) {
      const qid = `c${i + 1}`
      const instructions = candidateInstructions(c)
      questions[qid] = { type: 'noul', instructions, criteria: candidateCriteria(c) }
      metas.push({ qid, slug: c.slug, instructions })
    }
    const result = await jevAsk({
      state,
      questions,
      config: jevConfigOf(this.service.cfg),
      lane: 'slowlane-rerank',
      fallback: true, // any failure falls open to the legacy LLM rerank (§6.2)
    })
    if (!result.ok) return undefined
    const scored: { qid: string; slug: string; instructions: string; probability: number; band: JevBand }[] = []
    for (const m of metas) {
      const probability = noulProbability(result.answers[m.qid])
      if (probability === undefined) return undefined // 坏答案 → fail-open (§1)
      scored.push({ ...m, probability, band: jevBand(probability, 'rerank') })
    }
    const at = new Date().toISOString()
    await logVerdicts(
      scored.map((m) => ({
        at,
        lane: 'slowlane-rerank' as const,
        questionId: m.qid,
        qtype: 'noul' as const,
        ref: `slug:${m.slug}`,
        digest: digestFor(state, m.qid, m.instructions),
        probability: m.probability,
        band: m.band,
        agree: 'n/a' as const,
      })),
    )
    return scored
      .filter((m) => m.band === 'adopt')
      .sort((a, b) => b.probability - a.probability)
      .slice(0, 2)
      .map((m) => ({ slug: m.slug, why: `jev 判定相关（p=${m.probability.toFixed(2)}）` }))
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
