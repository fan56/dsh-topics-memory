import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { TopicsService } from '../lib/service.js'
import { Distiller, SYSTEM_PROMPT, defaultModelCaller, parseOps, pickLiveLlm } from '../lib/distill.js'

function make(cfgOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'topics-distill-'))
  const store = new BundleStore(root)
  let cfg = {
    repo: '', autoInject: true, topK: 4, perTopicBudget: 300, totalBudget: 1500,
    matchThreshold: 0.3, tagBoost: 0.15, graphDepth: 2, recencyWindowDays: 7,
    autoObserve: true, observationMaxChars: 2000, distillEveryTurns: 20,
    distillOnSessionEnd: true,
    // A configured route by default — the runInner route gate short-circuits
    // empty-route lanes, and almost every test here exercises the lane.
    distillProvider: 'p', distillModel: 'm', pushDebounceSeconds: 45,
    ...cfgOverrides,
  }
  const service = new TopicsService(store, () => cfg)
  const cleanup = () => rmSync(root, { recursive: true, force: true })
  return { root, store, service, cleanup }
}

const MODEL_JSON = JSON.stringify({
  ops: [
    {
      op: 'create',
      title: 'dsh-cron 定时方案',
      description: '定时任务落地方式',
      tags: ['dsh', 'cron'],
      depends: [],
      open_questions: ['错过窗口是否补跑'],
      impact: ['运维流程'],
      conclusion: 'dsh 无原生 cron；用 headless 会话加 OS cron，最长窗口一年。',
      recommendations: '配每日 schedule 兜底。',
      status: 'draft',
      observed_ids: ['obs-1', 'obs-2'],
    },
    {
      op: 'update',
      slug: 'dsh-cron-定时方案',
      conclusion: '补跑策略已定：不补跑，仅告警。',
      observed_ids: ['obs-3'],
    },
  ],
})

test('parseOps: plain JSON, fenced, tolerant extraction', () => {
  assert.equal(parseOps(MODEL_JSON).length, 2)
  assert.equal(parseOps('```json\n' + MODEL_JSON + '\n```').length, 2)
  assert.equal(parseOps('前导废话 {\"ops\": []} 尾巴').length, 0)
  assert.throws(() => parseOps('{"ops":')) // unbalanced
  assert.throws(() => parseOps('no json at all'))
  assert.throws(() => parseOps('{"noops": 1}'))
  // Non-object ops entries filtered.
  assert.equal(parseOps('{"ops": [1, null, {"op":"create"}]}').length, 1)
})

test('distiller: no model configured → idle', async () => {
  const h = make()
  try {
    const d = new Distiller(h.service, undefined)
    assert.equal(d.configured, false)
    const r = await d.run()
    assert.equal(r.reason, 'no-model')
    d.request('s1', 'every-n') // fire-and-forget must not crash
    await new Promise((r) => setTimeout(r, 20))
  } finally {
    h.cleanup()
  }
})

test('distiller: no observations → nothing to do', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const d = new Distiller(h.service, async () => MODEL_JSON)
    const r = await d.run('s1')
    assert.equal(r.reason, 'no-observations')
  } finally {
    h.cleanup()
  }
})

test('distiller: create + update ops land, observations marked distilled', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const o1 = await h.store.appendObservation({ kind: 'finding', source: 'auto', text: '观察到一' })
    const o2 = await h.store.appendObservation({ kind: 'decision', source: 'model', text: '观察到二', sessionId: 's1' })
    const o3 = await h.store.appendObservation({ kind: 'question', source: 'auto', text: '观察到三' })
    const modelJson = JSON.stringify({
      ops: [
        {
          op: 'create',
          title: 'dsh-cron 定时方案',
          description: '定时任务落地方式',
          tags: ['dsh', 'cron'],
          triggers: ['cron', '定时任务', '调度'],
          depends: [],
          open_questions: ['错过窗口是否补跑'],
          impact: ['运维流程'],
          conclusion: 'dsh 无原生 cron；用 headless 会话加 OS cron，最长窗口一年。',
          recommendations: '配每日 schedule 兜底。',
          status: 'draft',
          observed_ids: [o1.id, o2.id],
        },
        {
          op: 'update',
          slug: 'dsh-cron-定时方案',
          conclusion: '补跑策略已定：不补跑，仅告警。',
          observed_ids: [o3.id],
        },
      ],
    })
    const d = new Distiller(h.service, async (req) => {
      assert.match(req.system, /蒸馏引擎/)
      assert.match(req.user, /未蒸馏观察/)
      assert.ok(req.user.includes(o1.id), 'observation ids included in prompt')
      assert.equal(req.purpose, 'topics-distill')
      return modelJson
    })
    const r = await d.run('s1')
    assert.equal(r.ok, true)
    assert.deepEqual(r.created, ['dsh-cron-定时方案'])
    assert.deepEqual(r.updated, ['dsh-cron-定时方案'])
    assert.equal(r.marked, 3)
    const pending = await h.store.undistilledObservations()
    assert.equal(pending.length, 0)
    const doc = await h.store.readTopic('dsh-cron-定时方案')
    assert.match(doc.body, /补跑策略已定/) // update applied after create
    assert.equal(doc.fm.status, 'draft')
    const after = await h.store.allObservations()
    assert.equal(after.filter((o) => !o.distilled).length, 0)
    // o1+o2 fed the create, o3 fed the update — both ops wrote the same slug.
    assert.deepEqual(after[0].distilledInto, ['dsh-cron-定时方案', 'dsh-cron-定时方案'])
  } finally {
    h.cleanup()
  }
})

test('distiller: model error contained with reason', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await h.store.appendObservation({ kind: 'turn', source: 'auto', text: 'x' })
    const d = new Distiller(h.service, async () => {
      throw new Error('rate limited')
    })
    const r = await d.run()
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'model-error')
    assert.match(r.detail, /rate limited/)
    // Observations remain pending for retry.
    assert.equal((await h.store.undistilledObservations()).length, 1)
  } finally {
    h.cleanup()
  }
})

test('distiller: invalid JSON output contained', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await h.store.appendObservation({ kind: 'turn', source: 'auto', text: 'x' })
    const d = new Distiller(h.service, async () => '我觉得应该记点什么，但我不输出 JSON。')
    const r = await d.run()
    assert.equal(r.reason, 'invalid-output')
  } finally {
    h.cleanup()
  }
})

test('distiller: single-flight per session dedups concurrent runs', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await h.store.appendObservation({ kind: 'turn', source: 'auto', text: 'x' })
    let calls = 0
    const d = new Distiller(h.service, async () => {
      calls += 1
      await new Promise((r) => setTimeout(r, 50))
      return '{"ops":[]}'
    })
    d.request('s1', 'every-n')
    d.request('s1', 'session-end') // deduped
    d.request('s1', 'session-end')
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(calls, 1)
    // After completion a new request runs again.
    await h.store.appendObservation({ kind: 'turn', source: 'auto', text: 'y' })
    d.request('s1', 'every-n')
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(calls, 2)
  } finally {
    h.cleanup()
  }
})

test('distiller: request exposes the run; hasPending guards teardown cleanup', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await h.store.appendObservation({ kind: 'turn', source: 'auto', text: 'x' })
    const d = new Distiller(h.service, async () => {
      await new Promise((r) => setTimeout(r, 30))
      return '{"ops":[]}'
    })
    const run = d.request('s1', 'every-n')
    assert.ok(run instanceof Promise, 'request returns the run promise')
    assert.equal(d.hasPending('s1'), true, 'in-flight run is visible to the teardown guard')
    assert.equal(d.request('s1', 'session-end'), undefined, 'concurrent request is deduped (no run)')
    await run
    assert.equal(d.hasPending('s1'), false, 'guard clears once the run settles')
    // Unconfigured distiller: no run, never pending.
    const d2 = new Distiller(h.service, undefined)
    assert.equal(d2.request('s1', 'every-n'), undefined)
    assert.equal(d2.hasPending('s1'), false)
  } finally {
    h.cleanup()
  }
})

test('distiller: skipped observations stay pending', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const o1 = await h.store.appendObservation({ kind: 'turn', source: 'auto', text: '被消费' })
    const o2 = await h.store.appendObservation({ kind: 'turn', source: 'auto', text: '被跳过' })
    const d = new Distiller(h.service, async () => JSON.stringify({
      ops: [{ op: 'create', title: 'T', description: '一句话', triggers: ['甲', '乙', '丙'], conclusion: '结论', observed_ids: [o1.id] }],
    }))
    const r = await d.run()
    assert.equal(r.ok, true)
    assert.equal(r.marked, 1)
    const pending = await h.store.undistilledObservations()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].id, o2.id)
  } finally {
    h.cleanup()
  }
})

// ---- Distill lane instance probing (D) ----

test('pickLiveLlm: scoped wins, route-less and disposed candidates are skipped', () => {
  const scopedStale = { stream() {}, listProviders: () => [{ id: 'other' }] }
  const root = { stream() {}, listProviders: () => [{ id: 'zai-coding-cn' }] }
  assert.equal(pickLiveLlm([scopedStale, root], 'zai-coding-cn'), root, 'candidate without the route is skipped')
  const scopedLive = { stream() {}, listProviders: () => [{ id: 'p' }] }
  assert.equal(pickLiveLlm([scopedLive, root], 'p'), scopedLive, 'first candidate carrying the route wins')
  const dead = { stream() {}, get listProviders() { throw new Error('disposed scope') } }
  assert.equal(pickLiveLlm([dead, root], 'zai-coding-cn'), root, 'disposed scope (throws on access) is skipped')
  // ① no reachable, provable instance at all (missing / disposed / probe-less).
  assert.throws(() => pickLiveLlm([undefined, undefined], 'p'), /没有可用的模型服务实例/)
  assert.throws(() => pickLiveLlm([dead], 'p'), /没有可用的模型服务实例/)
  // A probe-less instance cannot vouch for an adapter — it must NOT be trusted
  // with a distill call (a later stream() would surface a RAW NO_ADAPTER).
  const unprobeable = { stream() {} }
  assert.throws(() => pickLiveLlm([unprobeable], 'p'), /没有可用的模型服务实例/)
  // ② reachable instances, none carrying the route — say which provider failed.
  assert.throws(
    () => pickLiveLlm([scopedStale], 'zai-coding-cn'),
    /distill-provider «zai-coding-cn» 没有匹配的模型路由（检查拼写或本机 provider 配置），等待下次会话启动重试/,
  )
})

test('defaultModelCaller: probes candidates before streaming; all-dead throws readable Chinese', async () => {
  const streamed = []
  const seenReqs = []
  const live = {
    listProviders: () => [{ id: 'p' }],
    stream: async function* (options) {
      streamed.push(options.provider)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'hello' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const dead = { stream() {}, get listProviders() { throw new Error('disposed') } }
  const caller = defaultModelCaller(
    (req) => {
      seenReqs.push(req?.sessionId)
      return [dead, live]
    },
    () => ({ provider: 'p', model: 'm' }),
  )
  const text = await caller({ system: 's', user: 'u', purpose: 't', sessionId: 's1', maxTokens: 10 })
  assert.equal(text, 'hello')
  assert.deepEqual(streamed, ['p'], 'stream went to the live instance, never the dead one')
  assert.deepEqual(seenReqs, ['s1'], 'the triggering session id reaches getCandidates (per-session capture lookup)')
  const deadCaller = defaultModelCaller(() => [undefined, undefined], () => ({ provider: 'p', model: 'm' }))
  await assert.rejects(() => deadCaller({ system: 's', user: 'u', purpose: 't', maxTokens: 10 }), /没有可用的模型服务实例/)
})

test('defaultModelCaller: NO_ADAPTER from stream is rethrown readable, other failures untouched', async () => {
  // Hostile shape: the route table lists the provider but the adapter registry
  // misses it at dispatch — exactly what a raw 'no adapter registered for
  // provider' in distill-state looks like. The pre-flight cannot see it, so
  // the stream boundary must translate it.
  const hostile = {
    listProviders: () => [{ id: 'p' }],
    stream: async function* () {
      throw Object.assign(new Error('no adapter registered for provider "p"'), { code: 'NO_ADAPTER' })
    },
  }
  const caller = defaultModelCaller(() => [hostile], () => ({ provider: 'p', model: 'm' }))
  await assert.rejects(
    () => caller({ system: 's', user: 'u', purpose: 't', maxTokens: 10 }),
    /缺少 provider 适配器.*no adapter registered for provider "p"/,
    'NO_ADAPTER becomes a readable distill failure naming the route',
  )
  const auth = {
    listProviders: () => [{ id: 'p' }],
    stream: async function* () {
      throw new Error('provider rejected the key')
    },
  }
  const authCaller = defaultModelCaller(() => [auth], () => ({ provider: 'p', model: 'm' }))
  await assert.rejects(() => authCaller({ system: 's', user: 'u', purpose: 't', maxTokens: 10 }), /provider rejected the key/)
})

test('distiller: dead llm scope records a readable failure instead of a raw NO_ADAPTER', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await h.store.appendObservation({ kind: 'turn', source: 'auto', text: 'x' })
    const caller = defaultModelCaller(() => [undefined], () => ({ provider: 'zai-coding-cn', model: 'glm-x' }))
    const d = new Distiller(h.service, caller)
    const r = await d.run('s1')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'model-error')
    assert.match(r.detail, /没有可用的模型服务实例/)
    assert.doesNotMatch(r.detail ?? '', /^Error: NO_ADAPTER/)
    // Observations stay pending for the next session's retry.
    assert.equal((await h.store.undistilledObservations()).length, 1)
  } finally {
    h.cleanup()
  }
})

// ---- BlockAssembler.finish shapes (defensive dual-shape compat) ----

/** Llm instance whose stream ends with the given finish reason (or none). */
function finishLlm(reason) {
  return {
    listProviders: () => [{ id: 'p' }],
    stream: async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'hi' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } }
      if (reason !== undefined) yield { type: 'finish', reason }
    },
  }
}

test('defaultModelCaller: finish object shapes — {kind:"stop"} resolves, max-tokens/error reject', async () => {
  const req = { system: 's', user: 'u', purpose: 't', maxTokens: 10 }
  const make = (reason) => defaultModelCaller(() => [finishLlm(reason)], () => ({ provider: 'p', model: 'm' }))
  // Object shapes — the ONLY shape observed in any known dsh-llm build
  // (harness assembler.ts: `get finish() { return this._finish ?? { kind: 'stop' } }`).
  assert.equal(await make({ kind: 'stop' })(req), 'hi', '{kind:"stop"} chunk resolves')
  assert.equal(await make(undefined)(req), 'hi', 'no finish chunk → assembler default {kind:"stop"} resolves')
  await assert.rejects(() => make({ kind: 'max-tokens' })(req), /model finish: max-tokens/)
  await assert.rejects(
    () => make({ kind: 'error', failure: { message: 'boom', code: 'PROVIDER' } })(req),
    /boom/,
    'failure.message wins over the generic finish text',
  )
})

test('defaultModelCaller: finish bare-string shapes stay tolerated (defensive, never observed)', async () => {
  const req = { system: 's', user: 'u', purpose: 't', maxTokens: 10 }
  const make = (reason) => defaultModelCaller(() => [finishLlm(reason)], () => ({ provider: 'p', model: 'm' }))
  assert.equal(await make('stop')(req), 'hi', 'bare "stop" resolves')
  await assert.rejects(() => make('rate-limited')(req), /model finish: rate-limited/)
})

// ---- Batch livelock fix: adaptive batch size + per-run call budget ----

/** Append n observations; returns their ids in append order. */
async function appendObs(store, n) {
  const ids = []
  for (let i = 0; i < n; i += 1) {
    const o = await store.appendObservation({ kind: 'turn', source: 'auto', text: `批量观察 ${i}` })
    ids.push(o.id)
  }
  return ids
}

/** Observation ids embedded in a distill prompt payload. */
const idsIn = (user) => [...user.matchAll(/"id":"(obs-[^"]+)"/g)].map((m) => m[1])

/** Valid ops JSON consuming exactly the given ids, one create per id (schema-gate complete). */
const consumeOps = (ids) =>
  JSON.stringify({ ops: ids.map((id) => ({ op: 'create', title: `T ${id}`, description: `概括 ${id}`, triggers: ['甲', '乙', '丙'], conclusion: `结论 ${id}`, observed_ids: [id] })) })

test('distiller: max-tokens halves the batch, retries, and the shrink persists across runs', async () => {
  const h = make({ distillBatchSize: 8, distillMaxModelCalls: 3 })
  try {
    await h.store.ensure()
    await appendObs(h.store, 9)
    const sizes = []
    let first = true
    const d = new Distiller(h.service, async (req) => {
      const ids = idsIn(req.user)
      sizes.push(ids.length)
      if (first) {
        first = false
        // Message-regex path (no code stamp): the raw gateway finish text.
        throw new Error('model finish: max-tokens')
      }
      return consumeOps(ids)
    })
    const r = await d.run('s1')
    assert.equal(r.ok, true)
    assert.deepEqual(sizes, [8, 5, 4], '8 overflows → halved to the 5 floor → drained the 4 remaining')
    assert.equal(r.marked, 9)
    assert.equal((await h.store.undistilledObservations()).length, 0)
    // The shrink persists: config still says 8, but the lane stays at 5, so a
    // fresh 10-observation pool is fetched 5-at-a-time, not 8.
    await appendObs(h.store, 10)
    const r2 = await d.run('s1')
    assert.equal(r2.ok, true)
    assert.equal(sizes[3], 5, 'run 2 starts at the shrunk size, not the configured batch size')
    assert.equal(r2.marked, 10)
    assert.deepEqual(sizes, [8, 5, 4, 5, 5])
  } finally {
    h.cleanup()
  }
})

test('distiller: per-run call budget stops with partial progress kept', async () => {
  const h = make({ distillBatchSize: 3, distillMaxModelCalls: 2 })
  try {
    await h.store.ensure()
    await appendObs(h.store, 10)
    const d = new Distiller(h.service, async (req) => consumeOps(idsIn(req.user)))
    const r = await d.run('s1')
    assert.equal(r.ok, true)
    assert.equal(r.marked, 6)
    assert.match(r.detail ?? '', /partial/)
    assert.match(r.detail ?? '', /2\/2/)
    assert.equal((await h.store.undistilledObservations()).length, 4)
  } finally {
    h.cleanup()
  }
})

test('distiller: output-limit at the batch floor stops without burning the budget', async () => {
  const h = make({ distillBatchSize: 5, distillMaxModelCalls: 3 })
  try {
    await h.store.ensure()
    await appendObs(h.store, 5)
    let calls = 0
    const d = new Distiller(h.service, async () => {
      calls += 1
      // Code-stamp path: how defaultModelCaller surfaces the finish branch.
      throw Object.assign(new Error('model finish: max-tokens'), { code: 'MAX_TOKENS' })
    })
    const r = await d.run('s1')
    assert.equal(calls, 1, 'halving cannot go below the floor — no pointless retries')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'model-error')
    assert.match(r.detail ?? '', /无法再缩小/)
    assert.equal((await h.store.undistilledObservations()).length, 5)
  } finally {
    h.cleanup()
  }
})

test('distiller: distillBatchSize config bounds the per-call batch', async () => {
  const h = make({ distillBatchSize: 7, distillMaxModelCalls: 1 })
  try {
    await h.store.ensure()
    await appendObs(h.store, 10)
    const seen = []
    const d = new Distiller(h.service, async (req) => {
      const ids = idsIn(req.user)
      seen.push(ids.length)
      return consumeOps(ids)
    })
    const r = await d.run('s1')
    assert.deepEqual(seen, [7])
    assert.equal(r.marked, 7)
    assert.match(r.detail ?? '', /1\/1/)
  } finally {
    h.cleanup()
  }
})

test('distiller: a batch that consumes nothing stops the run (no same-head repeat)', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const ids = await appendObs(h.store, 3)
    let calls = 0
    const d = new Distiller(h.service, async () => {
      calls += 1
      return consumeOps([ids[0]]) // always "consumes" the first observation
    })
    const r = await d.run('s1')
    // Batch 1 consumes ids[0]. Batch 2 re-references ids[0], which is not in
    // that batch → unattributable → exactly one corrective retry → still
    // zero → the stalled stop. Never a fourth same-head call.
    assert.equal(calls, 3, 'stalling batch gets one corrective retry, then the run stops')
    assert.equal(r.ok, true)
    assert.equal(r.marked, 1)
    assert.match(r.detail ?? '', /observed_ids/)
    assert.equal((await h.store.undistilledObservations()).length, 2)
  } finally {
    h.cleanup()
  }
})

test('distiller: a zero-progress stall records a readable reason, not a bare failure', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const ids = await appendObs(h.store, 3)
    let calls = 0
    // Ops come back but reference a slug that does not exist → nothing is
    // consumed (marked 0) and the head cannot advance: the stalled stop. The
    // observed_ids ARE batch-valid, so the stall is a slug problem — no
    // corrective observed_ids retry is spent on it.
    const d = new Distiller(h.service, async () => {
      calls += 1
      return JSON.stringify({
        ops: [{ op: 'update', slug: 'no-such-topic', conclusion: 'x', observed_ids: [ids[0]] }],
      })
    })
    const r = await d.run('s1')
    assert.equal(calls, 1, 'a bad-slug stall stops the run without an observed_ids retry')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'stalled', 'the failure record must name the stall, not land reason-less')
    assert.match(r.detail ?? '', /未消费/)
    assert.match(r.detail ?? '', /slug/)
    assert.equal((await h.store.undistilledObservations()).length, 3)
  } finally {
    h.cleanup()
  }
})

test('distiller: a request-side error mentioning max-tokens is fatal, not a shrink trigger', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await appendObs(h.store, 5)
    let calls = 0
    const d = new Distiller(h.service, async () => {
      calls += 1
      // No code stamp, and the text merely mentions max-tokens — the anchored
      // message fallback must NOT classify this as the retryable output-limit
      // finish (the old loose regex halved the batch and burned the budget).
      throw new Error('request rejected: max-tokens parameter must be positive')
    })
    const r = await d.run('s1')
    assert.equal(calls, 1, 'a request-side error gets no halving retry')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'model-error')
    assert.doesNotMatch(r.detail ?? '', /无法再缩小/)
    assert.equal((await h.store.undistilledObservations()).length, 5)
  } finally {
    h.cleanup()
  }
})

test('defaultModelCaller: output-limit finishes are code-stamped MAX_TOKENS (retryable class)', async () => {
  const req = { system: 's', user: 'u', purpose: 't', maxTokens: 10 }
  for (const finish of [{ kind: 'max-tokens' }, { kind: 'length' }]) {
    let err
    try {
      await defaultModelCaller(() => [finishLlm(finish)], () => ({ provider: 'p', model: 'm' }))(req)
    } catch (e) {
      err = e
    }
    assert.ok(err !== undefined, `${JSON.stringify(finish)} finish rejects`)
    assert.equal(err.code, 'MAX_TOKENS', `${finish.kind} is classified as the smaller-batch-retryable failure`)
  }
})

// ---- observed_ids enforcement: sanitize + one corrective retry ----

test('distiller: prompt hard-requires verbatim observed_ids on every op', () => {
  assert.match(SYSTEM_PROMPT, /硬性要求：每个 op 必须带 observed_ids/)
  assert.match(SYSTEM_PROMPT, /逐字复制/)
  assert.match(SYSTEM_PROMPT, /create 填它所综合依据的观察 id/)
  assert.match(SYSTEM_PROMPT, /update 填促使本次修订的观察 id/)
  assert.match(SYSTEM_PROMPT, /列表之外 id 的条目会被过滤/, 'out-of-list ids are filtered, not fatal to the op')
  assert.match(SYSTEM_PROMPT, /会被整体丢弃/, 'the consequence of missing/invalid ids is spelled out')
})

test('distiller: all-invalid observed_ids → one corrective retry rescues the batch', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const ids = await appendObs(h.store, 3)
    let calls = 0
    const d = new Distiller(h.service, async (req) => {
      calls += 1
      if (calls === 1) {
        return JSON.stringify({
          ops: [{ op: 'create', title: '幻觉主题', description: '一句话', triggers: ['幻觉甲', '幻觉乙', '幻觉丙'], conclusion: '结论', observed_ids: ['obs-hallucinated'] }],
        })
      }
      assert.match(req.user, /纠错重试/)
      assert.match(req.user, /逐字/)
      assert.ok(req.user.includes(ids[0]), 'the legal id list is spelled out in the correction message')
      return consumeOps(ids)
    })
    const r = await d.run('s1')
    assert.equal(calls, 2, 'original call + exactly one corrective retry')
    assert.equal(r.ok, true)
    assert.equal(r.marked, 3)
    assert.equal((await h.store.undistilledObservations()).length, 0)
  } finally {
    h.cleanup()
  }
})

test('distiller: corrective retry is capped at one — a second zero pass stalls readably', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await appendObs(h.store, 2)
    let calls = 0
    const d = new Distiller(h.service, async () => {
      calls += 1
      return JSON.stringify({
        ops: [{ op: 'create', title: '幻觉主题', description: '一句话', triggers: ['幻觉甲', '幻觉乙', '幻觉丙'], conclusion: '结论', observed_ids: ['obs-hallucinated'] }],
      })
    })
    const r = await d.run('s1')
    assert.equal(calls, 2, 'original + one correction, never a third')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'stalled')
    assert.match(r.detail ?? '', /observed_ids/)
    assert.match(r.detail ?? '', /纠错重试/)
    // The hallucinated-op topic never lands: unattributable writes are held back.
    assert.equal((await h.store.undistilledObservations()).length, 2)
  } finally {
    h.cleanup()
  }
})

test('distiller: partial valid ids mark without retry; filtered count lands in detail', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const o = await h.store.appendObservation({ kind: 'turn', source: 'auto', text: '唯一观察' })
    let calls = 0
    const d = new Distiller(h.service, async () => {
      calls += 1
      return JSON.stringify({
        ops: [
          { op: 'create', title: '有效主题', description: '一句话', triggers: ['甲', '乙', '丙'], conclusion: '结论一', observed_ids: [o.id] },
          { op: 'create', title: '幻觉主题', description: '一句话', triggers: ['甲', '乙', '丙'], conclusion: '结论二', observed_ids: ['obs-hallucinated'] },
        ],
      })
    })
    const r = await d.run('s1')
    assert.equal(calls, 1, 'partial progress needs no corrective retry')
    assert.equal(r.ok, true)
    assert.equal(r.marked, 1)
    assert.equal(r.created.length, 1, 'the unattributable op is held back; only the valid one lands')
    assert.match(r.detail ?? '', /filtered 1 invalid observed_ids/)
    assert.equal((await h.store.undistilledObservations()).length, 0)
  } finally {
    h.cleanup()
  }
})

test('distiller: corrective retry respects the call budget (no free lane)', async () => {
  const h = make({ distillMaxModelCalls: 1 })
  try {
    await h.store.ensure()
    await appendObs(h.store, 2)
    let calls = 0
    const d = new Distiller(h.service, async () => {
      calls += 1
      return JSON.stringify({
        ops: [{ op: 'create', title: '幻觉主题', description: '一句话', triggers: ['幻觉甲', '幻觉乙', '幻觉丙'], conclusion: '结论', observed_ids: ['obs-hallucinated'] }],
      })
    })
    const r = await d.run('s1')
    assert.equal(calls, 1, 'a budget of 1 leaves no room for the corrective retry')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'stalled')
    assert.match(r.detail ?? '', /预算/)
    assert.equal((await h.store.undistilledObservations()).length, 2)
  } finally {
    h.cleanup()
  }
})

test('distiller: scalar observed_ids string is normalized and rescued without retry', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const ids = await appendObs(h.store, 1)
    let calls = 0
    const d = new Distiller(h.service, async () => {
      calls += 1
      // The commonest shape drift: the model returns a bare id, not a list.
      return JSON.stringify({
        ops: [{ op: 'create', title: 'T', description: '一句话', triggers: ['甲', '乙', '丙'], conclusion: '结论', observed_ids: ids[0] }],
      })
    })
    const r = await d.run('s1')
    assert.equal(calls, 1, 'a rescuable scalar needs no corrective retry')
    assert.equal(r.ok, true)
    assert.equal(r.marked, 1)
    assert.equal((await h.store.undistilledObservations()).length, 0)
  } finally {
    h.cleanup()
  }
})

test('distiller: non-array non-string observed_ids counts as dropped and fires the retry gate', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const ids = await appendObs(h.store, 2)
    let calls = 0
    const d = new Distiller(h.service, async (req) => {
      calls += 1
      if (calls === 1) {
        // Neither list nor string: unrescuable, but must reach droppedForIds
        // (previously a TypeError swallowed by the per-op catch — the stall
        // then misattributed and the retry gate never fired).
        return JSON.stringify({ ops: [{ op: 'create', title: 'T', description: '一句话', triggers: ['甲', '乙', '丙'], conclusion: '结论', observed_ids: 42 }] })
      }
      assert.match(req.user, /纠错重试/)
      return consumeOps(ids)
    })
    const r = await d.run('s1')
    assert.equal(calls, 2, 'the retry gate fires for the unrescuable shape')
    assert.equal(r.ok, true)
    assert.equal(r.marked, 2)
    assert.equal((await h.store.undistilledObservations()).length, 0)
  } finally {
    h.cleanup()
  }
})

test('distiller: corrective retry that fails to produce ops stalls readably without a second retry', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await appendObs(h.store, 2)
    let calls = 0
    const d = new Distiller(h.service, async () => {
      calls += 1
      if (calls === 1) {
        return JSON.stringify({
          ops: [{ op: 'create', title: '幻觉主题', description: '一句话', triggers: ['幻觉甲', '幻觉乙', '幻觉丙'], conclusion: '结论', observed_ids: ['obs-hallucinated'] }],
        })
      }
      throw new Error('route unavailable')
    })
    const r = await d.run('s1')
    assert.equal(calls, 2, 'original call + exactly one corrective retry, never a third')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'stalled')
    assert.match(r.detail ?? '', /纠错重试未产出可消费的 ops（模型调用失败：route unavailable/)
    assert.equal((await h.store.undistilledObservations()).length, 2)
  } finally {
    h.cleanup()
  }
})

// ---- post-run GC: fed-but-unconsumed observations age out after three strikes ----

test('distiller: unconsumed observations accrue attempts; the third strike gc-drops into the detail', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await h.store.appendObservation({ kind: 'finding', source: 'auto', text: '没人要' })
    // The model deliberately skips the observation every run (empty ops).
    const d = new Distiller(h.service, async () => JSON.stringify({ ops: [] }))
    const r1 = await d.run('s1')
    assert.equal(r1.reason, 'no-ops')
    assert.equal((await h.store.allObservations())[0].attempts, 1)
    await d.run('s1')
    assert.equal((await h.store.allObservations())[0].attempts, 2)
    const r3 = await d.run('s1')
    assert.equal(r3.reason, 'no-ops')
    assert.equal(r3.gcDropped, 1, 'the third failed attempt deletes the observation')
    assert.match(r3.detail ?? '', /gc: dropped 1 unprocessable observation\(s\)/)
    assert.equal((await h.store.readDistillState())?.gcDropped, 1, 'the deletion count is persisted in the state file')
    assert.equal((await h.store.allObservations()).length, 0, 'the pool no longer haunts the backlog')
  } finally {
    h.cleanup()
  }
})

test('distiller: consumed observations never accrue attempts; only the leftovers do', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const kept = await h.store.appendObservation({ kind: 'finding', source: 'auto', text: '会被消费' })
    const left = await h.store.appendObservation({ kind: 'finding', source: 'auto', text: '没人要' })
    // The model consumes kept.id in every call; once kept is marked, the
    // follow-up batches can only stall around left — exactly one failed
    // attempt for the leftover, none for the consumed one.
    const d = new Distiller(h.service, async () =>
      JSON.stringify({ ops: [{ op: 'create', title: 'T', description: '一句话', triggers: ['甲', '乙', '丙'], conclusion: '结论', observed_ids: [kept.id] }] }),
    )
    const r = await d.run('s1')
    assert.equal(r.ok, true)
    assert.equal(r.marked, 1)
    const all = await h.store.allObservations()
    const consumedRec = all.find((o) => o.id === kept.id)
    assert.equal(consumedRec.distilled, true, 'the consumed observation left the candidate pool via markDistilled')
    assert.equal(consumedRec.attempts, undefined, 'and it never accrued an attempt')
    assert.equal(all.find((o) => o.id === left.id).attempts, 1)
    assert.deepEqual((await h.store.undistilledObservations()).map((o) => o.id), [left.id])
    assert.equal(r.gcDropped, undefined, 'one strike deletes nothing')
  } finally {
    h.cleanup()
  }
})

// ---- GC attempt semantics: only model-evaluated batches count (BLOCKER-1) ----

test('distiller: infrastructure failures never count toward the gc three strikes', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await h.store.appendObservation({ kind: 'turn', source: 'auto', text: '网络抖动不该删我' })
    const d = new Distiller(h.service, async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' })
    })
    for (let i = 0; i < 3; i += 1) {
      const r = await d.run('s1')
      assert.equal(r.ok, false)
      assert.equal(r.reason, 'model-error')
    }
    const all = await h.store.allObservations()
    assert.equal(all.length, 1, 'three failed runs left the pool intact — no data destroyed')
    assert.equal(all[0].attempts, undefined, 'zero attempts accrued: the model never evaluated the batch')
    assert.equal((await h.store.undistilledObservations()).length, 1)
    assert.equal((await h.store.readDistillState())?.reason, 'model-error', 'the failure stays readable in the state file')
  } finally {
    h.cleanup()
  }
})

test('distiller: unparseable output (invalid-output) never counts toward the gc either', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await h.store.appendObservation({ kind: 'turn', source: 'auto', text: 'x' })
    const d = new Distiller(h.service, async () => '我觉得应该记点什么，但我不输出 JSON。')
    for (let i = 0; i < 3; i += 1) {
      const r = await d.run('s1')
      assert.equal(r.reason, 'invalid-output')
    }
    const all = await h.store.allObservations()
    assert.equal(all.length, 1, 'provider quirks that garble output are exempt from the strikes')
    assert.equal(all[0].attempts, undefined)
  } finally {
    h.cleanup()
  }
})

test('distiller: unconfigured route short-circuits before the lane — readable reason, zero attempts, zero calls', async () => {
  const h = make({ distillProvider: '', distillModel: '' })
  try {
    await h.store.ensure()
    await h.store.appendObservation({ kind: 'turn', source: 'auto', text: 'x' })
    let calls = 0
    const d = new Distiller(h.service, async () => {
      calls += 1
      return '{"ops":[]}'
    })
    assert.equal(d.configured, true, 'the caller seam exists; the ROUTE is what is missing')
    for (let i = 0; i < 3; i += 1) {
      const r = await d.run('s1')
      assert.equal(r.reason, 'no-model')
      assert.match(r.detail ?? '', /distill route not configured/)
    }
    assert.equal(calls, 0, 'the model was never invoked')
    const all = await h.store.allObservations()
    assert.equal(all.length, 1, 'triggers without a route never book GC attempts')
    assert.equal(all[0].attempts, undefined)
  } finally {
    h.cleanup()
  }
})

test('distiller: stalled batches (parseable ops, zero consumption) still count toward the gc', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await appendObs(h.store, 2)
    const d = new Distiller(h.service, async () =>
      JSON.stringify({ ops: [{ op: 'create', title: '幻觉主题', description: '一句话', triggers: ['幻觉甲', '幻觉乙', '幻觉丙'], conclusion: '结论', observed_ids: ['obs-hallucinated'] }] }),
    )
    await d.run('s1')
    await d.run('s1')
    const r3 = await d.run('s1')
    assert.equal(r3.reason, 'stalled')
    assert.equal(r3.gcDropped, 2, 'parseable-but-useless answers are real evaluations: the third strike deletes')
    assert.equal((await h.store.allObservations()).length, 0, 'the exemption does not spare what should be deleted')
  } finally {
    h.cleanup()
  }
})

test('distiller: a failed distill-state write surfaces in the returned detail; marks still land', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const o1 = await h.store.appendObservation({ kind: 'finding', source: 'auto', text: '观察到一' })
    const o2 = await h.store.appendObservation({ kind: 'decision', source: 'model', text: '观察到二', sessionId: 's1' })
    const modelJson = JSON.stringify({
      ops: [
        {
          op: 'create',
          title: 'dsh-cron 定时方案',
          description: '定时任务落地方式',
          tags: ['dsh', 'cron'],
          triggers: ['cron', '定时任务', '调度'],
          depends: [],
          open_questions: ['错过窗口是否补跑'],
          impact: ['运维流程'],
          conclusion: 'dsh 无原生 cron；用 headless 会话加 OS cron，最长窗口一年。',
          recommendations: '配每日 schedule 兜底。',
          status: 'draft',
          observed_ids: [o1.id, o2.id],
        },
      ],
    })
    const d = new Distiller(h.service, async () => modelJson)
    const realWrite = h.store.writeDistillState.bind(h.store)
    let failNext = true
    h.store.writeDistillState = async (state) => {
      if (failNext) {
        failNext = false
        throw new Error('disk on fire')
      }
      return realWrite(state)
    }
    // The write fails: the run must still succeed (marks are independent of
    // the state file), but the detail must say so — a silent swallow is what
    // made a stale distill-state.json look like "manual runs never write".
    const r1 = await d.run('s1')
    assert.equal(r1.ok, true)
    assert.match(r1.detail ?? '', /distill-state 写入失败: disk on fire/)
    assert.equal((await h.store.undistilledObservations()).length, 0, 'marks landed despite the failed write')
    assert.equal(await h.store.readDistillState(), undefined, 'nothing was persisted for the failed run')
    // A healthy subsequent run persists the state file again, with no note.
    const o3 = await h.store.appendObservation({ kind: 'finding', source: 'auto', text: '观察到三' })
    const d2 = new Distiller(
      h.service,
      async () =>
        JSON.stringify({ ops: [{ op: 'create', title: '第二个主题', description: '一句话', triggers: ['甲', '乙', '丙'], conclusion: '结论', observed_ids: [o3.id] }] }),
    )
    const r2 = await d2.run('s1')
    assert.doesNotMatch(r2.detail ?? '', /写入失败/)
    assert.equal((await h.store.readDistillState())?.ok, true)
  } finally {
    h.cleanup()
  }
})
