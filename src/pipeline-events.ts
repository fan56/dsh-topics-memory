/**
 * meta/pipeline-events.jsonl — the pipeline-level anomaly ledger (spec §8.1,
 * A2/A6 BL-1 revised: the "记 wtf 账" mechanism never existed, this IS the
 * explicit ledger). One line JSON per event; always on, no config key
 * (恒开无键 — observability is not a gray-release feature).
 *
 * Discipline = decisions.jsonl (src/jev/log.ts) verbatim: field-whitelist
 * copy on write (extra caller fields cannot leak in, detail values must be
 * scalar), 512KB auto-compaction keeping the most recent quarter, and write
 * failures swallowed silently — a broken sink must never break the pipeline.
 * Unlike jev/log this writer takes the bundle root explicitly (callers like
 * the slow lane already hold it; tests point it at a tmp dir).
 *
 * @module pipeline-events
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { metaDir } from './paths.ts'

/** Closed vocabulary, spec §8.1 + W-C wave start set. `slow-lane-outcome` is
 *  the slow lane's per-run disposition row (quality.ts); the distill/link
 *  kinds are the A2/A6 producers' contract — they import this module. The
 *  two `seam-*` kinds are the B-line dual-write audit trail (卷二 §6.2:
 *  caller-identity audit — opts.actor — rides every seam call).
 *  `lesson-conflict-flagged` is the lesson distill branch's conflict
 *  self-check flag (B2 决议 5): informational for the B4 approval surface —
 *  the draft still lands as hint, no lifecycle state changes on this event. */
export type PipelineEventKind = 'slow-lane-outcome' | 'distill-op-invalid' | 'distill-op-retry-exhausted' | 'link-ref-rejected' | 'seam-observations-fed' | 'seam-lesson-status' | 'lesson-conflict-flagged'

/** File NAME inside the bundle's meta dir (path via pipelineEventsFile). */
export const PIPELINE_EVENTS_FILE = 'pipeline-events.jsonl'

export interface PipelineEvent {
  at: string
  kind: PipelineEventKind
  /** Bounded scalar metadata only — never conversation or conclusion text. */
  detail?: Record<string, string | number | boolean>
}

const COMPACT_LIMIT = 512 * 1024 // ~512KB cap, same as the decisions/ilog sidecars
/** Whitelist copy bounds: detail entries and their values stay metadata-sized. */
const DETAIL_MAX_ENTRIES = 16
const DETAIL_KEY_MAX_CHARS = 64
const DETAIL_VALUE_MAX_CHARS = 256

/** Runtime mirror of PipelineEventKind — the closed vocabulary is enforced
 *  at the write gate too (a JS caller cannot smuggle an unknown kind in). */
const KNOWN_KINDS: ReadonlySet<string> = new Set<string>([
  'slow-lane-outcome',
  'distill-op-invalid',
  'distill-op-retry-exhausted',
  'link-ref-rejected',
  'seam-observations-fed',
  'seam-lesson-status',
  'lesson-conflict-flagged',
])

export function pipelineEventsFile(bundleDir: string): string {
  return join(metaDir(bundleDir), PIPELINE_EVENTS_FILE)
}

// Serialized like jev/log: single-record appends are line-atomic anyway, but
// the compaction rewrite must not interleave with an append.
let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = queue.then(op, op)
  queue = run.catch(() => undefined)
  return run
}

/** All write failures die HERE — never upstream. */
async function appendJsonl(file: string, lines: readonly string[]): Promise<void> {
  await enqueue(async () => {
    try {
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, lines.map((l) => `${l}\n`).join(''), 'utf8')
      await compactIfNeeded(file)
    } catch {
      // fail-open: a broken ledger must never break the pipeline (§8.1)
    }
  })
}

// jev/log compactIfNeeded pattern: ~512KB cap; keep the most recent quarter
// when exceeded (headroom for the next window).
async function compactIfNeeded(file: string): Promise<void> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return
  }
  if (raw.length <= COMPACT_LIMIT) return
  const lines = raw.split('\n').filter((l) => l.trim() !== '')
  const keep = lines.slice(-Math.max(1, Math.floor(lines.length / 4)))
  const tmp = `${file}.tmp-${randomUUID()}`
  try {
    await writeFile(tmp, keep.map((l) => `${l}\n`).join(''), 'utf8')
    await rename(tmp, file)
  } catch {
    // swallow — the next append retries the compaction
  }
}

/**
 * Copy one event through the field whitelist onto the ledger. Only `at`,
 * `kind` and a scalar-valued `detail` map can pass; non-scalar detail values
 * (objects/arrays/null/NaN), surplus entries and over-long keys/values are
 * dropped here so no unbounded content can ride in. Write failures are
 * swallowed downstream — this never rejects and never throws.
 */
export async function recordPipelineEvent(bundleDir: string, event: PipelineEvent): Promise<void> {
  if (bundleDir === '' || typeof bundleDir !== 'string') return
  if (event === null || typeof event !== 'object') return
  if (typeof event.kind !== 'string' || !KNOWN_KINDS.has(event.kind)) return
  const detail: Record<string, string | number | boolean> = {}
  if (event.detail !== undefined && typeof event.detail === 'object') {
    for (const [key, value] of Object.entries(event.detail)) {
      if (Object.keys(detail).length >= DETAIL_MAX_ENTRIES) break
      const t = typeof value
      if (t === 'string') {
        if ((value as string) !== '') detail[key.slice(0, DETAIL_KEY_MAX_CHARS)] = (value as string).slice(0, DETAIL_VALUE_MAX_CHARS)
      } else if (t === 'number') {
        if (Number.isFinite(value)) detail[key.slice(0, DETAIL_KEY_MAX_CHARS)] = value
      } else if (t === 'boolean') {
        detail[key.slice(0, DETAIL_KEY_MAX_CHARS)] = value
      }
      // objects/arrays/null/undefined never pass the whitelist
    }
  }
  const at = typeof event.at === 'string' && event.at !== '' ? event.at : new Date().toISOString()
  const row =
    Object.keys(detail).length === 0
      ? { at, kind: event.kind }
      : { at, kind: event.kind, detail }
  await appendJsonl(pipelineEventsFile(bundleDir), [JSON.stringify(row)])
}
