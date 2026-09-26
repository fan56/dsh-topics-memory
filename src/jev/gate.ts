/**
 * Outbound secret gate (design 2026-09-25 §3.3) — self-contained port of the
 * dsh-jev-mcp `server.mjs` mechanism. The COMPLETE serialized request body
 * (model, state, questions — byte-identical to what goes on the wire) is
 * scanned for credential patterns BEFORE anything leaves the process; a hit
 * aborts the call with a structured descriptor that never echoes the secret.
 *
 * SECURITY INVARIANT: hit descriptors carry static metadata only (pattern
 * name, offset, ≤10 printable chars before the hit) — never the matched
 * text, and never text at or after the hit point.
 *
 * @module jev/gate
 */

import { readFileSync } from 'node:fs'

export interface SecretGateHit {
  pattern: string
  offset: number
  context: string
}

/** Minimal logger surface (both sinks optional — bare harnesses have none);
 *  the gate only ever warns, and a broken logger must not break the gate. */
export interface GateLogger {
  warn?: (m: string) => void
}

function safeWarn(log: GateLogger | undefined, message: string): void {
  try {
    log?.warn?.(message)
  } catch {
    // contained — diagnostics never take the feature down
  }
}

// Prefix-style patterns require a 20+ char continuation so that merely
// DISCUSSING a prefix (e.g. "set OPENROUTER_API_KEY to an sk-or-v1- key")
// never trips the gate — only an actual long token does.
export const BUILTIN_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'openrouter-key', re: /sk-or-v1-[A-Za-z0-9_-]{20,}/ },
  { name: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'openai-project-key', re: /sk-proj-[A-Za-z0-9_-]{20,}/ },
  { name: 'openai-sk-key', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'github-token', re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: 'github-pat', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'gitlab-token', re: /glpat-[A-Za-z0-9_-]{20,}/ },
  { name: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{20,}/ },
  { name: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'aws-temp-key-id', re: /ASIA[0-9A-Z]{16}/ },
  { name: 'google-api-key', re: /AIza[A-Za-z0-9_-]{20,}/ },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]

const MAX_SECRET_LINE = 512 // longer lines WARN; matching ALWAYS uses the full line
const MIN_EXTERNAL_SECRET = 8 // shorter entries would cause runaway false hits

/** Literal secrets from the external list file (JEV_SECRET_FILE semantics:
 *  one entry per line, ≥8 chars, `#` comments skipped, matched at FULL
 *  length — a >512-char line warns but is never truncated, or everything
 *  past char 512 would silently escape the gate). */
export function loadExternalSecrets(file: string, log?: GateLogger): string[] {
  if (file === '') return []
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    safeWarn(log, `topics jev: cannot read jevSecretFile (${file}): ${err instanceof Error ? err.message : String(err)}; continuing without it.`)
    return []
  }
  const secrets: string[] = []
  raw.split(/\r?\n/).forEach((line, i) => {
    const s = line.trim()
    if (s === '' || s.startsWith('#')) return
    if (s.length < MIN_EXTERNAL_SECRET) {
      safeWarn(log, `topics jev: jevSecretFile line ${i + 1} shorter than ${MIN_EXTERNAL_SECRET} chars, skipped (false-positive guard).`)
      return
    }
    if (s.length > MAX_SECRET_LINE) {
      safeWarn(log, `topics jev: jevSecretFile line ${i + 1} is ${s.length} chars (> ${MAX_SECRET_LINE}); matching uses the FULL line (no truncation).`)
    }
    secrets.push(s)
  })
  return secrets
}

// One-time-per-path load, mirroring the reference implementation's
// load-once-at-startup while staying compatible with the volatile
// `jevSecretFile` config: an unchanged path is served from the cache (no
// re-read), a swapped path reloads on the next call. `reloadSecrets` forces
// a re-read — the `/topics set jev-secret-file` wiring calls it so an
// in-place content change is picked up too.
let cache: { file: string; secrets: string[] } = { file: '', secrets: [] }

export function currentSecrets(file: string, log?: GateLogger): string[] {
  if (cache.file !== file) reloadSecrets(file, log)
  return cache.secrets
}

export function reloadSecrets(file: string, log?: GateLogger): string[] {
  cache = { file, secrets: loadExternalSecrets(file, log) }
  return cache.secrets
}

/**
 * Redacted context: at most 10 printable chars BEFORE the hit plus an
 * explicit [REDACTED:<pattern>] marker. Content at or after the hit point is
 * NEVER shown — when a prefix regex under-matches, the secret tail sits
 * right there. Belt and suspenders: if the matched text or any known
 * external secret still appears in the context, the whole context collapses
 * to '[REDACTED]'.
 */
export function describeHit(
  pattern: string,
  offset: number,
  matched: string,
  payload: string,
  externalSecrets: readonly string[] = [],
): SecretGateHit {
  const before = payload.slice(Math.max(0, offset - 10), offset).replace(/[^\x20-\x7e]/g, '.') // keep it printable
  const context = `${before}[REDACTED:${pattern}]`
  if (context.includes(matched) || externalSecrets.some((s) => s !== '' && context.includes(s))) {
    return { pattern, offset, context: '[REDACTED]' }
  }
  return { pattern, offset, context }
}

/**
 * Scan the serialized outbound payload for secrets.
 * @param payload JSON.stringify({model, state, questions}) — the exact wire body
 * @param externalSecrets literal secrets from the external list (cached via currentSecrets)
 * @param externalSource label for hit descriptors (the list file path)
 */
export function scanForSecrets(
  payload: string,
  externalSecrets: readonly string[] = [],
  externalSource = '',
): SecretGateHit | null {
  for (const { name, re } of BUILTIN_PATTERNS) {
    const m = re.exec(payload)
    if (m) return describeHit(name, m.index, m[0], payload, externalSecrets)
  }
  for (const secret of externalSecrets) {
    const idx = payload.indexOf(secret)
    if (idx !== -1) {
      return describeHit(externalSource !== '' ? `external(${externalSource})` : 'external', idx, secret, payload, externalSecrets)
    }
  }
  return null
}
