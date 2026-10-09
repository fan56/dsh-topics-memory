import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { TopicsService } from '../lib/service.js'
import { TopicsConfig, CONFIG_KEYS, displayKey, parseConfigValue } from '../lib/config.js'
import { ZERO_OPEN_WINDOW_DAYS } from '../lib/ilog.js'

// ---------------------------------------------------------------------------
// Zero-open decay (v5): config-gated, default off. End-to-end through the
// real service — the zero-open set is built from injections.jsonl (rendered
// pointers in the rolling 30-day window) and opens.jsonl (wide scope), the
// decay halves the hit score before the threshold cut, and the tag rides
// the hit/near-miss reasons into the log.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000
const SLUG_A = 'zero-open-marker-zz9q' // strong title match → stays a hit at half score
const SLUG_B = 'wmatch-side-topic' // description-only match 0.4 → decays below 0.3 into nearMisses
const QUERY = 'zero open marker zz9q 蒸馏 适配器 超时 回滚'

const BASE_CFG = {
  repo: '', autoInject: true, injectDedup: true, topK: 4, perTopicBudget: 300, totalBudget: 1500,
  matchThreshold: 0.3, tagBoost: 0.15, injectMode: 'pointer', graphDepth: 0, recencyWindowDays: 0,
  autoObserve: false, observationMaxChars: 2000, distillEveryTurns: 5, distillOnSessionEnd: false,
  distillProvider: '', distillModel: '', pushDebounceSeconds: 45, usageBoost: 0,
}

function makeService(cfgOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'topics-zodecay-'))
  const store = new BundleStore(root, { gitDisabled: true })
  const cfg = { ...BASE_CFG, ...cfgOverrides }
  const service = new TopicsService(store, () => cfg)
  const cleanup = () => rmSync(root, { recursive: true, force: true })
  return { service, store, cfg, cleanup }
}

async function seedTopics(service) {
  await service.saveTopic({ title: 'Zero Open Marker ZZ9Q', conclusion: 'An unrelated English conclusion.' })
  await service.saveTopic({ title: 'Wmatch Side Topic', description: '蒸馏 适配器', conclusion: '别的领域' })
}

/** n rendered rounds mentioning BOTH slugs, stamped `ageMs` ago. */
async function seedRounds(store, n, ageMs = 0) {
  const hit = (slug, score) => ({ slug, score, reasons: [], viaGraph: false })
  for (let k = 0; k < n; k += 1) {
    await store.appendInjectionRecord({
      at: new Date(Date.now() - ageMs - k * 1000).toISOString(),
      queryTokenCount: 3,
      rosterSize: 2,
      hits: [hit(SLUG_A, 1.2), hit(SLUG_B, 0.4)],
      nearMisses: [],
      injected: true,
    })
  }
}

test('zero-open decay: default off keeps the existing scoring byte-for-byte', async () => {
  const { service, cleanup } = makeService() // no zeroOpenDecay key at all
  try {
    await service.store.ensure()
    await seedTopics(service)
    await seedRounds(service.store, 5)
    const r = service.retrieveSync(QUERY, 's1')
    const a = r.outcome.hits.find((h) => h.slug === SLUG_A)
    const b = r.outcome.hits.find((h) => h.slug === SLUG_B)
    assert.ok(a && b, 'both clear the threshold untouched')
    assert.ok(Math.abs(a.score - 1.333) < 0.01, `title match 3×(4/9), got ${a.score}`)
    assert.ok(Math.abs(b.score - 0.4) < 0.01, `description match 1.2×(3/9), got ${b.score}`)
    for (const h of r.outcome.hits) assert.equal(h.reasons.includes('zero-open-decay'), false)
    for (const m of r.outcome.nearMisses) assert.equal(m.reasons?.includes('zero-open-decay'), false)
  } finally {
    cleanup()
  }
})

test('zero-open decay: gate on halves hit scores, tags reasons, drops borderline to nearMisses', async () => {
  const { service, cleanup } = makeService({ zeroOpenDecay: true })
  try {
    await service.store.ensure()
    await seedTopics(service)
    await seedRounds(service.store, 5)
    // Async path (awaited record write) — proves the tag reaches injections.jsonl.
    const r = await service.retrieve(QUERY, 's1')
    const a = r.outcome.hits.find((h) => h.slug === SLUG_A)
    assert.ok(a, 'half of 1.333 = 0.667 still clears the threshold')
    assert.ok(Math.abs(a.score - 0.667) < 0.01, `got ${a.score}`)
    assert.ok(a.reasons.includes('zero-open-decay'))
    assert.equal(r.outcome.hits.some((h) => h.slug === SLUG_B), false, '0.4 halves to 0.2 → out of hits')
    const miss = r.outcome.nearMisses.find((m) => m.slug === SLUG_B)
    assert.ok(miss, 'borderline candidate lands in nearMisses')
    assert.ok(Math.abs(miss.score - 0.2) < 0.01, `got ${miss.score}`)
    assert.ok(miss.reasons.includes('zero-open-decay'), 'the log shows why it stopped injecting')
    const records = await service.store.readInjectionRecords()
    const last = records.at(-1)
    const logged = last.hits.find((h) => h.slug === SLUG_A)
    assert.ok(logged.reasons.includes('zero-open-decay'), 'tag persists into the injection record')
  } finally {
    cleanup()
  }
})

test('zero-open decay: one open ever disqualifies the slug (wide-scope opens)', async () => {
  const { service, cleanup } = makeService({ zeroOpenDecay: true })
  try {
    await service.store.ensure()
    await seedTopics(service)
    await seedRounds(service.store, 5)
    await service.store.appendOpenRecord({ slug: SLUG_B, at: new Date().toISOString(), source: 'search' })
    const r = service.retrieveSync(QUERY, 's1')
    const b = r.outcome.hits.find((h) => h.slug === SLUG_B)
    assert.ok(b, 'opened once → no decay → back over the threshold')
    assert.ok(Math.abs(b.score - 0.4) < 0.01, `got ${b.score}`)
    assert.equal(b.reasons.includes('zero-open-decay'), false)
    const a = r.outcome.hits.find((h) => h.slug === SLUG_A)
    assert.ok(a.reasons.includes('zero-open-decay'), 'never-opened slug still decays')
  } finally {
    cleanup()
  }
})

test('zero-open decay: under 5 windowed rounds never decays', async () => {
  const { service, cleanup } = makeService({ zeroOpenDecay: true })
  try {
    await service.store.ensure()
    await seedTopics(service)
    await seedRounds(service.store, 4)
    const r = service.retrieveSync(QUERY, 's1')
    const a = r.outcome.hits.find((h) => h.slug === SLUG_A)
    assert.ok(Math.abs(a.score - 1.333) < 0.01, `4 rounds < ZERO_OPEN_MIN_INJECTIONS, got ${a.score}`)
    assert.equal(a.reasons.includes('zero-open-decay'), false)
  } finally {
    cleanup()
  }
})

test('zero-open decay: rounds outside the rolling 30-day window do not count', async () => {
  const { service, cleanup } = makeService({ zeroOpenDecay: true })
  try {
    await service.store.ensure()
    await seedTopics(service)
    await seedRounds(service.store, 5, (ZERO_OPEN_WINDOW_DAYS + 1) * DAY_MS)
    const r = service.retrieveSync(QUERY, 's1')
    const a = r.outcome.hits.find((h) => h.slug === SLUG_A)
    assert.ok(Math.abs(a.score - 1.333) < 0.01, `5 stale rounds are invisible to the rule, got ${a.score}`)
    assert.equal(a.reasons.includes('zero-open-decay'), false)
  } finally {
    cleanup()
  }
})

test('config: zeroOpenDecay key — schema default off, hot-editable, set parse', () => {
  const read = (ref) => (typeof ref?.get === 'function' ? ref.get() : ref)
  assert.equal(read(TopicsConfig({}).zeroOpenDecay), false, 'default off = zero behavior change')
  assert.equal(read(TopicsConfig({ zeroOpenDecay: true }).zeroOpenDecay), true)
  assert.ok(CONFIG_KEYS.includes('zeroOpenDecay'))
  assert.equal(displayKey('zeroOpenDecay'), 'zero-open-decay')
  assert.equal(parseConfigValue('zeroOpenDecay', 'on'), true)
  assert.equal(parseConfigValue('zeroOpenDecay', 'off'), false)
  assert.deepEqual(parseConfigValue('zeroOpenDecay', 'maybe'), { error: 'zeroOpenDecay 取值 on|off' })
})
