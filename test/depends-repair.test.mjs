import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { TopicsService } from '../lib/service.js'
import { parseTopicDoc, unwrapTopicRef, normalizeDependsEntry, dependsSlugs } from '../lib/okf.js'
import { fileHistory } from '../lib/git.js'

/** rm that tolerates an in-flight fire-and-forget write racing the cleanup. */
async function rmRetry(path, attempts = 6) {
  for (let i = 0; ; i += 1) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (e) {
      if (i >= attempts - 1 || (e.code !== 'ENOTEMPTY' && e.code !== 'ENOENT')) throw e
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}

const WIKI = 'github-仓库-fan56dsh-wiki-memory-的创建与管理'

/** The exact on-disk shape the double-wrap bug produced (5 saves = 5 wraps). */
function corruptedRaw(slug, depends) {
  return `---
type: Topic
title: ${slug}
tags: [沙盒]
depends:
${depends.map((d) => `  - ${d}`).join('\n')}
open_questions: []
impact: []
status: draft
generated: { by: t, at: 2026-08-31T00:00:00Z }
---

# Conclusion

结论。
`
}

// ---- okf: tolerant reference handling -------------------------------------

test('okf: unwrapTopicRef strips any number of wraps', () => {
  assert.equal(unwrapTopicRef(WIKI), WIKI)
  assert.equal(unwrapTopicRef(`topics/${WIKI}.md`), WIKI)
  assert.equal(unwrapTopicRef(`topics/topics/${WIKI}.md.md`), WIKI)
  assert.equal(unwrapTopicRef(`topics/topics/topics/topics/topics/${WIKI}.md.md.md.md.md`), WIKI)
  // Colon form seen in distilled bundles: `topics:foo` instead of `topics/foo.md`.
  assert.equal(unwrapTopicRef('topics:dsh-model-sync-v022-release'), 'dsh-model-sync-v022-release')
})

test('okf: normalizeDependsEntry canonicalizes every wild form and is idempotent', () => {
  const canonical = `topics/${WIKI}.md`
  for (const form of [WIKI, canonical, `topics/topics/${WIKI}.md.md`, `  ${canonical}  `]) {
    assert.equal(normalizeDependsEntry(form), canonical)
    assert.equal(normalizeDependsEntry(normalizeDependsEntry(form)), canonical)
  }
  assert.equal(normalizeDependsEntry(''), '')
  // Not a bundle-internal reference: never re-wrapped into a fake one.
  assert.equal(normalizeDependsEntry('a/b.md'), 'a/b')
  assert.equal(normalizeDependsEntry('https://example.com/a.md').includes('topics/'), false)
})

test('okf: dependsSlugs resolves wrapped entries to real slugs', () => {
  assert.deepEqual(
    dependsSlugs({ depends: [`topics/topics/${WIKI}.md.md`] }),
    [WIKI],
  )
})

// ---- store: upgrade repair on ensure() ------------------------------------

test('repair: ensure() unwraps multi-wrapped depends, commits once, is idempotent', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'topics-repair-'))
  t.after(() => rmRetry(root))
  mkdirSync(join(root, 'topics'), { recursive: true })
  writeFileSync(
    join(root, 'topics', 'demo-sandbox.md'),
    corruptedRaw('demo-sandbox', [`topics/topics/topics/topics/topics/${WIKI}.md.md.md.md.md`]),
    'utf8',
  )
  writeFileSync(
    join(root, 'topics', 'clean.md'),
    corruptedRaw('clean', [`topics/${WIKI}.md`]),
    'utf8',
  )

  const store = new BundleStore(root)
  await store.ensure()

  const doc = parseTopicDoc(readFileSync(join(root, 'topics', 'demo-sandbox.md'), 'utf8'))
  assert.deepEqual(doc.fm.depends, [`topics/${WIKI}.md`])
  // The clean file is byte-identical in meaning — untouched (no busy diff).
  const cleanDoc = parseTopicDoc(readFileSync(join(root, 'topics', 'clean.md'), 'utf8'))
  assert.deepEqual(cleanDoc.fm.depends, [`topics/${WIKI}.md`])

  // The edge resolves in the derived backlinks index again.
  const backlinks = await store.readBacklinks()
  assert.ok(backlinks[WIKI]?.some((e) => e.slug === 'demo-sandbox' && e.via === 'depends'))

  // Traceable: the repair lands as its own commit.
  const history = await fileHistory(root, 'topics/demo-sandbox.md')
  assert.ok(history.some((h) => h.message.startsWith('topics(migrate): repair wrapped depends')))

  // Idempotent: a second ensure() adds no commit.
  const afterFirst = history.length
  await store.ensure()
  assert.equal((await fileHistory(root, 'topics/demo-sandbox.md')).length, afterFirst)
})

test('repair: gitDisabled bundles are rewritten in place, no crash', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'topics-repair-nogit-'))
  t.after(() => rmRetry(root))
  mkdirSync(join(root, 'topics'), { recursive: true })
  writeFileSync(
    join(root, 'topics', 'wrapped.md'),
    corruptedRaw('wrapped', [`topics/topics/${WIKI}.md.md`]),
    'utf8',
  )
  const store = new BundleStore(root, { gitDisabled: true })
  await store.ensure()
  const doc = parseTopicDoc(readFileSync(join(root, 'topics', 'wrapped.md'), 'utf8'))
  assert.deepEqual(doc.fm.depends, [`topics/${WIKI}.md`])
})

test('repair: re-serialization keeps triggers, verified, and body intact', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'topics-repair-fields-'))
  t.after(() => rmRetry(root))
  mkdirSync(join(root, 'topics'), { recursive: true })
  writeFileSync(
    join(root, 'topics', 'rich.md'),
    corruptedRaw('rich', [`topics/topics/${WIKI}.md.md`])
      .replace('status: draft', 'status: draft\ntriggers: [沙盒触发词]\nverified: { by: reviewer, at: 2026-09-01T00:00:00Z }'),
    'utf8',
  )
  const store = new BundleStore(root, { gitDisabled: true })
  await store.ensure()
  const doc = parseTopicDoc(readFileSync(join(root, 'topics', 'rich.md'), 'utf8'))
  assert.deepEqual(doc.fm.depends, [`topics/${WIKI}.md`])
  assert.deepEqual(doc.fm.triggers, ['沙盒触发词'])
  assert.deepEqual(doc.fm.verified, { by: 'reviewer', at: '2026-09-01T00:00:00Z' })
  assert.match(doc.body, /# Conclusion/)
})

test('repair: bare-slug entries are wrapped up to canonical form and dupes collapse', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'topics-repair-bare-'))
  t.after(() => rmRetry(root))
  mkdirSync(join(root, 'topics'), { recursive: true })
  // A literal empty YAML list item makes the whole doc unparseable — those
  // files are brokenTopics()'s business, so emptiness is exercised at the
  // normalizeDependsEntry unit level instead.
  writeFileSync(
    join(root, 'topics', 'mixed.md'),
    corruptedRaw('mixed', [WIKI, `topics/${WIKI}.md`]),
    'utf8',
  )
  const store = new BundleStore(root, { gitDisabled: true })
  await store.ensure()
  const doc = parseTopicDoc(readFileSync(join(root, 'topics', 'mixed.md'), 'utf8'))
  assert.deepEqual(doc.fm.depends, [`topics/${WIKI}.md`])
})

// ---- service: the write path can never wrap again --------------------------

function tmpService() {
  const root = mkdtempSync(join(tmpdir(), 'topics-repair-svc-'))
  const store = new BundleStore(root)
  const cfg = {
    repo: '', autoInject: true, topK: 4, perTopicBudget: 300, totalBudget: 1500,
    matchThreshold: 0.3, tagBoost: 0.15, graphDepth: 2, recencyWindowDays: 7,
    autoObserve: true, observationMaxChars: 2000, distillEveryTurns: 20,
    distillOnSessionEnd: true, distillProvider: '', distillModel: '', pushDebounceSeconds: 45,
  }
  const service = new TopicsService(store, () => cfg)
  return { root, store, service, cleanup: () => rmRetry(root) }
}

async function dependsOnDisk(root, slug) {
  return parseTopicDoc(readFileSync(join(root, 'topics', `${slug}.md`), 'utf8')).fm.depends
}

test('service: update without depends preserves the stored entries (regression)', async (t) => {
  const { store, service, cleanup } = tmpService()
  t.after(cleanup)
  await store.ensure()
  await service.saveTopic({ title: '基座', conclusion: '基座结论。', depends: [WIKI] })
  // Three updates that omit depends — the old path stacked one wrap each.
  for (let i = 0; i < 3; i += 1) {
    await service.saveTopic({ slug: '基座', title: '基座', conclusion: `更新 ${i}。` })
  }
  assert.deepEqual(await dependsOnDisk(store.root, '基座'), [`topics/${WIKI}.md`])
})

test('service: path-form and wrapped depends input canonicalize on save', async (t) => {
  const { store, service, cleanup } = tmpService()
  t.after(cleanup)
  await store.ensure()
  await service.saveTopic({
    title: '混合',
    conclusion: '结论。',
    depends: [`topics/${WIKI}.md`, WIKI, `topics/topics/${WIKI}.md.md`],
  })
  assert.deepEqual(await dependsOnDisk(store.root, '混合'), [`topics/${WIKI}.md`])
})
