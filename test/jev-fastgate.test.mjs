// fastgate shadow tests (design 2026-09-25 §2 row 3) — hermetic:
// globalThis.fetch is stubbed (no network), the decisions.jsonl telemetry is
// redirected to a temp $DSH_TOPICS_HOME (re-read per append), and every test
// pins the seam's one invariant: verdicts land, behavior does not change.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { TopicsService } from '../lib/service.js'
import { SlowLane, FASTGATE_MAX_QUESTIONS } from '../lib/quality.js'

const CFG = {
  repo: '', autoInject: true, injectDedup: true, topK: 4, perTopicBudget: 300, totalBudget: 1500,
  matchThreshold: 0.3, tagBoost: 0.15, graphDepth: 2, recencyWindowDays: 7,
  autoObserve: true, observationMaxChars: 2000, distillEveryTurns: 20,
  distillOnSessionEnd: true, distillProvider: 'p', distillModel: 'm', pushDebounceSeconds: 45,
}

/** Cleanup that tolerates an in-flight fire-and-forget write racing it. */
function rmQuiet(path) {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // a racing appendJsonl write is harmless — the dir is temp anyway
  }
}

function makeService(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'topics-fastgate-'))
  const store = new BundleStore(root)
  const service = new TopicsService(store, () => ({ ...CFG, ...overrides }))
  t.after(() => rmQuiet(root))
  return service
}

/** Stub the systemone endpoint; per-candidate noul probabilities keyed by a
 *  marker substring of the question instructions. */
function stubFetch(probByMarker, opts = {}) {
  const calls = []
  const prev = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url: String(url), body })
    if (opts.status !== undefined) return new Response('mock backend down', { status: opts.status })
    const answers = {}
    for (const [qid, q] of Object.entries(body.questions)) {
      const marker = Object.keys(probByMarker ?? {}).find((m) => q.instructions.includes(m))
      answers[qid] = opts.badAnswers === true ? { noul: 'high' } : { noul: marker !== undefined ? probByMarker[marker] : 0.3 }
    }
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 33, output_tokens: 6 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { calls, restore: () => (globalThis.fetch = prev) }
}

/** Env + fetch stub + decisions.jsonl redirect, all undone at test end. */
function withJev(t, probByMarker, opts = {}) {
  const prevHome = process.env.DSH_TOPICS_HOME
  const prevKey = process.env.JEV_ZEN_API_KEY
  const home = mkdtempSync(join(tmpdir(), 'topics-fastgate-jev-'))
  process.env.DSH_TOPICS_HOME = home
  process.env.JEV_ZEN_API_KEY = 'test-zen-key'
  const stub = stubFetch(probByMarker, opts)
  t.after(() => {
    stub.restore()
    if (prevKey === undefined) delete process.env.JEV_ZEN_API_KEY
    else process.env.JEV_ZEN_API_KEY = prevKey
    if (prevHome === undefined) delete process.env.DSH_TOPICS_HOME
    else process.env.DSH_TOPICS_HOME = prevHome
    rmQuiet(home)
  })
  return { calls: stub.calls, home }
}

function rows(home) {
  try {
    return readFileSync(join(home, 'meta', 'decisions.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

/** Poll until a verdict row with `lane` exists (the shadow is fire-and-forget). */
async function waitVerdicts(home, lane, what = 'verdict rows') {
  for (let i = 0; i < 150; i += 1) {
    const found = rows(home).filter((r) => r.digest !== undefined && r.lane === lane)
    if (found.length > 0) return found
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out: ${what}`)
}

const SEEDS = ['Marker 01', 'Marker 02', 'Marker 03', 'Marker 04', 'Marker 05', 'Marker 06', 'Marker 07', 'Marker 08', 'Marker 09', 'Marker 10']

async function seedTopics(service, titles) {
  await service.store.ensure()
  for (const title of titles) {
    await service.saveTopic({ title, conclusion: `The ${title} topic exists.` })
  }
}

const slugOf = (title) => title.toLowerCase().replace(/\s+/g, '-')

test('fastgate: master switch + sampled cadence gates (off / skipped turn / firing turn)', async (t) => {
  // Master switch off → no call, no telemetry, no throw.
  const off = makeService(t) // jevEnabled absent → false
  const offLane = new SlowLane(off, undefined)
  const jevOff = withJev(t, {})
  offLane.dispatchFastGateShadow('s1', {
    query: '任意 query',
    candidates: [{ slug: 'marker-01', disposition: 'hit' }],
    turnId: 3,
  })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(jevOff.calls.length, 0, 'master switch off → zero decision calls')
  assert.equal(existsSync(join(jevOff.home, 'meta', 'decisions.jsonl')), false)

  // Sampled cadence mirrors the slow lane: turnId % 3 !== 0 skips, 3 fires.
  const service = makeService(t, { jevEnabled: true, qualityLane: 'sampled' })
  await seedTopics(service, SEEDS.slice(0, 1))
  const jev = withJev(t, { 'Marker 01': 0.9 })
  const lane = new SlowLane(service, undefined)
  lane.dispatchFastGateShadow('s1', {
    query: '关于 marker 01 的疑问',
    candidates: [{ slug: 'marker-01', disposition: 'hit' }],
    turnId: 1,
  })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(jev.calls.length, 0, 'sampled cadence skips turnId % 3 !== 0')
  lane.dispatchFastGateShadow('s1', {
    query: '关于 marker 01 的疑问',
    candidates: [{ slug: 'marker-01', disposition: 'hit' }],
    turnId: 3,
  })
  const verdicts = await waitVerdicts(jev.home, 'fastgate-shadow')
  assert.equal(verdicts.length, 1)
})

test('fastgate: agree reconciles the lexical disposition; hit+jev-veto is wouldBlock', async (t) => {
  const service = makeService(t, { jevEnabled: true, qualityLane: 'always' })
  await seedTopics(service, SEEDS.slice(0, 4))
  const jev = withJev(t, { 'Marker 01': 0.9, 'Marker 02': 0.05, 'Marker 03': 0.8, 'Marker 04': 0.8 })
  const lane = new SlowLane(service, undefined)
  lane.dispatchFastGateShadow('s1', {
    query: '关于 marker 的疑问',
    candidates: [
      { slug: 'marker-01', disposition: 'hit' },
      { slug: 'marker-02', disposition: 'hit' },
      { slug: 'marker-03', disposition: 'nearFloor' },
      { slug: 'marker-04', disposition: 'gate-blocked' },
    ],
    turnId: 3,
  })
  const verdicts = await waitVerdicts(jev.home, 'fastgate-shadow')
  const agree = Object.fromEntries(verdicts.map((v) => [v.ref, v.agree]))
  assert.deepEqual(agree, {
    'slug:marker-01': 'hit', // lexical let it through, jev agrees (adopt band)
    'slug:marker-02': 'wouldBlock', // lexical let it through, jev lands in the veto band
    'slug:marker-03': 'nearFloor',
    'slug:marker-04': 'gate-blocked',
  })
  const bands = Object.fromEntries(verdicts.map((v) => [v.ref, v.band]))
  assert.deepEqual(bands, {
    'slug:marker-01': 'adopt',
    'slug:marker-02': 'fallback',
    'slug:marker-03': 'adopt',
    'slug:marker-04': 'adopt',
  })
  // Wire shape: state = the round's query + task frame; per-candidate
  // instructions carry the title and two-sided criteria.
  const body = jev.calls[0].body
  assert.match(body.state, /关于 marker 的疑问/)
  assert.match(body.state, /任务背景/)
  for (const q of Object.values(body.questions)) {
    assert.equal(q.type, 'noul')
    assert.equal(typeof q.criteria.true, 'string')
    assert.equal(typeof q.criteria.false, 'string')
  }
})

test('fastgate: candidates cap at 8 questions; unknown slugs are skipped, never asked', async (t) => {
  const service = makeService(t, { jevEnabled: true, qualityLane: 'always' })
  await seedTopics(service, SEEDS) // 10 real topics
  const jev = withJev(t, {})
  const lane = new SlowLane(service, undefined)
  lane.dispatchFastGateShadow('s1', {
    query: '关于 marker 的疑问',
    candidates: [
      ...SEEDS.map((s) => ({ slug: slugOf(s), disposition: 'hit' })),
      { slug: 'vanished-topic', disposition: 'hit' },
      { slug: 'another-gone', disposition: 'nearFloor' },
    ],
    turnId: 3,
  })
  const verdicts = await waitVerdicts(jev.home, 'fastgate-shadow')
  assert.equal(Object.keys(jev.calls[0].body.questions).length, FASTGATE_MAX_QUESTIONS)
  assert.equal(verdicts.length, FASTGATE_MAX_QUESTIONS, 'the batch expands to ≤8 verdict rows')
  assert.deepEqual(verdicts.map((v) => v.questionId), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'])
  assert.equal(verdicts.every((v) => v.agree === 'hit'), true, 'all-hit candidates reconcile as hit')
  assert.equal(verdicts.some((v) => v.ref === 'slug:vanished-topic'), false, 'unknown slugs never reach the wire')
})

test('fastgate: zero behavior — no pending, retrieval output byte-identical with jev on', async (t) => {
  const withShadow = makeService(t, { jevEnabled: true, qualityLane: 'always' })
  const without = makeService(t) // jev off
  for (const service of [withShadow, without]) {
    await seedTopics(service, SEEDS.slice(0, 2))
  }
  const jev = withJev(t, { 'Marker 01': 0.9, 'Marker 02': 0.05 })
  const lane = new SlowLane(withShadow, undefined)
  const query = '关于 marker 01 marker 02 的疑问'
  const baseline = without.retrieveSync(query, 's1')
  withShadow.retrieveSync(query, 's1') // the round the shadow will audit
  lane.dispatchFastGateShadow('s1', {
    query,
    candidates: [
      { slug: 'marker-01', disposition: 'hit' },
      { slug: 'marker-02', disposition: 'nearFloor' },
    ],
    turnId: 3,
  })
  const verdicts = await waitVerdicts(jev.home, 'fastgate-shadow')
  assert.ok(verdicts.length >= 1, 'shadow verdicts landed…')
  const audited = withShadow.retrieveSync(query, 's2')
  // …and nothing about the injection changed: same hits, same assembled text,
  // no pending created, no throw.
  assert.deepEqual(audited.included, baseline.included)
  assert.equal(audited.text, baseline.text)
  assert.equal(lane.hasPending('s1'), false, 'the shadow never produces picks')
  assert.equal(lane.hasInFlight('s1'), false)
})

test('fastgate: backend failure → call row only (fallback=false), no verdict rows, no throw', async (t) => {
  const service = makeService(t, { jevEnabled: true, qualityLane: 'always' })
  await seedTopics(service, SEEDS.slice(0, 1))
  const jev = withJev(t, {}, { status: 500 })
  const lane = new SlowLane(service, undefined)
  lane.dispatchFastGateShadow('s1', {
    query: '关于 marker 01 的疑问',
    candidates: [{ slug: 'marker-01', disposition: 'hit' }],
    turnId: 3,
  })
  for (let i = 0; i < 150 && rows(jev.home).length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 20))
  }
  const all = rows(jev.home)
  const callRow = all.find((r) => r.questionCount !== undefined)
  assert.notEqual(callRow, undefined, 'the failed call still lands (fail-open extends to the stats)')
  assert.equal(callRow.lane, 'fastgate-shadow')
  assert.equal(callRow.outcome, 'http_5xx')
  assert.equal(callRow.fallback, false, 'a pure shadow has no legacy path to fall back to')
  assert.equal(all.some((r) => r.digest !== undefined), false, 'no verdict rows for a failed batch')
  assert.equal(lane.hasPending('s1'), false)
  assert.equal(lane.hasInFlight('s1'), false, 'the shadow settled cleanly')
})
