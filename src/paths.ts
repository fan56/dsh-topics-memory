/**
 * Path resolution for the local bundle (ADR 0008): the Cache lives at
 * `~/.dsh/topics/` (override with $DSH_TOPICS_HOME for tests), laid out as
 * an OKF bundle:
 *
 *   <root>/topics/<slug>.md      concept documents
 *   <root>/index.md              auto-generated bundle index
 *   <root>/meta/observations.jsonl   undistilled observations (M2)
 *   <root>/meta/injections.jsonl     injection log (ADR 0007)
 *   <root>/meta/conflicts.json       rebase-conflicted topics (ADR 0003)
 *
 * @module paths
 */

import { existsSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'

export function resolveDshHome(): string {
  const env = process.env.DSH_HOME?.trim()
  if (env !== undefined && env !== '') return env
  return join(homedir(), '.dsh')
}

export function resolveBundleRoot(): string {
  const env = process.env.DSH_TOPICS_HOME?.trim()
  if (env !== undefined && env !== '') return env
  const dshHome = resolveDshHome()
  return migrateLegacyBundleRoot(join(dshHome, 'topics'), join(dshHome, 'llmwiki'))
}

/**
 * Minimal fs surface, injectable so tests can hit the rename-race catch
 * deterministically (a real-fs test cannot mutate the world between the
 * guard checks and the rename). Defaults to the real node:fs functions —
 * production callers never pass it.
 */
interface FsLike {
  existsSync(path: string): boolean
  renameSync(from: string, to: string): void
}

/**
 * One-time migration from the pre-rename data location (`~/.dsh/llmwiki` to
 * `~/.dsh/topics`, ADR 0013). Constraints:
 * - one-time: fires only while the new directory is absent and the legacy one
 *   exists; after the rename (or a fresh bundle on the new path) the check is
 *   a no-op;
 * - fail-open: any rename error falls back to the legacy path so the plugin
 *   keeps serving the old bundle instead of booting an empty new one;
 * - bypassed entirely by an explicit $DSH_TOPICS_HOME (test/CI isolation).
 */
export function migrateLegacyBundleRoot(next: string, legacy: string, fs: FsLike = { existsSync, renameSync }): string {
  if (fs.existsSync(next) || !fs.existsSync(legacy)) return next
  try {
    fs.renameSync(legacy, next)
    return next
  } catch {
    // A concurrent boot may have won the rename: re-check the live filesystem
    // instead of trusting the stale pre-rename view — falling back to `legacy`
    // after it was moved away would strand this session on a dead path (empty
    // bundle, writes into an orphan directory nothing will ever read).
    return fs.existsSync(next) ? next : legacy
  }
}

export function topicsDir(root: string): string {
  return join(root, 'topics')
}

export function metaDir(root: string): string {
  return join(root, 'meta')
}

export function topicFile(root: string, slug: string): string {
  return join(root, 'topics', `${slug}.md`)
}

export function indexFile(root: string): string {
  return join(root, 'index.md')
}

export function observationsFile(root: string): string {
  return join(metaDir(root), 'observations.jsonl')
}

export function injectionsFile(root: string): string {
  return join(metaDir(root), 'injections.jsonl')
}

export function conflictsFile(root: string): string {
  return join(metaDir(root), 'conflicts.json')
}

/** Sanitized host name recorded in `generated.by` for multi-machine provenance. */
export function hostId(): string {
  return osHostname().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'unknown-host'
}

/** The actor string stamped into `generated.by` for machine-written topics. */
export function actorFor(): string {
  return `agent:dsh-topics-memory@${hostId()}`
}

/**
 * Current workspace identifier for lesson scope filtering (B2 MJ-2, spec
 * 卷一 §6.2): the sha256 prefix of the process cwd, overridable via
 * $DSH_TOPICS_WORKSPACE_ID (tests / multi-root hosts; the override also lets
 * a host pin one identity across chdirs). 拍板（spec 未钉死来源）: cwd hash at
 * read time is the minimal viable source — the same derivation the lesson
 * write path stamps into frontmatter.workspaceId, so no config plumbing.
 */
export function currentWorkspaceId(): string {
  const env = process.env.DSH_TOPICS_WORKSPACE_ID?.trim()
  if (env !== undefined && env !== '') return env
  return createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16)
}
