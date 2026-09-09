/**
 * Bundle store — reads and writes the local OKF bundle (the Cache).
 *
 * All writes go through a serialized queue: one git commit per topic save
 * (write-through, ADR 0003) plus a regenerated `index.md`. Observations and
 * the injection log are JSONL sidecars under `meta/`; they are committed on
 * the flush cadence (sync layer), not per append.
 *
 * @module store
 */

import {
  readdir,
  readFile,
  writeFile,
  rename,
  mkdir,
  appendFile,
  access,
} from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { constants as FsConstants } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as okf from './okf.ts'
import * as gitmod from './git.ts'
import { actorFor } from './paths.ts'
import type { InjectionRecord } from './ilog.ts'

export interface TopicMeta {
  slug: string
  title: string
  description?: string
  status: okf.TopicStatus
  tags: string[]
  depends: string[]
  generatedAt: string
}

export type ObservationKind = 'decision' | 'finding' | 'constraint' | 'question' | 'turn'

export interface Observation {
  id: string
  at: string
  kind: ObservationKind
  source: 'model' | 'auto'
  text: string
  sessionId?: string
  distilled: boolean
  distilledInto?: string[]
  /** Failed distill attempts: fed to the model but consumed by no op (GC counter). */
  attempts?: number
}

export interface SaveResult {
  slug: string
  path: string
  committed: boolean
  created: boolean
}

export class StoreError extends Error {
  override name = 'StoreError'
}

function existsSync(path: string): Promise<boolean> {
  return access(path, FsConstants.F_OK).then(
    () => true,
    () => false,
  )
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${randomUUID()}`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

function dedupePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    if (p === '' || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export interface BundleStoreOptions {
  /** Override the stamped actor (tests). Defaults to `agent:dsh-topics-memory@<host>`. */
  actor?: string
  /** Disable git operations entirely (pure-filesystem tests). */
  gitDisabled?: boolean
}

export class BundleStore {
  readonly root: string
  private readonly actor: string
  private readonly gitDisabled: boolean
  /** Serializes all write paths; reads are lock-free. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(root: string, opts: BundleStoreOptions = {}) {
    this.root = root
    this.actor = opts.actor ?? actorFor()
    this.gitDisabled = opts.gitDisabled === true
  }

  /** Serialize an async write operation behind the store-wide queue. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op)
    this.queue = run.catch(() => undefined)
    return run
  }

  topicsDir(): string {
    return join(this.root, 'topics')
  }

  metaDir(): string {
    return join(this.root, 'meta')
  }

  topicPath(slug: string): string {
    return join(this.root, 'topics', `${slug}.md`)
  }

  private observationsPath(): string {
    return join(this.metaDir(), 'observations.jsonl')
  }

  private injectionsPath(): string {
    return join(this.metaDir(), 'injections.jsonl')
  }

  private conflictsPath(): string {
    return join(this.metaDir(), 'conflicts.json')
  }

  private distillStatePath(): string {
    return join(this.metaDir(), 'distill-state.json')
  }

  /** Last distill-lane run outcome (diagnostics for /topics status and e2e). */
  async writeDistillState(state: unknown): Promise<void> {
    await mkdir(this.metaDir(), { recursive: true })
    await atomicWrite(this.distillStatePath(), `${JSON.stringify(state, null, 2)}\n`)
  }

  async readDistillState(): Promise<Record<string, unknown> | undefined> {
    try {
      return JSON.parse(await readFile(this.distillStatePath(), 'utf8')) as Record<string, unknown>
    } catch {
      return undefined
    }
  }

  private consolidateStatePath(): string {
    return join(this.metaDir(), 'consolidate-state.json')
  }

  /** Last consolidation-lane run outcome (cadence stamp + /topics status). */
  async writeConsolidateState(state: unknown): Promise<void> {
    await mkdir(this.metaDir(), { recursive: true })
    await atomicWrite(this.consolidateStatePath(), `${JSON.stringify(state, null, 2)}\n`)
  }

  async readConsolidateState(): Promise<Record<string, unknown> | undefined> {
    try {
      return JSON.parse(await readFile(this.consolidateStatePath(), 'utf8')) as Record<string, unknown>
    } catch {
      return undefined
    }
  }

  /** Create the directory skeleton, git repo, initial index, and repair
   * wrapped depends entries left by older save paths (idempotent). */
  async ensure(): Promise<void> {
    await mkdir(this.topicsDir(), { recursive: true })
    await mkdir(this.metaDir(), { recursive: true })
    if (!this.gitDisabled && !(await gitmod.isRepo(this.root))) {
      await gitmod.initRepo(this.root)
    }
    if (!(await existsSync(join(this.root, 'index.md')))) {
      await this.enqueue(() => this.regenerateIndex())
    }
    await this.repairDepends()
  }

  /** Repo initialized and not gitDisabled. */
  async hasGit(): Promise<boolean> {
    return !this.gitDisabled && gitmod.isRepo(this.root)
  }

  private async commit(paths: readonly string[], message: string): Promise<boolean> {
    if (this.gitDisabled) return false
    if (!(await gitmod.isRepo(this.root))) return false
    return gitmod.addAndCommit(this.root, paths, message)
  }

  async listTopics(): Promise<TopicMeta[]> {
    let files: string[]
    try {
      files = await readdir(this.topicsDir())
    } catch {
      return []
    }
    const metas: TopicMeta[] = []
    for (const f of files) {
      if (!f.endsWith('.md') || f === 'index.md') continue
      try {
        const raw = await readFile(join(this.topicsDir(), f), 'utf8')
        const doc = okf.parseTopicDoc(raw)
        metas.push({
          slug: f.slice(0, -3),
          title: doc.fm.title,
          description: doc.fm.description,
          status: doc.fm.status,
          tags: doc.fm.tags,
          depends: doc.fm.depends,
          generatedAt: doc.fm.generated.at,
        })
      } catch {
        // Broken topic files are skipped from rosters; status() surfaces them.
      }
    }
    return metas
  }

  /** Topics broken beyond parsing — surfaced by /topics status, never silently dropped. */
  async brokenTopics(): Promise<string[]> {
    let files: string[]
    try {
      files = await readdir(this.topicsDir())
    } catch {
      return []
    }
    const broken: string[] = []
    for (const f of files) {
      if (!f.endsWith('.md') || f === 'index.md') continue
      try {
        okf.parseTopicDoc(await readFile(join(this.topicsDir(), f), 'utf8'))
      } catch {
        broken.push(f)
      }
    }
    return broken
  }

  async readTopic(slug: string): Promise<okf.TopicDoc | undefined> {
    if (!okf.RESERVED_FILES.has(`${slug}.md`)) {
      try {
        return okf.parseTopicDoc(await readFile(this.topicPath(slug), 'utf8'))
      } catch (e) {
        if (e instanceof Error && e.name === 'OkfError') throw e
        return undefined
      }
    }
    return undefined
  }

  async exists(slug: string): Promise<boolean> {
    return existsSync(this.topicPath(slug))
  }

  /**
   * Upgrade repair for bundles written by the save path that stacked another
   * `topics/….md` wrap onto preserved-on-update depends entries, leaving
   * multi-wrapped references (`topics/topics/foo.md.md`) whose edges resolve
   * to nothing. Unwraps in place behind the write queue, regenerates the
   * derived files, and lands the result as one traceable commit; file
   * rewrites happen even without git, the commit just doesn't. Idempotent —
   * every clean startup re-scans and finds nothing to change.
   */
  private async repairDepends(): Promise<void> {
    await this.enqueue(async () => {
      let files: string[]
      try {
        files = await readdir(this.topicsDir())
      } catch {
        return
      }
      const changed: string[] = []
      for (const f of files) {
        if (!f.endsWith('.md') || f === 'index.md') continue
        const file = join(this.topicsDir(), f)
        let doc: okf.TopicDoc
        try {
          doc = okf.parseTopicDoc(await readFile(file, 'utf8'))
        } catch {
          continue // broken files are status()'s business, not the repair's
        }
        const normalized = dedupePaths(doc.fm.depends.map(okf.normalizeDependsEntry))
        if (sameStrings(normalized, doc.fm.depends)) continue
        doc.fm.depends = normalized
        await atomicWrite(file, okf.serializeTopicDoc(doc))
        changed.push(`topics/${f}`)
      }
      if (changed.length === 0) return
      await this.regenerateIndex()
      await this.commit([...changed, 'index.md'], `topics(migrate): repair wrapped depends entries in ${changed.length} topic file(s)`)
    })
  }

  /** First free slug: `foo`, then `foo-2`, `foo-3`, … */
  async uniqueSlug(base: string): Promise<string> {
    const clean = okf.slugify(base)
    if (!(await this.exists(clean))) return clean
    for (let i = 2; ; i += 1) {
      const candidate = `${clean}-${i}`
      if (!(await this.exists(candidate))) return candidate
    }
  }

  /**
   * Write a topic (atomic), regenerate the index, and commit both — one
   * commit per conclusion change (ADR 0003). `slug` in the doc's depends is
   * NOT normalized here; callers pass bundle-relative paths.
   */
  async saveTopic(
    input: { slug: string; doc: okf.TopicDoc },
    opts: { message: string; actor?: string; created?: boolean },
  ): Promise<SaveResult> {
    return this.enqueue(async () => {
      const slug = okf.slugify(input.slug)
      const file = this.topicPath(slug)
      const created = opts.created ?? !(await existsSync(file))
      const now = new Date().toISOString()
      const doc: okf.TopicDoc = {
        fm: { ...input.doc.fm, generated: { by: opts.actor ?? this.actor, at: now } },
        body: input.doc.body,
      }
      const raw = okf.serializeTopicDoc(doc)
      await atomicWrite(file, raw)
      await this.regenerateIndex()
      const committed = await this.commit([`topics/${slug}.md`, 'index.md'], opts.message)
      return { slug, path: `topics/${slug}.md`, committed, created }
    })
  }

  private async regenerateIndex(): Promise<void> {
    const metas = await this.listTopics()
    const entries: okf.IndexEntry[] = metas.map((m) => ({
      slug: m.slug,
      title: m.title,
      description: m.description,
      status: m.status,
      tags: m.tags,
    }))
    await atomicWrite(join(this.root, 'index.md'), okf.renderIndex(entries))
    await atomicWrite(join(this.metaDir(), 'backlinks.json'), `${JSON.stringify(await this.computeBacklinks(), null, 2)}\n`)
  }

  /**
   * Reverse-reference index: slug → who references it and how (`depends`
   * edges + body links). Regenerated on every topic write (ADR 0003
   * write-through), so it never drifts from the files.
   */
  private async computeBacklinks(): Promise<Record<string, { slug: string; via: 'depends' | 'link' }[]>> {
    const backlinks: Record<string, { slug: string; via: 'depends' | 'link' }[]> = {}
    const push = (target: string, from: string, via: 'depends' | 'link'): void => {
      if (target === from) return
      const list = backlinks[target] ?? []
      if (!list.some((e) => e.slug === from && e.via === via)) list.push({ slug: from, via })
      backlinks[target] = list
    }
    let files: string[]
    try {
      files = await readdir(this.topicsDir())
    } catch {
      return {}
    }
    for (const f of files) {
      if (!f.endsWith('.md') || f === 'index.md') continue
      const slug = f.slice(0, -3)
      try {
        const doc = okf.parseTopicDoc(await readFile(join(this.topicsDir(), f), 'utf8'))
        for (const dep of okf.dependsSlugs(doc.fm)) push(dep, slug, 'depends')
        for (const link of okf.bodyLinkSlugs(doc.body)) push(link, slug, 'link')
      } catch {
        // broken files contribute no edges
      }
    }
    return backlinks
  }

  /** Read the generated backlinks index (empty map when absent). */
  async readBacklinks(): Promise<Record<string, { slug: string; via: 'depends' | 'link' }[]>> {
    try {
      const raw = await readFile(join(this.metaDir(), 'backlinks.json'), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, { slug: string; via: 'depends' | 'link' }[]>
      }
    } catch {
      // absent = no backlinks computed yet
    }
    return {}
  }

  // ------------------------------------------------------------------
  // Observations (M2 raw material; tool-written from M1)
  // ------------------------------------------------------------------

  async appendObservation(input: {
    kind: ObservationKind
    source: 'model' | 'auto'
    text: string
    sessionId?: string
  }): Promise<Observation> {
    const obs: Observation = {
      id: `obs-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
      kind: input.kind,
      source: input.source,
      text: input.text,
      distilled: false,
    }
    if (input.sessionId !== undefined) obs.sessionId = input.sessionId
    // Behind the store-wide queue: markDistilled / recordUnconsumed rewrite
    // the whole JSONL file — an unsynchronized append here could interleave
    // with a rewrite and lose either the new observation or the rewrite.
    return this.enqueue(async () => {
      await mkdir(this.metaDir(), { recursive: true })
      await appendFile(this.observationsPath(), `${JSON.stringify(obs)}\n`, 'utf8')
      return obs
    })
  }

  async allObservations(limit = 500): Promise<Observation[]> {
    let raw: string
    try {
      raw = await readFile(this.observationsPath(), 'utf8')
    } catch {
      return []
    }
    const out: Observation[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line) as Observation)
      } catch {
        // Tolerate a torn last line (crash mid-append).
      }
    }
    return out.slice(-limit)
  }

  async undistilledObservations(limit = 40): Promise<Observation[]> {
    return (await this.allObservations(2000)).filter((o) => !o.distilled).slice(-limit)
  }

  async markDistilled(ids: readonly string[], intoSlugs: readonly string[]): Promise<number> {
    return this.enqueue(async () => {
      const all = await this.allObservations(2000)
      const idSet = new Set(ids)
      let changed = 0
      for (const o of all) {
        if (idSet.has(o.id) && !o.distilled) {
          o.distilled = true
          o.distilledInto = [...intoSlugs]
          changed += 1
        }
      }
      if (changed > 0) {
        await atomicWrite(this.observationsPath(), all.map((o) => `${JSON.stringify(o)}\n`).join(''))
        await this.commit(['meta/observations.jsonl'], `topics(meta): distill ${ids.length} observation(s) into ${intoSlugs.join(', ')}`)
      }
      return changed
    })
  }

  /**
   * GC policy for the distill lane: an observation fed to the model but left
   * unconsumed by any op has failed one attempt; after OBSERVATION_MAX_ATTEMPTS
   * failed attempts it is physically deleted. The user explicitly authorized
   * deleting raw observations the lane demonstrably cannot process — the
   * alternative is the same head haunting the backlog forever. Consumed
   * observations leave the pool via markDistilled and never accrue attempts.
   */
  static readonly OBSERVATION_MAX_ATTEMPTS = 3

  /**
   * Post-run GC bookkeeping: increment `attempts` for every observation in
   * `fedIds` that no op in `consumedIds` accounts for, then delete those that
   * reached OBSERVATION_MAX_ATTEMPTS. Returns the deletion count (the caller
   * records it in the distill-state detail). Increments persist with the
   * usual flush cadence; a deletion commits immediately — destroying data
   * must be traceable in git.
   */
  async recordUnconsumed(fedIds: readonly string[], consumedIds: readonly string[]): Promise<{ dropped: number }> {
    return this.enqueue(async () => {
      const all = await this.allObservations(2000)
      const fed = new Set(fedIds)
      const consumed = new Set(consumedIds)
      let changed = 0
      let dropped = 0
      const kept: Observation[] = []
      for (const o of all) {
        if (fed.has(o.id) && !consumed.has(o.id) && !o.distilled) {
          o.attempts = (o.attempts ?? 0) + 1
          changed += 1
        }
        if (!o.distilled && (o.attempts ?? 0) >= BundleStore.OBSERVATION_MAX_ATTEMPTS) {
          dropped += 1
          continue
        }
        kept.push(o)
      }
      if (changed > 0 || dropped > 0) {
        await atomicWrite(this.observationsPath(), kept.map((o) => `${JSON.stringify(o)}\n`).join(''))
      }
      if (dropped > 0) {
        await this.commit(['meta/observations.jsonl'], `topics(meta): gc ${dropped} unprocessable observation(s)`)
      }
      return { dropped }
    })
  }

  // ------------------------------------------------------------------
  // Injection log (ADR 0007) — appended per round, committed on flush
  // ------------------------------------------------------------------

  async appendInjectionRecord(record: unknown): Promise<void> {
    await mkdir(this.metaDir(), { recursive: true })
    await appendFile(this.injectionsPath(), `${JSON.stringify(record)}\n`, 'utf8')
    await this.compactInjectionsIfNeeded()
  }

  private async compactInjectionsIfNeeded(): Promise<void> {
    const file = this.injectionsPath()
    let size = 0
    try {
      size = (await readFile(file, 'utf8')).length
    } catch {
      return
    }
    // ~512KB cap; keep the most recent quarter when exceeded (headroom for
    // the next debounce window before the next compaction).
    if (size <= 512 * 1024) return
    const lines = (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim() !== '')
    await atomicWrite(file, lines.slice(-Math.max(1, Math.floor(lines.length / 4))).map((l) => `${l}\n`).join(''))
  }

  async readInjectionRecords(limit = 2000): Promise<InjectionRecord[]> {
    let raw: string
    try {
      raw = await readFile(this.injectionsPath(), 'utf8')
    } catch {
      return []
    }
    const out: InjectionRecord[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line) as InjectionRecord)
      } catch {
        // Torn tail line tolerated.
      }
    }
    return out.slice(-limit)
  }

  // ------------------------------------------------------------------
  // Pointer-open log (v4 §4.3) — one line per topic_open call; feeds the
  // 「指针打开率」 stat. Features only (slug/time), never conversation text.
  // ------------------------------------------------------------------

  private opensPath(): string {
    return join(this.metaDir(), 'opens.jsonl')
  }

  async appendOpenRecord(record: { slug: string; at: string; sessionId?: string }): Promise<void> {
    await mkdir(this.metaDir(), { recursive: true })
    await appendFile(this.opensPath(), `${JSON.stringify(record)}\n`, 'utf8')
    await this.compactOpensIfNeeded()
  }

  private async compactOpensIfNeeded(): Promise<void> {
    const file = this.opensPath()
    let size = 0
    try {
      size = (await readFile(file, 'utf8')).length
    } catch {
      return
    }
    if (size <= 512 * 1024) return
    const lines = (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim() !== '')
    await atomicWrite(file, lines.slice(-Math.max(1, Math.floor(lines.length / 4))).map((l) => `${l}\n`).join(''))
  }

  /** Opens in the recent window; tolerant of a torn tail like the other JSONLs. */
  async readOpenRecords(limit = 2000): Promise<{ slug: string; at: string; sessionId?: string }[]> {
    let raw: string
    try {
      raw = await readFile(this.opensPath(), 'utf8')
    } catch {
      return []
    }
    const out: { slug: string; at: string; sessionId?: string }[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line) as { slug?: unknown; at?: unknown; sessionId?: unknown }
        if (typeof parsed.slug === 'string' && typeof parsed.at === 'string') {
          const rec: { slug: string; at: string; sessionId?: string } = { slug: parsed.slug, at: parsed.at }
          if (typeof parsed.sessionId === 'string') rec.sessionId = parsed.sessionId
          out.push(rec)
        }
      } catch {
        // Torn tail line tolerated.
      }
    }
    return out.slice(-limit)
  }

  // ------------------------------------------------------------------
  // Conflicted topics (ADR 0003) — retrieval demotes these
  // ------------------------------------------------------------------

  async getConflicts(): Promise<Set<string>> {
    try {
      const raw = await readFile(this.conflictsPath(), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === 'string').map((p) => okf.pathToSlug(p)))
    } catch {
      // absent = no conflicts
    }
    return new Set()
  }

  /** Sync variant for the injection hot path. */
  getConflictsSync(): Set<string> {
    try {
      const raw = readFileSync(this.conflictsPath(), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === 'string').map((p) => okf.pathToSlug(p)))
    } catch {
      // absent = no conflicts
    }
    return new Set()
  }

  async setConflicts(paths: readonly string[]): Promise<void> {
    await this.enqueue(async () => {
      // Only topic files belong here: a rebase can also conflict on meta
      // sidecars (observations.jsonl is appended on both machines), and
      // storing those leaked non-topic paths into the conflicts mark, where
      // /topics status displayed them as if they were topics and the demote
      // gate keyed on slugs that can never exist.
      const topics = [...new Set(paths.filter((p) => /^topics\/.+\.md$/.test(p)))]
      if (topics.length === 0) {
        await atomicWrite(this.conflictsPath(), '[]\n')
      } else {
        await atomicWrite(this.conflictsPath(), `${JSON.stringify(topics, null, 2)}\n`)
      }
      await this.commit(['meta/conflicts.json'], `topics(meta): mark ${topics.length} conflicted topic(s)`)
    })
  }

  // ------------------------------------------------------------------
  // Roster / status
  // ------------------------------------------------------------------

  async status(): Promise<{
    root: string
    topicCount: number
    byStatus: Record<okf.TopicStatus, number>
    observationsPending: number
    observationsTotal: number
    conflicts: string[]
    broken: string[]
    git: boolean
    head?: string
  }> {
    const metas = await this.listTopics()
    const byStatus: Record<okf.TopicStatus, number> = { draft: 0, stable: 0, deprecated: 0 }
    for (const m of metas) byStatus[m.status] += 1
    const obs = await this.allObservations(2000)
    const conflicts = [...(await this.getConflicts())]
    const head = this.gitDisabled ? undefined : await gitmod.headRev(this.root).catch(() => undefined)
    return {
      root: this.root,
      topicCount: metas.length,
      byStatus,
      observationsPending: obs.filter((o) => !o.distilled).length,
      observationsTotal: obs.length,
      conflicts,
      broken: await this.brokenTopics(),
      git: !this.gitDisabled && (await gitmod.isRepo(this.root)),
      head,
    }
  }
}
