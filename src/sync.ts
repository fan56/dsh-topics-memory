/**
 * GitHub sync layer (ADR 0002/0003/0008) — active only when the `repo`
 * setting is non-empty; local-only mode bypasses the whole module.
 *
 * Semantics: pull --rebase (autostash) on session start and before each
 * push; push debounced (config, default 45s) after write-through commits,
 * hard flush on session end / plugin dispose. A rebase conflict aborts the
 * rebase and marks the conflicted topics — demoted in retrieval with a
 * visible warning, resolved by hand (ADR 0003: no automatic smart merging).
 *
 * @module sync
 */

import { spawn } from 'node:child_process'
import * as gitmod from './git.ts'
import type { BundleStore } from './store.ts'

export function remoteUrlFor(repo: string): string {
  return `https://github.com/${repo}.git`
}

export interface SyncConfig {
  /** `owner/name`; empty string = local-only mode. */
  repo: string
  pushDebounceSeconds: number
}

export type TokenResolver = () => Promise<string | undefined>
export type UrlResolver = (repo: string) => string

export class Sync {
  private timer: NodeJS.Timeout | undefined
  private pending = false
  private inFlight: Promise<void> = Promise.resolve()
  lastError = ''
  lastPushAt?: string
  lastPullAt?: string
  private readonly store: BundleStore
  private readonly cfg: () => SyncConfig
  private readonly token: TokenResolver
  private readonly urlFor: UrlResolver

  constructor(store: BundleStore, cfg: () => SyncConfig, token: TokenResolver = defaultTokenResolver, urlFor: UrlResolver = remoteUrlFor) {
    this.store = store
    this.cfg = cfg
    this.token = token
    this.urlFor = urlFor
  }

  get active(): boolean {
    return this.cfg().repo !== ''
  }

  /**
   * Session start (or `/topics sync pull`): rebase onto remote, mark
   * conflicts, then replay any push the previous session's local-only exit
   * deferred. The replay is best-effort — a failure just marks lastError and
   * the debounced flush (or the next boot's pull) retries.
   */
  async pull(): Promise<{ ok: boolean; conflicted: string[]; message: string }> {
    if (!this.active) return { ok: true, conflicted: [], message: 'local-only 模式，无同步' }
    const token = await this.safeToken()
    await gitmod.setRemote(this.store.root, this.urlFor(this.cfg().repo))
    if (!(await gitmod.remoteBranchExists(this.store.root, token))) {
      this.lastPullAt = new Date().toISOString()
      return { ok: true, conflicted: [], message: '远端还没有分支，跳过拉取' }
    }
    const outcome = await gitmod.pullRebase(this.store.root, token)
    this.lastPullAt = new Date().toISOString()
    if (outcome.ok) {
      // A successful rebase clears previous conflict marks.
      const prior = await this.store.getConflicts()
      if (prior.size > 0) await this.store.setConflicts([])
      // Deferred-push replay: the previous exit committed locally only, so a
      // successful rebase here is the moment the backlog lands on the remote.
      try {
        if ((await gitmod.unpushedCount(this.store.root)) > 0) {
          const pushed = await gitmod.push(this.store.root, token)
          if (pushed.ok) {
            this.lastPushAt = new Date().toISOString()
            this.lastError = ''
          } else {
            this.lastError = pushed.output.slice(-500)
          }
        }
      } catch {
        // pull must stay best-effort for the session-start caller
      }
      return { ok: true, conflicted: [], message: '已与远端同步' }
    }
    const conflictedSlugs = outcome.conflicted.map((p) => p.replace(/^topics\//, '').replace(/\.md$/, ''))
    if (conflictedSlugs.length > 0) {
      await this.store.setConflicts(outcome.conflicted)
    }
    this.lastError = outcome.output.slice(-500)
    // A rebase can fail without producing conflicted paths (identity missing,
    // fetch failure, corrupt state) — surface the git output tail instead of
    // the misleading 「未知路径」 so a headless failure is diagnosable.
    if (conflictedSlugs.length === 0) {
      const tail = outcome.output.trim().split('\n').slice(-3).join('；').slice(-200)
      return { ok: false, conflicted: [], message: `rebase 失败（无冲突文件）：${tail !== '' ? tail : 'git 无输出'}` }
    }
    return { ok: false, conflicted: conflictedSlugs, message: `rebase 冲突：${conflictedSlugs.join('、')}（已标记降权，待手工解决）` }
  }

  /** Called after every write-through commit — schedules the debounced push. */
  schedulePush(): void {
    if (!this.active) return
    this.pending = true
    if (this.timer !== undefined) return
    const seconds = Math.max(1, this.cfg().pushDebounceSeconds)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, seconds * 1000)
    // Never hold the process open for a debounced push.
    this.timer.unref?.()
  }

  /** Debounce flush, also used for session end and plugin dispose. */
  async flush(): Promise<{ ok: boolean; message: string }> {
    if (!this.active) return { ok: true, message: 'local-only 模式，无同步' }
    this.pending = false
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const run = this.inFlight.then(async () => {
      if (!(await this.store.hasGit())) return { ok: false, message: 'bundle 不是 git 仓库' }
      const token = await this.safeToken()
      await gitmod.setRemote(this.store.root, this.urlFor(this.cfg().repo))
      if (await gitmod.remoteBranchExists(this.store.root, token)) {
        const pre = await gitmod.pullRebase(this.store.root, token)
        if (!pre.ok) {
          const conflicted = pre.conflicted.map((p) => p.replace(/^topics\//, '').replace(/\.md$/, ''))
          if (conflicted.length > 0) await this.store.setConflicts(pre.conflicted)
          this.lastError = pre.output.slice(-500)
          return { ok: false, message: `push 前 rebase 失败：${conflicted.join('、') || pre.output.slice(-120)}` }
        }
      }
      const result = await gitmod.push(this.store.root, token)
      if (result.ok) {
        this.lastPushAt = new Date().toISOString()
        this.lastError = ''
        return { ok: true, message: '已推送到远端' }
      }
      this.lastError = result.output.slice(-500)
      return { ok: false, message: `push 失败：${result.output.slice(-160)}` }
    })
    this.inFlight = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Commit the meta sidecars (injection log, observations) — flush cadence. */
  async commitMeta(): Promise<void> {
    if (!this.active) return
    await gitmod.addAndCommit(this.store.root, ['meta'], 'topics(meta): flush injection log / observations').catch(() => undefined)
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private async safeToken(): Promise<string | undefined> {
    try {
      return await this.token()
    } catch {
      return undefined
    }
  }
}

/** Env first, gh CLI fallback per dsh-vault precedent; login is never our job. */
async function defaultTokenResolver(): Promise<string | undefined> {
  const env = process.env.GITHUB_TOKEN?.trim()
  if (env !== undefined && env !== '') return env
  return ghCliToken()
}

/** gh CLI fallback per dsh-vault precedent; login is never this plugin's job. */
async function ghCliToken(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn('gh', ['auth', 'token'], { stdio: ['ignore', 'pipe', 'ignore'], env: process.env })
    let out = ''
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8')
    })
    child.on('error', () => resolve(undefined))
    child.on('close', (code) => resolve(code === 0 ? out.trim() || undefined : undefined))
  })
}
