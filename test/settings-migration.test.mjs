import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, migrateLegacySettings, name as pluginName } from '../lib/index.js'

/**
 * One-time settings-namespace migration (llmwiki → topics, ADR 0013). The
 * fake provider mimics the real dsh-settings semantics the migration relies
 * on: register() surfaces a pre-existing stored section (and throws on
 * duplicates), describe() exposes the raw user layer per namespace, and
 * mutate() persists path ops into the user layer.
 */
function fakeSettings(doc, opts = {}) {
  const registrations = new Map()
  const warns = []
  const settings = {
    registered: registrations,
    warns,
    register(ns) {
      if (registrations.has(ns)) throw new Error(`settings namespace "${ns}" is already registered`)
      if (ns === 'llmwiki' && opts.legacyInvalid) throw new TypeError('invalid stored section')
      registrations.set(ns, { user: doc[ns] === undefined ? undefined : { ...doc[ns] } })
      return { get: () => ({ ...(doc[ns] ?? {}) }) }
    },
    describe() {
      return [...registrations.entries()].map(([ns, r]) =>
        r.user === undefined ? { ns } : { ns, user: r.user },
      )
    },
    async mutate(ns, ops) {
      const r = registrations.get(ns)
      if (r === undefined) throw new Error(`settings namespace "${ns}" is not registered`)
      if (opts.mutateRejects) throw new Error('persist failed')
      r.user = { ...(r.user ?? {}) }
      for (const op of ops) r.user[op.path[0]] = op.value
      doc[ns] = r.user
    },
  }
  if (opts.preRegistered?.length) {
    for (const ns of opts.preRegistered) settings.register(ns)
  }
  return settings
}

test('settings-migration: plugin identity carries the new name', () => {
  assert.equal(pluginName, 'dsh-topics-memory')
})

test('settings-migration: old-plugin coexistence → loud warn, migration skipped, no duplicate register', () => {
  // Simulates the 0.5.x dsh-llmwiki-memory still loaded: IT registered the
  // legacy `llmwiki` namespace before us. Registering blind would throw a
  // contained duplicate error and the migration would skip SILENTLY while
  // both plugins drift onto separate bundles.
  const doc = { llmwiki: { topK: 6, distillProvider: 'p', distillModel: 'm' } }
  const settings = fakeSettings(doc, { preRegistered: ['topics', 'llmwiki'] })
  const warns = []
  assert.equal(migrateLegacySettings(settings, (m) => warns.push(m)), undefined, 'no write scheduled')
  assert.equal(warns.length, 1, 'exactly one loud warning')
  assert.match(warns[0], /dsh-llmwiki-memory \(0\.5\.x\) is still running/)
  assert.match(warns[0], /Remove @aiwayds\/dsh-llmwiki-memory/)
  assert.deepEqual(doc.topics, undefined, 'no values copied behind a double load')
  assert.deepEqual(doc.llmwiki, { topK: 6, distillProvider: 'p', distillModel: 'm' }, 'legacy section untouched')
})

test('settings-migration: tuned legacy keys are copied into topics once', async () => {
  const doc = { llmwiki: { topK: 6, totalBudget: 2500, distillProvider: 'p', distillModel: 'm' } }
  const settings = fakeSettings(doc)
  settings.register('topics') // mirror apply(): the new ns registers before migration runs
  const pending = migrateLegacySettings(settings)
  assert.ok(pending instanceof Promise, 'a write was scheduled')
  await pending
  assert.deepEqual(doc.topics, { topK: 6, totalBudget: 2500, distillProvider: 'p', distillModel: 'm' })
  assert.ok(settings.registered.has('llmwiki'), 'legacy namespace registered to surface its section')
})

test('settings-migration: default-valued legacy keys are not copied', async () => {
  const doc = { llmwiki: { topK: 4, autoInject: true, distillProvider: 'p' } }
  const settings = fakeSettings(doc)
  settings.register('topics')
  await migrateLegacySettings(settings)
  assert.deepEqual(doc.topics, { distillProvider: 'p' }, 'only the user-tuned key travels')
})

test('settings-migration: idempotent — an already-configured topics ns is never touched', async () => {
  const doc = { llmwiki: { topK: 6 }, topics: { repo: 'someuser/dsh-topics-data' } }
  const settings = fakeSettings(doc)
  settings.register('topics')
  assert.equal(migrateLegacySettings(settings), undefined, 'no write scheduled')
  assert.deepEqual(doc.topics, { repo: 'someuser/dsh-topics-data' })
  assert.equal(settings.registered.has('llmwiki'), false, 'legacy ns never even registered')
})

test('settings-migration: legacy section with only defaults → no write', async () => {
  const doc = { llmwiki: { topK: 4, totalBudget: 1500 } }
  const settings = fakeSettings(doc)
  settings.register('topics')
  assert.equal(migrateLegacySettings(settings), undefined)
  assert.equal(doc.topics, undefined)
})

test('settings-migration: no legacy section → no write, no throw', async () => {
  const doc = {}
  const settings = fakeSettings(doc)
  settings.register('topics')
  assert.equal(migrateLegacySettings(settings), undefined)
  assert.equal(doc.topics, undefined)
})

test('settings-migration: fail-open — an invalid legacy section skips the migration', async () => {
  const doc = { llmwiki: { topK: 6 } }
  const settings = fakeSettings(doc, { legacyInvalid: true })
  settings.register('topics')
  assert.doesNotThrow(() => migrateLegacySettings(settings))
  assert.equal(doc.topics, undefined)
  assert.ok(settings.registered.has('topics'), 'the plugin still booted with its own namespace')
})

test('settings-migration: fail-open — a rejecting mutate is swallowed', async () => {
  const doc = { llmwiki: { topK: 6 } }
  const settings = fakeSettings(doc, { mutateRejects: true })
  settings.register('topics')
  await assert.doesNotReject(() => migrateLegacySettings(settings))
  assert.deepEqual(doc.llmwiki, { topK: 6 }, 'legacy section left as-is')
})

test('settings-migration: bare harness without describe/mutate → no-op', () => {
  assert.equal(migrateLegacySettings({ register: () => ({ get: () => ({}) }) }), undefined)
})

// ---- apply() wiring: the migration runs as part of plugin startup ----

test('settings-migration: apply() carries legacy values into the new namespace', async () => {
  const home = mkdtempSync(join(tmpdir(), 'topics-migrate-'))
  const prevRoot = process.env.DSH_TOPICS_HOME
  process.env.DSH_TOPICS_HOME = home
  try {
    const doc = { llmwiki: { topK: 6, distillProvider: 'p', distillModel: 'm' } }
    const settings = fakeSettings(doc)
    apply({
      settings,
      systemPrompt: { section: () => undefined, context: () => undefined },
      tools: { register: () => undefined },
      on: () => undefined,
      inject: (_deps, cb) => cb({ effect: () => () => {} }),
      effect: () => () => {},
      skills: {
        registerProvider() {
          return () => {}
        },
      },
    })
    // The apply path fire-and-forgets the write; poll for it to settle.
    for (let i = 0; i < 100 && doc.topics === undefined; i += 1) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.deepEqual(doc.topics, { topK: 6, distillProvider: 'p', distillModel: 'm' })
  } finally {
    if (prevRoot === undefined) delete process.env.DSH_TOPICS_HOME
    else process.env.DSH_TOPICS_HOME = prevRoot
    rmSync(home, { recursive: true, force: true })
  }
})
