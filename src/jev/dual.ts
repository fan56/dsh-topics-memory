/**
 * Dual-run pace-maker (design §3.4, added 09-27): fire the configured
 * backend AND the local laya-serve endpoint in parallel on every jev call.
 *
 *  - the PRIMARY answer drives the decision whenever it is ok;
 *  - the laya answer is always logged (its own call-layer row tagged
 *    backend='laya' plus verdict rows) — a free, permanently running
 *    laya-vs-jev comparison on identical questions;
 *  - TELEMETRY-ONLY: laya NEVER drives a decision. On real data its
 *    within-batch top-1 agreed with the primary 0/14 and its negatives sit in
 *    the same band as its positives (0.63-0.76), so both its relative ranking
 *    and its absolute scores are unusable (4-way bench, 09-27). A primary
 *    FAILURE (cold-start spike, timeout, 5xx…) is therefore a failure even
 *    when laya answered: the result stays ok:false and the caller fails open
 *    (ADR 0018). `layaResult` still carries the comparison answers so the
 *    caller can log the laya verdict rows;
 *  - laya not running = a refused connection in milliseconds — the switch
 *    can stay on unconditionally.
 *
 * The consolidation prefilter deliberately does NOT ride this wrapper: laya's
 * Chinese noul is the weak spot, and a wrong veto silently skips real
 * consolidation work. Prefilter keeps its plain fail-open.
 *
 * @module jev/dual
 */

import { jevAsk } from './client.ts'
import type { JevAskArgs, JevAskConfig, JevAskResult } from './client.ts'

/** Default local laya-serve endpoint (laya repo: `laya[serve]` binds 8000). */
export const DEFAULT_LAYA_URL = 'http://127.0.0.1:8000/v1/systemone'

export interface JevDualConfig extends JevAskConfig {
  /** Pace-maker switch (default OFF — zero extra requests when false). */
  jevLayaFallback: boolean
  /** Local laya-serve systemone endpoint. */
  jevLayaUrl: string
}

export interface JevDualArgs extends Omit<JevAskArgs, 'config'> {
  config: JevDualConfig
}

export type JevDualSource = 'primary' | 'laya'

export type JevDualResult = JevAskResult & {
  /** Which backend ANSWERED for the record: 'primary' when the primary
   *  answered (the only case that may drive), 'laya' when it failed and the
   *  pace-maker covered for telemetry only. */
  source: JevDualSource
  /** The pace-maker's own result when it ran (null when the switch is off),
   *  always logged by jevAsk via the overrides hook. */
  layaResult: JevAskResult | null
}

export async function jevAskDual(args: JevDualArgs): Promise<JevDualResult> {
  if (args.config.jevLayaFallback !== true) {
    const r = await jevAsk(args as JevAskArgs)
    return { ...r, source: 'primary', layaResult: null }
  }
  const layaArgs: JevAskArgs = {
    ...args,
    config: { ...args.config, jevModel: 'laya-rl-agent' },
    overrides: { endpoint: args.config.jevLayaUrl || DEFAULT_LAYA_URL, model: 'laya-rl-agent' },
  }
  const [primary, laya] = await Promise.all([jevAsk(args as JevAskArgs), jevAsk(layaArgs)])
  if (primary.ok) return { ...primary, source: 'primary', layaResult: laya }
  // REVISED 09-27 (real-data evidence: within-batch top-1 agreement 0/14):
  // a primary failure is a FAILURE even when the pace-maker answered — laya
  // is telemetry-only. The caller fails open (ADR 0018); layaResult carries
  // the comparison answers so the caller can still log laya verdict rows.
  return { ok: false, outcome: primary.outcome, message: primary.message, latencyMs: primary.latencyMs, source: 'laya', layaResult: laya }
}
