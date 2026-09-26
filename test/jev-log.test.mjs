// decisions.jsonl telemetry tests — temp $DSH_TOPICS_HOME per test (the
// resolveBundleRoot env is read per append, never frozen at import), no
// network, no key material involved.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { logCall, logVerdicts, digestFor, decisionsFile } = await import('../lib/jev/log.js')
const { band, RERANK_ADOPT, RERANK_FALLBACK, MERGE_PAIR_ADOPT, MERGE_PAIR_FALLBACK } = await import('../lib/jev/thresholds.js')

function callRec(overrides = {}) {
  return {
    at: '2026-09-25T00:00:00.000Z',
    lane: 'slowlane-rerank',
    backend: 'zen',
    model: 'jev-1.13-free',
    questionCount: 6,
    stateChars: 1843,
    latencyMs: 448,
    usage: { input_tokens: 2417, output_tokens: 108 },
    outcome: 'ok',
    fallback: false,
    ...overrides,
  }
}

function verdictRec(overrides = {}) {
  return {
    at: '2026-09-25T00:00:00.000Z',
    lane: 'fastgate-shadow',
    questionId: 'c3',
    qtype: 'noul',
    ref: 'slug:my-topic',
    digest: digestFor('state', 'c3', 'instr'),
    probability: 0.62,
    band: 'record',
    agree: 'hit',
    ...overrides,
  }
}

function readRows(root) {
  const raw = readFileSync(decisionsFile(root), 'utf8')
  return raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
}

/** Point $DSH_TOPICS_HOME at a fresh temp bundle; restore in finally. */
function withTempHome() {
  const prev = process.env.DSH_TOPICS_HOME
  const root = mkdtempSync(join(tmpdir(), 'topics-jev-log-'))
  process.env.DSH_TOPICS_HOME = root
  return {
    root,
    done() {
      rmSync(root, { recursive: true, force: true })
      if (prev === undefined) delete process.env.DSH_TOPICS_HOME
      else process.env.DSH_TOPICS_HOME = prev
    },
  }
}

test('log: call row lands at <bundle>/meta/decisions.jsonl with the exact §6.2 field whitelist', async () => {
  const t = withTempHome()
  try {
    await logCall(callRec())
    const rows = readRows(t.root)
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.deepEqual(
      Object.keys(row).sort(),
      ['at', 'backend', 'fallback', 'lane', 'latencyMs', 'model', 'outcome', 'questionCount', 'stateChars', 'usage'],
    )
    assert.equal(row.lane, 'slowlane-rerank')
    assert.deepEqual(row.usage, { input_tokens: 2417, output_tokens: 108 })
    assert.equal(row.fallback, false)
  } finally {
    t.done()
  }
})

test('log: extra fields on caller objects are dropped (redaction whitelist — no state text can leak)', async () => {
  const t = withTempHome()
  try {
    const leaky = { ...callRec(), stateText: 'SHOULD-NOT-LEAK', conclusion: 'SHOULD-NOT-LEAK-EITHER' }
    await logCall(leaky)
    const raw = readFileSync(decisionsFile(t.root), 'utf8')
    assert.ok(!raw.includes('SHOULD-NOT-LEAK'))
    const leakyVerdict = { ...verdictRec(), stateText: 'LEAK-ME-NOT' }
    await logVerdicts([leakyVerdict])
    const raw2 = readFileSync(decisionsFile(t.root), 'utf8')
    assert.ok(!raw2.includes('LEAK-ME-NOT'))
  } finally {
    t.done()
  }
})

test('log: verdict rows carry the §6.2 verdict-layer fields; empty batch writes nothing', async () => {
  const t = withTempHome()
  try {
    await logVerdicts([])
    assert.equal(existsSync(decisionsFile(t.root)), false, 'empty batch must not create the file')
  } finally {
    t.done()
  }

  const t2 = withTempHome()
  try {
    await logVerdicts([
      verdictRec(),
      verdictRec({ questionId: 'c4', probability: 0.05, band: 'fallback', agree: 'wouldBlock', ref: 'pair:a1b' }),
    ])
    const rows = readRows(t2.root)
    assert.equal(rows.length, 2)
    assert.deepEqual(
      Object.keys(rows[0]).sort(),
      ['agree', 'at', 'band', 'digest', 'lane', 'probability', 'qtype', 'questionId', 'ref'],
    )
    assert.equal(rows[1].agree, 'wouldBlock')
    assert.equal(rows[1].ref, 'pair:a1b')
  } finally {
    t2.done()
  }
})

test('log: digest is h1: + 16 hex, stable, and differs per state/question/instructions', () => {
  const d = digestFor('state text', 'c1', 'instructions')
  assert.match(d, /^h1:[0-9a-f]{16}$/)
  assert.equal(d, digestFor('state text', 'c1', 'instructions'))
  assert.notEqual(d, digestFor('other state', 'c1', 'instructions'))
  assert.notEqual(d, digestFor('state text', 'c2', 'instructions'))
  assert.notEqual(d, digestFor('state text', 'c1', 'other instructions'))
})

test('log: thresholds match design §5 and band() respects the boundaries', () => {
  assert.equal(RERANK_ADOPT, 0.6)
  assert.equal(RERANK_FALLBACK, 0.1)
  assert.equal(MERGE_PAIR_ADOPT, 0.5)
  assert.equal(MERGE_PAIR_FALLBACK, 0.15)

  assert.equal(band(0.6, 'rerank'), 'adopt')
  assert.equal(band(0.599, 'rerank'), 'record')
  assert.equal(band(0.1, 'rerank'), 'record')
  assert.equal(band(0.099, 'rerank'), 'fallback')
  assert.equal(band(0.95, 'rerank'), 'adopt')

  assert.equal(band(0.5, 'mergePair'), 'adopt')
  assert.equal(band(0.499, 'mergePair'), 'record')
  assert.equal(band(0.15, 'mergePair'), 'record')
  assert.equal(band(0.149, 'mergePair'), 'fallback')
})

test('log: 512KB rotation keeps the most recent quarter', async () => {
  const t = withTempHome()
  try {
    // pre-fill ~700 lines × ~1KB ≈ 700KB (> 512KB cap)
    const meta = join(t.root, 'meta')
    mkdirSync(meta, { recursive: true })
    const big = JSON.stringify({ pad: 'x'.repeat(1000), n: 0 })
    const lines = []
    for (let i = 0; i < 700; i++) lines.push(big.replace('"n":0', `"n":${i}`))
    writeFileSync(decisionsFile(t.root), lines.map((l) => `${l}\n`).join(''), 'utf8')

    await logCall(callRec({ outcome: 'timeout', fallback: true }))
    const rows = readRows(t.root)
    assert.ok(rows.length < 200, `compacted to ~quarter, got ${rows.length}`)
    assert.ok(rows.length > 100, `recent quarter preserved, got ${rows.length}`)
    // the new record survived at the tail
    assert.equal(rows[rows.length - 1].outcome, 'timeout')
    assert.equal(rows[rows.length - 1].fallback, true)
  } finally {
    t.done()
  }
})

test('log: under the cap nothing is rewritten', async () => {
  const t = withTempHome()
  try {
    await logCall(callRec())
    const before = readFileSync(decisionsFile(t.root), 'utf8')
    await logVerdicts([verdictRec()])
    const after = readFileSync(decisionsFile(t.root), 'utf8')
    assert.ok(after.startsWith(before))
  } finally {
    t.done()
  }
})

test('log: write failures are swallowed — logCall never rejects (fail-open extends to stats)', async () => {
  const prev = process.env.DSH_TOPICS_HOME
  const dir = mkdtempSync(join(tmpdir(), 'topics-jev-log-'))
  try {
    // $DSH_TOPICS_HOME points at a regular FILE → mkdir under it fails
    const blocker = join(dir, 'not-a-directory')
    writeFileSync(blocker, 'I am a file', 'utf8')
    process.env.DSH_TOPICS_HOME = blocker
    await assert.doesNotReject(logCall(callRec()))
    await assert.doesNotReject(logVerdicts([verdictRec()]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
    if (prev === undefined) delete process.env.DSH_TOPICS_HOME
    else process.env.DSH_TOPICS_HOME = prev
  }
})
