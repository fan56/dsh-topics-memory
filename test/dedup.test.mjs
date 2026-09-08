import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { BundleStore } from '../lib/store.js'
import { TopicsService } from '../lib/service.js'

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


const DEFAULT_CFG = {
  repo: '', autoInject: true, injectDedup: true, topK: 4, perTopicBudget: 300, totalBudget: 1500,
  matchThreshold: 0.3, tagBoost: 0.15, graphDepth: 2, recencyWindowDays: 7,
  autoObserve: true, observationMaxChars: 2000, distillEveryTurns: 20,
  distillOnSessionEnd: true, distillProvider: '', distillModel: '', pushDebounceSeconds: 45,
}

const TOPIC_A = { title: 'Echo Marker QX7QZ', conclusion: 'The Echo Marker QX7QZ topic exists.' }
const TOPIC_B = { title: 'Bravo Noodle W8R3', conclusion: 'The Bravo Noodle W8R3 topic exists.' }
// Digest floor for B must exceed a tiny totalBudget no matter how topicDigest
// truncates: the 待决 line is never truncated, so three fat open questions
// keep B's digest permanently too big for the small-budget rounds below.
const LONG_B = {
  title: 'Bravo Noodle W8R3',
  conclusion: 'The Bravo Noodle W8R3 topic exists.',
  openQuestions: [`q1 ${'x'.repeat(80)}`, `q2 ${'x'.repeat(80)}`, `q3 ${'x'.repeat(80)}`],
}
const SLUG_A = 'echo-marker-qx7qz'
const SLUG_B = 'bravo-noodle-w8r3'
const QUERY_A = '关于 echo marker qx7qz 的疑问'
const QUERY_B = '关于 bravo noodle w8r3 的疑问'
const QUERY_AB = '关于 echo marker qx7qz 与 bravo noodle w8r3 的疑问'

const userMsg = (text) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

/**
 * Minimal fake dsh ctx for apply(): the settings scope serves `overrides`
 * live (mutating the object mid-test changes cfgNow()), session/event
 * handlers are captured for direct dispatch, systemPrompt.context sinks are
 * recorded (index 0 = the topic-memory provider). The bundle root is
 * redirected to a tmp dir via $DSH_TOPICS_HOME before apply() runs.
 */
function bootPlugin(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'topics-dedup-'))
  const prevHome = process.env.DSH_TOPICS_HOME
  process.env.DSH_TOPICS_HOME = root
  const handlers = []
  const disposedHandlers = {}
  const contexts = []
  const agentsMap = new Map()
  const ctx = {
    settings: { register: () => ({ get: () => overrides }) },
    systemPrompt: {
      section: () => undefined,
      context: (input) => contexts.push(input),
    },
    tools: { register: () => undefined },
    agents: { get: (id) => agentsMap.get(String(id)) },
    on: (type, handler) => {
      if (type === 'session/event') handlers.push(handler)
      else if (type === 'agent/disposed' || type === 'session/disposed') disposedHandlers[type] = handler
    },
    inject: (_deps, cb) => cb({ effect: () => () => {} }),
    effect: () => () => {},
  }
  apply(ctx)
  const onEvent = handlers[0]
  const dispatch = (sessionId, type, data) => onEvent.call(undefined, { id: sessionId }, { type, data })
  // Real teardown events are cordis events, not session/event types: deliver
  // them through the recorded disposal handlers with their true payloads.
  const dispose = (sessionId, type) => {
    const handler = disposedHandlers[type]
    if (handler === undefined) throw new Error(`no recorded handler for ${type}`)
    if (type === 'agent/disposed') handler({ agent: { id: sessionId } })
    else handler({ id: sessionId })
  }
  const claim = (sessionId, text) => {
    if (!agentsMap.has(sessionId)) agentsMap.set(sessionId, { inbox: { nextTurn: [], nextStep: [] } })
    agentsMap.get(sessionId).inbox.nextTurn = [userMsg(text)]
    dispatch(sessionId, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1 })
  }
  const injectedText = (sessionId) => contexts[0].text({ agent: { id: sessionId } })
  const cleanup = async () => {
    if (prevHome === undefined) delete process.env.DSH_TOPICS_HOME
    else process.env.DSH_TOPICS_HOME = prevHome
    await rmRetry(root)
  }
  return { root, dispatch, dispose, claim, injectedText, cleanup }
}

/** Seed topics through a sibling service on the same bundle root. */
async function seedTopics(root, topics) {
  const store = new BundleStore(root)
  await store.ensure()
  const service = new TopicsService(store, () => ({ ...DEFAULT_CFG }))
  for (const topic of topics) await service.saveTopic(topic)
  return store
}

/** Poll for the fire-and-forget injection log writes (deflake, cf. tools.test.mjs). */
async function readRecords(store, expected) {
  let records = []
  for (let i = 0; i < 100; i += 1) {
    records = await store.readInjectionRecords()
    if (records.length >= expected) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return records
}

test('retrieveSync: exclude filters hits before assembly and reports deduped', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'topics-dedup-svc-'))
  t.after(() => rmRetry(root))
  const store = new BundleStore(root)
  await store.ensure()
  const service = new TopicsService(store, () => ({ ...DEFAULT_CFG }))
  await service.saveTopic(TOPIC_A)
  const r1 = service.retrieveSync(QUERY_A, 's1')
  assert.deepEqual(r1.included, [SLUG_A])
  assert.deepEqual(r1.deduped, [])
  const r2 = service.retrieveSync(QUERY_A, 's1', { exclude: new Set([SLUG_A]) })
  assert.equal(r2.text, '')
  assert.deepEqual(r2.deduped, [SLUG_A])
  assert.deepEqual(r2.included, [])
})

test('dedup: same topic two rounds in a row — round 2 blocked with why=dedup', async () => {
  const h = bootPlugin()
  try {
    const store = await seedTopics(h.root, [TOPIC_A])
    h.claim('s1', QUERY_A)
    assert.match(h.injectedText('s1'), /Echo Marker QX7QZ/)
    // The turn lifecycle must NOT clear the dedup registry (only session end does).
    h.dispatch('s1', 'turn/start', {})
    h.dispatch('s1', 'turn/end', {})
    h.claim('s1', QUERY_A)
    assert.equal(h.injectedText('s1'), '')
    const records = await readRecords(store, 2)
    assert.equal(records.length, 2)
    // Appends race (fire-and-forget), so identify rounds by content, not order.
    const first = records.find((r) => r.injected)
    const second = records.find((r) => !r.injected)
    assert.notEqual(first, undefined)
    assert.notEqual(second, undefined)
    assert.equal(second.why, 'dedup')
    assert.deepEqual(second.deduped, [SLUG_A])
  } finally {
    h.cleanup()
  }
})

test('dedup: a different topic in round two injects normally', async () => {
  const h = bootPlugin()
  try {
    const store = await seedTopics(h.root, [TOPIC_A, TOPIC_B])
    h.claim('s1', QUERY_A)
    assert.match(h.injectedText('s1'), /Echo Marker QX7QZ/)
    h.claim('s1', QUERY_B)
    const t2 = h.injectedText('s1')
    assert.match(t2, /Bravo Noodle W8R3/)
    assert.doesNotMatch(t2, /Echo Marker QX7QZ/)
    const records = await readRecords(store, 2)
    const second = records.find((r) => r.hits.some((h) => h.slug === SLUG_B))
    assert.notEqual(second, undefined)
    assert.equal(second.injected, true)
    assert.equal(second.deduped, undefined)
  } finally {
    h.cleanup()
  }
})

test('dedup: injectDedup=false keeps legacy behavior (re-inject every round)', async () => {
  const h = bootPlugin({ injectDedup: false })
  try {
    const store = await seedTopics(h.root, [TOPIC_A])
    h.claim('s1', QUERY_A)
    assert.match(h.injectedText('s1'), /Echo Marker QX7QZ/)
    h.claim('s1', QUERY_A)
    assert.match(h.injectedText('s1'), /Echo Marker QX7QZ/)
    const records = await readRecords(store, 2)
    assert.equal(records.filter((r) => r.injected).length, 2)
    assert.ok(records.every((r) => r.deduped === undefined && r.why === undefined))
  } finally {
    h.cleanup()
  }
})

test('dedup: session end clears the registry — same topic injects again', async () => {
  const h = bootPlugin()
  try {
    const store = await seedTopics(h.root, [TOPIC_A])
    h.claim('s1', QUERY_A)
    assert.match(h.injectedText('s1'), /Echo Marker QX7QZ/)
    h.dispatch('s1', 'session/end-seed', {})
    // A brand-new session injects the topic again…
    h.claim('s2', QUERY_A)
    assert.match(h.injectedText('s2'), /Echo Marker QX7QZ/)
    // …and the ended session's own entry is gone (re-claim injects, not deduped).
    h.claim('s1', QUERY_A)
    assert.match(h.injectedText('s1'), /Echo Marker QX7QZ/)
    // The real teardown events clear too (cordis `agent/disposed` carry the
    // agent; `session/disposed` carry the session).
    h.claim('s3', QUERY_A)
    assert.match(h.injectedText('s3'), /Echo Marker QX7QZ/)
    h.dispose('s3', 'agent/disposed')
    h.claim('s3', QUERY_A)
    assert.match(h.injectedText('s3'), /Echo Marker QX7QZ/)
    h.claim('s4', QUERY_A)
    assert.match(h.injectedText('s4'), /Echo Marker QX7QZ/)
    h.dispose('s4', 'session/disposed')
    h.claim('s4', QUERY_A)
    assert.match(h.injectedText('s4'), /Echo Marker QX7QZ/)
    const records = await readRecords(store, 7)
    assert.equal(records.length, 7)
    assert.equal(records.filter((r) => r.injected).length, 7)
    assert.equal(records.some((r) => r.why === 'dedup'), false)
  } finally {
    h.cleanup()
  }
})

test('dedup: total-budget-dropped slugs never enter the registry (digest mode)', async () => {
  // Legacy digest arithmetic: fat open-questions keep B's digest permanently
  // over a tiny budget. Pointer mode has its own variant below (small blocks,
  // tighter budget).
  const overrides = { totalBudget: 120, injectMode: 'digest' }
  const h = bootPlugin(overrides)
  try {
    const store = await seedTopics(h.root, [TOPIC_A, LONG_B])
    // Round 1: the short topic fits, the long one is dropped by the total budget.
    h.claim('s1', QUERY_AB)
    const t1 = h.injectedText('s1')
    assert.match(t1, /Echo Marker QX7QZ/)
    assert.doesNotMatch(t1, /Bravo Noodle W8R3/)
    const records1 = await readRecords(store, 1)
    assert.deepEqual(records1[0].dropped, [{ slug: SLUG_B, reason: 'total-budget' }])
    // Round 2 (same session, same query): the short topic is deduped, the long
    // one is budget-dropped again — nothing injects, and the mixed outcome is
    // why='below-budget-or-dropped', not 'dedup'.
    h.claim('s1', QUERY_AB)
    assert.equal(h.injectedText('s1'), '')
    const records2 = await readRecords(store, 2)
    // Appends race (fire-and-forget), so identify rounds by content, not order.
    const r2 = records2.find((r) => !r.injected)
    assert.notEqual(r2, undefined)
    assert.deepEqual(r2.deduped, [SLUG_A])
    assert.deepEqual(r2.dropped, [{ slug: SLUG_B, reason: 'total-budget' }])
    assert.equal(r2.why, 'below-budget-or-dropped')
    // Round 3: budget raised — the dropped slug now injects (it was never in
    // the registry), while the actually-injected short topic stays deduped.
    overrides.totalBudget = 4000
    h.claim('s1', QUERY_AB)
    const t3 = h.injectedText('s1')
    assert.match(t3, /Bravo Noodle W8R3/)
    assert.doesNotMatch(t3, /Echo Marker QX7QZ/)
    const records3 = await readRecords(store, 3)
    const r3 = records3.find((r) => r.injected && r.deduped !== undefined)
    assert.notEqual(r3, undefined)
    assert.deepEqual(r3.deduped, [SLUG_A])
    assert.equal(r3.dropped, undefined)
  } finally {
    h.cleanup()
  }
})

test('dedup: pointer mode budget drop keeps the same registry discipline', async () => {
  // Pointer blocks are small, so the squeeze comes from the clamp
  // (min(totalBudget, 600)): at 78 the wrapper + one pointer fit, the second
  // does not (its slice of the budget falls under the 24 floor). A and B
  // score identically, so WHICH one fits follows roster order — the test is
  // order-agnostic and pins the CONTRACT instead: dropped slugs stay
  // injectable, included slugs are deduped.
  const overrides = { totalBudget: 78 }
  const h = bootPlugin(overrides)
  try {
    const store = await seedTopics(h.root, [TOPIC_A, TOPIC_B])
    h.claim('s1', QUERY_AB)
    const t1 = h.injectedText('s1')
    const aIn = t1.includes('Echo Marker QX7QZ')
    const bIn = t1.includes('Bravo Noodle W8R3')
    assert.ok(aIn !== bIn, `exactly one pointer fits at budget 78 (a=${aIn} b=${bIn})`)
    const injectedSlug = aIn ? SLUG_A : SLUG_B
    const injectedTitle = aIn ? 'Echo Marker QX7QZ' : 'Bravo Noodle W8R3'
    const droppedSlug = aIn ? SLUG_B : SLUG_A
    const droppedTitle = aIn ? 'Bravo Noodle W8R3' : 'Echo Marker QX7QZ'
    const records1 = await readRecords(store, 1)
    assert.deepEqual(records1[0].dropped, [{ slug: droppedSlug, reason: 'total-budget' }])
    // Round 2: the injected one deduped, which frees exactly enough room for
    // the dropped one at the same budget (pointer blocks are small — unlike
    // the digest variant, the squeeze is per-round, not permanent).
    h.claim('s1', QUERY_AB)
    assert.match(h.injectedText('s1'), new RegExp(droppedTitle))
    const records2 = await readRecords(store, 2)
    // Both rounds inject — identify round 2 by its dedup mark (appends race).
    const r2 = records2.find((r) => r.injected && r.deduped !== undefined)
    assert.notEqual(r2, undefined)
    assert.deepEqual(r2.deduped, [injectedSlug])
    assert.equal(r2.dropped, undefined)
    // Round 3: both are in the registry now — raising the budget (clamped to
    // 600, plenty for both pointers) must NOT resurrect them. Budget drops
    // stay injectable; registry marks do not expire with the session.
    overrides.totalBudget = 4000
    h.claim('s1', QUERY_AB)
    assert.equal(h.injectedText('s1'), '')
    const records3 = await readRecords(store, 3)
    const r3 = records3.find((r) => !r.injected)
    assert.notEqual(r3, undefined)
    assert.equal(r3.why, 'dedup')
    assert.deepEqual([...r3.deduped].sort(), [SLUG_A, SLUG_B].sort())
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Echo suppression (2026-09 audit #3): a topic distilled from the CURRENT
// session's own turns is a lagging echo of what the model already said —
// it must not inject back into that session (suppressEcho, provenance via
// the observations log: sessionId → distilledInto).
// ---------------------------------------------------------------------------

test('echo: echoSlugsSync groups distilledInto by session (mtime-cached)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'topics-echo-'))
  t.after(() => rmRetry(root))
  const store = new BundleStore(root)
  await store.ensure()
  const service = new TopicsService(store, () => ({ ...DEFAULT_CFG }))
  await service.saveTopic(TOPIC_A)
  const o1 = await store.appendObservation({ kind: 'turn', source: 'auto', sessionId: 's1', text: '用户: a\n助手: b' })
  await store.appendObservation({ kind: 'turn', source: 'auto', sessionId: 's2', text: '用户: c\n助手: d' })
  await store.markDistilled([o1.id], [SLUG_A])
  assert.deepEqual([...service.echoSlugsSync('s1')], [SLUG_A])
  assert.deepEqual([...service.echoSlugsSync('s2')], [], 'other sessions have no echo set')
  assert.deepEqual([...service.echoSlugsSync('s3')], [], 'unknown sessions have no echo set')
  // New distill lands → mtime changes → cache rebuilds.
  const o2 = await store.appendObservation({ kind: 'turn', source: 'auto', sessionId: 's2', text: '用户: e\n助手: f' })
  await store.markDistilled([o2.id], [SLUG_A])
  assert.deepEqual([...service.echoSlugsSync('s2')], [SLUG_A], 'cache rebuilds after the log rewrite')
})

test('echo: echo-filtered hits never pack and log record.echoed', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'topics-echo-svc-'))
  t.after(() => rmRetry(root))
  const store = new BundleStore(root)
  await store.ensure()
  const service = new TopicsService(store, () => ({ ...DEFAULT_CFG }))
  await service.saveTopic(TOPIC_A)
  const r = service.retrieveSync(QUERY_A, 's1', { echo: new Set([SLUG_A]) })
  assert.equal(r.text, '')
  assert.deepEqual(r.echoed, [SLUG_A])
  assert.deepEqual(r.included, [])
  assert.deepEqual(r.deduped, [], 'echo is reported separately from dedup')
  const records = await readRecords(store, 1)
  const rec = records[records.length - 1]
  assert.deepEqual(rec.echoed, [SLUG_A])
  // Other topics in the same round are unaffected.
  const other = service.retrieveSync(QUERY_A, 's1', { echo: new Set(['totally-unrelated-topic']) })
  assert.deepEqual(other.included, [SLUG_A])
  assert.deepEqual(other.echoed, [])
})

test('echo: exclude wins when a slug is both deduped and echoed', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'topics-echo-both-'))
  t.after(() => rmRetry(root))
  const store = new BundleStore(root)
  await store.ensure()
  const service = new TopicsService(store, () => ({ ...DEFAULT_CFG }))
  await service.saveTopic(TOPIC_A)
  const r = service.retrieveSync(QUERY_A, 's1', { exclude: new Set([SLUG_A]), echo: new Set([SLUG_A]) })
  assert.equal(r.text, '')
  assert.deepEqual(r.deduped, [SLUG_A])
  assert.deepEqual(r.echoed, [])
})
