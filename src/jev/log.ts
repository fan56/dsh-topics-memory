/**
 * decisions.jsonl — System One usage/optimization telemetry (design
 * 2026-09-25 §6), always on while jevEnabled is on. Lives beside the ilog at
 * `<bundle>/meta/decisions.jsonl` under the same discipline: 512KB
 * auto-compaction keeping the most recent quarter, line JSON, and write
 * failures swallowed silently — fail-open extends to the stats itself.
 *
 * REDACTION INVARIANT (§6.1): metadata and probabilities only — slug/pair
 * hash/question type/score/latency/token count. NEVER the state text or
 * conclusion bodies. Writers copy an explicit field whitelist, so extra
 * fields on caller objects cannot leak into the file.
 *
 * @module jev/log
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { metaDir, resolveBundleRoot } from '../paths.ts'
import type { JevBand } from './thresholds.ts'

export type JevLane = 'slowlane-rerank' | 'consolidate-prefilter' | 'fastgate-shadow'

export type JevOutcome =
  | 'ok'
  | 'timeout'
  | 'network'
  | 'http_4xx'
  | 'http_5xx'
  | 'bad_json'
  | 'secret_gate_blocked'
  | 'missing_key'
  /** Local pre-flight refusal (e.g. questions violate the decisions/openrouter
   *  wire contract) — nothing was sent. Reserved outcome beyond §6.2's v1 list. */
  | 'invalid_request'

export interface JevUsage {
  input_tokens: number
  output_tokens: number
}

/** Call layer (§6.2): one row per HTTP call, failures included — the
 *  fallback rate is the health metric, so failed calls must be counted. */
export interface JevCallRecord {
  at: string
  lane: JevLane
  backend: string
  model: string
  questionCount: number
  stateChars: number
  latencyMs: number
  usage: JevUsage | null
  outcome: JevOutcome
  fallback: boolean
}

/** Verdict layer (§6.2): one row per question, batch requests expanded.
 *  `agree` reconciles the fast-gate shadow against the lexical disposition
 *  (wouldBlock = lexical let it through but jev landed in the veto band —
 *  the other half of the calibration goldmine). */
export interface JevVerdictRecord {
  at: string
  lane: JevLane
  questionId: string
  qtype: 'noul' | 'choice' | 'score'
  /** Candidate reference without content: `slug:xxx` | `pair:hash3`. */
  ref: string
  /** §6.2 digest — stable key for the repeat-decision-rate analysis. */
  digest: string
  probability: number
  band: JevBand
  agree: 'hit' | 'nearFloor' | 'gate-blocked' | 'wouldBlock' | 'n/a'
}

const COMPACT_LIMIT = 512 * 1024 // ~512KB cap, same as the ilog sidecars

export function decisionsFile(root: string): string {
  return join(metaDir(root), 'decisions.jsonl')
}

function liveFile(): string {
  return decisionsFile(resolveBundleRoot())
}

/** digest(state, questionId, instructions): `h1:` + first 16 hex of
 *  sha256(state + NUL + questionId + NUL + instructions) — the key the
 *  repeat-decision-rate analysis joins on. */
export function digestFor(state: string, questionId: string, instructions: string): string {
  const h = createHash('sha256')
  h.update(state)
  h.update('\u0000')
  h.update(questionId)
  h.update('\u0000')
  h.update(instructions)
  return `h1:${h.digest('hex').slice(0, 16)}`
}

// Serialized like the store's write queue: single-record appends are
// line-atomic anyway, but the compaction rewrite must not interleave with
// an append.
let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = queue.then(op, op)
  queue = run.catch(() => undefined)
  return run
}

/** All write failures die HERE — never upstream. */
async function appendJsonl(lines: readonly string[]): Promise<void> {
  await enqueue(async () => {
    try {
      const file = liveFile()
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, lines.map((l) => `${l}\n`).join(''), 'utf8')
      await compactIfNeeded(file)
    } catch {
      // fail-open: a broken stats sink must never break the feature (§6.1)
    }
  })
}

// store.ts compactInjectionsIfNeeded pattern: ~512KB cap; keep the most
// recent quarter when exceeded (headroom for the next window).
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

/** Call-layer row. Field whitelist enforced here: anything extra on the
 *  caller's object is dropped, so no state/conclusion text can sneak in. */
export async function logCall(rec: JevCallRecord): Promise<void> {
  await appendJsonl([
    JSON.stringify({
      at: rec.at,
      lane: rec.lane,
      backend: rec.backend,
      model: rec.model,
      questionCount: rec.questionCount,
      stateChars: rec.stateChars,
      latencyMs: rec.latencyMs,
      usage:
        rec.usage === null
          ? null
          : { input_tokens: rec.usage.input_tokens, output_tokens: rec.usage.output_tokens },
      outcome: rec.outcome,
      fallback: rec.fallback,
    }),
  ])
}

/** Verdict-layer rows (batch expanded by the caller). */
export async function logVerdicts(recs: readonly JevVerdictRecord[]): Promise<void> {
  if (recs.length === 0) return
  await appendJsonl(
    recs.map((rec) =>
      JSON.stringify({
        at: rec.at,
        lane: rec.lane,
        questionId: rec.questionId,
        qtype: rec.qtype,
        ref: rec.ref,
        digest: rec.digest,
        probability: rec.probability,
        band: rec.band,
        agree: rec.agree,
      }),
    ),
  )
}
