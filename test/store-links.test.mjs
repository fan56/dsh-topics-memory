import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { TopicsService } from '../lib/service.js'

// W-D 沉淀侧 store 面：links 落点 = 正文 `# Links` 段 [[wikilinks]]——
// 既有 bodyLinkSlugs → computeBacklinks 链路自动纳入（via:'link'，不新增边类型），
// regenerateIndex 同一写事务内重算 backlinks.json。

function make(cfgOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'topics-store-links-'))
  const store = new BundleStore(root)
  const cfg = {
    repo: '', autoInject: true, topK: 4, perTopicBudget: 300, totalBudget: 1500,
    matchThreshold: 0.3, tagBoost: 0.15, graphDepth: 2, recencyWindowDays: 7,
    autoObserve: true, observationMaxChars: 2000, distillEveryTurns: 20,
    distillOnSessionEnd: true, distillProvider: 'p', distillModel: 'm', pushDebounceSeconds: 45,
    ...cfgOverrides,
  }
  const service = new TopicsService(store, () => cfg)
  const cleanup = () => rmSync(root, { recursive: true, force: true })
  return { root, store, service, cleanup }
}

test('saveTopic links land as a # Links wikilink section and recompute backlinks', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await h.service.saveTopic({ title: '目标主题', conclusion: '目标结论' })
    const res = await h.service.saveTopic({
      title: '来源主题',
      conclusion: '来源结论',
      links: ['目标主题'],
    })
    assert.equal(res.slug, '来源主题')
    const doc = await h.store.readTopic('来源主题')
    assert.match(doc.body, /# Links/)
    assert.match(doc.body, /- \[\[目标主题\]\]/)
    const backlinks = await h.store.readBacklinks()
    assert.ok(
      backlinks['目标主题'].some((e) => e.slug === '来源主题' && e.via === 'link'),
      `expected link backlink, got ${JSON.stringify(backlinks['目标主题'])}`,
    )
    // Edge representation unchanged: the via vocabulary stays depends|link.
    for (const entries of Object.values(backlinks)) {
      for (const e of entries) assert.ok(e.via === 'depends' || e.via === 'link')
    }
  } finally {
    h.cleanup()
  }
})

test('link targets are normalized, deduped and self-guarded in the same write transaction', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await h.service.saveTopic({ title: '目标主题', conclusion: '目标结论' })
    await h.service.saveTopic({
      title: '来源主题',
      conclusion: '来源结论',
      links: ['topics/目标主题.md', '目标主题', '来源主题', 'https://example.com/x', ''],
    })
    const doc = await h.store.readTopic('来源主题')
    assert.equal((doc.body.match(/- \[\[目标主题\]\]/g) ?? []).length, 1, 'path form + slug form dedupe to one entry')
    assert.doesNotMatch(doc.body, /\[\[来源主题\]\]/, 'self-link never written')
    assert.doesNotMatch(doc.body, /example\.com/, 'non-topic targets never become edges')
    assert.doesNotMatch(doc.body, /\[\[\]\]/)
    const backlinks = await h.store.readBacklinks()
    assert.ok(backlinks['目标主题'].some((e) => e.slug === '来源主题' && e.via === 'link'))
  } finally {
    h.cleanup()
  }
})

test('depends and links coexist as distinct via kinds in the backlinks index', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await h.service.saveTopic({ title: '目标主题', conclusion: '目标结论' })
    await h.service.saveTopic({
      title: '来源主题',
      conclusion: '来源结论',
      depends: ['目标主题'],
      links: ['目标主题'],
    })
    const backlinks = await h.store.readBacklinks()
    const inbound = backlinks['目标主题'].filter((e) => e.slug === '来源主题')
    assert.deepEqual(
      inbound.map((e) => e.via).sort(),
      ['depends', 'link'],
      'one topic, two edge kinds — the existing depends+links system, nothing new',
    )
  } finally {
    h.cleanup()
  }
})

test('update: links replace the section; omitting links preserves the stored one', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await h.service.saveTopic({ title: '目标主题', conclusion: '目标结论' })
    await h.service.saveTopic({ title: '其他主题', conclusion: '其他结论' })
    await h.service.saveTopic({ title: '来源主题', conclusion: 'v1', links: ['目标主题'] })
    // Update WITHOUT links: body carries over, the Links section survives.
    await h.service.saveTopic({ title: '来源主题', conclusion: 'v2', slug: '来源主题' })
    let doc = await h.store.readTopic('来源主题')
    assert.match(doc.body, /- \[\[目标主题\]\]/, 'preserve-on-update')
    assert.ok(await h.store.readBacklinks().then((b) => b['目标主题'].some((e) => e.slug === '来源主题')))
    // Update WITH links: the section is replaced, backlinks recomputed.
    await h.service.saveTopic({ title: '来源主题', conclusion: 'v3', slug: '来源主题', links: ['其他主题'] })
    doc = await h.store.readTopic('来源主题')
    assert.doesNotMatch(doc.body, /\[\[目标主题\]\]/)
    assert.match(doc.body, /- \[\[其他主题\]\]/)
    const backlinks = await h.store.readBacklinks()
    assert.equal((backlinks['目标主题'] ?? []).filter((e) => e.slug === '来源主题' && e.via === 'link').length, 0)
    assert.ok(backlinks['其他主题'].some((e) => e.slug === '来源主题' && e.via === 'link'))
  } finally {
    h.cleanup()
  }
})

test('links that reduce to nothing write no section and leave no edges', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await h.service.saveTopic({
      title: '来源主题',
      conclusion: '来源结论',
      links: ['https://example.com', '子/目录', ''],
    })
    const doc = await h.store.readTopic('来源主题')
    assert.doesNotMatch(doc.body, /# Links/)
    assert.deepEqual(Object.keys(await h.store.readBacklinks()), [], 'no phantom targets in the index')
    // A topic whose only target is itself: section omitted too.
    await h.service.saveTopic({ title: '自指主题', conclusion: '结论', links: ['自指主题'] })
    const doc2 = await h.store.readTopic('自指主题')
    assert.doesNotMatch(doc2.body, /# Links/)
  } finally {
    h.cleanup()
  }
})
