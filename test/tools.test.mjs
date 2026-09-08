import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { TopicsService } from '../lib/service.js'
import { buildTopicTools } from '../lib/tools.js'

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


function tmpService() {
  const root = mkdtempSync(join(tmpdir(), 'topics-tools-'))
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

test('tools: registered set and names', async (t) => {
  const { service, cleanup } = tmpService()
  t.after(cleanup)
  const tools = buildTopicTools(service)
  assert.deepEqual(tools.map((tool) => tool.name), ['topic_save', 'topic_open', 'topic_search', 'topic_observe', 'topic_history'])
})

test('tool topic_open: full conclusion + staleness notice, logged for open rate', async (t) => {
  const { service, cleanup } = tmpService()
  t.after(cleanup)
  await service.store.ensure()
  const [save, open] = buildTopicTools(service)
  await save.execute({
    title: 'dsh-cron 定时插件',
    conclusion: '定时靠 headless + OS cron。',
    description: '定时任务方案',
    open_questions: ['错过窗口补跑吗'],
    recommendations: '发布前先提版本',
  })
  const out = await open.execute({ slug: 'dsh-cron-定时插件' })
  assert.equal(out.found, true)
  assert.equal(out.conclusion, '定时靠 headless + OS cron。')
  assert.deepEqual(out.openQuestions, ['错过窗口补跑吗'])
  assert.equal(out.recommendations, '发布前先提版本')
  assert.ok(typeof out.updatedAt === 'string' && out.updatedAt !== '', 'staleness timestamp present')
  const opens = await service.store.readOpenRecords()
  assert.equal(opens.length, 1)
  assert.equal(opens[0].slug, 'dsh-cron-定时插件')
  const miss = await open.execute({ slug: 'no-such-topic' })
  assert.equal(miss.found, false)
})

test('tool topic_save: create then update, output shape', async (t) => {
  const { service, cleanup } = tmpService()
  t.after(cleanup)
  await service.store.ensure()
  const [save] = buildTopicTools(service)
  const created = await save.execute({
    title: 'dsh-cron 定时插件',
    conclusion: '定时靠 headless + OS cron。',
    description: '定时任务方案',
    tags: ['dsh', 'Cron'],
    open_questions: ['错过窗口补跑吗'],
    recommendations: '发布前先提版本',
    status: 'stable',
  })
  assert.equal(created.created, true)
  assert.equal(created.slug, 'dsh-cron-定时插件')
  assert.equal(created.committed, true)
  const doc = await service.store.readTopic(created.slug)
  assert.equal(doc.fm.status, 'stable')
  assert.deepEqual(doc.fm.tags, ['dsh', 'cron']) // lowercased + deduped
  assert.equal(doc.fm.open_questions.length, 1)

  const updated = await save.execute({
    title: 'dsh-cron 定时插件',
    conclusion: '修订后的结论。',
    slug: created.slug,
  })
  assert.equal(updated.created, false)
  const doc2 = await service.store.readTopic(created.slug)
  assert.match(doc2.body, /修订后的结论。/)
  // tags preserved from previous version on update
  assert.deepEqual(doc2.fm.tags, ['dsh', 'cron'])
})

test('tool topic_search: finds seeded topic', async (t) => {
  const { service, cleanup } = tmpService()
  t.after(cleanup)
  await service.store.ensure()
  const [, , search] = buildTopicTools(service)
  await service.saveTopic({ title: 'podman e2e 套件', conclusion: '改 src 要重建镜像，容器内 ~/.dsh 隔离。', tags: ['podman'] })
  const out = await search.execute({ query: 'podman 镜像 重建' })
  assert.equal(out.results.length, 1)
  assert.equal(out.results[0].slug, 'podman-e2e-套件')
  assert.ok(out.results[0].score > 0)
  const miss = await search.execute({ query: '菜谱 红烧肉' })
  assert.equal(miss.results.length, 0)
})

test('tool topic_observe: records atomic observations', async (t) => {
  const { service, cleanup } = tmpService()
  t.after(cleanup)
  await service.store.ensure()
  const [, , , observe] = buildTopicTools(service)
  const r = await observe.execute({ kind: 'decision', text: '采用方案 C 双轨' })
  assert.match(r.id, /^obs-/)
  const pending = await service.store.undistilledObservations()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].kind, 'decision')
})

test('tool topic_history: traces conclusion changes via git', async (t) => {
  const { service, cleanup } = tmpService()
  t.after(cleanup)
  await service.store.ensure()
  const [save, , , , history] = buildTopicTools(service)
  const created = await save.execute({ title: 'evolving', conclusion: '第一版结论' })
  await save.execute({ title: 'evolving', conclusion: '第二版结论', slug: created.slug })
  await save.execute({ title: 'evolving', conclusion: '第三版结论', slug: created.slug })
  const out = await history.execute({ slug: created.slug })
  assert.equal(out.entries.length, 3)
  assert.match(out.entries[2].conclusion, /第一版结论/)
  assert.match(out.entries[0].conclusion, /第三版结论/)
})

test('retrieveSync: same-turn hot path is synchronous and logs fire-and-forget', async (t) => {
  const { service, cleanup } = tmpService()
  t.after(cleanup)
  await service.store.ensure()
  await service.saveTopic({ title: 'Echo Marker QX7QZ', conclusion: 'The Echo Marker QX7QZ topic exists.' })
  // No await anywhere: the digest must be ready in the SAME tick (chancelu
  // lesson — an async retrieval always loses the prompt-assembly race).
  const r = service.retrieveSync('关于 echo marker 的疑问')
  assert.ok(r.text.includes('Echo Marker QX7QZ'), r.text)
  assert.ok(r.outcome.hits.some((h) => h.slug === 'echo-marker-qx7qz'))
  // Zero-hit query → empty text (零注入).
  const miss = service.retrieveSync('完全无关的火锅菜谱问题')
  assert.equal(miss.text, '')
  // Log record lands asynchronously but eventually (poll — parallel test
  // load can starve the fire-and-forget write past a fixed sleep). Assert
  // as a multiset: the queue should preserve submission order, but the
  // assertion's essence is "one hit + one miss", not their file order.
  let records = []
  for (let i = 0; i < 100; i += 1) {
    records = await service.store.readInjectionRecords()
    if (records.length === 2) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(records.length, 2)
  assert.equal(records.filter((r) => r.injected).length, 1)
  assert.equal(records.filter((r) => !r.injected).length, 1)
})

// ---------------------------------------------------------------------------
// 2026-09 audit fixes: slug prefix normalization + lossless output shape.
// The host validates tool output against the declared schema and rejects any
// object carrying an undefined-valued key as non-lossless JSON
// (INVALID_TOOL_OUTPUT) — a topic without a description used to make every
// topic_open of it fail.
// ---------------------------------------------------------------------------

test('tool topic_open: unwraps a topics:-prefixed slug and logs the clean slug', async (t) => {
  const { service, cleanup } = tmpService()
  t.after(cleanup)
  await service.store.ensure()
  const [save, open] = buildTopicTools(service)
  await save.execute({ title: 'dsh-cron 定时插件', conclusion: '定时靠 headless + OS cron。' })
  // Pointers render as `(topics:<slug>)`; models copy that whole token back.
  const out = await open.execute({ slug: 'topics:dsh-cron-定时插件' })
  assert.equal(out.found, true)
  assert.equal(out.slug, 'dsh-cron-定时插件', 'response carries the clean slug')
  assert.equal(out.conclusion, '定时靠 headless + OS cron。')
  // Path and .md suffixes unwrap the same way; the open log records clean.
  const out2 = await open.execute({ slug: 'topics/dsh-cron-定时插件.md' })
  assert.equal(out2.found, true)
  const opens = await service.store.readOpenRecords()
  assert.deepEqual(opens.map((o) => o.slug), ['dsh-cron-定时插件', 'dsh-cron-定时插件'])
})

test('tool topic_open: output stays lossless when the topic has no description', async (t) => {
  const { service, cleanup } = tmpService()
  t.after(cleanup)
  await service.store.ensure()
  const [save, open] = buildTopicTools(service)
  await save.execute({ title: 'no-desc-topic-AB1', conclusion: '结论自含。' })
  const out = await open.execute({ slug: 'no-desc-topic-AB1' })
  assert.equal(out.found, true)
  assert.equal(out.slug, 'no-desc-topic-ab1', 'case-folded to the canonical slug (the save path wrote it folded; case-sensitive bundles miss otherwise)')
  assert.equal(!('description' in out), true, 'undefined description is omitted, never present-as-undefined')
  // The exact check the host's tool-output validator runs.
  const { isJsonValue } = await import('@deepseek-ai/dsh-util-values')
  assert.equal(isJsonValue(out), true, 'tool output is lossless JSON (would otherwise be INVALID_TOOL_OUTPUT)')
})

test('tool topic_history: entries stay lossless (conclusion omitted when absent)', async (t) => {
  const { service, cleanup } = tmpService()
  t.after(cleanup)
  await service.store.ensure()
  const tools = buildTopicTools(service)
  const save = tools[0]
  const history = tools[4]
  await save.execute({ title: 'hist-topic-CD2', conclusion: '第一版结论。' })
  await save.execute({ title: 'hist-topic-CD2', slug: 'hist-topic-cd2', conclusion: '第二版结论。' })
  const out = await history.execute({ slug: 'hist-topic-cd2' })
  assert.ok(out.entries.length >= 2, 'both revisions listed')
  const { isJsonValue } = await import('@deepseek-ai/dsh-util-values')
  assert.equal(isJsonValue(out), true, 'history output is lossless JSON')
})
