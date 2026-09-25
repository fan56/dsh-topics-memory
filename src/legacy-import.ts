/**
 * One-time legacy settings import for the 0.1.5 → 0.1.7 upgrade: the dsh
 * 0.1.7 host renames the old `~/.dsh/settings.yaml` to
 * `settings.yaml.imported` and imports its sections as profile patches keyed
 * by "section name = entry id". This plugin's old section was named `topics`,
 * NOT `dsh-topics-memory` — the host's one-shot import silently drops it.
 * This module recovers it once:
 *
 *   1. read `<home>/settings.yaml.imported` (preferred) →
 *      `<home>/settings.yaml` (fallback);
 *   2. flat-parse the `topics:` section (scalars only, conservative);
 *   3. keep keys whose legacy value differs from the current effective value;
 *   4. `settings.update('dsh-topics-memory', patch)` → on success write the
 *      audit marker `<home>/storages/dsh-topics-memory/legacy-import.json`;
 *      on failure warn and write nothing (the next boot retries);
 *   5. marker present → the whole migration is skipped (idempotent — a
 *      later manual edit of the imported file must not resurrect old values).
 *
 * A marker is written for EVERY settled outcome (imported / no-op /
 * no-legacy / no-section) so this runs at most once per home. Never throws
 * into the caller beyond what the apply()-side catch contains: plugin
 * activation must not depend on this.
 *
 * @module legacy-import
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Profile entry id the recovered values are written to. */
export const ENTRY_ID = 'dsh-topics-memory'

/** Legacy top-level section name in the old settings.yaml. */
export const LEGACY_SECTION = 'topics'

/** Storage dir name for the audit marker (repo dir name, host convention). */
export const STORAGE_DIR_NAME = 'dsh-topics-memory'

/** Legacy keys worth recovering, mapped 1:1 onto Config keys of the same name. */
export const LEGACY_KEYS = ['repo', 'distillProvider', 'distillModel', 'topK', 'totalBudget', 'autoObserve'] as const

export type LegacyKey = (typeof LEGACY_KEYS)[number]

/** The settings seam the import writes through (`ctx.settings.update`). */
export interface SettingsUpdateSeam {
  update(ns: string, patch: object): Promise<void>
}

/** Minimal logger surface (both sinks optional — bare harnesses have none). */
export interface LegacyImportLogger {
  info?(message: string): void
  warn?(message: string): void
}

export interface LegacyImportInput {
  /** Resolved dsh home (`paths.resolveDshHome()` at the call site). */
  home: string
  /** `ctx.settings` — absent/unusable seams skip the import without a marker. */
  settings?: SettingsUpdateSeam | undefined
  /** Host logger (optional). */
  logger?: LegacyImportLogger | undefined
  /** Current effective value for one legacy key (Volatile ref `.get()` at the call site). */
  getCurrent(key: LegacyKey): unknown
}

export type LegacyImportOutcome =
  | 'imported' // ≥1 key written through settings.update, marker written
  | 'no-op' // section found but every key equal/unknown, marker written
  | 'no-legacy' // neither legacy file exists, marker written
  | 'no-section' // legacy file exists without a `topics:` section, marker written
  | 'marker-exists' // already migrated before — nothing touched
  | 'no-settings' // settings seam unusable — no marker, retried next boot
  | 'update-failed' // settings.update rejected — no marker, retried next boot

export interface LegacyImportResult {
  outcome: LegacyImportOutcome
  /** Keys written through settings.update (also in the marker). */
  imported: Record<string, unknown>
  /** Keys not imported, with the reason (audit trail). */
  skipped: Record<string, string>
}

/** Candidates in priority order: the host's renamed document first. */
export function legacySettingsCandidates(home: string): string[] {
  return [join(home, 'settings.yaml.imported'), join(home, 'settings.yaml')]
}

/** Audit marker path: `<home>/storages/<dir>/legacy-import.json`. */
export function legacyMarkerPath(home: string): string {
  return join(home, 'storages', STORAGE_DIR_NAME, 'legacy-import.json')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A fully quoted scalar: balanced matching quote pair. */
function isQuoted(s: string): boolean {
  return s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
}

function unquote(s: string): string {
  const inner = s.slice(1, -1)
  // Double quotes: unescape \" and \\; single quotes: '' is a literal '.
  if (s.startsWith('"')) return inner.replaceAll('\\"', '"').replaceAll('\\\\', '\\')
  return inner.replaceAll("''", "'")
}

/**
 * Scalar inference for one flat `key: value` value. Quoted values are
 * unquoted (mirroring src/yaml.ts); a single-line quoted flow-JSON value
 * (`'["a","b"]'`) is JSON-parsed after unquoting — a malformed one stays a
 * string. Unquoted flow collections are kept as strings (conservative:
 * this is not a full YAML parser). Empty never reaches here (the line
 * parser skips value-less keys — they open a nested block).
 */
export function inferScalar(raw: string): unknown {
  const s = raw.trim()
  if (isQuoted(s)) {
    const inner = unquote(s)
    const t = inner.trim()
    if (t.startsWith('[') || t.startsWith('{')) {
      try {
        return JSON.parse(t)
      } catch {
        // not JSON after all — keep the unquoted string
      }
    }
    return inner
  }
  if (s === 'true' || s === 'True' || s === 'TRUE') return true
  if (s === 'false' || s === 'False' || s === 'FALSE') return false
  if (/^-?\d+$/.test(s) || /^-?\d+\.\d+$/.test(s)) return Number(s)
  return s
}

/**
 * Flat section parser: locate the top-level `section:` line and collect its
 * DIRECT children (`key: value` at one common indent) until the next
 * top-level key. Deliberately conservative — NOT a YAML parser:
 * - `key:` with an empty value (opens a nested map/sequence) is skipped, and
 *   the deeper lines under it never match the child indent, so folded values
 *   are skipped whole;
 * - lines at any other indent are ignored;
 * - an inline value on the header line itself (`section: x`) is not a flat
 *   map → `{}`.
 * Pure function — tests run it against literal strings.
 */
export function parseFlatSection(raw: string, section: string): Record<string, unknown> {
  const lines = raw.split('\n').map((l) => l.replace(/\r$/, ''))
  const header = new RegExp(`^${escapeRegExp(section)}:(.*)$`)
  const start = lines.findIndex((l) => header.test(l))
  if (start < 0) return {}
  // An inline header value means the section is not a block map of children.
  if (lines[start].replace(header, '$1').trim() !== '') return {}
  const out: Record<string, unknown> = {}
  let childIndent: number | undefined
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (indent === 0) break // next top-level key — section over
    if (childIndent === undefined) childIndent = indent
    if (indent !== childIndent) continue // nested block content — skipped
    const match = /^([^\s:][^:]*):(?:[ \t]+(.*))?$/.exec(line.trim())
    if (match === null) continue // not a `key: value` line — skipped
    if (match[2] === undefined || match[2].trim() === '') continue // opens a nested block
    out[match[1].trim()] = inferScalar(match[2])
  }
  return out
}

/**
 * Run the one-time import. Resolves with the outcome; only throws on truly
 * unexpected I/O errors (the apply()-side catch contains those). The marker
 * is written for every settled outcome EXCEPT the retry-worthy failures
 * (`no-settings`, `update-failed`) — those must re-run at the next boot.
 */
export async function runLegacySettingsImport(input: LegacyImportInput): Promise<LegacyImportResult> {
  const skipped: Record<string, string> = {}
  const imported: Record<string, unknown> = {}
  const warn = (message: string): void => {
    try {
      input.logger?.warn?.(message)
    } catch {
      // contained — a broken logger must not break the import
    }
  }
  const info = (message: string): void => {
    try {
      input.logger?.info?.(message)
    } catch {
      // contained
    }
  }

  const markerPath = legacyMarkerPath(input.home)
  if (existsSync(markerPath)) return { outcome: 'marker-exists', imported, skipped }

  // A settings seam that cannot accept the patch is a retry-worthy state:
  // return WITHOUT reading/marking, so a host that mounts the service later
  // (and a test harness pointing at a real home) neither imports nor writes.
  const settings = input.settings
  if (settings === undefined || typeof settings.update !== 'function') {
    return { outcome: 'no-settings', imported, skipped }
  }

  // Locate the legacy document.
  const source = legacySettingsCandidates(input.home).find((p) => existsSync(p))
  if (source === undefined) {
    writeMarker(markerPath, { at: new Date().toISOString(), outcome: 'no-legacy', source: undefined, imported, skipped })
    return { outcome: 'no-legacy', imported, skipped }
  }

  const section = parseFlatSection(readFileSync(source, 'utf8'), LEGACY_SECTION)
  // The marker records the source BASENAME: the marker lives inside the same
  // home, so the directory part is implied.
  const sourceName = source.slice(source.lastIndexOf('/') + 1)
  const present = Object.keys(section)
  if (present.length === 0) {
    writeMarker(markerPath, { at: new Date().toISOString(), outcome: 'no-section', source: sourceName, imported, skipped })
    return { outcome: 'no-section', imported, skipped }
  }

  // Key-level rule: import only when the legacy value differs from the
  // current effective value; keys this plugin does not know are recorded and
  // left alone (an unknown key would be rejected by the host's schema).
  for (const key of present) {
    if (!(LEGACY_KEYS as readonly string[]).includes(key)) {
      skipped[key] = 'unknown-key'
      continue
    }
    const legacyValue = section[key]
    if (legacyValue === input.getCurrent(key as LegacyKey)) skipped[key] = 'equal'
    else imported[key] = legacyValue
  }

  if (Object.keys(imported).length === 0) {
    writeMarker(markerPath, { at: new Date().toISOString(), outcome: 'no-op', source: sourceName, imported, skipped })
    info(`${ENTRY_ID}: legacy settings import (${LEGACY_SECTION} → ${ENTRY_ID}): nothing to import (all values equal or unknown)`)
    return { outcome: 'no-op', imported, skipped }
  }

  try {
    await settings.update(ENTRY_ID, imported)
  } catch (error) {
    // No marker: the next boot retries the import.
    warn(`${ENTRY_ID}: legacy settings import failed (will retry next boot): ${error instanceof Error ? error.message : String(error)}`)
    return { outcome: 'update-failed', imported, skipped }
  }

  writeMarker(markerPath, { at: new Date().toISOString(), outcome: 'imported', source: sourceName, imported, skipped })
  info(`${ENTRY_ID}: legacy settings import (${LEGACY_SECTION} → ${ENTRY_ID}): ${Object.keys(imported).join(', ')}`)
  return { outcome: 'imported', imported, skipped }
}

/** Persist the audit marker; a failed write leaves no marker (harmless — the
 *  next boot re-runs and converges, every step after the marker check is
 *  idempotent). */
function writeMarker(path: string, marker: Record<string, unknown>): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`)
  } catch {
    // contained — see above
  }
}
