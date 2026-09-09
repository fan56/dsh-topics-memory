/**
 * Hot-path retrieval — LLM-free, millisecond-scale (ADR 0004).
 *
 * Lineage: pi-topic-memory's tokenizer + Dice matching, adapted to the Topic
 * profile. Query tokens are matched against title/tags/slug/description/
 * conclusion via containment (|query ∩ field| / |query|), so long topics are
 * not penalized the way plain Dice dilutes them. Tag hits add a bounded
 * boost, recent topics a small recency bonus, and the `depends` graph expands
 * seeds to adjacent topics with geometric decay. Conflicted topics are
 * demoted, never dropped (ADR 0003).
 *
 * @module retrieval
 */

import type { TopicMeta } from './store.ts'
import { dependsSlugs } from './okf.ts'

export interface RetrievableTopic extends TopicMeta {
  /** `# Conclusion` section text (may be empty). */
  conclusion: string
  /** Body-referenced topic slugs ([[wikilinks]] + markdown links) — graph edges. */
  links?: string[]
  /** Self-declared recall triggers (v4 structural gate strong field). */
  triggers?: string[]
}

export interface RetrievalConfig {
  threshold: number
  topK: number
  tagBoost: number
  graphDepth: number
  recencyWindowDays: number
  now?: Date
  /** Slugs currently conflicted — demoted, not dropped. */
  conflicts?: ReadonlySet<string>
  /**
   * v4 structural gate v0 (design §4.1): a threshold-passing candidate only
   * injects when it ALSO hits a strong field (triggers/title/slug) or ≥2
   * distinct body terms — tags alone and single body terms can no longer
   * self-cross. Off for the explicit topic_search tool (the model asked).
   */
  structuralGate: boolean
  /**
   * UsageBoost (ADR 0015): behavioral bonus for topics used within the
   * rolling window. Gate-scoped but double-locked — capped below the
   * threshold and never granted to a zero-lexical candidate; the structural
   * gate still requires lexical evidence. 0 = off.
   */
  usageBoost: number
  /** Usage signals per slug (hits/opens in the window); absent map = no boost. */
  usage?: ReadonlyMap<string, { hits: number; opens: number }>
}

/** Hard cap for the usage bonus — below threshold 0.3 so usage can never
 *  carry a candidate across the gate on its own (ADR 0015). */
export const USAGE_BOOST_CAP = 0.2

export const DEFAULT_RETRIEVAL: RetrievalConfig = {
  threshold: 0.3,
  topK: 4,
  tagBoost: 0.15,
  graphDepth: 2,
  recencyWindowDays: 7,
  structuralGate: true,
  usageBoost: 0.15,
}

/** Trigger hits outrank every other lexical field (pi-llm-wiki: highest weight). */
export const TRIGGER_WEIGHT = 5

export interface SearchHit {
  slug: string
  score: number
  reasons: string[]
  viaGraph: boolean
  /** Structural gate v0 evidence (absent on graph-expanded entries). */
  strong?: boolean
  bodyHits?: number
  /** Recency-free score; graph decay starts from it (settle ties with the gate). */
  gateScore?: number
}

export interface SearchOutcome {
  hits: SearchHit[]
  /** Below threshold but close — the tuning evidence for /topics stats (ADR 0007). */
  nearMisses: SearchHit[]
  rosterSize: number
}

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu
const WORD_RUN = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Nd}][\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Nd}+#.-]*/gu

/**
 * Tokenize for matching: latin/digit words (≥2 chars) plus CJK character
 * bigrams (single char kept when the run has length 1).
 */
export function tokenize(text: string): string[] {
  const out = new Set<string>()
  for (const w of text.toLowerCase().match(WORD_RUN) ?? []) {
    if (w.length >= 2) out.add(w)
  }
  for (const run of text.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      out.add(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i += 1) out.add(run.slice(i, i + 2))
  }
  return [...out]
}

function containment(query: ReadonlySet<string>, field: ReadonlySet<string>): number {
  if (query.size === 0 || field.size === 0) return 0
  let hits = 0
  for (const t of query) if (field.has(t)) hits += 1
  return hits / query.size
}

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const t of a) if (b.has(t)) return true
  return false
}

export interface ScoredTopic {
  slug: string
  score: number
  reasons: string[]
  /** Strong-field hit (triggers/title/slug) — gate v0 pass condition A. */
  strong: boolean
  /** Distinct query terms found in description ∪ conclusion — pass condition B is ≥2. */
  bodyHits: number
  /** Score with the recency tiebreaker removed — the score the numeric gate
   *  looks at (lexical + tags + usageBoost; recency excluded, ADR 0015). */
  gateScore: number
}

/** Score one topic against the query tokens. */
export function scoreTopic(
  queryTokens: ReadonlySet<string>,
  topic: RetrievableTopic,
  cfg: RetrievalConfig,
): ScoredTopic {
  const title = new Set(tokenize(topic.title))
  const slug = new Set(tokenize(topic.slug))
  const triggers = new Set((topic.triggers ?? []).flatMap((t) => tokenize(t)))
  const tags = new Set(topic.tags.flatMap((t) => tokenize(t)))
  const description = new Set(tokenize(topic.description ?? ''))
  const conclusion = new Set(tokenize(topic.conclusion))
  const reasons: string[] = []
  let score = 0

  const cTriggers = containment(queryTokens, triggers)
  if (cTriggers > 0) {
    score += TRIGGER_WEIGHT * cTriggers
    reasons.push(`triggers:${cTriggers.toFixed(2)}`)
  }
  const cTitle = containment(queryTokens, title)
  if (cTitle > 0) {
    score += 3 * cTitle
    reasons.push(`title:${cTitle.toFixed(2)}`)
  }
  // Slug and tags are scored separately since the structural gate (v4): the
  // slug is a strong field, tags are not. Weights unchanged (2) so historical
  // score distributions stay comparable.
  const cSlug = containment(queryTokens, slug)
  if (cSlug > 0) {
    score += 2 * cSlug
    reasons.push(`slug:${cSlug.toFixed(2)}`)
  }
  const cTags = containment(queryTokens, tags)
  if (cTags > 0) {
    score += 2 * cTags
    reasons.push(`tags:${cTags.toFixed(2)}`)
  }
  const cDesc = containment(queryTokens, description)
  if (cDesc > 0) {
    score += 1.2 * cDesc
    reasons.push(`description:${cDesc.toFixed(2)}`)
  }
  const cConc = containment(queryTokens, conclusion)
  if (cConc > 0) {
    score += 0.8 * cConc
    reasons.push(`conclusion:${cConc.toFixed(2)}`)
  }
  // Exact tag hit boost, additive and capped at ONE boost's worth (v4 design:
  // the old ×3 cap let shared tags mint a 0.45 floor — the priming main
  // culprit). Never folded into the token set (dilution breaks the guard).
  let tagHits = 0
  for (const t of tags) {
    if (overlap(queryTokens, new Set([...tokenize(t)]))) tagHits += 1
  }
  if (tagHits > 0) {
    const boost = Math.min(cfg.tagBoost * tagHits, cfg.tagBoost)
    score += boost
    reasons.push(`tag-boost:+${boost.toFixed(2)}`)
  }
  // UsageBoost (ADR 0015) — gate-scoped behavioral bonus, unlike recency it
  // IS part of gateScore. Double-locked: capped below the threshold, and a
  // zero-lexical candidate (score === 0 here) never qualifies. Presence of a
  // signal is the trigger, not its magnitude — votes never scale the bonus.
  if (cfg.usageBoost > 0 && score > 0 && cfg.usage !== undefined) {
    const u = cfg.usage.get(topic.slug)
    if (u !== undefined && (u.hits > 0 || u.opens > 0)) {
      const boost = Math.min(cfg.usageBoost, USAGE_BOOST_CAP)
      score += boost
      reasons.push(`usage:+${boost.toFixed(2)}`)
    }
  }
  // Recency is a RANKING tiebreaker only (v4): it pads `score` but is kept
  // out of `gateScore`, so it can never carry a candidate across the numeric
  // threshold. Conflict demotion applies to the pre-tiebreaker score.
  let recencyBonus = 0
  if (score > 0 && cfg.recencyWindowDays > 0) {
    const generated = Date.parse(topic.generatedAt)
    if (!Number.isNaN(generated)) {
      const ageDays = ((cfg.now?.getTime() ?? Date.now()) - generated) / 86_400_000
      if (ageDays >= 0 && ageDays <= cfg.recencyWindowDays) {
        recencyBonus = 0.2
        reasons.push('recency')
      }
    }
  }
  if (cfg.conflicts?.has(topic.slug) === true) {
    score *= 0.3
    reasons.push('conflicted-demoted')
  }
  const gateScore = score
  score += recencyBonus
  const bodySet = new Set([...description, ...conclusion])
  let bodyHits = 0
  for (const t of queryTokens) if (bodySet.has(t)) bodyHits += 1
  const strong = cTriggers > 0 || cTitle > 0 || cSlug > 0
  return {
    slug: topic.slug,
    score: Math.round(score * 1000) / 1000,
    reasons,
    strong,
    bodyHits,
    gateScore: Math.round(gateScore * 1000) / 1000,
  }
}

/** Structural gate v0 verdict: strong-field hit, or ≥2 distinct body terms. */
export function passesGate(s: { strong: boolean; bodyHits: number }): boolean {
  return s.strong || s.bodyHits >= 2
}

/**
 * Search the roster: score every topic, apply the numeric threshold to the
 * gate score (recency excluded), split by the structural gate, then expand
 * gate-passed seeds through the `depends` graph (both directions, geometric
 * decay, depth ≤ cfg.graphDepth). Expanded entries enter at the back of the
 * hits and are exempt from the structural gate — they carry no lexical
 * evidence by design, only graph adjacency. Threshold-passing candidates the
 * gate rejects lead the near-misses (reason `gate-blocked`) so the replay
 * evidence shows what the gate is costing.
 */
export function searchTopics(query: string, roster: readonly RetrievableTopic[], cfg: Partial<RetrievalConfig> = {}): SearchOutcome {
  const c: RetrievalConfig = { ...DEFAULT_RETRIEVAL, ...cfg }
  const queryTokens = new Set(tokenize(query))
  if (queryTokens.size === 0 || roster.length === 0) {
    return { hits: [], nearMisses: [], rosterSize: roster.length }
  }
  const scored = roster.map((t) => scoreTopic(queryTokens, t, c)).sort((a, b) => b.score - a.score)
  const passing = scored.filter((s) => s.gateScore >= c.threshold)
  const directHits = passing.filter((s) => !c.structuralGate || passesGate(s)).slice(0, c.topK)
  const gateBlocked = c.structuralGate
    ? passing.filter((s) => !passesGate(s)).slice(0, c.topK)
    : []
  const nearFloor = scored.filter((s) => s.gateScore < c.threshold && s.gateScore >= c.threshold * 0.5).slice(0, 8)

  const hits: SearchHit[] = directHits.map((s) => ({ ...s, viaGraph: false }))
  const nearMisses: SearchHit[] = [
    ...gateBlocked.map((s) => ({ ...s, reasons: [...s.reasons, 'gate-blocked'], viaGraph: false })),
    ...nearFloor.map((s) => ({ ...s, viaGraph: false })),
  ].slice(0, 8)
  // Graph expansion (ADR 0005 graph-shaped bundle): walk depends + body
  // links, both directions, from the seeds; include up to topK+2 slots at
  // decaying score.
  if (c.graphDepth > 0 && hits.length > 0) {
    const bySlug = new Map(roster.map((r) => [r.slug, r]))
    const neighborsOf = (slug: string): string[] => {
      const topic = bySlug.get(slug)
      if (topic === undefined) return []
      const out = new Set<string>(dependsSlugs({ depends: topic.depends }))
      for (const l of topic.links ?? []) out.add(l)
      return [...out]
    }
    const dependents = new Map<string, string[]>()
    for (const r of roster) {
      for (const dep of new Set([...dependsSlugs({ depends: r.depends }), ...(r.links ?? [])])) {
        const list = dependents.get(dep) ?? []
        list.push(r.slug)
        dependents.set(dep, list)
      }
    }
    const seen = new Set(hits.map((h) => h.slug))
    // Decay starts from the gateScore: recency must not re-enter through the
    // graph channel after being banned from the direct gate.
    let frontier = hits.map((h) => ({ slug: h.slug, score: h.gateScore ?? h.score }))
    for (let depth = 1; depth <= c.graphDepth && frontier.length > 0; depth += 1) {
      const next: { slug: string; score: number }[] = []
      for (const node of frontier) {
        const neighbors = new Set<string>([...neighborsOf(node.slug), ...(dependents.get(node.slug) ?? [])])
        for (const neighbor of neighbors) {
          if (seen.has(neighbor)) continue
          seen.add(neighbor)
          const decayed = node.score * 0.5 ** depth
          if (decayed >= c.threshold && hits.length < c.topK + 2) {
            const already = hits.find((h) => h.slug === neighbor)
            if (already === undefined) hits.push({ slug: neighbor, score: Math.round(decayed * 1000) / 1000, reasons: [`depends:d${depth}`], viaGraph: true })
            next.push({ slug: neighbor, score: decayed })
          }
        }
      }
      frontier = next
    }
  }
  return { hits, nearMisses, rosterSize: roster.length }
}
