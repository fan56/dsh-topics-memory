import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { TopicsService } from '../lib/service.js'
import {
  Consolidator,
  CONSOLIDATE_SYSTEM_PROMPT,
  clusterTopics,
  dropExpiredDeprecated,
  topicTokens,
} from '../lib/consolidate.js'
import { digestFor } from '../lib/jev/log.js'
import * as okf from '../lib/okf.js'

const DAY_MS = 86_400_000

function make(cfgOverrides = {}, callerImpl, askJev) {
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
  // askJev injectable like the ModelCaller — undefined resolves to the real
  // jevAsk, which the default-off config below never lets run.
  const consolidator = new Consolidator(service, caller, askJev)
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

test('system prompt forbids create and refresh-conclusion rewrites, guards zero-usage', () => {
  assert.match(CONSOLIDATE_SYSTEM_PROMPT, /禁止 create/)
  assert.match(CONSOLIDATE_SYSTEM_PROMPT, /refresh 禁止改结论/)
  assert.match(CONSOLIDATE_SYSTEM_PROMPT, /injections30d/)
  assert.match(CONSOLIDATE_SYSTEM_PROMPT, /不要仅凭零使用就 deprecate/)
})

test('consolidator: cluster payload carries usage counts (0 when logs non-empty, absent when empty)', async () => {
  let captured
  const h = make(undefined, async (req) => {
    captured = req.user
    return JSON.stringify({ ops: [] })
  })
  try {
    await h.store.ensure()
    await seed(h, [
      { title: '相近主题甲 keyspace 洪泛', tags: ['redis'] },
      { title: '相近主题甲 keyspace 洪泛评估', tags: ['redis'] },
    ])
    // Empty IL → usage unknown → fields absent.
    await h.consolidator.run()
    assert.ok(!captured.includes('injections30d'), 'empty IL: fields absent, not lying zeros')
    // Non-empty IL → measured zeros surface for the guardrail.
    await h.store.appendInjectionRecord({
      at: new Date().toISOString(), injected: true, queryTokenCount: 2, rosterSize: 2,
      hits: [{ slug: 'x', score: 1, reasons: [], viaGraph: false }],
    })
    h.service.invalidate()
    await h.consolidator.run()
    assert.match(captured, /"injections30d":0/)
    assert.match(captured, /"opens30d":0/)
  } finally {
    h.cleanup()
  }
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

test('deprecated-TTL sweep: drops only expired deprecated; 0 disables; idempotent', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const SLUGS = await seed(h, [
      { title: '过期废弃条目 keyspace 洪泛', tags: ['redis'] },
      { title: '新鲜废弃条目 keyspace 洪泛', tags: ['redis'] },
      { title: '活着的老条目 keyspace 洪泛', tags: ['redis'] },
    ])
    // Rewrite frontmatter in place: generated.at is the became-deprecated clock.
    const age = async (slug, days, status) => {
      const file = join(h.store.topicsDir(), `${slug}.md`)
      const doc = okf.parseTopicDoc(await readFile(file, 'utf8'))
      doc.fm.status = status
      doc.fm.generated = { by: doc.fm.generated.by, at: new Date(Date.now() - days * DAY_MS).toISOString() }
      await writeFile(file, okf.serializeTopicDoc(doc))
    }
    await age(SLUGS['过期废弃条目 keyspace 洪泛'], 20, 'deprecated')
    await age(SLUGS['新鲜废弃条目 keyspace 洪泛'], 5, 'deprecated')
    await age(SLUGS['活着的老条目 keyspace 洪泛'], 20, 'draft')
    h.service.invalidate()

    const dropped = await dropExpiredDeprecated(h.service, 15)
    assert.deepEqual(dropped, [SLUGS['过期废弃条目 keyspace 洪泛']])
    assert.equal(await h.store.exists(SLUGS['过期废弃条目 keyspace 洪泛']), false)
    assert.ok(await h.store.exists(SLUGS['新鲜废弃条目 keyspace 洪泛']), 'fresh deprecated survives')
    assert.ok(await h.store.exists(SLUGS['活着的老条目 keyspace 洪泛']), 'old non-deprecated survives')
    // Roster excludes deprecated by design — only the old draft remains.
    const roster = await h.service.roster()
    assert.deepEqual(roster.map((r) => r.slug), [SLUGS['活着的老条目 keyspace 洪泛']])
    // 0 disables the sweep; re-running is a no-op.
    assert.deepEqual(await dropExpiredDeprecated(h.service, 0), [])
    assert.deepEqual(await dropExpiredDeprecated(h.service, 15), [])
    // The drop landed as a git commit (bundle history stays the safety net).
    assert.equal(h.store.hasGit ? await h.store.hasGit() : false, true)
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

// ---- jev prefilter (design 2026-09-25 §2 整理 lane 前置) ---------------------
//
// Hermetic by construction: the jev seam is injected (same pattern as the
// ModelCaller) — no network, and decisions.jsonl writes are redirected to a
// temp $DSH_TOPICS_HOME so the real bundle is never touched.

const NEAR_DUP_PAIRS = [
  { title: '重复簇主题 keyspace 洪泛', tags: ['redis'] },
  { title: '重复簇主题 keyspace 洪泛评估', tags: ['redis'] },
]

/** Config slice with the System One master switch ON (volatile keys at their
 *  documented defaults — the shape jevConfigOf must accept). */
function jevCfg() {
  return { jevEnabled: true, jevBackend: 'zen', jevModel: '', jevTimeoutMs: 100, jevSecretFile: '' }
}

/** Redirect decisions.jsonl to a temp bundle for the duration of `fn`. */
async function withTempDecisionsHome(fn) {
  const prev = process.env.DSH_TOPICS_HOME
  const tmpRoot = mkdtempSync(join(tmpdir(), 'topics-consolidate-jev-'))
  process.env.DSH_TOPICS_HOME = tmpRoot
  try {
    return await fn(tmpRoot)
  } finally {
    if (prev === undefined) delete process.env.DSH_TOPICS_HOME
    else process.env.DSH_TOPICS_HOME = prev
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

async function decisionRows(tmpRoot) {
  const raw = await readFile(join(tmpRoot, 'meta', 'decisions.jsonl'), 'utf8')
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
}

test('clusterTopics: pairs reuse clustering scores, best-first, only among kept members', () => {
  const entries = []
  for (let i = 0; i < 8; i += 1) {
    entries.push({ slug: `dup-${i}`, title: 'redis keyspace notification 洪泛评估 共享实例', status: 'stable', tags: ['redis'], conclusion: 'c' })
  }
  entries.push({ slug: 'lonely', title: '完全不相干的另一件事', status: 'draft', tags: ['other'], conclusion: 'd' })
  const clusters = clusterTopics(entries)
  assert.equal(clusters.length, 1)
  const c = clusters[0]
  assert.equal(c.entries.length, 6)
  // Complete graph on 8 nodes capped to 6 kept members → 15 inner edges.
  assert.equal(c.pairs.length, 15)
  for (let k = 1; k < c.pairs.length; k += 1) assert.ok(c.pairs[k - 1].similarity >= c.pairs[k].similarity, 'best-first')
  const slugs = new Set(c.entries.map((e) => e.slug))
  for (const p of c.pairs) {
    assert.notEqual(p.i, p.j)
    assert.ok(p.i >= 0 && p.i < c.entries.length && p.j >= 0 && p.j < c.entries.length)
    assert.ok(slugs.has(c.entries[p.i].slug) && slugs.has(c.entries[p.j].slug), 'pairs stay inside the kept members')
  }
})

test('prefilter: pair adopt → cluster goes to the LLM; sweep-aligned batch shape; verdict layer fields', async () => {
  await withTempDecisionsHome(async (tmpRoot) => {
    const jevCalls = []
    const h = make(jevCfg(), undefined, async (args) => {
      jevCalls.push(args)
      return { ok: true, answers: { p1: { noul: 0.8 }, cluster: { noul: 0.42 } }, usage: null, latencyMs: 1 }
    })
    try {
      await h.store.ensure()
      const SLUGS = await seed(h, NEAR_DUP_PAIRS)
      const r = await h.consolidator.run()
      assert.equal(r.ok, true)
      // One jev request for the cluster, then one LLM call — the adopt gate opened.
      assert.equal(jevCalls.length, 1)
      assert.equal(h.calls.length, 1)
      const args = jevCalls[0]
      assert.equal(args.lane, 'consolidate-prefilter')
      assert.equal(args.fallback, true, 'fail-open is wired into the call')
      // ≤6 问/簇: 1 pair + 1 record-only cluster question here.
      const qIds = Object.keys(args.questions)
      assert.equal(qIds.length, 2)
      assert.deepEqual([...qIds].sort(), ['cluster', 'p1'])
      // Protocol alignment with the t4 sweep (thresholds are protocol-bound).
      assert.match(args.state, /簇内 merge 校准/)
      assert.match(args.state, /合并保留一份不丢实质信息/)
      const pairQ = args.questions.p1
      assert.equal(pairQ.type, 'noul')
      assert.deepEqual(Object.keys(pairQ.criteria).sort(), ['false', 'true'], 'two-sided criteria')
      assert.match(pairQ.instructions, /## topic A/)
      assert.match(pairQ.instructions, /## topic B/)
      assert.match(pairQ.instructions, /应当合并吗/)
      assert.ok(pairQ.instructions.includes('重复簇主题 keyspace 洪泛'))
      assert.match(args.questions.cluster.instructions, /值得一次整理动作吗/)

      const rows = await decisionRows(tmpRoot)
      assert.equal(rows.length, 2)
      const pair = rows.find((x) => x.questionId === 'p1')
      const cluster = rows.find((x) => x.questionId === 'cluster')
      for (const row of rows) {
        assert.deepEqual(
          Object.keys(row).sort(),
          ['agree', 'at', 'band', 'digest', 'lane', 'probability', 'qtype', 'questionId', 'ref'],
        )
        assert.equal(row.lane, 'consolidate-prefilter')
        assert.equal(row.qtype, 'noul')
        assert.equal(row.agree, 'n/a', 'nothing lexical to reconcile against on this lane')
        assert.match(row.digest, /^h1:/)
      }
      assert.ok(pair.ref.startsWith('pair:'))
      assert.ok(pair.ref.includes(SLUGS['重复簇主题 keyspace 洪泛']))
      assert.ok(pair.ref.includes(SLUGS['重复簇主题 keyspace 洪泛评估']))
      assert.equal(pair.probability, 0.8)
      assert.equal(pair.band, 'adopt')
      assert.ok(cluster.ref.startsWith('cluster:'))
      assert.ok(cluster.ref.includes(SLUGS['重复簇主题 keyspace 洪泛']))
      // 簇级问只记录不门控: band pinned to 'record' regardless of the score.
      assert.equal(cluster.band, 'record')
      // digest determinism against the shipped digestFor.
      assert.equal(pair.digest, digestFor(args.state, 'p1', pairQ.instructions))
    } finally {
      h.cleanup()
    }
  })
})

test('prefilter: all pairs below adopt → LLM skipped (the saving), cluster question never gates, stamp untouched', async () => {
  await withTempDecisionsHome(async (tmpRoot) => {
    let jevCalls = 0
    const askStub = async (args) => {
      jevCalls += 1
      const answers = {}
      for (const id of Object.keys(args.questions)) answers[id] = { noul: id === 'cluster' ? 0.95 : 0.05 }
      return { ok: true, answers, usage: null, latencyMs: 1 }
    }
    const h = make(jevCfg(), undefined, askStub)
    try {
      await h.store.ensure()
      await seed(h, NEAR_DUP_PAIRS)
      // Rebuild with a host-logger sink to observe the per-skip log line.
      const notes = []
      const c = new Consolidator(h.service, h.caller, askStub, (m) => notes.push(m))
      const r = await c.run()
      // jev was asked once; the LLM never — the skip IS the saved call.
      assert.equal(jevCalls, 1)
      assert.equal(h.calls.length, 0)
      assert.equal(r.ok, false)
      assert.equal(r.reason, undefined, 'a prefilter skip is not a failure')
      assert.match(r.detail, /前置过滤跳过 1 簇/)
      // Stamp semantics untouched: the model never evaluated → no stamp → retry next window.
      assert.equal(await h.store.readConsolidateState(), undefined)
      assert.equal(notes.length, 1)
      assert.match(notes[0], /前置过滤跳过簇/)
      // Even a 0.95 cluster-level score only records, never flips the gate.
      const rows = await decisionRows(tmpRoot)
      const cluster = rows.find((x) => x.questionId === 'cluster')
      assert.equal(cluster.probability, 0.95)
      assert.equal(cluster.band, 'record')
      const pair = rows.find((x) => x.questionId === 'p1')
      assert.equal(pair.band, 'fallback')
    } finally {
      h.cleanup()
    }
  })
})

test('prefilter: top-k cap — a 15-pair cluster asks at most 5 pair questions; one adopt proceeds', async () => {
  await withTempDecisionsHome(async () => {
    let questions = null
    const h = make(jevCfg(), undefined, async (args) => {
      questions = args.questions
      const answers = {}
      for (const id of Object.keys(args.questions)) answers[id] = { noul: id === 'cluster' ? 0.1 : id === 'p1' ? 0.6 : 0.3 }
      return { ok: true, answers, usage: null, latencyMs: 1 }
    })
    try {
      await h.store.ensure()
      await seed(h, [
        { title: '大同簇条目甲 keyspace 洪泛', tags: ['redis'] },
        { title: '大同簇条目甲 keyspace 洪泛之二', tags: ['redis'] },
        { title: '大同簇条目甲 keyspace 洪泛之三', tags: ['redis'] },
        { title: '大同簇条目甲 keyspace 洪泛之四', tags: ['redis'] },
        { title: '大同簇条目甲 keyspace 洪泛之五', tags: ['redis'] },
        { title: '大同簇条目甲 keyspace 洪泛之六', tags: ['redis'] },
      ])
      const r = await h.consolidator.run()
      const ids = Object.keys(questions)
      assert.equal(ids.length, 6, 'p1..p5 + cluster — the ≤6 问/簇 batch shape')
      for (let i = 1; i <= 5; i += 1) assert.ok(ids.includes(`p${i}`))
      // p1 adopt (≥0.50) opens the gate despite the record-band rest.
      assert.equal(h.calls.length, 1)
      assert.equal(r.ok, true)
    } finally {
      h.cleanup()
    }
  })
})

test('prefilter: jev failure fails open — cluster goes to the LLM, no verdict rows', async () => {
  await withTempDecisionsHome(async (tmpRoot) => {
    let jevCalls = 0
    const h = make(jevCfg(), undefined, async () => {
      jevCalls += 1
      return { ok: false, outcome: 'timeout', message: 'timeout error: stub', latencyMs: 1 }
    })
    try {
      await h.store.ensure()
      await seed(h, NEAR_DUP_PAIRS)
      const r = await h.consolidator.run()
      assert.equal(jevCalls, 1)
      assert.equal(h.calls.length, 1, 'fail-open: the cluster went to the LLM as today')
      assert.equal(r.ok, true)
      assert.ok(!existsSync(join(tmpRoot, 'meta', 'decisions.jsonl')), 'no verdict layer rows on failure')
    } finally {
      h.cleanup()
    }
  })
})

test('prefilter: unusable pair score → fail-open (shape drift must not veto the cluster)', async () => {
  await withTempDecisionsHome(async () => {
    const h = make(jevCfg(), undefined, async (args) => {
      const answers = {}
      for (const id of Object.keys(args.questions)) answers[id] = id === 'cluster' ? { noul: 0.9 } : { confidence: 'high' }
      return { ok: true, answers, usage: null, latencyMs: 1 }
    })
    try {
      await h.store.ensure()
      await seed(h, NEAR_DUP_PAIRS)
      const r = await h.consolidator.run()
      assert.equal(h.calls.length, 1, 'a gate question without a usable score never skips the cluster')
      assert.equal(r.ok, true)
    } finally {
      h.cleanup()
    }
  })
})

test('prefilter: jevEnabled off → the jev branch never runs, behavior identical to today', async () => {
  const h = make({}, undefined, async () => {
    throw new Error('the real/stub jevAsk must not be called while the master switch is off')
  })
  try {
    await h.store.ensure()
    await seed(h, NEAR_DUP_PAIRS)
    const r = await h.consolidator.run()
    assert.equal(h.calls.length, 1)
    assert.equal(r.ok, true)
    assert.ok(!r.detail.includes('前置过滤'))
  } finally {
    h.cleanup()
  }
})
