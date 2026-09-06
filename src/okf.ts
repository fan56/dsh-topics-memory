/**
 * OKF v0.2 concept-document model for the Topic profile (ADR 0001).
 *
 * A Topic is a markdown file with YAML frontmatter plus a body. The Topic
 * profile fixes the extension keys (`depends`, `open_questions`, `impact`)
 * and the conventional body headings (`# Conclusion`, `# Recommendations`);
 * the OKF provenance/trust/lifecycle families pass through untouched.
 *
 * `depends` entries are bundle-relative paths (`topics/<slug>.md`) so the
 * file stays OKF-conformant and cross-linkable; graph helpers convert
 * between paths and slugs (ADR 0005).
 *
 * @module okf
 */

import { parseYaml, stringifyYaml, YamlError } from './yaml.ts'

export type TopicStatus = 'draft' | 'stable' | 'deprecated'

export interface SourceEntry {
  id?: string
  resource: string
  title?: string
  author?: string
  usage_count?: number
  last_modified?: string
}

export interface TrustStamp {
  by: string
  at: string
}

export interface TopicFrontmatter {
  type: string
  title: string
  description?: string
  tags: string[]
  /**
   * Self-declared recall triggers (v4 dual-channel design §4.1): short
   * phrases that should recall this topic when they appear in a query.
   * Optional; bundles written before the field simply have no trigger
   * matching (degraded, never an error). Highest-weight strong field.
   */
  triggers?: string[]
  /** Bundle-relative paths: `topics/<slug>.md`. */
  depends: string[]
  open_questions: string[]
  impact: string[]
  status: TopicStatus
  generated: TrustStamp
  verified?: TrustStamp
  stale_after?: string
  sources?: SourceEntry[]
  /** Producer-defined extras — preserved on round-trip per OKF §4.1. */
  [extra: string]: unknown
}

export interface TopicDoc {
  fm: TopicFrontmatter
  body: string
}

export class OkfError extends Error {
  override name = 'OkfError'
}

/** Filenames with defined meaning in a bundle; never usable as topic slugs. */
export const RESERVED_FILES: ReadonlySet<string> = new Set(['index.md', 'spec.md'])

const PROFILE_HEADINGS = ['conclusion', 'recommendations'] as const

function asStringArray(v: unknown): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new OkfError('expected a list')
  return v.map((x) => {
    if (typeof x !== 'string') throw new OkfError('list entries must be strings')
    return x
  })
}

function asTrust(v: unknown, field: string): TrustStamp {
  if (v === null || v === undefined || typeof v !== 'object') {
    throw new OkfError(`frontmatter.${field} must be an object {by, at}`)
  }
  const o = v as Record<string, unknown>
  if (typeof o.by !== 'string' || o.by === '' || typeof o.at !== 'string' || o.at === '') {
    throw new OkfError(`frontmatter.${field} requires string "by" and "at"`)
  }
  return { by: o.by, at: o.at }
}

function asStatus(v: unknown): TopicStatus {
  if (v === undefined || v === null || v === '') return 'draft'
  if (v === 'draft' || v === 'stable' || v === 'deprecated') return v
  throw new OkfError(`frontmatter.status must be draft|stable|deprecated, got "${String(v)}"`)
}

/**
 * Parse a Topic document. Throws OkfError on structural violations
 * (missing frontmatter, non-mapping, missing type/title).
 */
export function parseTopicDoc(raw: string): TopicDoc {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (m === null) throw new OkfError('document must start with a --- frontmatter block')
  let fmRaw: Record<string, unknown>
  try {
    fmRaw = parseYaml(m[1])
  } catch (e) {
    if (e instanceof YamlError) throw new OkfError(`frontmatter: ${e.message}`)
    throw e
  }
  if (typeof fmRaw.type !== 'string' || fmRaw.type === '') {
    throw new OkfError('frontmatter.type is required (OKF §4.1)')
  }
  const title = typeof fmRaw.title === 'string' && fmRaw.title !== '' ? fmRaw.title : fmRaw.type
  const tags = asStringArray(fmRaw.tags)
  const depends = asStringArray(fmRaw.depends)
  const open_questions = asStringArray(fmRaw.open_questions)
  const impact = asStringArray(fmRaw.impact)
  const generated = 'generated' in fmRaw ? asTrust(fmRaw.generated, 'generated') : { by: 'unknown', at: new Date(0).toISOString() }
  const fm: TopicFrontmatter = {
    type: fmRaw.type,
    title,
    tags,
    depends,
    open_questions,
    impact,
    status: asStatus(fmRaw.status),
    generated,
  }
  if (typeof fmRaw.description === 'string' && fmRaw.description !== '') fm.description = fmRaw.description
  // Triggers are producer-optional and must never invalidate an otherwise
  // sound doc: non-string entries are filtered, not thrown (degrade, per the
  // v4 design's "旧 bundle 无此字段降级不命中").
  if (fmRaw.triggers !== undefined && fmRaw.triggers !== null) {
    const raw = Array.isArray(fmRaw.triggers) ? fmRaw.triggers : [fmRaw.triggers]
    const triggers = raw.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim())
    if (triggers.length > 0) fm.triggers = triggers
  }
  if ('verified' in fmRaw && fmRaw.verified !== null && fmRaw.verified !== undefined) fm.verified = asTrust(fmRaw.verified, 'verified')
  if (typeof fmRaw.stale_after === 'string' && fmRaw.stale_after !== '') fm.stale_after = fmRaw.stale_after
  if (Array.isArray(fmRaw.sources)) {
    fm.sources = fmRaw.sources.map((s) => {
      if (s === null || typeof s !== 'object' || typeof (s as Record<string, unknown>).resource !== 'string') {
        throw new OkfError('frontmatter.sources entries require a string "resource" (OKF §5.1)')
      }
      return s as SourceEntry
    })
  }
  // Preserve unknown producer-defined keys verbatim (OKF §4.1 extensions).
  const known = new Set(['type', 'title', 'description', 'tags', 'triggers', 'depends', 'open_questions', 'impact', 'status', 'generated', 'verified', 'stale_after', 'sources'])
  for (const [k, v] of Object.entries(fmRaw)) {
    if (!known.has(k)) fm[k] = v
  }
  return { fm, body: m[2] }
}

/** Serialize a Topic document with a deterministic frontmatter field order. */
export function serializeTopicDoc(doc: TopicDoc): string {
  const fm = doc.fm
  const out: Record<string, unknown> = {
    type: fm.type,
    title: fm.title,
  }
  if (fm.description !== undefined) out.description = fm.description
  out.tags = fm.tags
  if (fm.triggers !== undefined && fm.triggers.length > 0) out.triggers = fm.triggers
  out.depends = fm.depends
  out.open_questions = fm.open_questions
  out.impact = fm.impact
  out.status = fm.status
  out.generated = { by: fm.generated.by, at: fm.generated.at }
  if (fm.verified !== undefined) out.verified = { by: fm.verified.by, at: fm.verified.at }
  if (fm.stale_after !== undefined) out.stale_after = fm.stale_after
  if (fm.sources !== undefined && fm.sources.length > 0) out.sources = fm.sources
  for (const [k, v] of Object.entries(fm)) {
    if (!(k in out)) out[k] = v
  }
  return `---\n${stringifyYaml(out)}---\n${doc.body}`
}

/** Split a body into `# Heading` sections: [{heading, text}] in order. */
export function splitSections(body: string): { heading: string; text: string }[] {
  const sections: { heading: string; text: string }[] = []
  let current: { heading: string; text: string[] } | undefined
  for (const line of body.split('\n')) {
    const m = /^# (.+)$/.exec(line)
    if (m !== null) {
      if (current !== undefined) sections.push({ heading: current.heading, text: current.text.join('\n').trim() })
      current = { heading: m[1].trim(), text: [] }
    } else if (current !== undefined) {
      current.text.push(line)
    }
  }
  if (current !== undefined) sections.push({ heading: current.heading, text: current.text.join('\n').trim() })
  return sections
}

/** The text under a given `# Heading`, or undefined when absent. */
export function sectionOf(body: string, heading: string): string | undefined {
  const hit = splitSections(body).find((s) => s.heading.toLowerCase() === heading.toLowerCase())
  return hit === undefined ? undefined : hit.text
}

/** First non-empty line of a text block — the 结论精句 used in digests. */
export function firstParagraph(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t !== '') return t
  }
  return ''
}

/** Replace or append a `# Heading` section, preserving other content and order. */
export function setSection(body: string, heading: string, text: string): string {
  const sections = splitSections(body)
  const idx = sections.findIndex((s) => s.heading.toLowerCase() === heading.toLowerCase())
  if (idx >= 0) {
    sections[idx] = { heading: sections[idx].heading, text }
  } else {
    sections.push({ heading, text })
  }
  return sections.map((s) => `# ${s.heading}\n\n${s.text}`).join('\n\n') + '\n'
}

/**
 * Slug from a title: latin lowercased, CJK preserved, spaces/punctuation
 * collapse to dashes. Never empty (falls back to `topic`) and never a
 * reserved filename.
 */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Cyrillic}\p{Nd}-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  if (slug === '' || RESERVED_FILES.has(`${slug}.md`)) return 'topic'
  return slug
}

/** `topics/foo.md` → `foo`; anything else unchanged. */
export function pathToSlug(path: string): string {
  const m = /^topics\/(.+)\.md$/.exec(path)
  return m === null ? path : m[1]
}

/** `foo` → `topics/foo.md`. */
export function slugToPath(slug: string): string {
  return `topics/${slug}.md`
}

/**
 * Strip every `topics/` (or `topics:` — a colon form the wild has produced)
 * prefix and `.md` suffix. The canonical depends entry carries exactly one
 * of each, but bundles written by the save path that re-wrapped preserved
 * values (fixed in the same release) can carry any number — idempotent by
 * construction.
 */
export function unwrapTopicRef(raw: string): string {
  let t = raw.trim()
  for (;;) {
    if (t.startsWith('topics/')) t = t.slice('topics/'.length)
    else if (t.startsWith('topics:')) t = t.slice('topics:'.length)
    else break
  }
  while (t.endsWith('.md')) t = t.slice(0, -3)
  return t
}

/**
 * Canonical bundle-relative path for a `depends` entry, accepting every form
 * the wild has produced: bare slug (`foo`), canonical path (`topics/foo.md`),
 * multi-wrapped (`topics/topics/foo.md.md`). Idempotent. A value that still
 * carries a path separator or scheme after unwrapping is not a bundle-internal
 * topic reference and comes back as its unwrapped self (a dead edge for the
 * graph, but never re-wrapped into a fake one); the empty string means the
 * entry unwrapped to nothing and should be dropped by the caller.
 */
export function normalizeDependsEntry(raw: string): string {
  const t = unwrapTopicRef(raw)
  if (t === '') return ''
  if (t.includes('/') || t.includes(':')) return t
  return slugToPath(t)
}

/** Topic slugs referenced by `depends`, tolerant of wrapped entries. */
export function dependsSlugs(fm: { depends: readonly string[] }): string[] {
  return fm.depends.map(unwrapTopicRef)
}

export interface IndexEntry {
  slug: string
  title: string
  description?: string
  status: TopicStatus
  tags: string[]
}

/** Render the auto-generated OKF `index.md` (progressive disclosure, §Bundle). */
export function renderIndex(entries: IndexEntry[]): string {
  const lines = [
    '# Topic Index',
    '',
    `Auto-generated by dsh-topics-memory — do not edit. ${entries.length} topic${entries.length === 1 ? '' : 's'}.`,
    '',
  ]
  for (const e of entries.sort((a, b) => a.slug.localeCompare(b.slug))) {
    const desc = e.description !== undefined && e.description !== '' ? ` — ${e.description}` : ''
    lines.push(`- [${e.title}](topics/${e.slug}.md) \`${e.status}\`${desc}`)
  }
  return lines.join('\n') + '\n'
}

/** Loose ISO-8601 instant check (OKF requires explicit UTC offsets in spec, kept tolerant). */
export function isIsoInstant(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)
}

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g
const MD_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

/**
 * Normalize one link target to a topic slug, or undefined when the target is
 * not a bundle-internal topic reference. Accepts `slug`, `slug.md`,
 * `topics/slug`, `[[slug#heading]]`, `[[slug|alias]]`.
 */
export function normalizeLinkTarget(target: string): string | undefined {
  let t = target.trim()
  if (t === '' || t.includes('://') || t.startsWith('#') || t.startsWith('mailto:')) return undefined
  t = t.split('#')[0].trim()
  if (t === '') return undefined
  if (t.endsWith('.md')) t = t.slice(0, -3)
  if (t.startsWith('./')) t = t.slice(2)
  if (t.startsWith('topics/')) t = t.slice('topics/'.length)
  if (t === '' || t.includes('/') || t.includes(':')) return undefined
  if (RESERVED_FILES.has(`${t}.md`)) return undefined
  return t
}

/**
 * Topic slugs referenced from a body: `[[wikilinks]]` (with optional
 * `#heading` / `|alias`) plus markdown links pointing at bundle paths.
 * These are the human-authored edges alongside `depends` — both feed the
 * retrieval graph walk and the backlinks index. Inline code and fenced
 * code blocks are stripped first: topics that document link syntax would
 * otherwise mint permanent phantom edges out of their own examples.
 */
export function bodyLinkSlugs(body: string): string[] {
  const out = new Set<string>()
  const prose = body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '')
  for (const m of prose.matchAll(WIKILINK)) {
    const slug = normalizeLinkTarget(m[1])
    if (slug !== undefined) out.add(slug)
  }
  for (const m of prose.matchAll(MD_LINK)) {
    const slug = normalizeLinkTarget(m[1])
    if (slug !== undefined) out.add(slug)
  }
  out.delete('')
  return [...out]
}

/** The conventional profile headings, for validators and tooling. */
export const CONCLUSION_HEADING = 'Conclusion'
export const RECOMMENDATIONS_HEADING = 'Recommendations'
