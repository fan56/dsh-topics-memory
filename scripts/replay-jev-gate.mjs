#!/usr/bin/env node
/**
 * jev gate replay — decisions.jsonl × injections.jsonl 对拍器 (design
 * 2026-09-25 §6.3 分歧清单 / §8 shadow 对拍).
 *
 * READ-ONLY offline join: the lexical dispositions recorded per round in
 * `<bundle>/meta/injections.jsonl` (hits / nearMisses with slug+score, the
 * gate-blocked rejects lead the nearMisses with reason `gate-blocked`)
 * against the jev verdict layer in `<bundle>/meta/decisions.jsonl`
 * (lane=fastgate-shadow, ref=slug:xxx), joined on slug + time window
 * (default ±10min, closest record wins).
 *
 * Outputs the two disagreement lists that ARE the calibration goldmine
 * (§5 分歧证据条款 — R6 类「jev 可能对」不许静默丢):
 *   - wouldBlock          — the lexical gate let a slug through but jev fell
 *                           in its fallback band (words passed, meaning vetoed);
 *   - gate-blocked rescue — jev scored ≥ HIGH_LINE but the lexical gate had
 *                           blocked the slug (potential false kills worth
 *                           rescuing, t4 §5: the rrk-185/193/200 class);
 * plus the reconciliation rate, the disagreement rate, and the mean jev
 * probability grouped by lexical disposition.
 *
 * Pure read-only: two readFiles, ZERO writes. --json prints machine-readable
 * output only.
 *
 * Usage:
 *   node scripts/replay-jev-gate.mjs [--bundle <path>] [--window <minutes>] [--json]
 * Default bundle: $DSH_TOPICS_HOME, else ~/.dsh/topics (paths.ts semantics,
 * minus the legacy migration — a replay never mutates anything).
 *
 * @module replay-jev-gate
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Rerank-band lines (src/jev/thresholds.ts) — inlined to keep this replay
// standalone zero-dep; if the source numbers move, mirror them here.
const RERANK_ADOPT = 0.6
const RERANK_FALLBACK = 0.1
/** 「jev 高分」for the gate-blocked rescue list — the sweep's F1-optimal 0.5
 *  line (t4 §5: the mid-band rescues live at 0.53–0.71, above the 0.6
 *  conservative line several would vanish). */
const HIGH_LINE = 0.5
const DEFAULT_WINDOW_MIN = 10

const round3 = (x) => Math.round(x * 1000) / 1000

/** Parse a jsonl file, tolerating a torn tail (same as the plugin reader). */
export async function loadJsonl(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null // missing file → caller decides
  }
  const out = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // torn tail tolerated
    }
  }
  return out
}

/**
 * Lexical disposition of every slug mentioned in one injection record:
 * hits → 'hit'; nearMisses → 'gate-blocked' when their reasons carry the
 * gate-blocked marker, else 'nearFloor'. Scores kept for the对照表.
 */
export function recordDispositions(record) {
  const bySlug = new Map()
  for (const hit of record.hits ?? []) {
    bySlug.set(hit.slug, { disposition: 'hit', score: hit.score })
  }
  for (const nm of record.nearMisses ?? []) {
    if (bySlug.has(nm.slug)) continue // a hit outranks any near-miss mention
    const blocked = (nm.reasons ?? []).includes('gate-blocked')
    bySlug.set(nm.slug, { disposition: blocked ? 'gate-blocked' : 'nearFloor', score: nm.score })
  }
  return bySlug
}

/** The jev verdict rows joinable against the ilog: lane=fastgate-shadow with
 *  a slug ref (pair/digest or other refs are out of scope for this join). */
export function shadowVerdicts(decisionRows) {
  const out = []
  for (const row of decisionRows ?? []) {
    if (row?.lane !== 'fastgate-shadow') continue
    if (typeof row.ref !== 'string' || !row.ref.startsWith('slug:')) continue
    if (typeof row.probability !== 'number' || !Number.isFinite(row.probability)) continue
    const band =
      row.band === 'adopt' || row.band === 'record' || row.band === 'fallback'
        ? row.band
        : row.probability >= RERANK_ADOPT
          ? 'adopt'
          : row.probability >= RERANK_FALLBACK
            ? 'record'
            : 'fallback'
    out.push({ ...row, slug: row.ref.slice('slug:'.length), band })
  }
  return out
}

/**
 * Join verdicts × ilog records on slug + time window; each verdict takes the
 * CLOSEST record mentioning its slug (ties → the earlier record).
 */
export function joinVerdicts(verdicts, records, windowMs) {
  const indexed = (records ?? [])
    .map((record) => ({ at: record.at, t: Date.parse(record.at), bySlug: recordDispositions(record), record }))
    .filter((e) => Number.isFinite(e.t))
  const rows = []
  let unmatched = 0
  for (const v of verdicts) {
    const vt = Date.parse(v.at)
    if (!Number.isFinite(vt)) {
      unmatched += 1
      continue
    }
    let best = null
    for (const e of indexed) {
      if (!e.bySlug.has(v.slug)) continue
      const dt = Math.abs(vt - e.t)
      if (dt > windowMs) continue
      if (best === null || dt < best.dt || (dt === best.dt && e.t < best.t)) best = { ...e, dt }
    }
    if (best === null) {
      unmatched += 1
      continue
    }
    const lex = best.bySlug.get(v.slug)
    rows.push({
      at: v.at,
      slug: v.slug,
      questionId: v.questionId,
      digest: v.digest,
      probability: v.probability,
      band: v.band,
      disposition: lex.disposition,
      lexicalScore: lex.score,
      querySample: best.record.querySample,
      recordAt: best.at,
    })
  }
  return { rows, unmatched }
}

/** wouldBlock = 词法放行 × jev 回退线; rescue = jev 高分 × gate-blocked. */
export function classifyDisagreements(rows) {
  return {
    wouldBlock: rows.filter((r) => r.disposition === 'hit' && r.band === 'fallback'),
    gateBlockedRescue: rows.filter((r) => r.disposition === 'gate-blocked' && r.probability >= HIGH_LINE),
  }
}

export function summarize(rows, verdictCount, unmatched) {
  const groups = {}
  for (const key of ['hit', 'nearFloor', 'gate-blocked']) groups[key] = { count: 0, sum: 0 }
  for (const r of rows) {
    const g = groups[r.disposition]
    if (g === undefined) continue
    g.count += 1
    g.sum += r.probability
  }
  for (const g of Object.values(groups)) g.mean = g.count === 0 ? null : round3(g.sum / g.count)
  const { wouldBlock, gateBlockedRescue } = classifyDisagreements(rows)
  const joined = rows.length
  const disagreements = wouldBlock.length + gateBlockedRescue.length
  return {
    verdicts: verdictCount,
    joined,
    unmatched,
    reconcileRate: verdictCount === 0 ? null : round3(joined / verdictCount),
    disagreementRate: joined === 0 ? null : round3(disagreements / joined),
    byDisposition: Object.fromEntries(
      Object.entries(groups).map(([k, g]) => [k, { count: g.count, meanProbability: g.mean }]),
    ),
    wouldBlock: wouldBlock.length,
    gateBlockedRescue: gateBlockedRescue.length,
  }
}

function defaultBundle() {
  const env = process.env.DSH_TOPICS_HOME?.trim()
  if (env !== undefined && env !== '') return env
  return join(homedir(), '.dsh', 'topics')
}

function fmtRow(r, i) {
  const at = (r.at ?? '').replace('T', ' ').slice(0, 19)
  const sample = r.querySample ? ` q=${r.querySample}` : ''
  const digest = typeof r.digest === 'string' && r.digest !== '' ? ` digest=${r.digest}` : ''
  return `  ${String(i + 1).padStart(3)}. ${at} ${r.slug} 词法=${r.lexicalScore ?? '?'} jev=${r.probability}${digest}${sample}`
}

const scriptMain = process.argv[1] !== undefined && process.argv[1].endsWith('replay-jev-gate.mjs')
if (scriptMain) {
  const args = process.argv.slice(2)
  const bundleArg = args.indexOf('--bundle')
  const bundle = bundleArg >= 0 ? args[bundleArg + 1] : defaultBundle()
  const windowArg = args.indexOf('--window')
  const minutes = windowArg >= 0 ? Number(args[windowArg + 1]) : DEFAULT_WINDOW_MIN
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.error('--window 需要正整数分钟（如 --window 10）')
    process.exit(1)
  }
  const json = args.includes('--json')
  const windowMs = minutes * 60_000

  const injections = await loadJsonl(join(bundle, 'meta', 'injections.jsonl'))
  const decisions = await loadJsonl(join(bundle, 'meta', 'decisions.jsonl'))
  if (injections === null) {
    if (json) console.log(JSON.stringify({ error: `cannot read ${join(bundle, 'meta', 'injections.jsonl')}` }))
    else console.error(`cannot read ${join(bundle, 'meta', 'injections.jsonl')}`)
    process.exit(1)
  }
  if (decisions === null) {
    if (json) console.log(JSON.stringify({ error: `cannot read ${join(bundle, 'meta', 'decisions.jsonl')}`, hint: 'jevEnabled 尚未产生任何判定层数据' }))
    else console.error(`cannot read ${join(bundle, 'meta', 'decisions.jsonl')}（jev 尚未产生判定层数据——shadow 期从零攒）`)
    process.exit(1)
  }

  const verdicts = shadowVerdicts(decisions)
  const { rows, unmatched } = joinVerdicts(verdicts, injections, windowMs)
  const summary = summarize(rows, verdicts.length, unmatched)
  const { wouldBlock, gateBlockedRescue } = classifyDisagreements(rows)

  if (json) {
    console.log(
      JSON.stringify(
        {
          bundle,
          windowMinutes: minutes,
          injectionRecords: injections.length,
          ...summary,
          disagreements: { wouldBlock, gateBlockedRescue },
        },
        null,
        2,
      ),
    )
  } else {
    console.log(`jev × 词法 对拍（只读）：${bundle}`)
    console.log(
      `ilog records=${injections.length}  verdicts(fastgate-shadow slug 问)=${summary.verdicts}  window=±${minutes}min`,
    )
    console.log('')
    console.log(`分歧清单 · wouldBlock（词法放行 × jev 回退线）共 ${wouldBlock.length} 条：`)
    if (wouldBlock.length === 0) console.log('  （无）')
    wouldBlock.forEach((r, i) => console.log(fmtRow(r, i)))
    console.log('')
    console.log(`分歧清单 · gate-blocked 高分（jev≥${HIGH_LINE} 被词法拦）共 ${gateBlockedRescue.length} 条：`)
    if (gateBlockedRescue.length === 0) console.log('  （无）')
    gateBlockedRescue.forEach((r, i) => console.log(fmtRow(r, i)))
    console.log('')
    const gd = summary.byDisposition
    const fmt = (k) => `${k}=${gd[k].meanProbability === null ? '—' : gd[k].meanProbability}（n=${gd[k].count}）`
    console.log(`按词法处置分组的 jev 均分：${fmt('hit')}  ${fmt('nearFloor')}  ${fmt('gate-blocked')}`)
    console.log(
      `对账率=${summary.reconcileRate === null ? '—' : `${(summary.reconcileRate * 100).toFixed(1)}%`}（joined=${summary.joined}/${summary.verdicts}，unmatched=${summary.unmatched}）  ` +
        `分歧率=${summary.disagreementRate === null ? '—' : `${(summary.disagreementRate * 100).toFixed(1)}%`}（wouldBlock ${summary.wouldBlock} + rescue ${summary.gateBlockedRescue}）`,
    )
    console.log('分歧案例是校准金矿（design §5 分歧证据条款）：人工复核后回填阈值骨架，不许静默丢。')
  }
}
