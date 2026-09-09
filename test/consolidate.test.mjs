import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { TopicsService } from '../lib/service.js'
import {
  Consolidator,
  CONSOLIDATE_SYSTEM_PROMPT,
  clusterTopics,
  topicTokens,
} from '../lib/consolidate.js'
import * as okf from '../lib/okf.js'

const DAY_MS = 86_400_000

function make(cfgOverrides = {}, callerImpl) {
  const root = mkdtempSync(join(tmpdir(), 'topics-consolidate-'))
  const store = new BundleStore(root)
  let cfg = {
    repo: '', autoInject: true, topK: 4, perTopicBudget: 300, totalBudget: 1500,
    matchThreshold: 0.3, tagBoost: 0.15, graphDepth: 2, recencyWindowDays: 7,
    autoObserve: true, observationMaxChars: 2000, distillEveryTurns: 20,
    distillOnSessionEnd: true,
    distillProvider: 'p', distillModel: 'm',
    consolidateCadence: 'daily',
    pushDebounceSeconds: 45,
    ...cfgOverrides,
  }
  const service = new TopicsService(store, () => cfg)
  const calls = []
  const caller =
    callerImpl ??
    (async (req) => {
      calls.push(req)
      return JSON.stringify({ ops: [] })
    })
  const consolidator = new Consolidator(service, caller)
  const cleanup = () => rmSync(root, { recursive: true, force: true })
  return { root, store, service, consolidator, calls, caller, cfgRef: { get: () => cfg, set: (v) => (cfg = v) }, cleanup }
}

async function seed(h, topics) {
  const slugs = {}
  for (const t of topics) {
    const res = await h.service.saveTopic({
      title: t.title,
      conclusion: t.conclusion ?? `${t.title} 的结论。`,
      tags: t.tags ?? [],
      status: t.status,
    })
    slugs[t.title] = res.slug
  }
  h.service.invalidate()
  return slugs
}

test('topicTokens: latin words + cjk bigrams', () => {
  const tokens = topicTokens('dsh alpha.4 persistence API 漂移 修复')
  assert.ok(tokens.has('dsh') && tokens.has('persistence'))
  // Space-separated CJK segments produce no cross-segment bigrams...
  assert.ok(tokens.has('漂移') && tokens.has('修复'))
  assert.ok(!tokens.has('移修'))
  // ...but one contiguous segment does.
  const joined = topicTokens('漂移修复')
  assert.ok(joined.has('漂移') && joined.has('移修'))
  assert.equal(topicTokens('').size, 0)
})

test('clusterTopics: duplicates cluster, singletons dropped', () => {
  const entries = [
    { slug: 'a', title: 'cs-voice-agent slash 命令功能（/mcp 与 /wiki）', status: 'stable', tags: ['cs-geely'], conclusion: 'x' },
    { slug: 'b', title: 'cs-voice-agent slash 命令功能（/mcp、/wiki）', status: 'draft', tags: ['cs-geely'], conclusion: 'y' },
    { slug: 'c', title: 'asciicast 脱敏副本审计方法', status: 'stable', tags: ['security'], conclusion: 'z' },
  ]
  const clusters = clusterTopics(entries)
  assert.equal(clusters.length, 1)
  assert.deepEqual(clusters[0].entries.map((e) => e.slug).sort(), ['a', 'b'])
  assert.ok(clusters[0].similarity >= 0.3)
})

test('clusterTopics: capped at 6 members, sorted by peak similarity', () => {
  const entries = []
  for (let i = 0; i < 8; i += 1) {
    entries.push({ slug: `dup-${i}`, title: 'redis keyspace notification 洪泛评估 共享实例', status: 'stable', tags: ['redis'], conclusion: 'c' })
  }
  entries.push({ slug: 'lonely', title: '完全不相干的另一件事', status: 'draft', tags: ['other'], conclusion: 'd' })
  const clusters = clusterTopics(entries)
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0].entries.length, 6)
})

test('cadenceDays mapping', () => {
  assert.equal(Consolidator.cadenceDays('daily'), 1)
  assert.equal(Consolidator.cadenceDays('3d'), 3)
  assert.equal(Consolidator.cadenceDays('7d'), 7)
  assert.equal(Consolidator.cadenceDays('off'), undefined)
  assert.equal(Consolidator.cadenceDays(undefined), undefined)
  assert.equal(Consolidator.cadenceDays('weekly'), undefined)
})

test('system prompt forbids create and refresh-conclusion rewrites', () => {
  assert.match(CONSOLIDATE_SYSTEM_PROMPT, /禁止 create/)
  assert.match(CONSOLIDATE_SYSTEM_PROMPT, /refresh 禁止改结论/)
})

test('consolidator: no caller wired → no-model', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const idle = new Consolidator(h.service, undefined)
    const r = await idle.run()
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'no-model')
  } finally {
    h.cleanup()
  }
})

test('consolidator: distill route unset → no-model with readable detail', async () => {
  const h = make({ distillProvider: '', distillModel: '' })
  try {
    await h.store.ensure()
    const r = await h.consolidator.run()
    assert.equal(r.reason, 'no-model')
    assert.match(r.detail, /distill-provider/)
  } finally {
    h.cleanup()
  }
})

test('consolidator: no similar pairs → no-clusters, stamp NOT advanced', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await seed(h, [
      { title: '完全不同的话题甲', tags: ['alpha'] },
      { title: '截然相异的领域乙', tags: ['beta'] },
    ])
    const r = await h.consolidator.run()
    assert.equal(r.reason, 'no-clusters')
    assert.equal(await h.store.readConsolidateState(), undefined)
  } finally {
    h.cleanup()
  }
})

test('consolidator: merge lands — survivor updated, other deprecated with pointer, roster drops it', async () => {
  let SLUGS
  const h = make(undefined, async (req) => {
    h.calls.push(req)
    assert.equal(req.purpose, 'topics-consolidate')
    assert.match(req.system, /整理引擎/)
    return JSON.stringify({
      ops: [
        {
          op: 'merge',
          survivor: SLUGS['voice slash 命令'],
          merged: [SLUGS['voice slash 命令功能']],
          conclusion: 'slash 命令 /mcp 与 /wiki 已上线，二者合并后的完整结论。',
          reason: '结论重复',
        },
      ],
    })
  })
  try {
    await h.store.ensure()
    SLUGS = await seed(h, [
      { title: 'voice slash 命令', tags: ['cs-geely', 'slash'] },
      { title: 'voice slash 命令功能', tags: ['cs-geely', 'slash'], status: 'draft' },
    ])
    const r = await h.consolidator.run()
    assert.equal(r.ok, true)
    assert.deepEqual(r.merged, [SLUGS['voice slash 命令']])
    const survivor = await h.store.readTopic(SLUGS['voice slash 命令'])
    assert.match(survivor.body, /二者合并后的完整结论/)
    const absorbed = await h.store.readTopic(SLUGS['voice slash 命令功能'])
    assert.equal(absorbed.fm.status, 'deprecated')
    assert.match(absorbed.body, new RegExp(`已并入 topics/${SLUGS['voice slash 命令']}\\.md`))
    assert.match(absorbed.body, /以下结论保留作历史参考/)
    // The retired entry left the retrieval roster — merge semantics hold.
    const roster = await h.service.roster()
    assert.ok(!roster.some((e) => e.slug === SLUGS['voice slash 命令功能']))
    assert.ok(roster.some((e) => e.slug === SLUGS['voice slash 命令']))
    // Stamp advanced; state carries the action.
    const state = await h.store.readConsolidateState()
    assert.equal(state.ok, true)
    assert.deepEqual(state.merged, [SLUGS['voice slash 命令']])
  } finally {
    h.cleanup()
  }
})

test('consolidator: promote / deprecate / refresh land; invalid ops dropped', async () => {
  const h = make(undefined, async () =>
    JSON.stringify({
      ops: [
        { op: 'promote', slug: '甲系主题', reason: '结论已稳定' },
        { op: 'deprecate', slug: '乙系主题', reason: '已被取代' },
        { op: 'refresh', slug: '丙系主题', tags: ['fresh'], title: '丙系主题（修订）', reason: '标签更准' },
        // All of the following must be dropped, none applied:
        { op: 'merge', survivor: '甲系主题', merged: ['甲系主题'], conclusion: 'self merge' },
        { op: 'merge', survivor: '不存在的slug', merged: ['乙系主题'], conclusion: 'ghost' },
        { op: 'merge', survivor: '甲系主题', merged: ['乙系主题'] }, // conclusion required
        { op: 'create', title: '模型想造新条目' },
        { op: 'refresh', slug: '丙系主题', conclusion: '越权重写结论' },
        { op: 'nonsense', slug: '甲系主题' },
      ],
    }))
  try {
    await h.store.ensure()
    // 甲/乙/丙 share the bigrams 系主+主题 → one cluster, ops addressable.
    const SLUGS = await seed(h, [
      { title: '甲系主题', tags: ['jia'] },
      { title: '乙系主题', tags: ['yi'] },
      { title: '丙系主题', tags: ['bing'] },
    ])
    const r = await h.consolidator.run()
    assert.equal(r.ok, true)
    assert.deepEqual(r.promoted, [SLUGS['甲系主题']])
    assert.deepEqual(r.deprecated, [SLUGS['乙系主题']])
    assert.deepEqual(r.refreshed, [SLUGS['丙系主题']])
    assert.equal(r.droppedOps, 6)
    const promoted = await h.store.readTopic(SLUGS['甲系主题'])
    assert.equal(promoted.fm.status, 'stable')
    const deprecated = await h.store.readTopic(SLUGS['乙系主题'])
    assert.equal(deprecated.fm.status, 'deprecated')
    const refreshed = await h.store.readTopic(SLUGS['丙系主题'])
    assert.ok(refreshed.fm.tags.includes('fresh'))
    assert.match(refreshed.fm.title, /修订/)
    assert.match(refreshed.body, /丙系主题 的结论。/) // conclusion untouched
    // The model's create attempt never landed.
    const metas = await h.store.listTopics()
    assert.equal(metas.length, 3)
  } finally {
    h.cleanup()
  }
})

test('consolidator: model error before any evaluation → stamp not advanced, retried next window', async () => {
  let attempt = 0
  const h = make(undefined, async () => {
    attempt += 1
    throw new Error('network down')
  })
  try {
    await h.store.ensure()
    await seed(h, [
      { title: '重复条目一号 redis keyspace', tags: ['redis'] },
      { title: '重复条目一号 redis keyspace 通知', tags: ['redis'] },
    ])
    const r = await h.consolidator.run()
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'model-error')
    assert.equal(await h.store.readConsolidateState(), undefined)
    // No stamp → the next session start (or manual run) retries immediately.
    const retry = await h.consolidator.maybeRun()
    assert.notEqual(retry, undefined)
    assert.equal(retry.reason, 'model-error')
    assert.equal(attempt, 2)
  } finally {
    h.cleanup()
  }
})

test('consolidator: maybeRun cadence gates (7d)', async () => {
  const h = make({ consolidateCadence: '7d' })
  try {
    await h.store.ensure()
    await seed(h, [
      { title: '相近主题一号 keyspace 洪泛', tags: ['redis'] },
      { title: '相近主题一号 keyspace 洪泛评估', tags: ['redis'] },
    ])
    // off → never runs regardless of stamps.
    h.cfgRef.set({ ...h.cfgRef.get(), consolidateCadence: 'off' })
    assert.equal(await h.consolidator.maybeRun(), undefined)
    h.cfgRef.set({ ...h.cfgRef.get(), consolidateCadence: '7d' })
    // First ever run (no stamp) → fires.
    const first = await h.consolidator.maybeRun()
    assert.notEqual(first, undefined)
    assert.equal(first.ok, true)
    // Fresh stamp → not due.
    assert.equal(await h.consolidator.maybeRun(), undefined)
    // Backdate the stamp 8 days → due again.
    await h.store.writeConsolidateState({ at: new Date(Date.now() - 8 * DAY_MS).toISOString(), ok: true })
    const later = await h.consolidator.maybeRun()
    assert.notEqual(later, undefined)
  } finally {
    h.cleanup()
  }
})

test('consolidator: in-flight guard dedups concurrent runs', async () => {
  let resolveGate
  const gate = new Promise((res) => (resolveGate = res))
  const h = make(undefined, async () => {
    await gate
    return JSON.stringify({ ops: [] })
  })
  try {
    await h.store.ensure()
    await seed(h, [
      { title: '相近主题二号 keyspace', tags: ['redis'] },
      { title: '相近主题二号 keyspace 通知', tags: ['redis'] },
    ])
    const p1 = h.consolidator.run()
    const p2 = h.consolidator.run()
    assert.equal(p1, p2)
    resolveGate()
    const r1 = await p1
    const r2 = await p2
    assert.equal(r1.ok, true)
    assert.equal(r2, r1)
  } finally {
    h.cleanup()
  }
})

test('consolidator: merge union tags on survivor', async () => {
  let SLUGS
  const h = make(undefined, async () =>
    JSON.stringify({
      ops: [
        {
          op: 'merge',
          survivor: SLUGS['部署链路甲 cicd'],
          merged: [SLUGS['部署链路甲 cicd 快捷']],
          conclusion: '合并后的部署链路结论。',
          tags: ['cicd', 'deploy'],
        },
      ],
    }))
  try {
    await h.store.ensure()
    SLUGS = await seed(h, [
      { title: '部署链路甲 cicd', tags: ['cicd'] },
      { title: '部署链路甲 cicd 快捷', tags: ['deploy'] },
    ])
    const r = await h.consolidator.run()
    assert.equal(r.ok, true)
    const survivor = await h.store.readTopic(SLUGS['部署链路甲 cicd'])
    assert.deepEqual([...survivor.fm.tags].sort(), ['cicd', 'deploy'])
  } finally {
    h.cleanup()
  }
})

test('real backup corpus clusters (local copy, no network)', async () => {
  const backup = '/Users/qingguee/dsh-topics-backup-20260909'
  let names
  try {
    names = (await readdir(join(backup, 'topics'))).filter((f) => f.endsWith('.md'))
  } catch {
    return // backup not present on this machine — skip silently
  }
  assert.ok(names.length > 100, `expected the full corpus, got ${names.length}`)
  const entries = []
  for (const f of names) {
    try {
      const doc = okf.parseTopicDoc(await readFile(join(backup, 'topics', f), 'utf8'))
      if (doc.fm.status === 'deprecated') continue
      entries.push({
        slug: f.slice(0, -3),
        title: doc.fm.title,
        status: doc.fm.status,
        tags: doc.fm.tags,
        conclusion: (okf.sectionOf(doc.body, okf.CONCLUSION_HEADING) ?? '').slice(0, 600),
      })
    } catch {
      // broken file — skip
    }
  }
  const clusters = clusterTopics(entries)
  assert.ok(clusters.length > 0, 'real corpus should produce at least one cluster')
  // Known verbatim duplicate: two "cs-geely-voice-agent slash 命令功能" topics.
  const slashDupes = entries.filter((e) => e.title.includes('slash 命令功能'))
  assert.equal(slashDupes.length, 2)
  assert.ok(
    clusters.some((c) => slashDupes.every((d) => c.entries.some((e) => e.slug === d.slug))),
    'verbatim duplicate pair must land in one cluster',
  )
})
