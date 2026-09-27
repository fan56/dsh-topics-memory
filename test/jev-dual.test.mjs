// jev dual-run pace-maker (design §3.4, added 09-27) — hermetic: fetch stubbed
// per-URL (api.typesafe.ai / opencode.ai = primary; 127.0.0.1:8000 = laya),
// decisions.jsonl redirected to a temp $DSH_TOPICS_HOME, keys env-injected.
// ---------------------------------------------------------------------------
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { TopicsService } from '../lib/service.js'
import { SlowLane } from '../lib/quality.js'

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
  const root = mkdtempSync(join(tmpdir(), 'topics-quality-dual-'))
  const store = new BundleStore(root)
  const service = new TopicsService(store, () => ({ ...CFG, ...overrides }))
  return { root, store, service, cleanup: () => rmRetry(root) }
}

const ringEntry = (user, assistant) => ({ user, assistant, at: new Date().toISOString() })

/** Fake ModelCaller answering the query-builder role; counts lane calls (the
 *  legacy rerank runs inside the same produce pipeline — a non-zero count
 *  AFTER a laya takeover would prove the fallback mis-fired). The legacy
 *  pick must be a LEGAL candidate slug (the rerank drops picks outside the
 *  band, so an unknown slug would leave the lane with no pending at all). */
function fakeCaller(counters = { build: 0, legacyRerank: 0 }, legacySlug = 'echo-marker-qx7qz') {
  return async (req) => {
    if (req.system.includes('检索查询构建器')) {
      counters.build += 1
      return JSON.stringify({ needs: true, query: 'echo marker qx7qz', ignore: [] })
    }
    if (req.system.includes('注入门禁')) {
      counters.legacyRerank += 1
      return JSON.stringify({ picks: [{ slug: legacySlug, why: 'legacy rerank fired' }] })
    }
    return JSON.stringify({ ops: [] })
  }
}

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

function decisionRows(home) {
  try {
    return readFileSync(join(home, 'meta', 'decisions.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

/** Dual-routed fetch stub: URL decides the backend. Each side has its own
 *  probability map (keyed by a marker substring) and failure switches. */
function dualFetchStub({ primaryProb, layaProb, primaryFail = null, layaFail = null, layaBadAnswers = false }) {
  const calls = []
  const prev = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    const isLaya = u.includes('127.0.0.1:8000')
    calls.push({ url: u, backend: isLaya ? 'laya' : 'primary', body: JSON.parse(init.body) })
    if (isLaya && layaFail === 'refused') throw new Error('connect ECONNREFUSED 127.0.0.1:8000')
    if (isLaya && layaFail === 'timeout') {
      return new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('The operation was aborted due to timeout')
          e.name = 'TimeoutError'
          rej(e)
        })
      })
    }
    if (!isLaya && primaryFail !== null) {
      if (primaryFail === 'timeout') {
        return new Promise((_res, rej) => {
          init.signal.addEventListener('abort', () => {
            const e = new Error('The operation was aborted due to timeout')
            e.name = 'TimeoutError'
            rej(e)
          })
        })
      }
      return new Response('backend exploded', { status: primaryFail })
    }
    const body = JSON.parse(init.body)
    const map = isLaya ? layaProb : primaryProb
    const bad = isLaya ? layaBadAnswers : false
    const answers = {}
    for (const [qid, q] of Object.entries(body.questions)) {
      const marker = Object.keys(map ?? {}).find((m) => q.instructions.includes(m))
      answers[qid] = bad ? { noul: 'high' } : { noul: marker !== undefined ? map[marker] : 0.3 }
    }
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 111, output_tokens: 22 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { calls, restore: () => (globalThis.fetch = prev) }
}

function withDual(t, { primaryProb, layaProb, primaryFail = null, layaFail = null, layaBadAnswers = false }) {
  const prevHome = process.env.DSH_TOPICS_HOME
  const prevKey = process.env.JEV_ZEN_API_KEY
  const home = mkdtempSync(join(tmpdir(), 'topics-quality-dual-home-'))
  process.env.DSH_TOPICS_HOME = home
  process.env.JEV_ZEN_API_KEY = 'test-zen-key'
  const stub = dualFetchStub({ primaryProb, layaProb, primaryFail, layaFail, layaBadAnswers })
  t.after(() => {
    stub.restore()
    if (prevKey === undefined) delete process.env.JEV_ZEN_API_KEY
    else process.env.JEV_ZEN_API_KEY = prevKey
    if (prevHome === undefined) delete process.env.DSH_TOPICS_HOME
    else process.env.DSH_TOPICS_HOME = prevHome
    rmRetry(home)
  })
  return { calls: stub.calls, home, rows: () => decisionRows(home) }
}

const JEV_SEEDS = ['Alpha Marker AA11', 'Beta Marker BB22', 'Gamma Marker CC33']

async function seedJevTopics(service) {
  await service.store.ensure()
  for (const title of JEV_SEEDS) {
    await service.saveTopic({ title, conclusion: `The echo marker qx7qz note of ${title} exists.` })
  }
}

const PRIMARY_PROB = { 'Alpha Marker': 0.9, 'Beta Marker': 0.7, 'Gamma Marker': 0.5 }
const LAYA_PROB = { 'Alpha Marker': 0.6, 'Beta Marker': 0.55, 'Gamma Marker': 0.5 }

async function driveRerank(lane) {
  lane.dispatch('s1', { ring: [ringEntry('u', 'a')], turnId: 3 })
  await waitPending(lane, 's1')
  return lane.consume('s1', 4)
}

test('dual off (default): zero laya requests — behavior identical to pre-dual', async (t) => {
  const { service, cleanup } = tmpService({ qualityLane: 'always', jevEnabled: true })
  t.after(cleanup)
  await seedJevTopics(service)
  const jev = withDual(t, { primaryProb: PRIMARY_PROB, layaProb: LAYA_PROB })
  const lane = new SlowLane(service, fakeCaller())
  await driveRerank(lane)
  assert.equal(jev.calls.filter((c) => c.backend === 'laya').length, 0, 'no pace-maker request')
  const rows = jev.rows()
  assert.equal(rows.some((r) => r.backend === 'laya'), false, 'no laya verdict rows')
  for (const c of jev.calls) assert.equal(c.body.model, 'jev-1.13-free')
})

test('dual on, primary ok: primary drives, laya logged as comparison (degraded=false)', async (t) => {
  const { service, cleanup } = tmpService({ qualityLane: 'always', jevEnabled: true, jevLayaFallback: true })
  t.after(cleanup)
  await seedJevTopics(service)
  const jev = withDual(t, { primaryProb: PRIMARY_PROB, layaProb: LAYA_PROB })
  const lane = new SlowLane(service, fakeCaller())
  const consumed = await driveRerank(lane)
  assert.ok(consumed !== undefined && 'pending' in consumed)
  // primary drives the picks via jev thresholds — laya's ranking NOT used.
  assert.deepEqual(consumed.pending.items, [
    { slug: 'alpha-marker-aa11', why: 'jev 判定相关（p=0.90）' },
    { slug: 'beta-marker-bb22', why: 'jev 判定相关（p=0.70）' },
  ])
  const layaCalls = jev.calls.filter((c) => c.backend === 'laya')
  assert.equal(layaCalls.length, 1, 'pace-maker fired once, in parallel')
  assert.equal(layaCalls[0].body.model, 'laya-rl-agent')
  const verdicts = jev.rows().filter((r) => r.digest !== undefined)
  assert.equal(verdicts.length, 6, '3 primary + 3 laya comparison rows')
  assert.equal(verdicts.filter((v) => v.backend === 'laya').length, 3)
  assert.equal(verdicts.every((v) => v.degraded === false), true, 'comparison rows are not degraded')
})

test('dual on, primary timeout → legacy LLM rerank fallback; laya comparison rows still land (REVISED 09-27: real-data top-1 agreement 0/14 killed the ranking takeover)', async (t) => {
  const { service, cleanup } = tmpService({ qualityLane: 'always', jevEnabled: true, jevLayaFallback: true, jevTimeoutMs: 30 })
  t.after(cleanup)
  await seedJevTopics(service)
  // primary: every call hangs past the 30ms timeout; laya answers — but per
  // the 09-27 real-data evidence (within-batch top-1 agreement 0/14) its
  // ranking is NOT trusted for picks: the legacy LLM rerank drives instead.
  const jev = withDual(t, { primaryProb: PRIMARY_PROB, layaProb: LAYA_PROB, primaryFail: 'timeout' })
  const counters = { build: 0, legacyRerank: 0 }
  // the legacy pick must be one of the seeded candidates, else the rerank
  // drops it (illegal slug) and the lane settles no pending at all.
  const lane = new SlowLane(service, fakeCaller(counters, 'alpha-marker-aa11'))
  lane.dispatch('s1', { ring: [ringEntry('u', 'a')], turnId: 3 })
  await waitPending(lane, 's1')
  const consumed = lane.consume('s1', 4)
  assert.ok(consumed !== undefined && 'pending' in consumed)
  assert.equal(counters.legacyRerank, 1, 'fail-open falls to the legacy LLM rerank (ADR 0018)')
  assert.deepEqual(consumed.pending.items, [
    { slug: 'alpha-marker-aa11', why: 'legacy rerank fired' },
  ])
  const rows = jev.rows()
  const layaVerdicts = rows.filter((r) => r.digest !== undefined && r.backend === 'laya')
  assert.equal(layaVerdicts.length, 3, 'laya comparison rows still land (telemetry only)')
  assert.equal(layaVerdicts.every((v) => v.degraded === false), true, 'comparison rows are not degraded (nothing drove)')
})

test('dual on, primary AND laya fail → legacy LLM rerank fallback unchanged', async (t) => {
  const { service, cleanup } = tmpService({ qualityLane: 'always', jevEnabled: true, jevLayaFallback: true, jevTimeoutMs: 30 })
  t.after(cleanup)
  await service.store.ensure()
  await service.saveTopic({ title: 'Echo Marker QX7QZ', conclusion: 'The Echo Marker QX7QZ topic exists.' })
  const jev = withDual(t, { primaryProb: PRIMARY_PROB, layaProb: LAYA_PROB, primaryFail: 'timeout', layaFail: 'refused' })
  const counters = { build: 0, legacyRerank: 0 }
  const lane = new SlowLane(service, fakeCaller(counters))
  lane.dispatch('s1', { ring: [ringEntry('u', 'a')], turnId: 3 })
  await waitPending(lane, 's1')
  const consumed = lane.consume('s1', 4)
  assert.ok(consumed !== undefined && 'pending' in consumed)
  assert.match(consumed.pending.items[0].why, /legacy rerank fired/)
  assert.equal(counters.legacyRerank, 1)
  const rows = jev.rows()
  assert.equal(rows.filter((r) => r.backend === 'laya' && r.outcome !== undefined).length >= 1, true, 'laya refusal logged')
})

test('dual on, laya down (refused) → primary-only, zero behavior change', async (t) => {
  const { service, cleanup } = tmpService({ qualityLane: 'always', jevEnabled: true, jevLayaFallback: true })
  t.after(cleanup)
  await seedJevTopics(service)
  const jev = withDual(t, { primaryProb: PRIMARY_PROB, layaProb: LAYA_PROB, layaFail: 'refused' })
  const lane = new SlowLane(service, fakeCaller())
  const consumed = await driveRerank(lane)
  assert.ok(consumed !== undefined && 'pending' in consumed)
  assert.deepEqual(consumed.pending.items, [
    { slug: 'alpha-marker-aa11', why: 'jev 判定相关（p=0.90）' },
    { slug: 'beta-marker-bb22', why: 'jev 判定相关（p=0.70）' },
  ])
  assert.equal(jev.calls.filter((c) => c.backend === 'laya').length, 1, 'pace-maker attempted')
  assert.equal(jev.rows().some((r) => r.backend === 'laya' && r.digest !== undefined), false, 'laya produced nothing → no laya VERDICT rows')
  assert.equal(jev.rows().some((r) => r.backend === 'laya' && r.outcome === 'network'), true, 'laya refusal logged as a call row')
})

test('fastgate shadow dual: primary ok → primary verdicts + laya comparison rows, degraded=false', async (t) => {
  const { service, cleanup } = tmpService({ qualityLane: 'always', jevEnabled: true, jevLayaFallback: true })
  t.after(cleanup)
  await seedJevTopics(service)
  const jev = withDual(t, { primaryProb: { 'Alpha Marker': 0.9, 'Beta Marker': 0.3, 'Gamma Marker': 0.5 }, layaProb: { 'Alpha Marker': 0.6, 'Beta Marker': 0.55, 'Gamma Marker': 0.5 } })
  const lane = new SlowLane(service, fakeCaller())
  await driveRerank(lane)
  lane.dispatchFastGateShadow('s1', {
    query: 'echo marker qx7qz',
    candidates: [
      { slug: 'alpha-marker-aa11', disposition: 'hit' },
      { slug: 'beta-marker-bb22', disposition: 'nearFloor' },
      { slug: 'gamma-marker-cc33', disposition: 'nearFloor' },
    ],
    turnId: 4,
  })
  for (let i = 0; i < 100 && jev.rows().filter((r) => r.lane === 'fastgate-shadow' && r.digest !== undefined).length < 6; i += 1) await waitMs(20)
  const verdicts = jev.rows().filter((r) => r.lane === 'fastgate-shadow' && r.digest !== undefined)
  assert.equal(verdicts.filter((v) => v.backend === 'primary').length, 3)
  assert.equal(verdicts.filter((v) => v.backend === 'laya').length, 3)
  const agree = verdicts.filter((v) => v.ref === 'slug:alpha-marker-aa11' && v.backend === 'primary')[0]?.agree
  assert.equal(agree, 'hit')
})
