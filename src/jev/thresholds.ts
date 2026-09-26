/**
 * System One decision bands (design 2026-09-25 §5).
 *
 * The numbers are CALIBRATED — single-case A/B plus a 383-case threshold
 * sweep (2026-09-25) — and bound to the batch wire protocol (protocol-drift
 * evidence: the same case scores differently single vs batch). Changing the
 * protocol requires a re-sweep; do not tune these in place.
 *
 * @module jev/thresholds
 */

/** Slow-lane rerank (候选问): adopt ≥ 0.60, strong-veto < 0.10. */
export const RERANK_ADOPT = 0.6
export const RERANK_FALLBACK = 0.1

/** Consolidation prefilter (pair 问「同一问题吗」): adopt ≥ 0.50, veto < 0.15. */
export const MERGE_PAIR_ADOPT = 0.5
export const MERGE_PAIR_FALLBACK = 0.15

export type JevBand = 'adopt' | 'record' | 'fallback'
export type JevBandKind = 'rerank' | 'mergePair'

/** Map a noul probability to its band: adopt → act on it, record → only log
 *  it, fallback → hard veto back to the lexical/legacy behavior. */
export function band(probability: number, kind: JevBandKind): JevBand {
  const floor = kind === 'rerank' ? RERANK_FALLBACK : MERGE_PAIR_FALLBACK
  const adopt = kind === 'rerank' ? RERANK_ADOPT : MERGE_PAIR_ADOPT
  if (probability >= adopt) return 'adopt'
  if (probability >= floor) return 'record'
  return 'fallback'
}
