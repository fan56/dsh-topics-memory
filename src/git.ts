/**
 * Git CLI wrapper for the bundle Cache (ADR 0002/0003).
 *
 * Every command is an argv-array child process (no shell), with a timeout and
 * a plugin identity for commits (`user.name`/`user.email` via -c, never
 * touching the user's git config). In GitHub mode the token is attached
 * per-invocation as an http.extraHeader — it never lands in the remote URL,
 * .git/config, or any file (ADR 0002).
 *
 * @module git
 */

import { spawn } from 'node:child_process'

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

export class GitError extends Error {
  override name = 'GitError'
  readonly result: GitResult
  constructor(message: string, result: GitResult) {
    super(message)
    this.result = result
  }
}

export interface GitRunOptions {
  cwd: string
  timeoutMs?: number
  /** Token for http extra header (push/pull in GitHub mode). */
  token?: string
  /** Throw GitError on non-zero exit (default true). */
  mayFail?: boolean
}

const DEFAULT_TIMEOUT_MS = 30_000

export function runGit(args: readonly string[], opts: GitRunOptions): Promise<GitResult> {
  const extra: string[] = []
  if (opts.token !== undefined && opts.token !== '') {
    const basic = Buffer.from(`x-access-token:${opts.token}`, 'utf8').toString('base64')
    extra.push('-c', `http.extraHeader=Authorization: Basic ${basic}`)
  }
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...extra, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new GitError(`git ${args[0]} timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`, { code: -1, stdout, stderr }))
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const result: GitResult = { code: code ?? -1, stdout, stderr }
      if ((code ?? -1) !== 0 && opts.mayFail !== true) {
        reject(new GitError(`git ${args[0]} failed (${code}): ${stderr.trim().split('\n').at(-1) ?? ''}`, result))
      } else {
        resolve(result)
      }
    })
  })
}

/** Commit identity so bundle history never depends on the machine's git config. */
const IDENTITY = ['-c', 'user.name=dsh-topics-memory', '-c', 'user.email=dsh-topics-memory@localhost']

export async function isRepo(cwd: string): Promise<boolean> {
  const r = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd, mayFail: true }).catch(() => undefined)
  return r !== undefined && r.code === 0 && r.stdout.trim() === 'true'
}

export async function initRepo(cwd: string, branch = 'main'): Promise<void> {
  await runGit(['init', '-b', branch], { cwd })
}

export async function addAndCommit(cwd: string, paths: readonly string[], message: string): Promise<boolean> {
  await runGit(['add', '--', ...paths], { cwd })
  // Commit only when something is staged (write-through must not spam empty commits).
  const staged = await runGit(['diff', '--cached', '--name-only'], { cwd })
  if (staged.stdout.trim() === '') return false
  const r = await runGit([...IDENTITY, 'commit', '-m', message], { cwd })
  return r.code === 0
}

export async function headRev(cwd: string): Promise<string | undefined> {
  const r = await runGit(['rev-parse', 'HEAD'], { cwd, mayFail: true }).catch(() => undefined)
  if (r === undefined || r.code !== 0) return undefined
  return r.stdout.trim()
}

export interface HistoryEntry {
  hash: string
  date: string
  message: string
}

/** Per-file history — the toolized exit of 「git 可追溯」(need 3). */
export async function fileHistory(cwd: string, path: string, limit = 50): Promise<HistoryEntry[]> {
  const r = await runGit(
    ['log', '--follow', `--max-count=${limit}`, '--date=iso-strict', '--pretty=%H%x09%ad%x09%s', '--', path],
    { cwd, mayFail: true },
  ).catch(() => undefined)
  if (r === undefined || r.code !== 0) return []
  return r.stdout
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const [hash, date, ...rest] = l.split('\t')
      return { hash: hash ?? '', date: date ?? '', message: rest.join('\t') }
    })
}

/** The full content of a topic file at a given revision (conclusion diffing). */
export async function fileAtRev(cwd: string, path: string, rev: string): Promise<string | undefined> {
  const r = await runGit(['show', `${rev}:${path}`], { cwd, mayFail: true }).catch(() => undefined)
  if (r === undefined || r.code !== 0) return undefined
  return r.stdout
}

export interface PullOutcome {
  ok: boolean
  /** Paths left in conflicted state (empty when ok). */
  conflicted: string[]
  output: string
}

/**
 * `pull --rebase` with conflict containment: on conflict we abort the rebase
 * (ADR 0003 — no automatic smart merging) and report the conflicted paths so
 * the caller can mark those topics. Remote and branch are explicit — the
 * bundle never depends on upstream tracking config. IDENTITY rides along:
 * a rebase REPLAYS local commits, which requires a committer identity, and
 * a fresh machine (CI, new host) may have none — without this the pull
 * fails with an empty conflicted list on every session start.
 */
export async function pullRebase(cwd: string, token?: string, remote = 'origin', branch = 'main'): Promise<PullOutcome> {
  const r = await runGit([...IDENTITY, 'pull', '--rebase', '--autostash', remote, branch], { cwd, token, mayFail: true, timeoutMs: 60_000 }).catch((e) => {
    return { code: -1, stdout: '', stderr: String(e instanceof Error ? e.message : e) } satisfies GitResult
  })
  if (r.code === 0) return { ok: true, conflicted: [], output: r.stdout + r.stderr }
  const conflicted = (
    await runGit(['diff', '--name-only', '--diff-filter=U'], { cwd, mayFail: true }).catch(() => ({ code: -1, stdout: '', stderr: '' }) satisfies GitResult)
  ).stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  if (conflicted.length > 0) {
    await runGit(['rebase', '--abort'], { cwd, mayFail: true }).catch(() => undefined)
  }
  return { ok: false, conflicted, output: r.stdout + r.stderr }
}

export async function push(cwd: string, token?: string, remote = 'origin', branch = 'main'): Promise<{ ok: boolean; output: string }> {
  const r = await runGit(['push', remote, branch], { cwd, token, mayFail: true, timeoutMs: 60_000 }).catch((e) => {
    return { code: -1, stdout: '', stderr: String(e instanceof Error ? e.message : e) } satisfies GitResult
  })
  return { ok: r.code === 0, output: (r.stdout + r.stderr).trim() }
}

export async function setRemote(cwd: string, url: string, remote = 'origin'): Promise<void> {
  const existing = await runGit(['remote', 'get-url', remote], { cwd, mayFail: true }).catch(() => undefined)
  if (existing !== undefined && existing.code === 0 && existing.stdout.trim() !== '') {
    await runGit(['remote', 'set-url', remote, url], { cwd })
  } else {
    await runGit(['remote', 'add', remote, url], { cwd })
  }
}

export async function removeRemote(cwd: string, remote = 'origin'): Promise<void> {
  await runGit(['remote', 'remove', remote], { cwd, mayFail: true }).catch(() => undefined)
}

export async function hasRemote(cwd: string, remote = 'origin'): Promise<boolean> {
  const r = await runGit(['remote', 'get-url', remote], { cwd, mayFail: true }).catch(() => undefined)
  return r !== undefined && r.code === 0 && r.stdout.trim() !== ''
}

export async function unpushedCount(cwd: string, remote = 'origin', branch = 'main'): Promise<number> {
  const r = await runGit(['rev-list', '--count', `${remote}/${branch}..${branch}`], { cwd, mayFail: true }).catch(() => undefined)
  if (r === undefined || r.code !== 0) return 0
  return Number(r.stdout.trim()) || 0
}

/** True when the remote advertises the branch — empty remotes skip the pull step. */
export async function remoteBranchExists(cwd: string, token?: string, remote = 'origin', branch = 'main'): Promise<boolean> {
  const r = await runGit(['ls-remote', '--heads', remote, branch], { cwd, token, mayFail: true, timeoutMs: 60_000 }).catch(() => undefined)
  return r !== undefined && r.code === 0 && r.stdout.trim() !== ''
}
