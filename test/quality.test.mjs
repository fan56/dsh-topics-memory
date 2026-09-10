import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { BundleStore } from '../lib/store.js'
import { TopicsService } from '../lib/service.js'
import { SlowLane, parseJsonObject, PENDING_TTL_MS, TURN_LAG_LIMIT } from '../lib/quality.js'

/** rm that tolerates an in-flight fire-and-forget write racing the cleanup. */
async function rmRetry(path, attempts = 6) {
  for (let i = 0; ; i += 1) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (e) {
      if (i >= attempts - 1 || (e.code !== 'ENOTEMPTY' && e.code !== 'ENOENT')) throw e
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}


const CFG = {
  repo: '', autoInject: true, injectDedup: true, topK: 4, perTopicBudget: 300, totalBudget: 1500,
  matchThreshold: 0.3, tagBoost: 0.15, graphDepth: 2, recencyWindowDays: 7,
  autoObserve: true, observationMaxChars: 2000, distillEveryTurns: 20,
  distillOnSessionEnd: true, distillProvider: 'p', distillModel: 'm', pushDebounceSeconds: 45,
}

function tmpService(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'topics-quality-'))
  const store = new BundleStore(root)
  const service = new TopicsService(store, () => ({ ...CFG, ...overrides }))
  return { root, store, service, cleanup: () => rmRetry(root) }
}

const ringEntry = (user, assistant) => ({ user, assistant, at: new Date().toISOString() })

/** Fake ModelCaller that answers by system-prompt role. */
function fakeCaller(handlers = {}) {
  return async (req) => {
    if (req.system.includes('检索查询构建器')) {
      if (handlers.build === 'throw') throw new Error('model exploded')
      return handlers.build ?? JSON.stringify({ needs: true, query: 'echo marker qx7qz', ignore: ['粘贴的日志'] })
    }
    if (req.system.includes('注入门禁')) {
      if (handlers.rerank === 'throw') throw new Error('model exploded')
      return handlers.rerank ?? JSON.stringify({ picks: [{ slug: 'echo-marker-qx7qz', why: '当前问题正需要这条结论' }] })
    }
    return JSON.stringify({ ops: [] })
  }
}

const serviceWith = (store, overrides = {}) => new TopicsService(store, () => ({ ...CFG, qualityLane: 'always', ...overrides }))

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitPending(lane, sessionId, what = 'pending lands') {
  for (let i = 0; i < 150; i += 1) {
    if (lane.hasPending(sessionId)) return
    await waitMs(20)
  }
  throw new Error(`timed out: ${what}`)
}

test('parseJsonObject: plain, fenced, tolerant extraction', () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 })
  assert.deepEqual(parseJsonObject('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(parseJsonObject('前缀文字 {"a":{"b":"}{}"}} 尾随'), { a: { b: '}{}' } })
  assert.throws(() => parseJsonObject('no object here'))
})

test('slow lane: dispatch guards (off lane, sampled cadence, empty ring, unconfigured)', async (t) => {
  const { service, cleanup } = tmpService()
  t.after(cleanup)
  const ring = [ringEntry('用户问了 echo marker', '答了')]
  // Only 'sampled' | 'always' dispatch — undefined/off stay idle.
  const off = new SlowLane(service, fakeCaller())
  off.dispatch('s1', { ring, turnId: 3 })
  assert.equal(off.hasPending('s1'), false)
  // Sampled cadence: turnId not divisible by 3 skips.
  const laneSampled = new SlowLane(serviceWith(service.store, { qualityLane: 'sampled' }), fakeCaller())
  laneSampled.dispatch('s1', { ring, turnId: 1 })
  assert.equal(laneSampled.hasPending('s1'), false, 'sampled skips turnId % 3 !== 0')
  // Empty ring never dispatches.
  const laneAlways = new SlowLane(serviceWith(service.store), fakeCaller())
  laneAlways.dispatch('s1', { ring: [], turnId: 3 })
  assert.equal(laneAlways.hasPending('s1'), false, 'empty ring never dispatches')
  // Unconfigured caller.
  const laneNoModel = new SlowLane(serviceWith(service.store), undefined)
  laneNoModel.dispatch('s1', { ring, turnId: 3 })
  assert.equal(laneNoModel.hasPending('s1'), false, 'no model → no dispatch')
})

test('slow lane: produce + consume — 消费即清, one shot', async (t) => {
  const { service, cleanup } = tmpService({ qualityLane: 'always' })
  t.after(cleanup)
  await service.store.ensure()
  await service.saveTopic({ title: 'Echo Marker QX7QZ', conclusion: 'The Echo Marker QX7QZ topic exists.' })
  const lane = new SlowLane(service, fakeCaller())
  lane.dispatch('s1', { ring: [ringEntry('用户在问 echo marker qx7qz 怎么处理', '答了一半')], turnId: 3 })
  await waitPending(lane, 's1')
  const consumed = lane.consume('s1', 4)
  assert.ok(consumed !== undefined && 'pending' in consumed, 'pending delivered once')
  const pending = consumed.pending
  assert.deepEqual(pending.items, [{ slug: 'echo-marker-qx7qz', why: '当前问题正需要这条结论' }])
  assert.equal(pending.model, 'p/m')
  assert.ok(pending.queryBuild.keptChars > 0)
  assert.ok(pending.queryBuild.rawChars > 0)
  assert.deepEqual(pending.queryBuild.stripped, ['粘贴的日志'])
  assert.equal(lane.hasPending('s1'), false, 'consume cleared the slot')
  assert.equal(lane.consume('s1', 4), undefined, 'second consume is empty')
})

test('slow lane: turn-lag expiry bound; ttl constant pinned', async (t) => {
  const { service, cleanup } = tmpService({ qualityLane: 'always' })
  t.after(cleanup)
  await service.store.ensure()
  await service.saveTopic({ title: 'Echo Marker QX7QZ', conclusion: 'exists.' })
  const lane = new SlowLane(service, fakeCaller())
  lane.dispatch('s1', { ring: [ringEntry('u', 'a')], turnId: 3 })
  await waitPending(lane, 's1')
  // Production at turn 3; asked at 3 + TURN_LAG_LIMIT + 1 → expired, slot gone.
  const expiredLag = lane.consume('s1', 3 + TURN_LAG_LIMIT + 1)
  assert.ok(expiredLag !== undefined && 'expired' in expiredLag && expiredLag.expired === 'turn-lag')
  assert.equal(lane.hasPending('s1'), false, 'expired slot is gone (消费即清 applies to expiry too)')
  // Within the bound → delivered.
  lane.dispatch('s2', { ring: [ringEntry('u', 'a')], turnId: 6 })
  await waitPending(lane, 's2')
  const ok = lane.consume('s2', 6 + TURN_LAG_LIMIT)
  assert.ok(ok !== undefined && 'pending' in ok, 'turn-lag exactly at the bound still delivers')
  assert.equal(PENDING_TTL_MS, 10 * 60_000)
})

test('slow lane: clear on session boundary + hasInFlight during produce', async (t) => {
  const { service, cleanup } = tmpService({ qualityLane: 'always' })
  t.after(cleanup)
  await service.store.ensure()
  await service.saveTopic({ title: 'Echo Marker QX7QZ', conclusion: 'exists.' })
  // A parked build call lets us observe the in-flight window; the gate is
  // releasable so the pipeline can settle (in-flight is per session).
  let parked = true
  let releaseBuild
  const gate = new Promise((resolve) => { releaseBuild = resolve })
  const lane = new SlowLane(service, async (req) => {
    if (req.system.includes('检索查询构建器')) {
      if (parked) {
        await gate
        return JSON.stringify({ needs: false })
      }
      return JSON.stringify({ needs: true, query: 'echo marker qx7qz' })
    }
    return JSON.stringify({ picks: [{ slug: 'echo-marker-qx7qz', why: 'w' }] })
  })
  lane.dispatch('s1', { ring: [ringEntry('u', 'a')], turnId: 3 })
  await waitMs(30)
  assert.equal(lane.hasInFlight('s1'), true, 'pipeline in flight while the call is parked')
  releaseBuild()
  for (let i = 0; i < 100 && lane.hasInFlight('s1'); i += 1) await waitMs(20)
  assert.equal(lane.hasInFlight('s1'), false)
  assert.equal(lane.hasPending('s1'), false, 'needs:false produced nothing')
  // A resting pending slot is droppable (session boundary).
  parked = false
  lane.dispatch('s1', { ring: [ringEntry('u', 'a')], turnId: 3 })
  await waitPending(lane, 's1')
  lane.clear('s1')
  assert.equal(lane.hasPending('s1'), false)
  assert.equal(lane.consume('s1', 3), undefined)
})

test('slow lane: model errors are contained — no pending, no throw', async (t) => {
  const { service, cleanup } = tmpService({ qualityLane: 'always' })
  t.after(cleanup)
  await service.store.ensure()
  const lane = new SlowLane(service, fakeCaller({ build: 'throw', rerank: 'throw' }))
  lane.dispatch('s1', { ring: [ringEntry('u', 'a')], turnId: 3 })
  await waitMs(50)
  assert.equal(lane.hasPending('s1'), false)
  assert.equal(lane.hasInFlight('s1'), false)
})

test('slow lane: dispatch exclude keeps already-carried slugs out of the band', async (t) => {
  const { service, cleanup } = tmpService({ qualityLane: 'always' })
  t.after(cleanup)
  await service.store.ensure()
  await service.saveTopic({ title: 'Echo Marker QX7QZ', conclusion: 'exists.' })
  const lane = new SlowLane(service, fakeCaller())
  // The only candidate is already carried by the session (injected earlier /
  // echo) → empty band after filtering, no rerank spent, no pending: the old
  // behavior produced a pending that the consumption-side dedup silently
  // swallowed (2026-09 audit: 2 dead slow rounds).
  lane.dispatch('s1', { ring: [ringEntry('u', 'a')], turnId: 3, exclude: new Set(['echo-marker-qx7qz']) })
  await waitMs(50)
  assert.equal(lane.hasPending('s1'), false, 'fully-excluded band produces no pending')
  assert.equal(lane.hasInFlight('s1'), false)
  // An unrelated exclude set must not block the pick.
  lane.dispatch('s2', { ring: [ringEntry('u', 'a')], turnId: 3, exclude: new Set(['some-other-topic']) })
  await waitPending(lane, 's2')
  const consumed = lane.consume('s2', 4)
  assert.ok(consumed !== undefined && 'pending' in consumed, 'unrelated exclusion leaves the band intact')
})

test('slow lane: rerank picks are validated against the candidate band', async (t) => {
  const { service, cleanup } = tmpService({ qualityLane: 'always' })
  t.after(cleanup)
  await service.store.ensure()
  await service.saveTopic({ title: 'Echo Marker QX7QZ', conclusion: 'exists.' })
  const caller = async (req) => {
    if (req.system.includes('检索查询构建器')) return JSON.stringify({ needs: true, query: 'echo marker qx7qz' })
    return JSON.stringify({
      picks: [
        { slug: 'fabricated-slug', why: '不在候选里' },
        { slug: 'echo-marker-qx7qz', why: '' },
        { slug: 'echo-marker-qx7qz', why: '真相关' },
        { slug: 'echo-marker-qx7qz', why: '第二条同 slug 被上限截断' },
      ],
    })
  }
  const lane = new SlowLane(service, caller)
  lane.dispatch('s1', { ring: [ringEntry('u', 'a')], turnId: 3 })
  await waitPending(lane, 's1')
  const consumed = lane.consume('s1', 3)
  assert.ok(consumed !== undefined && 'pending' in consumed)
  assert.deepEqual(consumed.pending.items, [{ slug: 'echo-marker-qx7qz', why: '真相关' }])
})

// ---------------------------------------------------------------------------
// Service-level merge: shadow verdicts, lane fields, dedup.
// ---------------------------------------------------------------------------

test('retrieveSync: slow delivery merges, shadows, and logs the lane family', async (t) => {
  const { service, cleanup } = tmpService()
  t.after(cleanup)
  await service.store.ensure()
  await service.saveTopic({ title: 'Echo Marker QX7QZ', conclusion: 'The Echo Marker QX7QZ topic exists.' })
  const r = service.retrieveSync('完全无关的火锅菜谱', 's1', undefined, {
    items: [{ slug: 'echo-marker-qx7qz', why: '回指上一轮的 echo marker 工作' }],
    computedAt: new Date(Date.now() - 5000).toISOString(),
    queryBuild: { rawChars: 120, keptChars: 16, stripped: ['粘贴的日志'] },
    model: 'p/m',
    ms: 1234,
  })
  // Fast lane: zero lexical hits. Slow lane: the pick rides in.
  assert.equal(r.outcome.hits.length, 0)
  assert.ok(r.text.includes('Echo Marker QX7QZ'), r.text)
  assert.ok(r.text.includes('为什么相关'), r.text)
  assert.deepEqual(r.slowIncluded, ['echo-marker-qx7qz'])
  let records = []
  for (let i = 0; i < 100; i += 1) {
    records = await service.store.readInjectionRecords()
    if (records.some((x) => x.lane === 'slow')) break
    await waitMs(20)
  }
  const rec = records.find((x) => x.lane === 'slow')
  assert.notEqual(rec, undefined)
  assert.equal(rec.injected, true)
  assert.ok(rec.computedAt !== undefined && rec.consumedAt !== undefined)
  assert.deepEqual(rec.slow, [{ slug: 'echo-marker-qx7qz', why: '回指上一轮的 echo marker 工作' }])
  assert.deepEqual(rec.queryBuild, { rawChars: 120, keptChars: 16, stripped: ['粘贴的日志'] })
  assert.equal(rec.slowModel, 'p/m')
  assert.equal(rec.slowMs, 1234)
  // Shadow verdict: judged against the CURRENT (unrelated) query, recorded —
  // log-only, it did NOT block the injection.
  assert.equal(rec.shadowVerdict.length, 1)
  assert.equal(rec.shadowVerdict[0].slug, 'echo-marker-qx7qz')
  assert.equal(rec.shadowVerdict[0].pass, false, 'unrelated query → shadow fails, still injected')
})

test('retrieveSync: slow picks respect dedup exclusion and vanish gracefully', async (t) => {
  const { service, cleanup } = tmpService()
  t.after(cleanup)
  await service.store.ensure()
  await service.saveTopic({ title: 'Echo Marker QX7QZ', conclusion: 'exists.' })
  const delivery = {
    items: [{ slug: 'echo-marker-qx7qz', why: 'w' }],
    computedAt: new Date().toISOString(),
    queryBuild: { rawChars: 10, keptChars: 5, stripped: [] },
    model: 'p/m',
    ms: 1,
  }
  const r = service.retrieveSync('任意输入', 's1', { exclude: new Set(['echo-marker-qx7qz']) }, delivery)
  assert.equal(r.text, '')
  assert.deepEqual(r.deduped, ['echo-marker-qx7qz'])
  assert.deepEqual(r.slowIncluded, [])
  // Unknown slug: dropped silently (vanished between production and consume).
  const r2 = service.retrieveSync('任意输入', 's1', undefined, { ...delivery, items: [{ slug: 'gone-topic', why: 'w' }] })
  assert.equal(r2.text, '')
  assert.deepEqual(r2.slowIncluded, [])
})

test('retrieveSync: lane is mixed when both lanes deliver; expired pending is visible', async (t) => {
  const { service, cleanup } = tmpService()
  t.after(cleanup)
  await service.store.ensure()
  await service.saveTopic({ title: 'Echo Marker QX7QZ', conclusion: 'The Echo Marker QX7QZ topic exists.' })
  const r = service.retrieveSync('关于 echo marker qx7qz 的疑问', 's1', undefined, {
    items: [{ slug: 'echo-marker-qx7qz', why: 'w' }],
    computedAt: new Date().toISOString(),
    queryBuild: { rawChars: 10, keptChars: 5, stripped: [] },
    model: 'p/m',
    ms: 1,
  })
  assert.ok(r.text.includes('Echo Marker QX7QZ'))
  // The pick rides the fast pointer this round: content enters exactly once,
  // never as a duplicated second block (fast/slow double-pack fix).
  assert.deepEqual(r.included, ['echo-marker-qx7qz'])
  assert.deepEqual(r.slowIncluded, [], 'fast-covered pick is not packed twice')
  assert.equal((r.text.match(/\(topics:echo-marker-qx7qz[ )]/g) ?? []).length, 1, 'one pointer header only')
  assert.ok(!r.text.includes('为什么相关'), 'no slow-why line when the fast pointer carries it')
  let records = []
  for (let i = 0; i < 100; i += 1) {
    records = await service.store.readInjectionRecords()
    if (records.some((x) => x.lane === 'mixed')) break
    await waitMs(20)
  }
  const rec = records.find((x) => x.lane === 'mixed')
  assert.notEqual(rec, undefined)
  assert.equal(rec.slow.length, 1, 'fast-covered pick still counts as slow-delivered')
  // Expired pending, no fast hits: injected=false, why carries the reason.
  service.retrieveSync('完全无关的火锅菜谱', 's1', undefined, undefined, 'ttl')
  let recs = []
  for (let i = 0; i < 100; i += 1) {
    recs = await service.store.readInjectionRecords()
    if (recs.some((x) => x.slowExpired === 'ttl')) break
    await waitMs(20)
  }
  const expired = recs.filter((x) => x.slowExpired === 'ttl')
  assert.equal(expired.length, 1)
  assert.equal(expired[0].lane, 'slow')
  assert.equal(expired[0].why, 'slow-expired-ttl')
})

// ---------------------------------------------------------------------------
// Index-level wiring: turn/end produces, the next spliced consumes.
// ---------------------------------------------------------------------------

/** Fake llm answering by system-prompt role; counts lane calls for polling. */
function roleLlm() {
  const instance = { laneCalls: 0 }
  instance.listProviders = () => [{ id: 'p' }]
  instance.stream = async function* (options) {
    const system = String(options?.system ?? '')
    let text = '{"ops":[]}'
    if (system.includes('检索查询构建器')) {
      instance.laneCalls += 1
      text = JSON.stringify({ needs: true, query: 'echo marker qx7qz', ignore: [] })
    } else if (system.includes('注入门禁')) {
      instance.laneCalls += 1
      text = JSON.stringify({ picks: [{ slug: 'echo-marker-qx7qz', why: '上一轮正说到它' }] })
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  return instance
}

test('wiring: turn/end produces a pending, the next spliced consumes it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'topics-quality-wire-'))
  const prevHome = process.env.DSH_TOPICS_HOME
  process.env.DSH_TOPICS_HOME = root
  const handlers = []
  const contexts = []
  const agentsMap = new Map()
  const store = new BundleStore(root)
  await store.ensure()
  await store.saveTopic({
    slug: 'echo-marker-qx7qz',
    doc: {
      fm: { type: 'Topic', title: 'Echo Marker QX7QZ', tags: [], depends: [], open_questions: [], impact: [], status: 'draft', generated: { by: 't', at: new Date().toISOString() } },
      body: '# Conclusion\n\nThe Echo Marker QX7QZ topic exists.\n',
    },
  }, { message: 'seed' })
  const cfg = { ...CFG, qualityLane: 'always', autoObserve: false }
  const ctx = {
    settings: { register: () => ({ get: () => cfg }) },
    systemPrompt: { section: () => undefined, context: (input) => contexts.push(input) },
    tools: { register: () => undefined },
    agents: { get: (id) => agentsMap.get(String(id)) },
    on: (type, handler) => {
      if (type === 'session/event') handlers.push(handler)
    },
    inject: (_deps, cb) => cb({ effect: () => () => {} }),
    effect: () => () => {},
    skills: {
      registerProvider() {
        return () => {}
      },
    },
  }
  apply(ctx)
  const onEvent = handlers[0]
  const dispatch = (sessionId, type, data) => onEvent.call(undefined, { id: sessionId }, { type, data })
  const userMsg = (text) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  try {
    const llm = roleLlm()
    agentsMap.set('s1', { id: 's1', inbox: { nextTurn: [], nextStep: [] }, ctx: { llm } })
    // A complete turn gives the ring buffer material; turn/end fires the lane.
    dispatch('s1', 'user/message', userMsg('echo marker qx7qz 还没处理完吗'))
    dispatch('s1', 'assistant/message', { role: 'assistant', content: [{ type: 'text', text: '在看。' }] })
    dispatch('s1', 'turn/end', {})
    // Poll the fake llm's lane-call counter: both aux calls done → pending set.
    for (let i = 0; i < 150 && llm.laneCalls < 2; i += 1) await waitMs(20)
    assert.ok(llm.laneCalls >= 2, 'slow lane made both aux calls')
    // Next steer message: unrelated query → fast lane zero, slow pending delivers.
    agentsMap.get('s1').inbox.nextTurn = [userMsg('接下来干别的')]
    dispatch('s1', 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1 })
    const provider = contexts.find((c) => c.name === 'topics:topic-memory')
    const text = provider.text({ agent: { id: 's1' } })
    assert.ok(text.includes('Echo Marker QX7QZ'), `slow pick should deliver: ${text}`)
    assert.ok(text.includes('为什么相关'))
    // Consumed → gone: another unrelated claim injects nothing.
    agentsMap.get('s1').inbox.nextTurn = [userMsg('再干点别的')]
    dispatch('s1', 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1 })
    const text2 = provider.text({ agent: { id: 's1' } })
    assert.equal(text2, '')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_TOPICS_HOME
    else process.env.DSH_TOPICS_HOME = prevHome
    await rmRetry(root)
  }
})

test('retrieveSync: gate-blocked evidence lands in the persisted record', async (t) => {
  const { service, cleanup } = tmpService()
  t.after(cleanup)
  await service.store.ensure()
  // A tag-only topic the structural gate must block (v4: tags are not strong).
  await service.saveTopic({ title: '烹饪手册', tags: ['定时'], description: '家常菜做法', conclusion: '先洗菜再下锅。' })
  service.retrieveSync('定时', 's1')
  let recs = []
  for (let i = 0; i < 100; i += 1) {
    recs = await service.store.readInjectionRecords()
    if (recs.length > 0) break
    await waitMs(20)
  }
  assert.equal(recs[0].hits.length, 0)
  const nm = recs[0].nearMisses.find((x) => x.slug === '烹饪手册')
  assert.notEqual(nm, undefined, 'blocked candidate is a near-miss')
  assert.ok(nm.reasons.includes('gate-blocked'), `reasons persisted: ${JSON.stringify(nm)}`)
})

test('wiring: autoInject off → the slow lane never produces (no unconsumable spend)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'topics-quality-off-'))
  const prevHome = process.env.DSH_TOPICS_HOME
  process.env.DSH_TOPICS_HOME = root
  const handlers = []
  const contexts = []
  const agentsMap = new Map()
  const store = new BundleStore(root)
  await store.ensure()
  const cfg = { ...CFG, qualityLane: 'always', autoObserve: false, autoInject: false }
  const ctx = {
    settings: { register: () => ({ get: () => cfg }) },
    systemPrompt: { section: () => undefined, context: (input) => contexts.push(input) },
    tools: { register: () => undefined },
    agents: { get: (id) => agentsMap.get(String(id)) },
    on: (type, handler) => {
      if (type === 'session/event') handlers.push(handler)
    },
    inject: (_deps, cb) => cb({ effect: () => () => {} }),
    effect: () => () => {},
    skills: {
      registerProvider() {
        return () => {}
      },
    },
  }
  apply(ctx)
  const onEvent = handlers[0]
  const dispatch = (sessionId, type, data) => onEvent.call(undefined, { id: sessionId }, { type, data })
  const userMsg = (text) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  try {
    const llm = roleLlm()
    agentsMap.set('s1', { id: 's1', inbox: { nextTurn: [], nextStep: [] }, ctx: { llm } })
    dispatch('s1', 'user/message', userMsg('echo marker qx7qz 还没处理完吗'))
    dispatch('s1', 'assistant/message', { role: 'assistant', content: [{ type: 'text', text: '在看。' }] })
    dispatch('s1', 'turn/end', {})
    await waitMs(300)
    assert.equal(llm.laneCalls, 0, 'no aux LLM spend when injection is off')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_TOPICS_HOME
    else process.env.DSH_TOPICS_HOME = prevHome
    await rmRetry(root)
  }
})
