import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordPipelineEvent, pipelineEventsFile, PIPELINE_EVENTS_FILE } from '../lib/pipeline-events.js'

const COMPACT_LIMIT = 512 * 1024 // the jev/log-transplanted cap, pinned here

function tmpBundle() {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-events-'))
  return { root, file: join(root, 'meta', PIPELINE_EVENTS_FILE), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function readRows(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
}

async function waitFile(file, what = 'ledger file') {
  for (let i = 0; ; i += 1) {
    try {
      return readRows(file)
    } catch (e) {
      if (e.code !== 'ENOENT' || i > 150) throw new Error(`timed out: ${what}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }
}

test('pipeline-events: file placement + one line JSON per event (at/kind/detail)', async () => {
  const { root, file, cleanup } = tmpBundle()
  try {
    assert.equal(PIPELINE_EVENTS_FILE, 'pipeline-events.jsonl')
    assert.equal(pipelineEventsFile(root), join(root, 'meta', 'pipeline-events.jsonl'))
    await recordPipelineEvent(root, {
      at: '2026-10-10T00:00:00.000Z',
      kind: 'slow-lane-outcome',
      detail: { outcome: 'delivered', reason: 'rerank-picks', ms: 123 },
    })
    const rows = await waitFile(file)
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0], {
      at: '2026-10-10T00:00:00.000Z',
      kind: 'slow-lane-outcome',
      detail: { outcome: 'delivered', reason: 'rerank-picks', ms: 123 },
    })
  } finally {
    await new Promise((r) => setTimeout(r, 30))
    cleanup()
  }
})

test('pipeline-events: whitelist copy — extra top-level fields and non-scalar detail values never land', async () => {
  const { root, file, cleanup } = tmpBundle()
  try {
    await recordPipelineEvent(root, {
      at: '2026-10-10T00:00:00.000Z',
      kind: 'link-ref-rejected',
      // @ts-expect-error — JS test: smuggle extra top-level fields
      secret: 'must not pass',
      state: 'conversation text must not pass',
      detail: {
        ref: 'slug:ok',
        n: 1.5,
        b: false,
        obj: { nested: 'no' },
        arr: [1, 2],
        nul: null,
        nan: NaN,
        inf: Infinity,
        empty: '',
        long: 'x'.repeat(999),
      },
    })
    const rows = await waitFile(file)
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.deepEqual(
      Object.keys(row).sort(),
      ['at', 'detail', 'kind'],
      'extra top-level fields are dropped by the whitelist',
    )
    assert.deepEqual(row.detail, {
      ref: 'slug:ok',
      n: 1.5,
      b: false,
      long: 'x'.repeat(256), // bounded copy: capped, never unbounded
    })
  } finally {
    await new Promise((r) => setTimeout(r, 30))
    cleanup()
  }
})

test('pipeline-events: empty/absent detail omitted; missing at defaults to now; bad kind/at tolerated silently', async () => {
  const { root, file, cleanup } = tmpBundle()
  try {
    await recordPipelineEvent(root, { at: '', kind: 'distill-op-invalid', detail: {} })
    await recordPipelineEvent(root, { at: '2026-10-10T00:00:00.000Z', kind: 'distill-op-retry-exhausted' })
    const rows = await waitFile(file)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].kind, 'distill-op-invalid')
    assert.ok(typeof rows[0].at === 'string' && rows[0].at.length > 0, 'empty at falls back to now')
    assert.equal(rows[0].detail, undefined, 'empty detail omitted')
    assert.equal(rows[1].detail, undefined, 'absent detail omitted')
    // Invalid events never throw and never write.
    await recordPipelineEvent(root, { at: 'x', kind: '' })
    await recordPipelineEvent(root, null)
    await recordPipelineEvent(root, { at: 'x', kind: 'unknown-kind' }) // outside the closed enum
    const again = readRows(file)
    assert.equal(again.length, 2, 'bad-kind / unknown-kind / non-object events are dropped')
  } finally {
    await new Promise((r) => setTimeout(r, 30))
    cleanup()
  }
})

test('pipeline-events: 512KB compaction keeps the most recent quarter', async () => {
  const { root, file, cleanup } = tmpBundle()
  try {
    // Rows near the whitelist ceiling: 16 detail entries × 256-char values
    // ≈ 4.4KB/row, so the 512KB cap is crossed inside the run.
    const pads = Object.fromEntries(Array.from({ length: 15 }, (_, k) => [`pad${k}`, 'p'.repeat(256)]))
    const total = 500
    const writes = []
    for (let i = 0; i < total; i += 1) {
      writes.push(
        recordPipelineEvent(root, {
          at: `2026-10-10T00:00:${String(Math.floor(i / 60)).padStart(2, '0')}.${String(i % 60).padStart(2, '0')}Z`,
          kind: 'slow-lane-outcome',
          detail: { i, ...pads },
        }),
      )
    }
    await Promise.all(writes)
    const raw = readFileSync(file, 'utf8')
    assert.ok(raw.length <= COMPACT_LIMIT, `compacted under the cap (got ${raw.length})`)
    const rows = readRows(file)
    assert.ok(rows.length < total, `compaction actually dropped old lines (got ${rows.length})`)
    assert.ok(rows.length >= 1)
    assert.equal(rows[rows.length - 1].detail.i, total - 1, 'the most recent event survives')
    for (const r of rows) assert.equal(r.kind, 'slow-lane-outcome')
  } finally {
    await new Promise((r) => setTimeout(r, 30))
    cleanup()
  }
}, 60_000)

test('pipeline-events: write failure stays silent (bundleDir is a file, empty dir)', async () => {
  const outer = mkdtempSync(join(tmpdir(), 'pipeline-events-bad-'))
  try {
    const notADir = join(outer, 'not-a-dir')
    writeFileSync(notADir, 'plain file', 'utf8')
    // meta/ under a REGULAR file → ENOTDIR — swallowed, promise resolves.
    await recordPipelineEvent(notADir, { at: '2026-10-10T00:00:00.000Z', kind: 'link-ref-rejected', detail: { ref: 'slug:x' } })
    // Empty bundleDir → guard bails silently.
    await recordPipelineEvent('', { at: '2026-10-10T00:00:00.000Z', kind: 'link-ref-rejected' })
    assert.equal(readFileSync(notADir, 'utf8'), 'plain file', 'the file is untouched')
  } finally {
    await new Promise((r) => setTimeout(r, 30))
    rmSync(outer, { recursive: true, force: true })
  }
})

test('pipeline-events: concurrent appends all land line-atomic', async () => {
  const { root, file, cleanup } = tmpBundle()
  try {
    const total = 200
    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        recordPipelineEvent(root, {
          at: '2026-10-10T00:00:00.000Z',
          kind: 'slow-lane-outcome',
          detail: { i, outcome: 'no-run', reason: 'cadence' },
        }),
      ),
    )
    const rows = readRows(file) // JSON.parse per line — a torn line would throw here
    assert.equal(rows.length, total, 'no event lost, no line torn')
    assert.deepEqual(
      rows.map((r) => r.detail.i).sort((a, b) => a - b),
      Array.from({ length: total }, (_, i) => i),
    )
  } finally {
    await new Promise((r) => setTimeout(r, 30))
    cleanup()
  }
})
