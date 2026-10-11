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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TopicMeta } from './store.ts'
import { dependsSlugs } from './okf.ts'
import type { EmbedResult } from './embedding.ts'

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
  /**
   * Zero-open decay (v5, default off — config `zeroOpenDecay`): halve the
   * score of slugs on the zero-open list (≥5 rendered injections in the
   * rolling 30 days, zero opens ever) at score-finalization time, BEFORE
   * the threshold cut — a decayed candidate that drops below the threshold
   * lands in nearMisses with the `zero-open-decay` reason, so the log
   * shows why it stopped injecting. Absent/off = zero behavior change.
   */
  zeroOpenDecay?: boolean
  /** Zero-open slugs for this round (service-built from the ilog tail). */
  zeroOpenSlugs?: ReadonlySet<string>
}

/** Hard cap for the usage bonus — below threshold 0.3 so usage can never
 *  carry a candidate across the gate on its own (ADR 0015). */
export const USAGE_BOOST_CAP = 0.2

/** Score multiplier for zero-open slugs when zeroOpenDecay is on (v5). */
export const ZERO_OPEN_DECAY_FACTOR = 0.5

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
  // Zero-open decay (v5): same demotion family as conflicts — applied to
  // the content score BEFORE gateScore is taken, so the threshold cut and
  // the near-miss band both see the halved score; recency still rides
  // outside it as the ranking tiebreaker.
  if (cfg.zeroOpenDecay === true && cfg.zeroOpenSlugs?.has(topic.slug) === true) {
    score *= ZERO_OPEN_DECAY_FACTOR
    reasons.push('zero-open-decay')
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

// ---------------------------------------------------------------------------
// Injection-quality line (wave/injection-quality, spec §2.1/§3.1/§3.3) —
// CAPABILITY ONLY. None of this is wired into searchTopics or any service
// path; the caller gates it on packageMode ≠ 'off' (Phase 2 wiring). With
// the config keys at their defaults every code path below is unreachable
// from the hot lane, so default-off behavior stays byte-for-byte.
// ---------------------------------------------------------------------------

// --- ① Query sanitization (A4 决议 4, spec §3.3) ---------------------------
// Pure, LLM-free, millisecond-scale. Treats the queryTokenCount p90=462
// paste-pollution tail: fenced code blocks, URLs, line-leading shell
// prompts, over-long lines, and a hard token cap.

/**
 * Token cap in tokenize() units — the SAME unit injections.jsonl logs as
 * queryTokenCount (p90=462 baseline; real-query p50=153 stays untouched).
 * Raised or lowered via SanitizeOptions.maxTokens.
 */
export const QUERY_TOKEN_CAP = 96

/**
 * Lines longer than this are folded to their head (log-paste guard). Sized
 * so the 96-token cap is the binding constraint, not the fold: 96 latin
 * tokens ≈ 650+ chars, so a legitimate long single-line query passes the
 * fold intact and only the token cap trims it. (实现期定 constant.)
 */
export const MAX_LINE_CHARS = 720

export interface SanitizeOptions {
  maxTokens?: number
  maxLineChars?: number
}

const FENCE_OPEN = /^[ \t]*(```|~~~)/
// Line-leading shell prompt: `user@host:~/repo$ `, `C:\> `, or a bare
// `$ `/`# `/`% `/`> `/`❯ ` marker. Requires trailing whitespace so words
// like `$PATH` or `#tag` survive untouched.
const LINE_PROMPT = /^[ \t]*(?:[\w.@:/\\~-]*[$#%>❯➜])[ \t]+/
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`)\]]+/gi
// Chunks the cap walks: one latin/digit word (or hyphenated compound) per
// match, or one CJK run (sliced when a run alone busts the cap).
const CHUNK_RUN = new RegExp(`${WORD_RUN.source}|${CJK_RUN.source}`, 'gu')

/** Remove fenced code blocks wholesale (markers AND body): fenced code is
 *  the paste-pollution payload; the prose around it is the actual query. */
function stripFencedBlocks(text: string): string {
  const out: string[] = []
  let open: string | null = null
  for (const line of text.split('\n')) {
    const m = line.match(FENCE_OPEN)
    if (open === null) {
      if (m !== null) open = m[1]
      else out.push(line)
    } else if (m !== null && m[1] === open) {
      open = null // closing fence — block fully dropped
    }
    // inside an open fence: drop the line
  }
  return out.join('\n')
}

/** Cap the sanitized text to ≤ cap distinct retrieval tokens. Fast path:
 *  at or under the cap the text passes through VERBATIM (no re-chunking —
 *  hyphens, punctuation and spacing survive byte-exact; retrieval scores
 *  tokens, not bytes, but the string may be echoed into logs/injection).
 *  Only an over-cap text rebuilds from chunks: head-first (a query's intent
 *  leads; pollution trails), with CJK runs sliced at the character level so
 *  a single giant run truncates instead of being dropped whole. */
function capTokens(text: string, cap: number): string {
  const total = tokenize(text).length
  if (total === 0) return '' // nothing lexical survives — caller sees a zero-token query
  if (total <= cap) return text
  const seen = new Set<string>()
  const kept: string[] = []
  for (const chunk of text.match(CHUNK_RUN) ?? []) {
    const fresh = tokenize(chunk).filter((t) => !seen.has(t))
    if (fresh.length === 0) continue // already-covered chunk adds nothing
    if (seen.size + fresh.length <= cap) {
      for (const t of fresh) seen.add(t)
      kept.push(chunk)
      continue
    }
    const room = cap - seen.size
    if (room <= 0) break
    // Over budget: CJK runs truncate exactly (slice room+1 chars → ≤ room
    // fresh bigrams, so the cap invariant holds). Latin chunks are single
    // tokens by construction — they never reach here with room > 0, but if
    // one ever does, dropping it beats busting the cap.
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(chunk)) {
      kept.push(chunk.slice(0, room + 1))
    }
    break
  }
  return kept.join(' ')
}

/**
 * Sanitize a raw user query for retrieval (spec §3.3): strip fenced code
 * blocks and URLs, fold line-leading shell prompts, fold over-long lines to
 * their head, cap the distinct-token count. Returns '' when nothing lexical
 * survives — the caller treats that as a zero-token query (natural skip).
 * Pure function; the hot lane only reaches it behind packageMode.
 */
export function sanitizeQuery(raw: string, opts: SanitizeOptions = {}): string {
  const cap = opts.maxTokens ?? QUERY_TOKEN_CAP
  const maxLineChars = opts.maxLineChars ?? MAX_LINE_CHARS
  if (raw === '') return ''
  let text = stripFencedBlocks(raw)
  text = text.replace(URL_RE, ' ')
  text = text
    .split('\n')
    .map((line) => {
      let l = line.replace(LINE_PROMPT, '')
      if (l.length > maxLineChars) l = l.slice(0, maxLineChars)
      return l
    })
    .join('\n')
  text = text.replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  return capTokens(text, cap)
}

// --- ② Embedding index (A4 决议 2, spec §3.1) -------------------------------
// meta/embeddings.json: { slug: { model, dim, vec } }. Loading and auditing
// never throws; a missing/corrupt index reads as EMPTY, which routes every
// semantic path into the explicit passthrough below.

export interface EmbeddingIndexEntry {
  model: string
  dim: number
  vec: number[]
}

/** slug -> entry, exactly as persisted in meta/embeddings.json. */
export type EmbeddingIndex = Record<string, EmbeddingIndexEntry>

export function embeddingIndexPath(bundleDir: string): string {
  return join(bundleDir, 'meta', 'embeddings.json')
}

function parseEmbeddingIndexEntry(value: unknown): EmbeddingIndexEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const e = value as Record<string, unknown>
  if (typeof e.model !== 'string' || e.model === '') return null
  if (typeof e.dim !== 'number' || !Number.isInteger(e.dim) || e.dim <= 0) return null
  if (!Array.isArray(e.vec) || e.vec.length !== e.dim) return null
  if (!e.vec.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  return { model: e.model, dim: e.dim, vec: e.vec as number[] }
}

/** Load meta/embeddings.json from a bundle dir. Missing file, corrupt JSON,
 *  or malformed entries are skipped/empty — never throws (a broken index
 *  must degrade to the lexical path, not break retrieval). */
export function loadEmbeddingIndex(bundleDir: string): EmbeddingIndex {
  let raw: string
  try {
    raw = readFileSync(embeddingIndexPath(bundleDir), 'utf8')
  } catch {
    return {}
  }
  try {
    const json: unknown = JSON.parse(raw)
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return {}
    const out: EmbeddingIndex = {}
    for (const [slug, entry] of Object.entries(json as Record<string, unknown>)) {
      if (slug === '') continue
      const parsed = parseEmbeddingIndexEntry(entry)
      if (parsed !== null) out[slug] = parsed
    }
    return out
  } catch {
    return {}
  }
}

/** Persist the index in the canonical shape (the rebuild's write side —
 *  embedding/rebuilding itself stays with the caller). Offline rebuild
 *  path, not the hot lane. */
export function saveEmbeddingIndex(bundleDir: string, index: EmbeddingIndex, mkdir = true): void {
  if (mkdir) mkdirSync(join(bundleDir, 'meta'), { recursive: true })
  writeFileSync(embeddingIndexPath(bundleDir), JSON.stringify(index))
}

/**
 * An embed function bound to a config, carrying the RESOLVED model identity
 * the index must match (build once via embedding.ts's `embedderWith`).
 * ensureIndexFresh reads `.model` only — it never calls the function; the
 * rebuild is the caller's job.
 */
export type EmbedderFn = ((texts: readonly string[]) => Promise<EmbedResult>) & { model: string }

/**
 * Freshness audit: which slugs need (re)embedding — missing from the index,
 * built by a different model, or shape-broken (dim/vec disagree). Returns
 * them in roster order; an EMPTY list means the index covers the roster.
 * A '' embedder model means the semantic layer is off → nothing to maintain.
 *
 * NOTE the freshness boundary: content-change invalidation needs a stored
 * content hash, which the pinned {model,dim,vec} entry shape does not carry
 * — the rebuild trigger policy is spec-实现期定 and stays with the caller.
 */
export function ensureIndexFresh(index: EmbeddingIndex, topics: readonly { slug: string }[], embedFn: EmbedderFn): string[] {
  if ((embedFn.model ?? '') === '') return []
  const stale: string[] = []
  for (const t of topics) {
    const e = index[t.slug]
    if (e === undefined || e.model !== embedFn.model || e.dim !== e.vec.length || !(e.dim > 0)) stale.push(t.slug)
  }
  return stale
}

// --- ③ nearFloor semantic rerank (A4 决议 2, spec §3.1) ---------------------
// Cosine reordering of the nearFloor band ONLY (0.20–0.30 — the 93%
// near-miss mass). Thresholds, gateScore and the structural gate are
// untouched: the reranker reorders and tags, never re-scores.

export const RERANK_FLOOR = 0.2
export const RERANK_CEILING = 0.3
export const SEMANTIC_RERANK_REASON = 'semantic-rerank'

export interface RerankedHit extends SearchHit {
  /** Cosine(query, slug-vector), rounded 4dp. Present only on reranked
   *  hits; absent = the candidate rode through unchanged. */
  similarity?: number
}

export type RerankPassthroughReason =
  | 'no-candidates' // nothing to rank
  | 'no-query-vector' // embed failed upstream — the explicit degradation
  | 'empty-index' // meta/embeddings.json absent/corrupt
  | 'no-rerankable-candidates' // band candidates lack usable index vectors

export interface RerankOptions {
  /** Expected index model; entries built by another model count as
   *  vector-less (they ride through at the band tail). */
  expectedModel?: string
  floor?: number
  ceiling?: number
}

export interface RerankResult {
  /** Candidates in final order. On passthrough: the input array, same
   *  order, no tags — byte-identical ordering, explicit why. */
  hits: RerankedHit[]
  /** true = the semantic layer engaged (order may or may not have moved). */
  reranked: boolean
  passthroughReason?: RerankPassthroughReason
}

/** Cosine similarity; 0 for dim mismatch or zero vectors (never throws). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}

/**
 * Reorder the nearFloor band (0.20–0.30 by gateScore) by cosine similarity
 * against the query vector. Band members with a usable index vector sort by
 * similarity (stable — ties keep input order) and gain the
 * `semantic-rerank` reason plus their similarity; everyone else — out of
 * band, unindexed, model-mismatched — passes through UNCHANGED at the tail
 * in input order. Scores are never touched.
 *
 * Degradation is explicit and total: provider/model unconfigured, probe
 * failure, missing query vector or missing index all return the input as-is
 * with `reranked:false` and a passthroughReason (原序透传，不许静默 — the
 * caller logs it into the degraded status). `queryText` rides the signature
 * for provenance/debug parity with the caller's logging; the v1 math is
 * vector-only.
 */
export function rerankNearFloor(
  queryText: string,
  queryVec: readonly number[] | null | undefined,
  nearFloorCandidates: readonly SearchHit[],
  index: EmbeddingIndex,
  opts: RerankOptions = {},
): RerankResult {
  void queryText // v1 math is vector-only — see doc above
  if (nearFloorCandidates.length === 0) {
    return { hits: [], reranked: false, passthroughReason: 'no-candidates' }
  }
  if (!Array.isArray(queryVec) || queryVec.length === 0) {
    return { hits: [...nearFloorCandidates], reranked: false, passthroughReason: 'no-query-vector' }
  }
  if (Object.keys(index).length === 0) {
    return { hits: [...nearFloorCandidates], reranked: false, passthroughReason: 'empty-index' }
  }
  const floor = opts.floor ?? RERANK_FLOOR
  const ceiling = opts.ceiling ?? RERANK_CEILING
  const simOf = new Map<SearchHit, number | null>()
  for (const hit of nearFloorCandidates) {
    const entry = index[hit.slug]
    const usable =
      entry !== undefined &&
      entry.dim === entry.vec.length &&
      entry.dim > 0 &&
      entry.dim === queryVec.length &&
      (opts.expectedModel === undefined || entry.model === opts.expectedModel)
    simOf.set(hit, usable ? cosineSimilarity(queryVec, entry.vec) : null)
  }
  const band = nearFloorCandidates.filter((h) => {
    const sim = simOf.get(h)
    return sim !== null && sim !== undefined && h.gateScore !== undefined && h.gateScore >= floor && h.gateScore < ceiling
  })
  if (band.length === 0) {
    return { hits: [...nearFloorCandidates], reranked: false, passthroughReason: 'no-rerankable-candidates' }
  }
  const rerankedSet = new Set(band)
  const tail = nearFloorCandidates.filter((h) => !rerankedSet.has(h))
  // Stable sort: V8's Array#sort keeps input order for equal similarities.
  const ordered = [...band].sort((x, y) => (simOf.get(y) as number) - (simOf.get(x) as number))
  return {
    hits: [
      ...ordered.map((h) => {
        const sim = simOf.get(h) as number
        return { ...h, reasons: [...h.reasons, SEMANTIC_RERANK_REASON], similarity: Math.round(sim * 10_000) / 10_000 }
      }),
      ...tail.map((h) => ({ ...h })),
    ],
    reranked: true,
  }
}
