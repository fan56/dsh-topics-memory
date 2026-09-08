/**
 * Distill lane (M2, ADR 0004) — background LLM process that turns undistilled
 * observations into Topic writes.
 *
 * Single-flight per session, fire-and-forget from the observer, never throws
 * into the caller. The model route comes from config (distill-provider +
 * distill-model); when unset the lane stays idle with a visible status. The
 * actual LLM seam is injected as a `ModelCaller` so unit tests run hermetic.
 *
 * @module distill
 */

import * as okf from './okf.ts'
import type { TopicsService } from './service.ts'

export interface ModelRequest {
  system: string
  user: string
  purpose: string
  sessionId?: string
  maxTokens: number
  signal?: AbortSignal
}

export type ModelCaller = (req: ModelRequest) => Promise<string>

export interface DistillOp {
  op: 'create' | 'update'
  slug?: string
  title?: string
  description?: string
  tags?: string[]
  triggers?: string[]
  depends?: string[]
  open_questions?: string[]
  impact?: string[]
  conclusion?: string
  recommendations?: string
  status?: string
  observed_ids?: string[]
}

export interface DistillResult {
  ok: boolean
  reason?: 'no-model' | 'no-observations' | 'in-flight' | 'model-error' | 'invalid-output' | 'no-ops' | 'stalled'
  created: string[]
  updated: string[]
  marked: number
  /** Observations deleted by the post-run GC this run (present when > 0). */
  gcDropped?: number
  detail?: string
}

export const SYSTEM_PROMPT = [
  '你是 topic 记忆库的蒸馏引擎。输入是若干条未蒸馏的会话观察（JSON）和现有 topic 索引。',
  '任务：把观察沉淀成 Topic 操作。只输出一个 JSON 对象，不要任何其他文字、Markdown 代码块或解释。',
  '输出格式：{"ops": [...]}，每个元素：',
  '  {"op":"create","title":"主题名","description":"一句话","tags":["小写标签"],"triggers":["应想起本条的触发词"],"depends":["前置topic的slug"],',
  '   "open_questions":["未决问题"],"impact":["影响面"],"conclusion":"当前结论(自含散文)","recommendations":"可执行建议","status":"draft",',
  '   "observed_ids":["obs-..."]}',
  '  {"op":"update","slug":"已有slug","conclusion":"修订后的完整结论","open_questions":[...],"observed_ids":["obs-..."]}',
  '规则：',
  '- 硬性要求：每个 op 必须带 observed_ids 字段，值只能从本次输入「未蒸馏观察」里列出的 id 中逐字复制（形如 "obs-..."）；create 填它所综合依据的观察 id，update 填促使本次修订的观察 id。含列表之外 id 的条目会被过滤；observed_ids 缺失、为空或过滤后不剩任何有效 id 的 op 会被整体丢弃。',
  '- create 建议带 triggers：3-8 个「什么输入出现时应该想起这条记忆」的短语，写具体名词/术语，禁止 dsh、配置、错误 之类的泛词。',
  '- conclusion 必须自含（不依赖观察原文也能读懂），写「目前有效的结论」，不是流水账。',
  '- 同一主题只允许一个 create；已有相近 topic 时用 update 修订它的 conclusion。',
  '- 观察里有价值就沉淀，没价值就跳过该观察（被跳过观察的 id 不要出现在任何 op 里）；没有可沉淀内容时输出 {"ops":[]}。',
  '- 中文主题用中文写；tags 全小写。',
].join('\n')

/** Adaptive-batch floor — below this, shrinking cannot rescue an output limit. */
const MIN_BATCH_SIZE = 5
/** Fallbacks when the config fields are absent (bare test harnesses). */
const DEFAULT_BATCH_SIZE = 40
const DEFAULT_MAX_MODEL_CALLS = 8

/** Minimal observation surface the batch payload needs (structural, no store import). */
interface ObservationLike {
  id: string
  kind: string
  source: string
  text: string
}

/** Outcome of one model call over one batch (see Distiller.runBatch). */
interface BatchOutcome {
  created: string[]
  updated: string[]
  marked: number
  /** Model calls this batch spent (1, or 2 when the corrective retry fired). */
  callsUsed?: number
  /** observed_ids entries dropped for not matching the batch's true id set. */
  filteredIds?: number
  /** Model returned valid JSON with an empty ops array. */
  noOps?: boolean
  /** Model call died on the output-token limit (retryable with a smaller batch). */
  maxTokens?: boolean
  /** Non-retryable call failure classification (parse or stream error). */
  fatalReason?: 'model-error' | 'invalid-output'
  /** Batch ids an op actually consumed — the GC's consumed set for this batch. */
  consumedIds?: string[]
  detail?: string
  /**
   * Specific zero-consumption explanation for the stalled stop (undefined =
   * fall back to the generic slug hint).
   */
  stallDetail?: string
}

/** Outcome of executing (a sanitized subset of) one batch's ops. */
interface AppliedOps {
  created: string[]
  updated: string[]
  /** Batch-valid observation ids consumed by executed ops. */
  consumedIds: string[]
  consumedSlugs: string[]
  /** observed_ids entries dropped for not matching the batch's id set. */
  filteredIds: number
  /**
   * Structurally valid ops held back entirely because none of their
   * observed_ids matched the batch — the corrective-retry trigger.
   */
  droppedForIds: number
}

export class Distiller {
  private inFlight = new Map<string, Promise<DistillResult>>()
  private readonly service: TopicsService
  private readonly caller: ModelCaller | undefined
  /** Live batch size — adopted from config each run, shrunk on output-limit failures. */
  private batchSize = DEFAULT_BATCH_SIZE
  /** Config value the live batch size was adopted from; a config change resets the shrink state. */
  private batchSizeBase = DEFAULT_BATCH_SIZE

  constructor(service: TopicsService, caller: ModelCaller | undefined) {
    this.service = service
    this.caller = caller
  }

  /**
   * Adopt the configured batch size for this run. The shrink state sticks
   * across runs (a model that overflowed at 40 stays at 20 until restart),
   * but an explicit config change resets it — /topics set is the manual
   * grow-back lever, so the lane needs no speculative auto-recovery that
   * would just re-pay a failed call on every run.
   */
  private adoptBatchSize(configured: number): void {
    if (this.batchSizeBase !== configured) {
      this.batchSizeBase = configured
      this.batchSize = configured
    }
  }

  get configured(): boolean {
    return this.caller !== undefined
  }

  /**
   * Fire-and-forget from the observer; dedups concurrent runs per session.
   * Returns the run promise (undefined when deduped or unconfigured) so the
   * caller can hook post-run cleanup — the per-session llm capture in
   * index.ts must live exactly as long as a run that may read it. `manual`
   * is the /topics distill trigger: same lane, same in-flight guard.
   * `boot-replay` is the session-start backlog drain: a previous exit's
   * skipped (or killed-mid-run) distill replays here.
   */
  request(sessionId: string, reason: 'every-n' | 'session-end' | 'manual' | 'boot-replay'): Promise<DistillResult> | undefined {
    if (!this.configured) return undefined
    if (this.inFlight.has(sessionId)) return undefined
    const run = this.run(sessionId).finally(() => this.inFlight.delete(sessionId))
    this.inFlight.set(sessionId, run)
    void run.catch(() => undefined)
    return run
  }

  /** True while a run for the session is still in flight (teardown guard). */
  hasPending(sessionId: string): boolean {
    return this.inFlight.has(sessionId)
  }

  /** True while ANY session's run is still in flight (exit-dispose guard). */
  hasAnyPending(): boolean {
    return this.inFlight.size > 0
  }

  async run(sessionId?: string): Promise<DistillResult> {
    const result = await this.runInner(sessionId)
    // The GC count rides the detail (and the state file) so /topics status and
    // e2e diagnostics see how many observations were deleted, not just marked.
    const gcNote =
      result.gcDropped !== undefined && result.gcDropped > 0
        ? `；gc: dropped ${result.gcDropped} unprocessable observation(s)`
        : ''
    const detail =
      result.detail === undefined ? (gcNote === '' ? undefined : gcNote.replace(/^；/, '')) : `${result.detail}${gcNote}`
    // Persist the outcome — /topics status and e2e diagnostics both read it.
    // A failed write must not masquerade as success: the marks have already
    // landed, so the only witness left is the run detail the command output
    // shows. Surface the write error there instead of swallowing it.
    let stateNote = ''
    await this.service.store
      .writeDistillState({
        at: new Date().toISOString(),
        ok: result.ok,
        reason: result.reason,
        created: result.created,
        updated: result.updated,
        marked: result.marked,
        gcDropped: result.gcDropped,
        detail,
      })
      .catch((err: unknown) => {
        stateNote = `；distill-state 写入失败: ${err instanceof Error ? err.message : String(err)}`
      })
    const fullDetail =
      stateNote === '' ? detail : detail === undefined ? stateNote.replace(/^；/, '') : `${detail}${stateNote}`
    return { ...result, detail: fullDetail }
  }

  private async runInner(sessionId?: string): Promise<DistillResult> {
    if (!this.configured || this.caller === undefined) {
      return { ok: false, reason: 'no-model', created: [], updated: [], marked: 0 }
    }
    // Route gate — checked PER RUN here rather than once at wiring time, so
    // `/topics set distill-provider` stays live without a plugin reload. An
    // empty route must never start lane bookkeeping: a GC attempt recorded
    // against a lane that cannot call the model would turn three automatic
    // triggers into data deletion. Short-circuit BEFORE the first fetch,
    // with the readable reason /topics distill surfaces.
    const routeCfg = this.service.cfg
    if ((routeCfg.distillProvider ?? '') === '' || (routeCfg.distillModel ?? '') === '') {
      return {
        ok: false,
        reason: 'no-model',
        created: [],
        updated: [],
        marked: 0,
        detail: 'distill route not configured (set distill-provider and distill-model)',
      }
    }
    // Bounded batch loop (livelock fix): the pre-fix lane fed the whole
    // newest-40 undistilled window into one model call and failed the entire
    // run on a single output-limit overflow — nothing was ever marked, so
    // the same batch was re-fetched forever. The loop walks the pool in
    // batches, halves the batch on an output-limit failure (the escape
    // hatch: a smaller head provably converges toward the floor), stops when
    // a batch cannot make progress, and keeps the marks of every successful
    // batch (partial progress beats zero progress) under a per-run budget.
    const cfg = this.service.cfg
    // The floor bounds the ADAPTIVE shrink only — an explicit (small) config
    // value is honored as-is, clamped merely to a positive fetch size.
    this.adoptBatchSize(Math.max(1, cfg.distillBatchSize ?? DEFAULT_BATCH_SIZE))
    const maxCalls = Math.max(1, cfg.distillMaxModelCalls ?? DEFAULT_MAX_MODEL_CALLS)
    const created: string[] = []
    const updated: string[] = []
    let marked = 0
    let calls = 0
    // Why the loop ended before draining the pool (undefined = pool drained).
    let stopped: 'budget' | 'no-ops' | 'stalled' | 'max-tokens' | 'failure' | undefined
    let failureReason: 'model-error' | 'invalid-output' | undefined
    let failureDetail: string | undefined
    let firstFetch = true
    let filteredTotal = 0
    let stallDetail: string | undefined
    // GC bookkeeping (store.recordUnconsumed): every id the model EVALUATED
    // this run (parseable answer, however useless) minus the ids an op
    // consumed = one failed attempt per observation; three failed attempts
    // delete it from the pool. Collection happens per-outcome in the loop
    // below, not at fetch time: a batch whose call threw (model-error) or
    // produced unparseable text (invalid-output) never counts, and neither
    // does a shrink retry that has not been evaluated yet (BLOCKER-1: three
    // ECONNREFUSED runs must not delete data the model never saw).
    const fedIds = new Set<string>()
    const consumedRunIds = new Set<string>()
    for (;;) {
      const observations = await this.service.store.undistilledObservations(this.batchSize)
      if (observations.length === 0) {
        if (firstFetch) {
          return { ok: false, reason: 'no-observations', created: [], updated: [], marked: 0 }
        }
        break
      }
      firstFetch = false
      if (calls >= maxCalls) {
        stopped = 'budget'
        break
      }
      // The batch spends 1 call, or 2 when the corrective observed_ids retry
      // fires — the budget check above already guaranteed room for both.
      const outcome = await this.runBatch(sessionId, observations, maxCalls - calls)
      calls += Math.max(1, outcome.callsUsed ?? 1)
      for (const id of outcome.consumedIds ?? []) consumedRunIds.add(id)
      filteredTotal += outcome.filteredIds ?? 0
      created.push(...outcome.created)
      updated.push(...outcome.updated)
      marked += outcome.marked
      if (outcome.maxTokens) {
        // Provisional failure record: if a later batch succeeds it stays
        // unused (progress branch wins); if the run ends without progress
        // (budget out, floor reached) it is exactly what the state should show.
        failureReason = 'model-error'
        failureDetail = outcome.detail
        if (this.batchSize > MIN_BATCH_SIZE) {
          this.batchSize = Math.max(MIN_BATCH_SIZE, Math.floor(this.batchSize / 2))
          // Not evaluated yet: the same head is re-fed smaller below, and
          // only the outcome that actually renders a verdict counts a GC
          // attempt (a mid-shrink overflow is capacity, not a content
          // judgment).
          continue // retry the smaller same-head batch — the livelock escape
        }
        // Floor reached: repeated output-limit finishes ARE an evaluation
        // verdict on this content (the model saw it and could not fit an
        // answer) — the batch counts toward the GC.
        for (const o of observations) fedIds.add(o.id)
        stopped = 'max-tokens'
        failureDetail = `批次无法再缩小（当前 ${this.batchSize} 条）仍触发输出上限：${outcome.detail ?? 'model finish: max-tokens'}`
        break
      }
      if (outcome.fatalReason !== undefined) {
        // model-error (call threw) / invalid-output (unparseable text): the
        // model never evaluated the content, so the batch gains NO GC
        // attempt — three network blips must not delete the pool.
        stopped = 'failure'
        failureReason = outcome.fatalReason
        failureDetail = outcome.detail
        break
      }
      // Parseable answer (ops, empty or not): the batch was genuinely
      // evaluated — its unconsumed ids gain one failed attempt.
      for (const o of observations) fedIds.add(o.id)
      if (outcome.noOps) {
        stopped = 'no-ops'
        break
      }
      if (outcome.marked === 0) {
        // Ops came back but consumed none of this batch's observations — the
        // head cannot advance, so re-calling would only repeat (or duplicate
        // topics). Stop and surface what already landed.
        stopped = 'stalled'
        stallDetail = outcome.stallDetail
        break
      }
    }
    // Post-run GC: every fed-but-unconsumed observation gains a failed
    // attempt; three strikes delete it. Best-effort — never fail a run over
    // bookkeeping.
    let gcDropped: number | undefined
    if (fedIds.size > 0) {
      try {
        const { dropped } = await this.service.store.recordUnconsumed([...fedIds], [...consumedRunIds])
        if (dropped > 0) gcDropped = dropped
      } catch {
        // contained — the run result stands without the GC note
      }
    }
    const progress = created.length + updated.length > 0
    let result: DistillResult
    if (progress) {
      const head =
        stopped === 'budget'
          ? `已达单次 run 模型调用预算（${calls}/${maxCalls}），剩余积压留待后续 run`
          : stopped === 'max-tokens'
            ? '随后批次触发输出上限，本轮停止'
            : stopped === 'failure'
              ? `随后批次失败，本轮停止：${failureDetail ?? 'unknown'}`
              : stopped === 'no-ops'
                ? '后续批次模型未产出 ops，本轮停止'
                : stopped === 'stalled'
                  ? `后续批次未消费任何观察，本轮停止${stallDetail !== undefined ? `：${stallDetail}` : ''}`
                  : undefined
      const filteredNote = filteredTotal > 0 ? `；filtered ${filteredTotal} invalid observed_ids` : ''
      const base = head === undefined ? undefined : `partial: 已蒸馏标记 ${marked} 条观察（${calls} 次模型调用）；${head}`
      result = {
        ok: true,
        created,
        updated,
        marked,
        detail:
          base === undefined
            ? filteredNote === ''
              ? undefined
              : filteredNote.replace(/^；/, '')
            : `${base}${filteredNote}`,
      }
    } else {
      result = {
        ok: false,
        reason:
          failureReason ??
          (stopped === 'no-ops' ? 'no-ops' : stopped === 'stalled' ? 'stalled' : undefined),
        created: [],
        updated: [],
        marked: 0,
        // A stalled run must never land as an unexplained failure: the batch
        // names its own zero-consumption cause when it can (invalid
        // observed_ids), otherwise the generic slug hint stands.
        detail:
          failureDetail ??
          (stopped === 'stalled'
            ? stallDetail ?? '批次 ops 未消费任何观察（常见原因：ops 引用了不存在的 topic slug）'
            : undefined),
      }
    }
    if (gcDropped !== undefined) result.gcDropped = gcDropped
    return result
  }

  /**
   * One model call (plus at most one corrective retry) over one batch:
   * payload build → ops → topic writes → marks. `budgetLeft` is the calls
   * still available to the run including this batch's first call (≥ 1); the
   * corrective retry only fires when it can stay inside that budget.
   */
  private async runBatch(
    sessionId: string | undefined,
    observations: readonly ObservationLike[],
    budgetLeft: number,
  ): Promise<BatchOutcome> {
    const metas = await this.service.store.listTopics()
    // Real open questions need the docs; fetch for index (bounded).
    const indexDetailed = []
    for (const m of metas.slice(0, 100)) {
      const doc = await this.service.store.readTopic(m.slug).catch(() => undefined)
      indexDetailed.push({
        slug: m.slug,
        title: m.title,
        status: m.status,
        tags: m.tags,
        open_questions: doc?.fm.open_questions ?? [],
        conclusion: (okf.firstParagraph(okf.sectionOf(doc?.body ?? '', okf.CONCLUSION_HEADING) ?? '')).slice(0, 200),
      })
    }
    const observationsPayload = observations.map((o) => ({ id: o.id, kind: o.kind, source: o.source, text: o.text }))
    const user = [
      `现有 topic 索引（${indexDetailed.length} 个）：`,
      JSON.stringify(indexDetailed),
      '',
      `未蒸馏观察（${observationsPayload.length} 条）：`,
      JSON.stringify(observationsPayload),
      '',
      '请输出蒸馏结果（严格 JSON，{"ops":[...]}）：',
    ].join('\n')
    let raw: string
    const caller = this.caller
    if (caller === undefined) {
      // Unreachable via runInner (it guards), but never let a future call site
      // turn a wiring bug into a silent invalid-output.
      return { created: [], updated: [], marked: 0, fatalReason: 'model-error', detail: 'distill caller unavailable' }
    }
    try {
      raw = await caller({ system: SYSTEM_PROMPT, user, purpose: 'topics-distill', sessionId, maxTokens: 4000 })
    } catch (e) {
      const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
      return isMaxTokens(e)
        ? { created: [], updated: [], marked: 0, maxTokens: true, detail }
        : { created: [], updated: [], marked: 0, fatalReason: 'model-error', detail }
    }
    let ops: DistillOp[]
    try {
      ops = parseOps(raw)
    } catch (e) {
      return {
        created: [],
        updated: [],
        marked: 0,
        fatalReason: 'invalid-output',
        detail: String(e instanceof Error ? e.message : e).slice(0, 200),
      }
    }
    if (ops.length === 0) {
      return { created: [], updated: [], marked: 0, noOps: true, callsUsed: 1 }
    }
    // observed_ids are the ONLY bridge between ops and marks — without a valid
    // id the store cannot mark anything and the batch head can never advance
    // (the real-machine zero-consumption livelock: topics landed, backlog
    // never moved). Sanitize against the batch's TRUE id set BEFORE executing:
    // an op whose ids all miss the batch is unattributable and gets held back,
    // because executing it anyway would duplicate the topic when the
    // corrective retry re-emits it with fixed ids.
    const validIds = new Set(observations.map((o) => o.id))
    const idList = observations.map((o) => o.id)
    let applied = await this.applyOps(ops, validIds)
    let callsUsed = 1
    if (applied.consumedIds.length === 0 && applied.droppedForIds > 0) {
      if (budgetLeft < 2) {
        // No free lane: the retry must fit the same run budget.
        return {
          created: [],
          updated: [],
          marked: 0,
          callsUsed,
          filteredIds: applied.filteredIds,
          stallDetail: `ops 未包含有效 observed_ids（已过滤 ${applied.filteredIds} 个无效 id），且模型调用预算不足以纠错重试（剩余 ${budgetLeft - 1} 次）`,
        }
      }
      const pass1 = applied
      const { applied: pass2, why } = await this.correctiveRetry(sessionId, user, idList, validIds)
      callsUsed = 2
      if (pass2 === undefined || pass2.consumedIds.length === 0) {
        const tail =
          pass2 === undefined
            ? `纠错重试未产出可消费的 ops（${why}）`
            : `纠错重试后 ops 仍未包含有效 observed_ids（累计过滤 ${pass1.filteredIds + pass2.filteredIds} 个无效 id）`
        return {
          created: [...pass1.created, ...pass2?.created ?? []],
          updated: [...pass1.updated, ...pass2?.updated ?? []],
          marked: 0,
          callsUsed,
          filteredIds: pass1.filteredIds + (pass2?.filteredIds ?? 0),
          stallDetail: `${tail}；本批 ${observations.length} 条观察零消费`,
        }
      }
      applied = {
        created: [...pass1.created, ...pass2.created],
        updated: [...pass1.updated, ...pass2.updated],
        consumedIds: pass2.consumedIds,
        consumedSlugs: pass2.consumedSlugs,
        filteredIds: pass1.filteredIds + pass2.filteredIds,
        droppedForIds: pass2.droppedForIds,
      }
    }
    let marked = 0
    if (applied.consumedIds.length > 0) {
      marked = await this.service.store.markDistilled(applied.consumedIds, applied.consumedSlugs)
    }
    void this.service.sync?.schedulePush()
    return {
      created: applied.created,
      updated: applied.updated,
      marked,
      callsUsed,
      filteredIds: applied.filteredIds,
      consumedIds: applied.consumedIds,
    }
  }

  /**
   * The ONE corrective retry for a zero-valid-observed_ids batch: re-ask with
   * the batch's legal id list spelled out verbatim. It spends a second call
   * from the same run budget; any failure here resolves to
   * `{ applied: undefined, why }` and the caller falls through to the stalled
   * stop — a max-tokens correction does NOT trigger the batch halving (that
   * escape hatch belongs to the main pass).
   */
  private async correctiveRetry(
    sessionId: string | undefined,
    originalUser: string,
    idList: readonly string[],
    validIds: ReadonlySet<string>,
  ): Promise<{ applied?: AppliedOps; why: string }> {
    const caller = this.caller
    if (caller === undefined) return { why: 'distill caller unavailable' }
    const user = [
      originalUser,
      '',
      '---',
      '纠错重试：你上一次返回的 ops 未包含任何有效的 observed_ids。',
      `本批合法观察 id 列表（共 ${idList.length} 个，必须逐字复制，禁止改写、缩写或编造）：`,
      JSON.stringify(idList),
      '请重新输出完整蒸馏结果（严格 JSON，{"ops":[...]}）：每个 op 必须带 observed_ids，值只能从上面的列表逐字选取；create 填它所综合依据的观察 id，update 填促使本次修订的观察 id。没有可沉淀内容就输出 {"ops":[]}。',
    ].join('\n')
    let raw: string
    try {
      raw = await caller({ system: SYSTEM_PROMPT, user, purpose: 'topics-distill', sessionId, maxTokens: 4000 })
    } catch (e) {
      return { why: `模型调用失败：${String(e instanceof Error ? e.message : e).slice(0, 160)}` }
    }
    let retried: DistillOp[]
    try {
      retried = parseOps(raw)
    } catch (e) {
      return { why: `输出无法解析：${String(e instanceof Error ? e.message : e).slice(0, 160)}` }
    }
    if (retried.length === 0) return { why: '模型返回空 ops' }
    return { applied: await this.applyOps(retried, validIds), why: '' }
  }

  /**
   * Execute a batch's ops with observed_ids sanitized upfront. A scalar
   * observed_ids string (the commonest model shape drift) is normalized to a
   * one-element list; other non-array shapes are held back as droppedForIds
   * rather than dying in the per-op catch. An op whose
   * sanitized id set is empty is held back entirely (droppedForIds): an
   * unattributable topic write is one the marks can never account for, and
   * the stalled stop would leave it duplicated on the next run. Structural
   * failures (missing fields, unknown update slug) keep the per-op try/catch
   * isolation — one bad op never sinks the batch, and a stall they cause is
   * NOT attributed to observed_ids (no corrective retry for those).
   */
  private async applyOps(ops: readonly DistillOp[], validIds: ReadonlySet<string>): Promise<AppliedOps> {
    const applied: AppliedOps = {
      created: [],
      updated: [],
      consumedIds: [],
      consumedSlugs: [],
      filteredIds: 0,
      droppedForIds: 0,
    }
    for (const op of ops) {
      try {
        // Shape normalization first: models most often deviate by returning a
        // scalar string instead of a list — rescue it into a one-element list.
        // Any other non-array shape counts toward droppedForIds so the
        // corrective-retry gate fires, instead of a silent TypeError in the
        // per-op catch below that would misattribute the stall.
        const rawIds: readonly unknown[] = Array.isArray(op.observed_ids)
          ? op.observed_ids
          : typeof op.observed_ids === 'string'
            ? [op.observed_ids]
            : []
        const ids = rawIds.filter((id): id is string => typeof id === 'string' && validIds.has(id))
        applied.filteredIds += Math.max(0, rawIds.length - ids.length)
        if (ids.length === 0) {
          applied.droppedForIds += 1
          continue
        }
        if (op.op === 'create' && typeof op.title === 'string' && typeof op.conclusion === 'string') {
          const res = await this.service.saveTopic({
            title: op.title,
            conclusion: op.conclusion,
            description: op.description,
            tags: op.tags,
            triggers: Array.isArray(op.triggers) ? op.triggers.filter((t): t is string => typeof t === 'string') : undefined,
            depends: op.depends,
            openQuestions: op.open_questions,
            impact: op.impact,
            recommendations: op.recommendations,
            status: op.status === 'stable' ? 'stable' : 'draft',
            source: 'distill',
          })
          applied.created.push(res.slug)
          applied.consumedSlugs.push(res.slug)
        } else if (op.op === 'update' && typeof op.slug === 'string') {
          const existing = await this.service.store.readTopic(op.slug)
          if (existing === undefined) continue
          const res = await this.service.saveTopic({
            title: existing.fm.title,
            conclusion: typeof op.conclusion === 'string' ? op.conclusion : undefined,
            openQuestions: op.open_questions,
            status: op.status === 'stable' || op.status === 'deprecated' ? op.status : undefined,
            slug: op.slug,
            source: 'distill',
          })
          applied.updated.push(res.slug)
          applied.consumedSlugs.push(res.slug)
        } else {
          continue
        }
        applied.consumedIds.push(...ids)
      } catch {
        // One bad op must not sink the batch; unconsumed observations stay pending.
      }
    }
    return applied
  }
}

/** Extract the first balanced JSON object from model output (tolerates fences). */
export function parseOps(raw: string): DistillOp[] {
  let text = raw.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  if (fence !== null) text = fence[1].trim()
  const start = text.indexOf('{')
  if (start < 0) throw new Error('no JSON object in output')
  // Balanced-brace scan respecting strings.
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
        const ops = (parsed as { ops?: unknown }).ops
        if (!Array.isArray(ops)) throw new Error('output has no ops array')
        return ops.filter((o): o is DistillOp => o !== null && typeof o === 'object')
      }
    }
  }
  throw new Error('unbalanced JSON in output')
}

/**
 * Minimal live-route probe surface, shared by the distill lane and the
 * distill-route pickers: any llm-like service instance with an optional
 * provider listing. A disposed scope throws on access.
 */
export interface LlmProbeShape {
  listProviders?(): readonly { id: string }[]
}

/**
 * A candidate llm instance plus the cheap liveness probe. `listProviders` is
 * optional so bare fakes still work; when present it must list the route's
 * provider for the instance to qualify.
 */
export interface LlmCandidateShape extends LlmProbeShape {
  stream(options: unknown): AsyncIterable<unknown>
}

export interface LlmCandidatePick {
  llm?: LlmProbeShape
  /** How many candidates exposed a live route table (probe ran cleanly). */
  probed: number
}

/**
 * The one walker behind both llm-instance picks (distill lane + route pickers)
 * so their semantics cannot drift: walk the candidates in priority order and
 * return the first whose live route table satisfies `probe`, plus how many
 * candidates were cleanly probed along the way (the caller uses that to tell
 * 「有实例但不匹配」 apart from 「没有实例」). A disposed scope throws on
 * access — that instance is skipped, not fatal. An instance WITHOUT the probe
 * is accepted as-is unless `requireProbe` is set: it offers nothing to compare
 * against, so an unprobable candidate can never vouch for the route.
 */
export function pickLlmCandidate(
  candidates: readonly (LlmProbeShape | undefined)[],
  probe: (providers: readonly { id: string }[]) => boolean,
  requireProbe = false,
): LlmCandidatePick {
  let probed = 0
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    try {
      const providers = typeof candidate.listProviders === 'function' ? candidate.listProviders() : undefined
      if (providers !== undefined) {
        probed += 1
        if (!probe(providers)) continue
      } else if (requireProbe) {
        // An unprobeable instance cannot prove an adapter serves the route —
        // skipping it is what lets the pre-flight fail with the readable
        // message instead of letting a later stream() surface a raw NO_ADAPTER.
        continue
      }
    } catch {
      continue // disposed scope: even touching the service throws
    }
    return { llm: candidate, probed }
  }
  return { probed }
}

/**
 * Cheap pre-flight for the distill lane: walk the candidates in priority order
 * (per-session capture first, then the session-wide capture, apply-time root
 * last) and return the only instance that honestly qualifies — one whose live
 * `listProviders()` PROVES a registered adapter serves `provider`. On dsh-llm
 * 0.1.2-alpha.4 `listProviders()` reads the same adapter registry `stream()`
 * dispatches through (lib/index.js:1308 vs :1626), so a probed match is an
 * adapter guarantee; candidates that cannot be probed are skipped, not
 * trusted. Fails BEFORE calling stream, with the failure mode readable: a
 * reachable instance that lacks the route (scope released by a teardown, or a
 * typo'd provider) says so; no reachable instance at all says that instead.
 */
export function pickLiveLlm(candidates: readonly (LlmCandidateShape | undefined)[], provider: string): LlmCandidateShape {
  const { llm, probed } = pickLlmCandidate(
    candidates,
    (providers) => providers.some((p) => p.id === provider),
    true,
  )
  if (llm !== undefined) return llm as LlmCandidateShape
  if (probed > 0) {
    throw new Error(`distill-provider «${provider}» 没有匹配的模型路由（检查拼写或本机 provider 配置），等待下次会话启动重试`)
  }
  throw new Error(`蒸馏模型路由 ${provider} 暂不可用：没有可用的模型服务实例（会话已结束或本机 llm 服务缺失）`)
}

/** True for the adapter-registry miss thrown by `llm.stream()` on a route nobody registered. */
function isNoAdapter(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  if ((error as { code?: unknown }).code === 'NO_ADAPTER') return true
  return typeof (error as { message?: unknown }).message === 'string' && /no adapter registered for provider/i.test((error as { message: string }).message)
}

/**
 * True for the output-token-limit finish — the one model failure a smaller
 * batch can actually rescue (fewer observations in, fewer ops out). Stamped
 * as `code: 'MAX_TOKENS'` by defaultModelCaller's finish branch; the message
 * fallback is anchored to the exact finish shape this lane itself emits
 * (`model finish: <kind>`), so a request-side error that merely mentions
 * max-tokens in its text can never trigger the persistent batch shrink.
 */
function isMaxTokens(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  if ((error as { code?: unknown }).code === 'MAX_TOKENS') return true
  return (
    typeof (error as { message?: unknown }).message === 'string' &&
    /^model finish: (max-tokens|length)$/i.test((error as { message: string }).message)
  )
}

/**
 * Default ModelCaller over the dsh LLM seam (`ctx.llm.stream` + BlockAssembler),
 * following dsh-session-title-llm's call policy. `getCandidates` supplies the
 * ordered instance candidates — production passes the triggering session's
 * captured instance first, then the session-wide capture and the apply-time
 * root; the first one whose live routes prove the configured provider wins.
 * The configured-route gate is NOT here: `Distiller.runInner` checks the
 * route per run (so `/topics set distill-provider` stays live without a
 * reload); this closure's own route check at call time is defense-in-depth
 * for direct callers.
 *
 * Last-line guarantee: whatever host shape the candidates come from, a
 * `NO_ADAPTER` miss inside `stream()` is never recorded raw — it is rethrown
 * as a readable failure naming the route and the likely cause, so the
 * distill-state detail stays actionable (CHANGELOG promise).
 *
 * dsh 0.1.2-alpha.3 seam shape: `GenerateOptions.purpose` is the closed union
 * `'compaction' | 'session-title'` — a distill call has no sanctioned value
 * there, so it stays unset (ordinary-conversation classification). `sessionId`
 * is `Branded<'SessionId'>`, stamped by the agent loop for request routing and
 * replay cursors; this lane runs outside the loop (often after session end),
 * so it stays unset too. `deepFreeze` moved to @deepseek-ai/dsh-util-values.
 */
export function defaultModelCaller(
  getCandidates: (req?: ModelRequest) => readonly (LlmCandidateShape | undefined)[],
  getRoute: () => { provider: string; model: string } | undefined,
): ModelCaller | undefined {
  return async (req) => {
    const route = getRoute()
    if (route === undefined) throw new Error('distill route not configured (set distill-provider and distill-model)')
    const llm = pickLiveLlm(getCandidates(req), route.provider)
    const { BlockAssembler, createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const { deepFreeze } = await import('@deepseek-ai/dsh-util-values')
    const messages = [
      createUserMessage({
        content: [{ type: 'text', text: req.user }],
        source: { kind: 'plugin', plugin: 'dsh-topics-memory' },
      }),
    ]
    const options = deepFreeze({
      provider: route.provider,
      model: route.model,
      messages,
      system: req.system,
      maxTokens: req.maxTokens,
      signal: req.signal,
    })
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of llm.stream(options)) {
        ;(assembler as unknown as { push(c: unknown): void }).push(chunk)
      }
    } catch (e) {
      if (isNoAdapter(e)) {
        const message = e instanceof Error ? e.message : String(e)
        throw new Error(
          `蒸馏模型路由 ${route.provider}/${route.model} 缺少 provider 适配器（${message}）：` +
            '会话级 llm 实例可能已随会话结束释放，请在会话活跃期间触发蒸馏，或检查宿主是否加载了 provider 适配器插件',
        )
      }
      throw e
    }
    // Defensive: tolerate both object {kind, ...} and bare-string finish
    // shapes; the bare-string form has never been observed in any known
    // dsh-llm version.
    const finish = assembler.finish as string | { kind?: string; failure?: { message: string } } | undefined
    const finishKind = typeof finish === 'string' ? finish : finish?.kind
    const failure = typeof finish === 'object' && finish !== undefined ? finish.failure : undefined
    if (finish !== undefined && finishKind !== 'stop') {
      const message = failure?.message ?? `model finish: ${String(finishKind)}`
      if (finishKind === 'max-tokens' || finishKind === 'length') {
        // Code-stamped so the distill loop can classify it as the one
        // retryable-with-a-smaller-batch failure (isMaxTokens).
        throw Object.assign(new Error(message), { code: 'MAX_TOKENS' })
      }
      throw new Error(message)
    }
    const blocks = assembler.blocks() as { type: string; text?: string }[]
    const text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('')
    if (text.trim() === '') throw new Error('model produced no text')
    return text
  }
}
