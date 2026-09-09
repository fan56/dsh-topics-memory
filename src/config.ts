/**
 * Plugin configuration — the `topics` settings namespace, user-editable in
 * settings.yaml and via `/topics set` (ADR 0006/0007 tunables).
 *
 * @module config
 */

import z from '@deepseek-ai/schemastery'

export const TopicsConfig = z.object({
  /** GitHub repo `owner/name`; empty = local-only mode (ADR 0008). */
  repo: z.string().default(''),
  /** Master switch for per-turn injection. */
  autoInject: z.boolean().default(true),
  /** Skip re-injecting topics already injected earlier in the same session. */
  injectDedup: z.boolean().default(true),
  /** Skip re-injecting topics distilled from the CURRENT session's own turns
   *  (蒸馏回声): the conversation already carries that knowledge, so a
   *  pointer is a stale echo at best (2026-09 audit: 3 of 6 useless rounds).
   *  Provenance rides the observations log (sessionId → distilledInto). */
  suppressEcho: z.boolean().default(true),
  /** Max topics injected per round (ADR 0006: ≤4). */
  topK: z.number().default(4),
  /** Per-topic digest budget in tokens. */
  perTopicBudget: z.number().default(300),
  /** Total injection budget in tokens. */
  totalBudget: z.number().default(1500),
  /** Retrieval score threshold — tune via /topics stats near-miss evidence. */
  matchThreshold: z.number().default(0.3),
  /** Additive boost per tag hit (v4: total cap = this value, was ×3). */
  tagBoost: z.number().default(0.15),
  /** Injection shape: pointer (default, ≤600 tok) keeps the legacy digest view. */
  injectMode: z.string().default('pointer'),
  /** Slow quality lane (v4 §4.2): off | sampled (1/3 of turns) | always. */
  qualityLane: z.string().default('sampled'),
  /** depends-graph expansion depth (0 disables). */
  graphDepth: z.number().default(2),
  /** Days within which a topic counts as recent (+0.2). */
  recencyWindowDays: z.number().default(7),
  /** Capture each turn's user/assistant text as raw observations (M2). */
  autoObserve: z.boolean().default(true),
  /** Whether injection and observation also engage delegated subagent sessions (ADR 0011).
   *  v4 default flipped to false: one-shot subagent turns diluted the pool.
   *  The slow quality lane never runs for subagents either way (hard guard). */
  includeSubagents: z.boolean().default(false),
  /** Max auto-captured chars per side (user/assistant) per turn. */
  observationMaxChars: z.number().default(2000),
  /** Background distill cadence: every N turns of a long session. */
  distillEveryTurns: z.number().default(5),
  /** Distill once when a session ends. */
  distillOnSessionEnd: z.boolean().default(true),
  /** Distill lane model route; both must be set, else distill stays idle. */
  distillProvider: z.string().default(''),
  distillModel: z.string().default(''),
  /** Observations per distill model call; auto-halves on output-limit failures (floor 5). */
  distillBatchSize: z.number().default(40),
  /** Max model calls per distill run — successful batches keep their marks (partial progress).
   *  Default 8: with the batch loop, one run then drains ~30-40 observations
   *  instead of ~10, which is what makes a real backlog actually shrink. */
  distillMaxModelCalls: z.number().default(8),
  /** Consolidation lane (整理) cadence: how often a session start may run the
   *  LLM gardener over the EXISTING pool (merge near-duplicates, promote
   *  settled drafts, deprecate superseded, refresh metadata). Reuses the
   *  distill model route; off disables the lane entirely. */
  consolidateCadence: z.string().default('daily'),
  /** Deprecated topics older than this many days are dropped at session start
   *  (local TTL sweep, no model; each drop is its own git commit, so history
   *  stays recoverable on the remote). 0 disables the sweep. */
  deprecatedTtlDays: z.number().default(15),
  /** Debounced push delay in GitHub mode. */
  pushDebounceSeconds: z.number().default(45),
})

export type TopicsConfigValue = {
  repo: string
  autoInject: boolean
  injectDedup: boolean
  suppressEcho: boolean
  topK: number
  perTopicBudget: number
  totalBudget: number
  matchThreshold: number
  tagBoost: number
  injectMode: string
  qualityLane: string
  graphDepth: number
  recencyWindowDays: number
  autoObserve: boolean
  includeSubagents: boolean
  observationMaxChars: number
  distillEveryTurns: number
  distillOnSessionEnd: boolean
  distillProvider: string
  distillModel: string
  distillBatchSize: number
  distillMaxModelCalls: number
  consolidateCadence: string
  deprecatedTtlDays: number
  pushDebounceSeconds: number
}

export const CONFIG_KEYS = [
  'repo',
  'autoInject',
  'injectDedup',
  'suppressEcho',
  'topK',
  'perTopicBudget',
  'totalBudget',
  'matchThreshold',
  'tagBoost',
  'injectMode',
  'qualityLane',
  'graphDepth',
  'recencyWindowDays',
  'autoObserve',
  'includeSubagents',
  'observationMaxChars',
  'distillEveryTurns',
  'distillOnSessionEnd',
  'distillProvider',
  'distillModel',
  'distillBatchSize',
  'distillMaxModelCalls',
  'consolidateCadence',
  'deprecatedTtlDays',
  'pushDebounceSeconds',
] as const

export type ConfigKey = (typeof CONFIG_KEYS)[number]

/** CamelCase → dash-display (topK → top-k) for command output. */
export function displayKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/** /topics set <key> <value> — parse the raw string into the typed value. */
export function parseConfigValue(key: ConfigKey, raw: string): boolean | number | string | { error: string } {
  switch (key) {
    case 'repo': {
      if (raw !== '' && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(raw)) {
        return { error: 'repo 需要形如 owner/name，或留空切换回 local-only 模式' }
      }
      return raw
    }
    case 'autoInject':
    case 'injectDedup':
    case 'suppressEcho':
    case 'autoObserve':
    case 'distillOnSessionEnd':
    case 'includeSubagents': {
      if (raw === 'on' || raw === 'true') return true
      if (raw === 'off' || raw === 'false') return false
      return { error: `${key} 取值 on|off` }
    }
    case 'topK':
    case 'perTopicBudget':
    case 'totalBudget':
    case 'graphDepth':
    case 'recencyWindowDays':
    case 'observationMaxChars':
    case 'distillEveryTurns':
    case 'distillBatchSize':
    case 'distillMaxModelCalls':
    case 'deprecatedTtlDays':
    case 'pushDebounceSeconds': {
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return { error: `${key} 需要非负整数` }
      return n
    }
    case 'injectMode': {
      if (raw === 'pointer' || raw === 'digest') return raw
      return { error: 'inject-mode 取值 pointer|digest' }
    }
    case 'consolidateCadence': {
      if (raw === 'off' || raw === 'daily' || raw === '3d' || raw === '7d') return raw
      return { error: 'consolidate-cadence 取值 off|daily|3d|7d' }
    }
    case 'qualityLane': {
      if (raw === 'off' || raw === 'sampled' || raw === 'always') return raw
      return { error: 'quality-lane 取值 off|sampled|always' }
    }
    case 'matchThreshold':
    case 'tagBoost': {
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0) return { error: `${key} 需要非负数` }
      return n
    }
    case 'distillProvider':
    case 'distillModel':
      return raw
  }
}
