import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { TopicsService } from '../lib/service.js'
import { SlowLane, CALL_TIMEOUT_MS, TURN_LAG_LIMIT } from '../lib/quality.js'

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
// jevEnabled stays unset → OFF: the legacy LLM rerank is the A4 baseline path.

function tmpService(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'slow-outcome-'))
  const store = new BundleStore(root)
  const service = new TopicsService(store, () => ({ ...CFG, ...overrides }))
  return { root, store, service, cleanup: () => rmRetry(root) }
}

const ringEntry = (user, assistant) => ({ user, assistant, at: new Date().toISOString() })

/** Fake ModelCaller that answers by system-prompt role (no real network). */
function fakeCaller(handlers = {}) {
  return async (req) => {
    if (req.system.includes('检索查询构建器')) {
      if (handlers.build === 'throw') throw new Error('model exploded')
      return handlers.build ?? JSON.stringify({ needs: true, query: 'echo marker qx7qz', ignore: [] })
    }
    if (req.system.includes('注入门禁')) {
      if (handlers.rerank === 'throw') throw new Error('model exploded')
      return handlers.rerank ?? JSON.stringify({ picks: [{ slug: 'echo-marker-qx7qz', why: '当前问题正需要这条结论' }] })
    }
    return JSON.stringify({ ops: [] })
  }
}

const pipelineRows = (root) =>
  readFileSync(join(root, 'meta', 'pipeline-events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))

/** Poll the ledger until an outcome row matches the predicate (W-C rows only). */
async function waitRow(root, pred, what = 'outcome row') {
  for (let i = 0; ; i += 1) {
    try {
      const hit = pipelineRows(root).find((r) => r.kind === 'slow-lane-outcome' && pred(r))
      if (hit !== undefined) return hit
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
    if (i > 250) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

function waitPending(lane, sessionId, what = 'pending lands') {
  return (async () => {
    for (let i = 0; i < 150; i += 1) {
      if (lane.hasPending(sessionId)) return
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error(`timed out: ${what}`)
  })()
}

test('slow outcome: every dispatch guard lands no-run with its reason (A4 决议 3 调度跳过)', async (t) => {
  const { root, service, cleanup } = tmpService()
  t.after(cleanup)
  const ring = [ringEntry('u', 'a')]
  // Lane off (qualityLane neither sampled nor always).
  const off = new SlowLane(service, fakeCaller())
  off.dispatch('s-off', { ring, turnId: 3 })
  // Sampled cadence miss.
  const sampled = new SlowLane(new TopicsService(service.store, () => ({ ...CFG, qualityLane: 'sampled' })), fakeCaller())
  sampled.dispatch('s-cadence', { ring, turnId: 1 })
  // No model configured.
  const noModel = new SlowLane(new TopicsService(service.store, () => ({ ...CFG, qualityLane: 'always' })), undefined)
  noModel.dispatch('s-nomodel', { ring, turnId: 3 })
  // Empty ring.
  const always = new SlowLane(new TopicsService(service.store, () => ({ ...CFG, qualityLane: 'always' })), fakeCaller())
  always.dispatch('s-ring', { ring: [], turnId: 3 })

  for (const [sessionId, reason] of [['s-off', 'lane-off'], ['s-cadence', 'cadence'], ['s-nomodel', 'no-caller'], ['s-ring', 'empty-ring']]) {
    const row = await waitRow(root, (r) => r.detail?.sessionId === sessionId, `no-run/${reason}`)
    assert.equal(row.detail.outcome, 'no-run')
    assert.equal(row.detail.reason, reason)
    assert.equal(row.detail.turnId, { 's-off': 3, 's-cadence': 1, 's-nomodel': 3, 's-ring': 3 }[sessionId])
  }
  // The last-outcome slot is the spliced seam's answer (spec §8.2 wiring).
  assert.equal(off.lastOutcomeOf('s-off'), 'no-run')
  assert.equal(sampled.lastOutcomeOf('s-cadence'), 'no-run')
  assert.equal(always.lastOutcomeOf('s-ring'), 'no-run')
})

test('slow outcome: build declines → no-claim (A4 决议 3 「没跑」vs「跑了全败」第一半)', async (t) => {
  const { root, service, cleanup } = tmpService({ qualityLane: 'always' })
  t.after(cleanup)
  await service.store.ensure()
  const lane = new SlowLane(service, fakeCaller({ build: JSON.stringify({ needs: false }) }))
  lane.dispatch('s1', { ring: [ringEntry('u', 'a')], turnId: 3 })
  const row = await waitRow(root, (r) => r.detail?.sessionId === 's1', 'no-claim')
  assert.equal(row.detail.outcome, 'no-claim')
  assert.equal(row.detail.reason, 'build-no-need')
  assert.equal(lane.hasPending('s1'), false)
  assert.equal(lane.lastOutcomeOf('s1'), 'no-claim')
})

test('slow outcome: model failures are qualified, not silent — llm-error (throw / unparseable)', async (t) => {
  const { root, service, cleanup } = tmpService({ qualityLane: 'always' })
  t.after(cleanup)
  await service.store.ensure()
  await service.saveTopic({ title: 'Echo Marker QX7QZ', conclusion: 'exists.' })
  const lane = new SlowLane(service, fakeCaller({ build: 'throw' }))
  lane.dispatch('s-throw', { ring: [ringEntry('u', 'a')], turnId: 3 })
  const rowThrow = await waitRow(root, (r) => r.detail?.sessionId === 's-throw', 'llm-error throw')
  assert.equal(rowThrow.detail.outcome, 'llm-error')
  assert.equal(rowThrow.detail.reason, 'call-failed')
  assert.equal(lane.lastOutcomeOf('s-throw'), 'llm-error')

  // Unparseable build output — previously a bare silent `return`.
  const lane2 = new SlowLane(new TopicsService(service.store, () => ({ ...CFG, qualityLane: 'always' })), fakeCaller({ build: '不是 JSON 的输出' }))
  lane2.dispatch('s-badjson', { ring: [ringEntry('u', 'a')], turnId: 3 })
  const rowJson = await waitRow(root, (r) => r.detail?.sessionId === 's-badjson', 'llm-error bad-json')
  assert.equal(rowJson.detail.outcome, 'llm-error')
  assert.equal(rowJson.detail.reason, 'build-bad-json')
  // The rerank-level unparseable path qualifies the same way.
  const lane3 = new SlowLane(new TopicsService(service.store, () => ({ ...CFG, qualityLane: 'always' })), fakeCaller({ rerank: ' garbage ' }))
  lane3.dispatch('s-rerank-badjson', { ring: [ringEntry('u', 'a')], turnId: 3 })
  const rowRerank = await waitRow(root, (r) => r.detail?.sessionId === 's-rerank-badjson', 'llm-error rerank-bad-json')
  assert.equal(rowRerank.detail.outcome, 'llm-error')
  assert.equal(rowRerank.detail.reason, 'rerank-bad-json')
})

test('slow outcome: build call timeout → timeout (real withTimeout path, mock clock)', async (t) => {
  const { root, service, cleanup } = tmpService({ qualityLane: 'always' })
  t.after(cleanup)
  await service.store.ensure()
  await service.saveTopic({ title: 'Echo Marker QX7QZ', conclusion: 'exists.' })
  const lane = new SlowLane(service, () => new Promise(() => {})) // never answers
  t.mock.timers.enable({ apis: ['setTimeout'] })
  lane.dispatch('s-timeout', { ring: [ringEntry('u', 'a')], turnId: 3 })
  t.mock.timers.tick(CALL_TIMEOUT_MS + 1)
  t.mock.timers.reset() // hand real timers back for the ledger polling below
  const row = await waitRow(root, (r) => r.detail?.sessionId === 's-timeout', 'timeout')
  assert.equal(row.detail.outcome, 'timeout')
  assert.equal(row.detail.reason, 'call-failed')
  assert.equal(lane.hasPending('s-timeout'), false)
  assert.equal(lane.lastOutcomeOf('s-timeout'), 'timeout')
})

test('slow outcome: empty roster / rerank picks nothing → no-candidates (A4 决议 3 候选空)', async (t) => {
  const { root, service, cleanup } = tmpService({ qualityLane: 'always' })
  t.after(cleanup)
  await service.store.ensure()
  // Empty roster → no candidates at all.
  const lane = new SlowLane(service, fakeCaller())
  lane.dispatch('s-noroster', { ring: [ringEntry('u', 'a')], turnId: 3 })
  const rowRoster = await waitRow(root, (r) => r.detail?.sessionId === 's-noroster', 'no-candidates roster')
  assert.equal(rowRoster.detail.outcome, 'no-candidates')
  assert.equal(rowRoster.detail.reason, 'roster-empty')
  // Roster exists, rerank answers fine but picks nothing → ran, gate said no.
  await service.saveTopic({ title: 'Echo Marker QX7QZ', conclusion: 'exists.' })
  const lane2 = new SlowLane(new TopicsService(service.store, () => ({ ...CFG, qualityLane: 'always' })), fakeCaller({ rerank: JSON.stringify({ picks: [] }) }))
  lane2.dispatch('s-zeropicks', { ring: [ringEntry('u', 'a')], turnId: 3 })
  const rowPicks = await waitRow(root, (r) => r.detail?.sessionId === 's-zeropicks', 'no-candidates zero-picks')
  assert.equal(rowPicks.detail.outcome, 'no-candidates')
  assert.equal(rowPicks.detail.reason, 'rerank-zero-picks')
  assert.equal(lane2.hasPending('s-zeropicks'), false)
})

test('slow outcome: delivered happy path — pending carries outcome, ledger row lands', async (t) => {
  const { root, service, cleanup } = tmpService({ qualityLane: 'always' })
  t.after(cleanup)
  await service.store.ensure()
  await service.saveTopic({ title: 'Echo Marker QX7QZ', conclusion: 'The Echo Marker QX7QZ topic exists.' })
  const lane = new SlowLane(service, fakeCaller())
  lane.dispatch('s-ok', { ring: [ringEntry('用户在问 echo marker qx7qz 怎么处理', '答了一半')], turnId: 3 })
  await waitPending(lane, 's-ok')
  const consumed = lane.consume('s-ok', 4)
  assert.ok(consumed !== undefined && 'pending' in consumed)
  assert.equal(consumed.pending.outcome, 'delivered', 'the pending exposes its producing run\'s disposition')
  const row = await waitRow(root, (r) => r.detail?.sessionId === 's-ok', 'delivered')
  assert.equal(row.detail.outcome, 'delivered')
  assert.equal(row.detail.reason, 'rerank-picks')
  assert.ok(typeof row.detail.ms === 'number' && row.detail.ms >= 0)
  assert.equal(lane.lastOutcomeOf('s-ok'), 'delivered')
})

test('slow outcome: turn-lag expiry → expired (A4 决议 3 pending 过期)', async (t) => {
  const { root, service, cleanup } = tmpService({ qualityLane: 'always' })
  t.after(cleanup)
  await service.store.ensure()
  await service.saveTopic({ title: 'Echo Marker QX7QZ', conclusion: 'exists.' })
  const lane = new SlowLane(service, fakeCaller())
  lane.dispatch('s-expired', { ring: [ringEntry('u', 'a')], turnId: 3 })
  await waitPending(lane, 's-expired')
  const expired = lane.consume('s-expired', 3 + TURN_LAG_LIMIT + 1)
  assert.ok(expired !== undefined && 'expired' in expired && expired.expired === 'turn-lag')
  const row = await waitRow(root, (r) => r.detail?.sessionId === 's-expired' && r.detail?.outcome === 'expired', 'expired')
  assert.equal(row.detail.outcome, 'expired')
  assert.equal(row.detail.reason, 'turn-lag')
  assert.equal(lane.lastOutcomeOf('s-expired'), 'expired')
})

test('slow outcome: a dispatch during an in-flight pipeline → no-run/in-flight, original run still completes', async (t) => {
  const { root, service, cleanup } = tmpService({ qualityLane: 'always' })
  t.after(cleanup)
  await service.store.ensure()
  await service.saveTopic({ title: 'Echo Marker QX7QZ', conclusion: 'exists.' })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const lane = new SlowLane(service, async (req) => {
    if (req.system.includes('检索查询构建器')) return gate.then(() => JSON.stringify({ needs: true, query: 'echo marker qx7qz', ignore: [] }))
    return JSON.stringify({ picks: [{ slug: 'echo-marker-qx7qz', why: '真相关' }] })
  })
  lane.dispatch('s-inflight', { ring: [ringEntry('u', 'a')], turnId: 3 })
  lane.dispatch('s-inflight', { ring: [ringEntry('u', 'a')], turnId: 3 }) // second trigger overlaps
  const row = await waitRow(root, (r) => r.detail?.sessionId === 's-inflight' && r.detail?.reason === 'in-flight', 'no-run in-flight')
  assert.equal(row.detail.outcome, 'no-run')
  assert.equal(row.detail.reason, 'in-flight')
  release()
  await waitPending(lane, 's-inflight')
  assert.equal(lane.lastOutcomeOf('s-inflight'), 'delivered', 'the original run overwrites the slot when it settles')
})

test('slow outcome: clear() drops the session outcome slot (teardown boundary)', async (t) => {
  const { root, service, cleanup } = tmpService() // lane off → dispatch lands no-run/lane-off
  t.after(cleanup)
  const lane = new SlowLane(service, fakeCaller())
  lane.dispatch('s-clear', { ring: [ringEntry('u', 'a')], turnId: 1 })
  await waitRow(root, (r) => r.detail?.sessionId === 's-clear', 'no-run lane-off')
  assert.equal(lane.lastOutcomeOf('s-clear'), 'no-run')
  lane.clear('s-clear')
  assert.equal(lane.lastOutcomeOf('s-clear'), undefined)
})
