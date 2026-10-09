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

// ---- open-source attribution + injection-vs-open panel (v5) ----
import { attributeOpen, aggregateOpenPanel, aggregateZeroOpen, renderedPointers, OPEN_ATTRIBUTION_WINDOW_MS, ZERO_OPEN_WINDOW_DAYS } from '../lib/ilog.js'

const ATTR_NOW = Date.parse('2026-10-08T12:00:00Z')
const h = (n) => 3_600_000 * n

function arec(over = {}) {
  return { at: new Date(ATTR_NOW - 3_600_000).toISOString(), sessionId: 's1', queryTokenCount: 3, rosterSize: 5, hits: [], nearMisses: [], injected: true, ...over }
}

test('attributeOpen: pointer branch — same session, in window, raw hits (deduped still counts)', () => {
  const records = [
    arec({ at: new Date(ATTR_NOW - 2 * h(1)).toISOString(), hits: [{ slug: 'alpha', score: 0.4, reasons: [], viaGraph: false }] }),
    arec({ hits: [{ slug: 'alpha', score: 0.42, reasons: [], viaGraph: false }], deduped: ['alpha'] }),
  ]
  // Newest matching record wins; a deduped hit still attributes pointer.
  const r = attributeOpen(records, 'alpha', 's1', ATTR_NOW)
  assert.equal(r.source, 'pointer')
  assert.equal(r.score, 0.42)
  assert.equal(r.sinceInjectionMs, 3_600_000)
})

test('attributeOpen: search branch — slug never injected for this session', () => {
  const records = [arec({ hits: [{ slug: 'beta', score: 0.9, reasons: [], viaGraph: false }] })]
  const r = attributeOpen(records, 'alpha', 's1', ATTR_NOW)
  assert.equal(r.source, 'search')
  assert.equal('score' in r, false)
  assert.equal('sinceInjectionMs' in r, false)
  // Other session's injection never attributes either.
  assert.equal(attributeOpen(records, 'beta', 's2', ATTR_NOW).source, 'search')
  // No session id → nothing to correlate against.
  assert.equal(attributeOpen(records, 'beta', undefined, ATTR_NOW).source, 'search')
})

test('attributeOpen: 48h window boundary — inclusive edge, expired falls back to search', () => {
  const edge = [arec({ at: new Date(ATTR_NOW - OPEN_ATTRIBUTION_WINDOW_MS).toISOString(), hits: [{ slug: 'alpha', score: 0.5, reasons: [], viaGraph: false }] })]
  assert.equal(attributeOpen(edge, 'alpha', 's1', ATTR_NOW).source, 'pointer', 'exactly 48h is still attributable')
  const expired = [arec({ at: new Date(ATTR_NOW - OPEN_ATTRIBUTION_WINDOW_MS - 1).toISOString(), hits: [{ slug: 'alpha', score: 0.5, reasons: [], viaGraph: false }] })]
  assert.equal(attributeOpen(expired, 'alpha', 's1', ATTR_NOW).source, 'search', 'past 48h expires')
  // Unparsable stamps never attribute (torn/garbage tail lines).
  const garbage = [arec({ at: 't', hits: [{ slug: 'alpha', score: 1, reasons: [], viaGraph: false }] })]
  assert.equal(attributeOpen(garbage, 'alpha', 's1', ATTR_NOW).source, 'search')
})

function orec(at, slug, extra = {}) {
  return { slug, at, ...extra }
}

test('aggregateOpenPanel: denominator excludes dropped/deduped/echoed, counts slow, dedups fast+slow pairs', () => {
  const injections = [
    arec({ at: '2026-10-08T10:00:00Z', sessionId: undefined, hits: [
      { slug: 'alpha', score: 0.4, reasons: [], viaGraph: false },
      { slug: 'dropped-one', score: 0.45, reasons: [], viaGraph: false },
      { slug: 'deduped-one', score: 0.5, reasons: [], viaGraph: false },
      { slug: 'echoed-one', score: 0.6, reasons: [], viaGraph: false },
    ], dropped: [{ slug: 'dropped-one', reason: 'budget' }], deduped: ['deduped-one'], echoed: ['echoed-one'], slow: [{ slug: 'alpha', why: 'w' }] }),
    arec({ at: '2026-10-08T10:01:00Z', sessionId: undefined, hits: [{ slug: 'gamma', score: 2.5, reasons: [], viaGraph: false }], slow: [{ slug: 'alpha', why: 'w' }] }),
  ]
  const panel = aggregateOpenPanel(injections, [])
  // Round 1: alpha (hit AND slow — one pointer), dropped/deduped/echoed excluded.
  // Round 2: gamma + alpha-slow. Entries = 1 + 2 = 3; alpha counted per round.
  assert.equal(panel.pointerEntries, 3)
  const bySlug = new Map(panel.topics.map((t) => [t.slug, t]))
  assert.equal(bySlug.get('alpha').injections, 2)
  assert.equal(bySlug.get('gamma').injections, 1)
  assert.equal(bySlug.has('dropped-one'), false)
  assert.equal(bySlug.has('deduped-one'), false)
  assert.equal(bySlug.has('echoed-one'), false)
})

test('aggregateOpenPanel: numerator window-aligned to the earliest round in the window', () => {
  const injections = [arec({ at: '2026-10-08T10:00:00Z' }), arec({ at: '2026-10-08T11:00:00Z' })]
  const opens = [
    orec('2026-10-07T10:00:00Z', 'alpha'),  // a day before the window → excluded
    orec('2026-10-08T09:59:59.999Z', 'alpha'), // 1ms before → excluded
    orec('2026-10-08T10:00:00Z', 'alpha'),  // exactly the window edge → included
    orec('2026-10-08T12:00:00Z', 'alpha'),  // inside → included
    orec('t', 'alpha'),                     // unparsable — cannot prove outside → included
  ]
  const panel = aggregateOpenPanel(injections, opens)
  assert.equal(panel.pointerEntries, 0)
  assert.equal(panel.opensInWindow, 3)
  assert.equal(panel.openRate, 0)
  // Wide-scope slug attribution keeps all five for the per-topic row.
  assert.equal(panel.topics.length, 0, 'no rendered pointers → no per-topic rows')
})

test('aggregateOpenPanel: per-topic rows, zero-open list capped at 10 with total', () => {
  // 12 topics injected 5..16 times, none ever opened.
  const injections = []
  for (let i = 0; i < 12; i += 1) {
    for (let k = 0; k < 5 + i; k += 1) {
      injections.push(arec({ at: new Date(ATTR_NOW - h(1) - k * 1000).toISOString(), sessionId: undefined, hits: [{ slug: `t${String(i).padStart(2, '0')}`, score: 0.4, reasons: [], viaGraph: false }] }))
    }
  }
  // A frequently injected topic WITH an open must not appear in zero-open.
  for (let k = 0; k < 20; k += 1) {
    injections.push(arec({ at: new Date(ATTR_NOW - k * 1000).toISOString(), sessionId: undefined, hits: [{ slug: 'opened-lot', score: 0.4, reasons: [], viaGraph: false }] }))
  }
  const panel = aggregateOpenPanel(injections, [orec(new Date(ATTR_NOW).toISOString(), 'opened-lot')])
  assert.equal(panel.zeroOpen.length, 10)
  assert.equal(panel.zeroOpenTotal, 12)
  // Top of both lists is the most-injected zero-open topic (t11, 16 injections).
  assert.equal(panel.zeroOpen[0].slug, 't11')
  assert.equal(panel.zeroOpen[0].injections, 16)
  // Per-topic table caps at 10 rows, sorted by injections desc.
  assert.equal(panel.topics.length, 10)
  assert.equal(panel.topics[0].slug, 'opened-lot')
  assert.equal(panel.topics[0].injections, 20)
  assert.equal(panel.topics[0].opens, 1)
})

test('aggregateOpenPanel: source split + score bands', () => {
  const injections = [
    arec({ at: '2026-10-08T10:00:00Z', sessionId: undefined, hits: [
      { slug: 'a', score: 0.3, reasons: [], viaGraph: false },   // band 0 lower edge
      { slug: 'b', score: 0.5, reasons: [], viaGraph: false },   // band 1 lower edge
      { slug: 'c', score: 0.99, reasons: [], viaGraph: false },  // band 1 upper edge
      { slug: 'd', score: 1.0, reasons: [], viaGraph: false },   // band 2 lower edge
      { slug: 'e', score: 4.99, reasons: [], viaGraph: false },  // band 3 upper edge
      { slug: 'f', score: 5, reasons: [], viaGraph: false },     // band 4 lower edge
      { slug: 'g', score: 7, reasons: [], viaGraph: false },     // band 4
      { slug: 'h', score: 0.25, reasons: [], viaGraph: false },  // below every band (still a pointer)
    ] }),
  ]
  const opens = [
    orec('2026-10-08T11:00:00Z', 'a', { source: 'pointer', score: 0.3 }),
    orec('2026-10-08T11:01:00Z', 'a', { source: 'pointer', score: 0.3 }),
    orec('2026-10-08T11:02:00Z', 'b', { source: 'search' }),
    orec('2026-10-08T11:03:00Z', 'c'), // legacy: no source field
  ]
  const panel = aggregateOpenPanel(injections, opens)
  assert.equal(panel.pointerEntries, 8)
  assert.equal(panel.hasSourceData, true)
  assert.equal(panel.pointerOpens, 2)
  assert.equal(panel.searchOpens, 1)
  const byLabel = new Map(panel.bands.map((b) => [b.label, b]))
  assert.deepEqual(panel.bands.map((b) => b.label), ['[0.3,0.5)', '[0.5,1)', '[1,2)', '[2,5)', '[5,∞)'])
  assert.deepEqual(byLabel.get('[0.3,0.5)'), { label: '[0.3,0.5)', pointers: 1, opens: 2, openRate: 1 }, 'search/legacy opens do not enter band numerators; rate capped at 1')
  assert.deepEqual(byLabel.get('[0.5,1)'), { label: '[0.5,1)', pointers: 2, opens: 0, openRate: 0 })
  assert.deepEqual(byLabel.get('[1,2)'), { label: '[1,2)', pointers: 1, opens: 0, openRate: 0 })
  assert.deepEqual(byLabel.get('[2,5)'), { label: '[2,5)', pointers: 1, opens: 0, openRate: 0 })
  assert.deepEqual(byLabel.get('[5,∞)'), { label: '[5,∞)', pointers: 2, opens: 0, openRate: 0 })
})

test('aggregateOpenPanel: legacy opens only — placeholder signal, no crash', () => {
  const injections = [arec({ at: '2026-10-08T10:00:00Z', sessionId: undefined, hits: [{ slug: 'a', score: 1.2, reasons: [], viaGraph: false }] })]
  const opens = [orec('2026-10-08T10:05:00Z', 'a')]
  const panel = aggregateOpenPanel(injections, opens)
  assert.equal(panel.hasSourceData, false)
  assert.equal(panel.pointerOpens, 0)
  assert.equal(panel.searchOpens, 0)
  assert.equal(panel.opensInWindow, 1)
  assert.equal(panel.openRate, 1)
})

// ---- renderedPointers / aggregateZeroOpen (v5 shared zero-open rule) ----

const DAY_MS = 86_400_000

function zorec(slug, atMs, over = {}) {
  return arec({ at: new Date(atMs).toISOString(), sessionId: undefined, hits: [{ slug, score: 0.4, reasons: [], viaGraph: false }], ...over })
}

test('renderedPointers: exclusions out, fast+slow pair once, slow carries no score', () => {
  const r = arec({
    sessionId: undefined,
    hits: [
      { slug: 'a', score: 0.4, reasons: [], viaGraph: false },
      { slug: 'b', score: 0.5, reasons: [], viaGraph: false },
      { slug: 'c', score: 0.6, reasons: [], viaGraph: false },
    ],
    deduped: ['b'],
    dropped: [{ slug: 'c', reason: 'budget' }],
    slow: [{ slug: 'a', why: 'w' }, { slug: 'd', why: 'w' }],
  })
  assert.deepEqual(renderedPointers(r), [{ slug: 'a', score: 0.4 }, { slug: 'd' }])
})

test('aggregateZeroOpen: ≥5 windowed rendered injections with zero opens qualify', () => {
  const five = []
  for (let k = 0; k < 5; k += 1) five.push(zorec('hot', ATTR_NOW - k * 60_000))
  assert.equal(aggregateZeroOpen(five, [], ATTR_NOW).get('hot'), 5)
  // 4 rounds → below the threshold.
  assert.equal(aggregateZeroOpen(five.slice(1), [], ATTR_NOW).has('hot'), false)
  // Excluded rounds never count: 3 rendered + 2 deduped → 3.
  const dedupedRound = zorec('hot', ATTR_NOW - 10 * 60_000, { deduped: ['hot'] })
  assert.equal(aggregateZeroOpen([...five.slice(2), dedupedRound, { ...dedupedRound }], [], ATTR_NOW).has('hot'), false)
  // One open ever (wide scope, even far outside the window) disqualifies.
  const openedLongAgo = orec(new Date(ATTR_NOW - 40 * DAY_MS).toISOString(), 'hot')
  assert.equal(aggregateZeroOpen(five, [openedLongAgo], ATTR_NOW).has('hot'), false)
})

test('aggregateZeroOpen: only injections inside the rolling 30-day window count', () => {
  // 4 recent + 2 stale rounds = 6 whole-window, 4 windowed → not qualified.
  const recent = [0, 1, 2, 3].map((k) => zorec('stale', ATTR_NOW - k * 60_000))
  const old = [0, 1].map((k) => zorec('stale', ATTR_NOW - (ZERO_OPEN_WINDOW_DAYS + 1 + k) * DAY_MS))
  assert.equal(aggregateZeroOpen([...recent, ...old], [], ATTR_NOW).has('stale'), false)
  // 5 windowed (4 recent + 1 exactly at the cutoff edge) → qualified with 5.
  const edge = zorec('stale', ATTR_NOW - ZERO_OPEN_WINDOW_DAYS * DAY_MS)
  const justBefore = zorec('stale', ATTR_NOW - ZERO_OPEN_WINDOW_DAYS * DAY_MS - 1)
  const withEdge = aggregateZeroOpen([...recent, edge, justBefore, ...old], [], ATTR_NOW)
  assert.equal(withEdge.get('stale'), 5, 'cutoff edge is inclusive, 1ms older is not')
  // Unparsable stamps cannot prove window membership → skipped.
  const garbage = arec({ at: 't', sessionId: undefined, hits: [{ slug: 'hot', score: 0.4, reasons: [], viaGraph: false }] })
  assert.equal(aggregateZeroOpen([garbage], [], ATTR_NOW).size, 0)
})

test('aggregateOpenPanel: zero-open list is window-scoped, per-topic table stays whole-window', () => {
  // 'stale-hot': 6 rendered rounds total, but only 4 inside the 30-day
  // window anchored at the newest round → off the zero-open list; its
  // per-topic row keeps the whole-window count of 6.
  const staleRecent = [0, 1, 2, 3].map((k) => zorec('stale-hot', ATTR_NOW - 2 * h(1) - k * 60_000))
  const staleOld = [0, 1].map((k) => zorec('stale-hot', ATTR_NOW - (ZERO_OPEN_WINDOW_DAYS + 2 + k) * DAY_MS))
  const fresh = [0, 1, 2, 3, 4].map((k) => zorec('fresh-hot', ATTR_NOW - k * 60_000))
  const panel = aggregateOpenPanel([...staleRecent, ...staleOld, ...fresh], [])
  assert.deepEqual(panel.zeroOpen.map((z) => z.slug), ['fresh-hot'])
  assert.equal(panel.zeroOpen[0].injections, 5)
  assert.equal(panel.zeroOpenTotal, 1)
  const stale = panel.topics.find((t) => t.slug === 'stale-hot')
  assert.equal(stale.injections, 6, 'per-topic row counts the whole fed window')
  assert.equal(stale.opens, 0)
})
