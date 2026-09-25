import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENTRY_ID,
  LEGACY_KEYS,
  LEGACY_SECTION,
  inferScalar,
  legacyMarkerPath,
  legacySettingsCandidates,
  parseFlatSection,
  runLegacySettingsImport,
} from '../lib/legacy-import.js'

// One-time legacy settings import (0.1.5 → 0.1.7): the host's one-shot
// settings.yaml import keys sections by "section name = entry id", so this
// plugin's old `topics:` section was silently dropped. Parser tests are pure
// string-in/string-out; import-logic tests run against a tmp dsh home with a
// fake settings seam (the marker file is the observable contract).

function tmpHome() {
  return mkdtempSync(join(tmpdir(), 'topics-legacy-'))
}

function writeLegacyDoc(home, name, body) {
  writeFileSync(join(home, name), body)
}

/** Fake settings seam recording update() calls; `fail` makes update reject. */
function fakeSettings({ fail = false } = {}) {
  const calls = []
  return {
    seam: {
      async update(ns, patch) {
        if (fail) throw new Error('settings service exploded')
        calls.push({ ns, patch })
      },
    },
    calls,
  }
}

function fakeLogger() {
  const lines = []
  return {
    logger: {
      info: (m) => lines.push({ level: 'info', message: m }),
      warn: (m) => lines.push({ level: 'warn', message: m }),
    },
    lines,
  }
}

// ---- Parser (pure) -----------------------------------------------------------

test('parse: flat section collects scalars with number/boolean/string inference', () => {
  const doc = [
    'ui-theme:',
    '  preference: light',
    'topics:',
    '  repo: fan56/dsh-wiki-memory',
    '  distillProvider: zai-coding-cn',
    '  distillModel: glm-5.3-flash',
    '  topK: 4',
    '  totalBudget: 1500',
    '  autoObserve: true',
    'dsh-tui:',
    '  preference: dark',
  ].join('\n')
  assert.deepEqual(parseFlatSection(doc, LEGACY_SECTION), {
    repo: 'fan56/dsh-wiki-memory',
    distillProvider: 'zai-coding-cn',
    distillModel: 'glm-5.3-flash',
    topK: 4,
    totalBudget: 1500,
    autoObserve: true,
  })
})

test('parse: quoted values are unquoted (single and double)', () => {
  const doc = [
    'topics:',
    `  repo: 'fan56/dsh-wiki'`,
    '  distillModel: "glm-5.3-flash"',
    "  injectMode: 'pointer'",
  ].join('\n')
  const parsed = parseFlatSection(doc, 'topics')
  assert.equal(parsed.repo, 'fan56/dsh-wiki')
  assert.equal(parsed.distillModel, 'glm-5.3-flash')
  assert.equal(parsed.injectMode, 'pointer')
})

test('parse: single-line quoted flow JSON is JSON-parsed after unquoting', () => {
  const doc = [
    'topics:',
    `  managedRoutes: '["a","b"]'`,
    `  nested: '{"k": 1}'`,
    `  broken: '[not json'`,
  ].join('\n')
  const parsed = parseFlatSection(doc, 'topics')
  assert.deepEqual(parsed.managedRoutes, ['a', 'b'])
  assert.deepEqual(parsed.nested, { k: 1 })
  assert.equal(parsed.broken, '[not json') // malformed JSON stays a string
})

test('parse: nested blocks and folded values are skipped conservatively', () => {
  const doc = [
    'topics:',
    '  repo: fan56/dsh-wiki-memory',
    '  nested:',
    '    inner: 1',
    '    deeper:',
    '      leaf: 2',
    '  topK: 6',
    'other:',
    '  key: value',
  ].join('\n')
  const parsed = parseFlatSection(doc, 'topics')
  // `nested` opens a block (skipped), its children sit at a deeper indent
  // (skipped), and scalars before/after the block at the child indent survive.
  assert.deepEqual(parsed, { repo: 'fan56/dsh-wiki-memory', topK: 6 })
})

test('parse: absent section and inline-value section both yield an empty map', () => {
  assert.deepEqual(parseFlatSection('other:\n  key: 1\n', 'topics'), {})
  assert.deepEqual(parseFlatSection('topics: []\n', 'topics'), {}, 'inline value = not a flat block map')
})

test('parse: section ends at the next top-level key — no leakage', () => {
  const doc = 'topics:\n  topK: 3\nafter:\n  totalBudget: 999\n'
  assert.deepEqual(parseFlatSection(doc, 'topics'), { topK: 3 })
})

test('parse: inferScalar covers the scalar vocabulary directly', () => {
  assert.equal(inferScalar('plain'), 'plain')
  assert.equal(inferScalar('4'), 4)
  assert.equal(inferScalar('0.3'), 0.3)
  assert.equal(inferScalar('true'), true)
  assert.equal(inferScalar('false'), false)
  assert.equal(inferScalar("'quoted: value'"), 'quoted: value')
  assert.deepEqual(inferScalar(`'["x"]'`), ['x'])
})

// ---- Import logic (tmp home + fake seam) --------------------------------------

const LEGACY_DOC = [
  'topics:',
  '  repo: fan56/dsh-wiki-memory',
  '  distillProvider: zai-coding-cn',
  '  distillModel: glm-5.3-flash',
  '  topK: 4',
  '  totalBudget: 1500',
  '  autoObserve: true',
  '',
].join('\n')

/** Defaults mirroring the live schema so "equal" is deterministic per key. */
const CURRENT = {
  repo: '',
  distillProvider: '',
  distillModel: '',
  topK: 4,
  totalBudget: 1500,
  autoObserve: true,
}

function boot(input = {}) {
  const home = input.home ?? tmpHome()
  const settings = 'settings' in input ? input.settings : fakeSettings()
  const logger = input.logger ?? fakeLogger()
  return {
    home,
    settings,
    logger,
    getCurrent: input.getCurrent ?? ((key) => CURRENT[key]),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

test('import: differing keys are written through settings.update and the audit marker lands', async () => {
  const t = boot()
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', LEGACY_DOC)
    const result = await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, logger: t.logger.logger, getCurrent: (k) => CURRENT[k] })
    assert.equal(result.outcome, 'imported')
    // Only keys whose legacy value differs from the current effective value.
    assert.deepEqual(t.settings.calls, [{
      ns: 'dsh-topics-memory',
      patch: { repo: 'fan56/dsh-wiki-memory', distillProvider: 'zai-coding-cn', distillModel: 'glm-5.3-flash' },
    }])
    // Equal values are recorded as skipped, never imported.
    assert.deepEqual(result.skipped, { topK: 'equal', totalBudget: 'equal', autoObserve: 'equal' })
    // The marker is the persistent audit record.
    const marker = JSON.parse(readFileSync(legacyMarkerPath(t.home), 'utf8'))
    assert.equal(marker.outcome, 'imported')
    assert.equal(marker.source, 'settings.yaml.imported')
    assert.deepEqual(marker.imported, { repo: 'fan56/dsh-wiki-memory', distillProvider: 'zai-coding-cn', distillModel: 'glm-5.3-flash' })
    assert.deepEqual(marker.skipped, { topK: 'equal', totalBudget: 'equal', autoObserve: 'equal' })
    assert.equal(typeof marker.at, 'string')
    // One summary line, naming the migrated keys.
    const summary = t.logger.lines.find((l) => l.message.includes('legacy settings import'))
    assert.ok(summary, 'a summary line is logged')
    assert.ok(summary.message.includes('repo, distillProvider, distillModel'))
  } finally {
    t.cleanup()
  }
})

test('import: existing marker short-circuits everything (idempotent, no resurrection)', async () => {
  const t = boot()
  try {
    mkdirSync(join(t.home, 'storages', 'dsh-topics-memory'), { recursive: true })
    writeFileSync(legacyMarkerPath(t.home), '{"at":"2026-09-25T00:00:00.000Z","outcome":"imported"}\n')
    writeLegacyDoc(t.home, 'settings.yaml.imported', LEGACY_DOC)
    const result = await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, getCurrent: () => undefined })
    assert.equal(result.outcome, 'marker-exists')
    assert.equal(t.settings.calls.length, 0, 'settings.update never called')
    assert.equal(readFileSync(legacyMarkerPath(t.home), 'utf8').includes('2026-09-25T00:00:00.000Z'), true, 'marker untouched')
  } finally {
    t.cleanup()
  }
})

test('import: every legacy value equal → no update, marker no-op with equal reasons', async () => {
  const t = boot()
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', [
      'topics:',
      '  topK: 4',
      '  autoObserve: true',
    ].join('\n'))
    const result = await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, logger: t.logger.logger, getCurrent: (k) => CURRENT[k] })
    assert.equal(result.outcome, 'no-op')
    assert.equal(t.settings.calls.length, 0)
    const marker = JSON.parse(readFileSync(legacyMarkerPath(t.home), 'utf8'))
    assert.equal(marker.outcome, 'no-op')
    assert.deepEqual(marker.imported, {})
    assert.deepEqual(marker.skipped, { topK: 'equal', autoObserve: 'equal' })
  } finally {
    t.cleanup()
  }
})

test('import: unknown keys are recorded and left out of the update', async () => {
  const t = boot()
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', [
      'topics:',
      '  oldRenamedKey: 42',
      '  topK: 9',
    ].join('\n'))
    const result = await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, getCurrent: (k) => CURRENT[k] })
    assert.equal(result.outcome, 'imported')
    assert.deepEqual(t.settings.calls[0].patch, { topK: 9 })
    assert.deepEqual(result.skipped, { oldRenamedKey: 'unknown-key' })
  } finally {
    t.cleanup()
  }
})

test('import: settings.update rejects → warn, NO marker (next boot retries)', async () => {
  const t = boot({ settings: fakeSettings({ fail: true }) })
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', LEGACY_DOC)
    const result = await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, logger: t.logger.logger, getCurrent: (k) => CURRENT[k], updateRetry: { attempts: 3, delayMs: 1 } })
    assert.equal(result.outcome, 'update-failed')
    assert.equal(existsSync(legacyMarkerPath(t.home)), false, 'no marker on a failed update')
    assert.equal(t.logger.lines.filter((l) => l.level === 'warn' && l.message.includes('attempt 3/3')).length, 1, 'all retry attempts ran and were logged')
    assert.ok(t.logger.lines.some((l) => l.level === 'warn' && l.message.includes('retry next boot')))
  } finally {
    t.cleanup()
  }
})

test('import: settings.update recovers within the retry budget → imported (boot-time lock contention)', async () => {
  // The real-host failure mode (2026-09-25): during boot the host holds the
  // profile writer lock, so the first update calls time out and only a retry
  // lands. The seam here rejects twice, then accepts.
  const t = boot()
  let failures = 2
  const flakySeam = {
    async update(ns, patch) {
      if (failures > 0) {
        failures -= 1
        throw new Error('atomic-write: timed out waiting for the writer lock at package.json.lock')
      }
      t.settings.calls.push({ ns, patch })
    },
  }
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', LEGACY_DOC)
    const result = await runLegacySettingsImport({ home: t.home, settings: flakySeam, logger: t.logger.logger, getCurrent: (k) => CURRENT[k], updateRetry: { attempts: 5, delayMs: 1 } })
    assert.equal(result.outcome, 'imported')
    assert.deepEqual(t.settings.calls[0].patch, { repo: 'fan56/dsh-wiki-memory', distillProvider: 'zai-coding-cn', distillModel: 'glm-5.3-flash' })
    const marker = JSON.parse(readFileSync(legacyMarkerPath(t.home), 'utf8'))
    assert.equal(marker.outcome, 'imported')
    assert.ok(t.logger.lines.some((l) => l.level === 'warn' && l.message.includes('attempt 1/5')), 'failed attempts are logged, not silent')
  } finally {
    t.cleanup()
  }
})

test('import: no settings seam → warn (not silent), no marker, nothing read or written', async () => {
  const t = boot()
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', LEGACY_DOC)
    const result = await runLegacySettingsImport({ home: t.home, settings: undefined, logger: t.logger.logger, getCurrent: (k) => CURRENT[k] })
    assert.equal(result.outcome, 'no-settings')
    assert.equal(existsSync(legacyMarkerPath(t.home)), false)
    // The 2026-09-24 incident hid behind a silent no-settings exit — the
    // branch must leave a trace in the boot log.
    const warnLine = t.logger.lines.find((l) => l.level === 'warn' && l.message.includes('no-settings'))
    assert.ok(warnLine, 'a no-settings warn line is logged')
  } finally {
    t.cleanup()
  }
})

test('import: no legacy document at all → marker no-legacy', async () => {
  const t = boot()
  try {
    const result = await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, getCurrent: (k) => CURRENT[k] })
    assert.equal(result.outcome, 'no-legacy')
    assert.equal(t.settings.calls.length, 0)
    const marker = JSON.parse(readFileSync(legacyMarkerPath(t.home), 'utf8'))
    assert.equal(marker.outcome, 'no-legacy')
    assert.deepEqual(marker.imported, {})
  } finally {
    t.cleanup()
  }
})

test('import: legacy document without our section → marker no-section', async () => {
  const t = boot()
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', 'ui-theme:\n  preference: light\n')
    const result = await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, getCurrent: (k) => CURRENT[k] })
    assert.equal(result.outcome, 'no-section')
    const marker = JSON.parse(readFileSync(legacyMarkerPath(t.home), 'utf8'))
    assert.equal(marker.outcome, 'no-section')
  } finally {
    t.cleanup()
  }
})

test('import: settings.yaml.imported wins over settings.yaml', async () => {
  const t = boot()
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', LEGACY_DOC)
    writeLegacyDoc(t.home, 'settings.yaml', 'topics:\n  repo: WRONG/source\n')
    await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, getCurrent: (k) => CURRENT[k] })
    assert.deepEqual(t.settings.calls[0].patch, { repo: 'fan56/dsh-wiki-memory', distillProvider: 'zai-coding-cn', distillModel: 'glm-5.3-flash' })
    const marker = JSON.parse(readFileSync(legacyMarkerPath(t.home), 'utf8'))
    assert.equal(marker.source, 'settings.yaml.imported')
  } finally {
    t.cleanup()
  }
})

test('import: settings.yaml is the fallback when nothing was renamed', async () => {
  const t = boot()
  try {
    writeLegacyDoc(t.home, 'settings.yaml', 'topics:\n  topK: 11\n')
    await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, getCurrent: (k) => CURRENT[k] })
    assert.deepEqual(t.settings.calls[0].patch, { topK: 11 })
    const marker = JSON.parse(readFileSync(legacyMarkerPath(t.home), 'utf8'))
    assert.equal(marker.source, 'settings.yaml')
  } finally {
    t.cleanup()
  }
})

test('contract: entry id, section name, marker dir and key mapping are stable', () => {
  assert.equal(ENTRY_ID, 'dsh-topics-memory')
  assert.equal(LEGACY_SECTION, 'topics')
  assert.equal(legacyMarkerPath('/home/x/.dsh'), join('/home/x/.dsh', 'storages', 'dsh-topics-memory', 'legacy-import.json'))
  assert.deepEqual(legacySettingsCandidates('/d'), [join('/d', 'settings.yaml.imported'), join('/d', 'settings.yaml')])
  assert.deepEqual(
    [...LEGACY_KEYS],
    ['repo', 'distillProvider', 'distillModel', 'topK', 'totalBudget', 'autoObserve'],
    'identity key mapping: legacy name = Config key name',
  )
})

// Regression gate for the 2026-09-24 incident: apply() used to read
// `ctx.settings` DIRECTLY at its tail, which is undefined on a real boot
// whose settings service mounts after apply — the import then silently
// no-settings'd every boot. apply must wire the import through
// ctx.inject(['settings'], …) so it fires the moment the seam exists.
test('apply wiring: import rides ctx.inject(settings) and lands the marker in $DSH_HOME', async () => {
  const { apply } = await import('../lib/index.js')
  const home = tmpHome()
  const bundle = mkdtempSync(join(tmpdir(), 'topics-legacy-bundle-'))
  const prevDshHome = process.env.DSH_HOME
  const prevTopicsHome = process.env.DSH_TOPICS_HOME
  process.env.DSH_HOME = home
  process.env.DSH_TOPICS_HOME = bundle
  const seam = fakeSettings()
  const logger = fakeLogger()
  // Minimal fake dsh ctx (same recipe as dedup.test.mjs); the inject stub
  // fires immediately with a context carrying the fake settings seam.
  const ctx = {
    systemPrompt: { section: () => undefined, context: () => undefined },
    tools: { register: () => undefined },
    agents: { get: () => undefined },
    on: () => () => {},
    effect: () => () => {},
    skills: { registerProvider: () => () => {} },
    logger: logger.logger,
    inject: (_deps, cb) => cb({ settings: seam.seam }),
  }
  try {
    writeLegacyDoc(home, 'settings.yaml.imported', LEGACY_DOC)
    apply(ctx)
    // Fire-and-forget: let the floating import promise settle.
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(seam.calls, [{
      ns: ENTRY_ID,
      patch: { repo: 'fan56/dsh-wiki-memory', distillProvider: 'zai-coding-cn', distillModel: 'glm-5.3-flash' },
    }], 'only the keys differing from the (default) effective values are written')
    const marker = JSON.parse(readFileSync(legacyMarkerPath(home), 'utf8'))
    assert.equal(marker.outcome, 'imported')
    assert.equal(marker.source, 'settings.yaml.imported')
    assert.ok(logger.lines.some((l) => l.level === 'info' && l.message.includes('legacy settings import')), 'summary logged')
  } finally {
    if (prevDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDshHome
    if (prevTopicsHome === undefined) delete process.env.DSH_TOPICS_HOME
    else process.env.DSH_TOPICS_HOME = prevTopicsHome
    rmSync(home, { recursive: true, force: true })
    rmSync(bundle, { recursive: true, force: true })
  }
})
