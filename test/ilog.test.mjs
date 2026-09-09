import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateStats, querySample } from '../lib/ilog.js'

function rec(overrides = {}) {
  return {
    at: new Date().toISOString(),
    queryTokenCount: 5,
    rosterSize: 10,
    hits: [],
    nearMisses: [],
    injected: false,
    ...overrides,
  }
}

test('aggregateStats: empty history', () => {
  const s = aggregateStats([])
  assert.equal(s.rounds, 0)
  assert.equal(s.hitRate, 0)
})

test('aggregateStats: hit rate, zero-hit rounds, avg hits', () => {
  const records = [
    rec({ hits: [{ slug: 'a', score: 1, reasons: [], viaGraph: false }], injected: true, usedTokens: 300 }),
    rec({ hits: [{ slug: 'a', score: 0.9, reasons: [], viaGraph: false }, { slug: 'b', score: 0.5, reasons: [], viaGraph: true }], injected: true, usedTokens: 500 }),
    rec({}),
    rec({ hits: [{ slug: 'b', score: 0.4, reasons: [], viaGraph: false }], injected: true }),
  ]
  const s = aggregateStats(records)
  assert.equal(s.rounds, 4)
  assert.equal(s.injectedRounds, 3)
  assert.equal(s.hitRate, 0.75)
  assert.equal(s.zeroHitRounds, 1)
  assert.equal(s.avgHitsPerRound, 1)
  assert.equal(s.topTopics.find((t) => t.slug === 'a').count, 2)
  assert.equal(s.avgBudgetUtilization, 400)
})

test('aggregateStats: deduped hits stay out of topTopics, keep retrieval metrics', () => {
  const records = [
    rec({ hits: [{ slug: 'a', score: 1, reasons: [], viaGraph: false }], injected: true }),
    // All-hit dedup round: 'a' was NOT injected → must not count as a hit for topTopics…
    rec({ hits: [{ slug: 'a', score: 0.9, reasons: [], viaGraph: false }], injected: false, why: 'dedup', deduped: ['a'] }),
    // …nor in the mixed round, while non-deduped 'b' counts. Raw-hit metrics
    // (avgHitsPerRound, zeroHitRounds) keep describing retrieval, not injection.
    rec({ hits: [{ slug: 'a', score: 0.9, reasons: [], viaGraph: false }, { slug: 'b', score: 0.5, reasons: [], viaGraph: false }], injected: true, deduped: ['a'] }),
  ]
  const s = aggregateStats(records)
  // 'a' appears in all three rounds but only round 1 actually injected it —
  // without the dedup exclusion its count would be 3.
  assert.equal(s.topTopics.find((t) => t.slug === 'a').count, 1)
  assert.equal(s.topTopics.find((t) => t.slug === 'b').count, 1)
  assert.equal(s.avgHitsPerRound, 1.33)
})

test('aggregateStats: near-miss histogram ordered by bucket', () => {
  const records = [
    rec({ nearMisses: [{ slug: 'x', score: 0.22 }, { slug: 'y', score: 0.24 }] }),
    rec({ nearMisses: [{ slug: 'z', score: 0.12 }] }),
    rec({ nearMisses: [{ slug: 'w', score: 0.26 }] }),
  ]
  const s = aggregateStats(records)
  const buckets = s.nearMissHistogram.map((b) => b.bucket)
  assert.equal(buckets.length, 3)
  const nums = buckets.map((b) => Number(b.split('–')[0]))
  assert.deepEqual([...nums].sort((a, b) => a - b), nums)
  assert.equal(s.nearMissHistogram.find((b) => b.bucket.startsWith('0.20')).count, 2)
})

test('querySample: bounded and ellipsized', () => {
  assert.equal(querySample('短问题'), '短问题')
  const long = querySample('x'.repeat(100))
  assert.ok(long.length <= 41)
  assert.ok(long.endsWith('…'))
})

// ---- aggregateUsage (ADR 0015) ----
import { aggregateUsage, USAGE_WINDOW_DAYS } from '../lib/ilog.js'

const NOW = Date.parse('2026-09-09T12:00:00Z')
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString()

function urec(at, injected = true, hits = [], extra = {}) {
  return { at, injected, hits, queryTokenCount: 3, rosterSize: 5, ...extra }
}

test('aggregateUsage: vote weights, window, exclusions', () => {
  const injections = [
    // 5 days ago: alpha hit + slow pick beta → both 1 hit
    urec(daysAgo(5), true, [{ slug: 'alpha' }, { slug: 'gamma' }], { slow: [{ slug: 'beta', why: 'w' }] }),
    // 10 days ago: delta hit but round not injected → nothing
    urec(daysAgo(10), false, [{ slug: 'delta' }]),
    // 10 days ago: echo/dedup/dropped excluded
    urec(daysAgo(10), true, [{ slug: 'echoed-1' }, { slug: 'kept-1' }], {
      echoed: ['echoed-1'],
      deduped: ['deduped-1'],
      dropped: [{ slug: 'dropped-1', reason: 'budget' }],
    }),
    // 31 days ago: outside window
    urec(daysAgo(31), true, [{ slug: 'alpha' }]),
  ]
  const opens = [
    { slug: 'alpha', at: daysAgo(2) },   // open votes 3
    { slug: 'ghost', at: daysAgo(40) },  // outside window
  ]
  const usage = aggregateUsage(injections, opens, USAGE_WINDOW_DAYS, NOW)
  assert.deepEqual(usage.get('alpha'), { hits: 1, opens: 1 })
  assert.deepEqual(usage.get('beta'), { hits: 1, opens: 0 })
  assert.deepEqual(usage.get('gamma'), { hits: 1, opens: 0 })
  assert.equal(usage.get('delta'), undefined)
  assert.deepEqual(usage.get('kept-1'), { hits: 1, opens: 0 })
  assert.equal(usage.has('echoed-1'), false)
  assert.equal(usage.has('deduped-1'), false)
  assert.equal(usage.has('dropped-1'), false)
  assert.equal(usage.has('ghost'), false)
})
