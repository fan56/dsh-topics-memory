import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { parseTopicDoc } from '../lib/okf.js'

function tmpStore(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'topics-store-'))
  return { store: new BundleStore(root, { gitDisabled: true, ...opts }), root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function doc(title, body = '# Conclusion\n\n结论。\n') {
  return parseTopicDoc(`---
type: Topic
title: ${title}
tags: [test]
depends: []
open_questions: []
impact: []
status: draft
generated: { by: t, at: 2026-08-31T00:00:00Z }
---

${body}`)
}

test('store: ensure creates skeleton idempotently', async () => {
  const { store, cleanup } = tmpStore()
  try {
    await store.ensure()
    await store.ensure()
    assert.equal(await store.exists('nothing'), false)
    const s = await store.status()
    assert.equal(s.topicCount, 0)
    assert.equal(s.git, false)
  } finally {
    cleanup()
  }
})

test('store: save/list/read topic round-trip + index', async () => {
  const { store, cleanup } = tmpStore()
  try {
    await store.ensure()
    const r1 = await store.saveTopic({ slug: 'alpha', doc: doc('Alpha 主题') }, { message: 'create alpha' })
    assert.equal(r1.slug, 'alpha')
    assert.equal(r1.created, true)
    const r2 = await store.saveTopic({ slug: 'alpha', doc: doc('Alpha 主题 v2') }, { message: 'update alpha', created: false })
    assert.equal(r2.created, false)
    const metas = await store.listTopics()
    assert.equal(metas.length, 1)
    assert.equal(metas[0].title, 'Alpha 主题 v2')
    const read = await store.readTopic('alpha')
    assert.equal(read.fm.title, 'Alpha 主题 v2')
    // generated stamped by the store actor on save (machine provenance)
    assert.match(read.fm.generated.by, /^agent:dsh-topics-memory@/)
    const index = await readFile(indexPath(store), 'utf8')
    assert.match(index, /alpha/)
  } finally {
    cleanup()
  }
})

import { readFile } from 'node:fs/promises'
function indexPath(store) {
  return join(store.root, 'index.md')
}

test('store: uniqueSlug avoids collisions', async () => {
  const { store, cleanup } = tmpStore()
  try {
    await store.ensure()
    await store.saveTopic({ slug: 'x', doc: doc('X') }, { message: 'c1' })
    assert.equal(await store.uniqueSlug('x'), 'x-2')
    await store.saveTopic({ slug: 'x-2', doc: doc('X2') }, { message: 'c2' })
    assert.equal(await store.uniqueSlug('x'), 'x-3')
    assert.equal(await store.uniqueSlug('全新'), '全新')
  } finally {
    cleanup()
  }
})

test('store: broken topic file surfaces in brokenTopics, skipped in roster', async () => {
  const { store, cleanup } = tmpStore()
  try {
    await store.ensure()
    await store.saveTopic({ slug: 'good', doc: doc('Good') }, { message: 'c' })
    await writeFileRaw(store, 'topics/bad.md', '---\nnot: closed\n')
    assert.deepEqual(await store.brokenTopics(), ['bad.md'])
    assert.equal((await store.listTopics()).length, 1)
    const s = await store.status()
    assert.deepEqual(s.broken, ['bad.md'])
  } finally {
    cleanup()
  }
})

import { writeFile } from 'node:fs/promises'
async function writeFileRaw(store, rel, content) {
  await writeFile(join(store.root, rel), content, 'utf8')
}

test('store: observations lifecycle', async () => {
  const { store, cleanup } = tmpStore()
  try {
    await store.ensure()
    const o1 = await store.appendObservation({ kind: 'turn', source: 'auto', text: '第一轮' })
    const o2 = await store.appendObservation({ kind: 'decision', source: 'model', text: '决定用 A 方案', sessionId: 's1' })
    assert.equal((await store.allObservations()).length, 2)
    assert.equal((await store.undistilledObservations()).length, 2)
    const marked = await store.markDistilled([o1.id, o2.id], ['topic-a'])
    assert.equal(marked, 2)
    const left = await store.undistilledObservations()
    assert.equal(left.length, 0)
    const all = await store.allObservations()
    assert.deepEqual(all[0].distilledInto, ['topic-a'])
    // double-mark is a no-op
    assert.equal(await store.markDistilled([o1.id], ['topic-a']), 0)
    assert.ok(o2.id.startsWith('obs-'))
  } finally {
    cleanup()
  }
})

test('store: injection records append/read/compact', async () => {
  const { store, cleanup } = tmpStore()
  try {
    await store.ensure()
    for (let i = 0; i < 3; i += 1) {
      await store.appendInjectionRecord({ at: 't', queryTokenCount: i, rosterSize: 0, hits: [], nearMisses: [], injected: false })
    }
    assert.equal((await store.readInjectionRecords()).length, 3)
    // Force compaction path via direct file write >512KB
    const bigLines = Array.from({ length: 12000 }, (_, i) => JSON.stringify({ at: 't', i, pad: 'x'.repeat(60) }))
    await writeFileRaw(store, 'meta/injections.jsonl', bigLines.join('\n'))
    await store.appendInjectionRecord({ at: 't', queryTokenCount: 1, rosterSize: 0, hits: [], nearMisses: [], injected: false })
    const size = (await readFile(join(store.root, 'meta/injections.jsonl'), 'utf8')).length
    assert.ok(size < 512 * 1024, `size=${size}`)
    // Compaction keeps the last quarter of a >512KB file (± the merged append).
    const kept = (await store.readInjectionRecords(5000)).length
    assert.ok(kept >= 2990 && kept <= 3001, `kept=${kept}`)
    assert.equal((await store.readInjectionRecords()).length, 2000) // default cap
  } finally {
    cleanup()
  }
})

test('store: conflicts set/clear with slug normalization', async () => {
  const { store, cleanup } = tmpStore()
  try {
    await store.ensure()
    await store.setConflicts(['topics/a.md', 'topics/b.md'])
    assert.deepEqual([...(await store.getConflicts())].sort(), ['a', 'b'])
    await store.setConflicts([])
    assert.equal((await store.getConflicts()).size, 0)
  } finally {
    cleanup()
  }
})

test('store: setConflicts drops non-topic paths (meta sidecar leak)', async () => {
  const { store, cleanup } = tmpStore()
  try {
    await store.ensure()
    // A rebase can conflict on meta sidecars; only topic files may be marked.
    await store.setConflicts(['topics/a.md', 'meta/observations.jsonl', 'index.md'])
    assert.deepEqual(await store.getConflicts(), new Set(['a']))
    const raw = JSON.parse(readFileSync(join(store.root, 'meta', 'conflicts.json'), 'utf8'))
    assert.deepEqual(raw, ['topics/a.md'])
  } finally {
    cleanup()
  }
})

test('store: backlinks index — depends + body links, regenerated on write', async () => {
  const { store, cleanup } = tmpStore()
  try {
    await store.ensure()
    await store.saveTopic(
      { slug: 'base', doc: doc('Base', '# Conclusion\n\n见 [[consumer]] 与 [面板](topics/panel.md)。') },
      { message: 'c1' },
    )
    await store.saveTopic(
      { slug: 'consumer', doc: { ...doc('Consumer'), fm: { ...doc('Consumer').fm, depends: ['topics/base.md'] } } },
      { message: 'c2' },
    )
    await store.saveTopic({ slug: 'panel', doc: doc('Panel') }, { message: 'c3' })
    const bl = await store.readBacklinks()
    assert.deepEqual(bl['base'], [{ slug: 'consumer', via: 'depends' }])
    // [[consumer]] in base's body → consumer gets a link backlink from base
    const consumerRefs = bl['consumer'] ?? []
    assert.ok(consumerRefs.some((e) => e.slug === 'base' && e.via === 'link'), JSON.stringify(bl))
    assert.deepEqual(bl['panel'], [{ slug: 'base', via: 'link' }])
    // rewriting base without links drops the stale edge (write-through)
    await store.saveTopic({ slug: 'base', doc: doc('Base', '# Conclusion\n\n没有引用了。') }, { message: 'c4', created: false })
    const bl2 = await store.readBacklinks()
    assert.equal((bl2['consumer'] ?? []).length, 0)
    assert.equal(bl2['panel'], undefined)
  } finally {
    cleanup()
  }
})

test('store: readTopic rejects reserved filenames', async () => {
  const { store, cleanup } = tmpStore()
  try {
    await store.ensure()
    assert.equal(await store.readTopic('index'), undefined)
  } finally {
    cleanup()
  }
})

test('store: recordUnconsumed counts attempts and gc-deletes at the third strike', async () => {
  const { store, cleanup } = tmpStore()
  try {
    await store.ensure()
    const o1 = await store.appendObservation({ kind: 'turn', source: 'auto', text: '反复喂' })
    const o2 = await store.appendObservation({ kind: 'finding', source: 'auto', text: '会被消费' })
    const o3 = await store.appendObservation({ kind: 'turn', source: 'auto', text: '从不喂它' })
    // Run 1: o1 fed and left unconsumed (+1), o2 fed and consumed (no attempt).
    let r = await store.recordUnconsumed([o1.id, o2.id], [o2.id])
    assert.equal(r.dropped, 0)
    let all = await store.allObservations()
    assert.equal(all.find((o) => o.id === o1.id).attempts, 1)
    assert.equal(all.find((o) => o.id === o2.id).attempts, undefined, 'consumed observations never accrue attempts')
    assert.equal(all.find((o) => o.id === o3.id).attempts, undefined, 'unfed observations are untouched')
    // Run 2: second strike, still alive.
    await store.recordUnconsumed([o1.id], [])
    assert.equal((await store.allObservations()).find((o) => o.id === o1.id).attempts, 2)
    // Run 3: third strike deletes o1 and nothing else.
    r = await store.recordUnconsumed([o1.id], [])
    assert.equal(r.dropped, 1)
    all = await store.allObservations()
    assert.equal(all.find((o) => o.id === o1.id), undefined, 'three strikes and the observation is gone')
    assert.equal(all.length, 2)
    assert.equal((await store.undistilledObservations()).length, 2)
  } finally {
    cleanup()
  }
})

test('store: recordUnconsumed never touches distilled observations', async () => {
  const { store, cleanup } = tmpStore()
  try {
    await store.ensure()
    const o1 = await store.appendObservation({ kind: 'turn', source: 'auto', text: '先失败后被消费' })
    // One failed attempt, then the observation is consumed: from that moment
    // it is GC-immune even when fed to the model again.
    await store.recordUnconsumed([o1.id], [])
    await store.markDistilled([o1.id], ['topic-a'])
    const r = await store.recordUnconsumed([o1.id], [])
    assert.equal(r.dropped, 0)
    const all = await store.allObservations()
    assert.equal(all.length, 1)
    assert.equal(all[0].attempts, 1, 'the pre-consumption attempt is preserved; no new one accrues')
  } finally {
    cleanup()
  }
})
