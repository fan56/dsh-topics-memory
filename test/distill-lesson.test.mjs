import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { TopicsService } from '../lib/service.js'
import { Distiller, SYSTEM_PROMPT, LESSON_PROMPT } from '../lib/distill.js'
import { pipelineEventsFile } from '../lib/pipeline-events.js'

// B 线蒸馏 lesson 分支（B2 决议 3①，spec 卷二 §3.1）：feedObservations 投喂的
// kind:'signal'+source:'fed' 结构化观察走 LESSON_PROMPT 分支产 lesson ops
// （行为教训，hint 草稿）；普通观察走现行 SYSTEM_PROMPT 逐字节不动。
// mock-LLM 家法，禁真网络。

function make(cfgOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'topics-distill-lesson-'))
  const store = new BundleStore(root)
  let cfg = {
    repo: '', autoInject: true, topK: 4, perTopicBudget: 300, totalBudget: 1500,
    matchThreshold: 0.3, tagBoost: 0.15, graphDepth: 2, recencyWindowDays: 7,
    autoObserve: true, observationMaxChars: 2000, distillEveryTurns: 20,
    distillOnSessionEnd: true,
    distillProvider: 'p', distillModel: 'm', pushDebounceSeconds: 45,
    ...cfgOverrides,
  }
  const service = new TopicsService(store, () => cfg)
  const cleanup = () => rmSync(root, { recursive: true, force: true })
  return { root, store, service, cleanup }
}

/** Complete lesson create op — passes the lesson schema gate. */
const lessonOp = (over = {}) => ({
  op: 'create',
  kind: 'lesson',
  title: '当蒸馏路由缺失时先探活再重试',
  triggers: ['蒸馏路由', 'NO_ADAPTER', 'provider 探活'],
  conclusion: '先调 listProviders 探活，确认路由存在后再发起 stream。',
  scope: 'workspace',
  observed_ids: [],
  ...over,
})

async function readEvents(root) {
  try {
    return readFileSync(pipelineEventsFile(root), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

const feedSignal = (store, text = '[tool-error] tool=bash count=3 exit=1', sessionId = 's1') =>
  store.appendObservation({ kind: 'signal', source: 'fed', text, sessionId })

async function seedEstablishedLesson(service, over = {}) {
  return service.saveTopic({
    title: 'Commit No Signoff',
    triggers: ['git commit', '署名'],
    conclusion: 'commit 一律不带 Co-Authored-By 署名。',
    kind: 'lesson',
    confidence: 'established',
    ...over,
  })
}

// ---- prompt contract ----

test('LESSON_PROMPT carries the 判定问句, empty-result escape, op shape and conflict rule', () => {
  // 判定问句 = 边界闸（B2 决议 1），空结果 = 宁缺勿滥。
  assert.match(LESSON_PROMPT, /违反它会犯错误吗/)
  assert.match(LESSON_PROMPT, /没有教训可立：明确输出 \{"ops":\[\]\}/)
  assert.match(LESSON_PROMPT, /宁缺勿滥，禁止为凑数编造教训/)
  // op 形状：kind:'lesson' / 条件式 title / triggers 3-8 / 祈使句 conclusion / scope。
  assert.match(LESSON_PROMPT, /"kind":"lesson"/)
  assert.match(LESSON_PROMPT, /"triggers":\["condition 触发词，恰好 3-8 个具体短语"\]/)
  assert.match(LESSON_PROMPT, /"conclusion":"action：怎么做，祈使句，自含可执行"/)
  assert.match(LESSON_PROMPT, /"scope":"workspace 或 global"/)
  // confidence/source 由 lane 落库固定，模型不输出。
  assert.match(LESSON_PROMPT, /confidence 一律 hint、来源一律 distilled/)
  // 矛盾自查（基线版）：清单对照 + conflictsWith 标记 + 审批门裁决。
  assert.match(LESSON_PROMPT, /现有 established lesson 清单/)
  assert.match(LESSON_PROMPT, /"conflictsWith":\["该教训的slug"\]/)
  assert.match(LESSON_PROMPT, /是否新覆旧由审批门裁决，不要因此放弃输出/)
  // observed_ids 桥语义与 topic 分支同款硬性要求。
  assert.match(LESSON_PROMPT, /硬性要求：每个 op 必须带 observed_ids/)
  assert.match(LESSON_PROMPT, /逐字复制/)
  // 只允许 create（lesson 修订是审批门领地）。
  assert.match(LESSON_PROMPT, /每个元素只允许 create/)
})

test('SYSTEM_PROMPT stays lesson-free (lane separation)', () => {
  assert.doesNotMatch(SYSTEM_PROMPT, /lesson/i)
  assert.doesNotMatch(SYSTEM_PROMPT, /判定问句/)
  assert.doesNotMatch(SYSTEM_PROMPT, /conflictsWith/)
})

// ---- 蒸馏输入分流 ----

test('routing: fed+signal observation rides the lesson branch, ordinary observation the topic branch', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const sig = await feedSignal(h.store)
    const d = new Distiller(h.service, async (req) => {
      assert.equal(req.system, LESSON_PROMPT)
      assert.match(req.user, /现有 established lesson 清单/)
      assert.match(req.user, /信号观察/)
      assert.ok(req.user.includes(sig.id))
      return JSON.stringify({ ops: [] })
    })
    const r = await d.run('s1')
    assert.equal(r.reason, 'no-ops') // 空结果=无教训可立
    // 普通观察（auto/model 来源）走现行 SYSTEM_PROMPT。
    await h.store.appendObservation({ kind: 'finding', source: 'auto', text: '普通观察' })
    const d2 = new Distiller(h.service, async (req) => {
      assert.equal(req.system, SYSTEM_PROMPT)
      assert.match(req.user, /未蒸馏观察/)
      assert.doesNotMatch(req.user, /信号观察/)
      return JSON.stringify({ ops: [] })
    })
    const r2 = await d2.run('s1')
    assert.equal(r2.reason, 'no-ops')
  } finally {
    h.cleanup()
  }
})

test('mixed window: both branches run in one run, each sub-pool isolated', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const sig = await feedSignal(h.store)
    const ord = await h.store.appendObservation({ kind: 'finding', source: 'auto', text: '普通观察一' })
    const systems = []
    const d = new Distiller(h.service, async (req) => {
      systems.push(req.system)
      if (req.system === SYSTEM_PROMPT) {
        assert.ok(req.user.includes(ord.id), 'topic branch sees the ordinary observation')
        assert.ok(!req.user.includes(sig.id), 'topic branch must not see the fed signal')
        return JSON.stringify({
          ops: [{ op: 'create', title: '普通主题', description: '一句话', triggers: ['甲', '乙', '丙'], conclusion: '结论', observed_ids: [ord.id] }],
        })
      }
      assert.ok(req.user.includes(sig.id), 'lesson branch sees the fed signal')
      assert.ok(!req.user.includes(ord.id), 'lesson branch must not see the ordinary observation')
      return JSON.stringify({ ops: [lessonOp({ observed_ids: [sig.id] })] })
    })
    const r = await d.run('s1')
    assert.equal(r.ok, true)
    assert.equal(r.marked, 2)
    assert.deepEqual(systems.sort(), [SYSTEM_PROMPT, LESSON_PROMPT].sort())
    assert.equal((await h.store.readTopic('普通主题')).fm.type, 'Topic', 'ordinary create stays a topic')
    const lesson = await h.store.readTopic('当蒸馏路由缺失时先探活再重试')
    assert.equal(lesson.fm.confidence, 'hint')
    // 双池全消费。
    assert.equal((await h.store.undistilledObservations()).length, 0)
  } finally {
    h.cleanup()
  }
})

// ---- lesson op 落库 + 观察消费闭环 ----

test('lesson create lands via the lesson data plane; source observation marked consumed', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const sig = await feedSignal(h.store)
    const d = new Distiller(h.service, async () =>
      JSON.stringify({ ops: [lessonOp({ observed_ids: [sig.id] })] }))
    const r = await d.run('s1')
    assert.equal(r.ok, true)
    assert.deepEqual(r.created, ['当蒸馏路由缺失时先探活再重试'])
    const doc = await h.store.readTopic('当蒸馏路由缺失时先探活再重试')
    assert.equal(doc.fm.type, 'Lesson') // OKF lesson kind
    assert.equal(doc.fm.confidence, 'hint') // 蒸馏产一律 hint（B4 审批门升 established）
    assert.equal(doc.fm.source, 'distilled')
    assert.equal(doc.fm.scope, 'workspace')
    assert.equal(doc.fm.status, 'draft') // confidence↔status 派生
    assert.ok(typeof doc.fm.workspaceId === 'string' && doc.fm.workspaceId.length > 0, 'workspace lesson stamps the cwd hash (MJ-2)')
    assert.match(doc.body, /先调 listProviders 探活/)
    // 消费闭环：observed_ids 桥语义不变，落库后来源观察标 consumed。
    const after = await h.store.allObservations()
    assert.equal(after[0].distilled, true)
    assert.deepEqual(after[0].distilledInto, ['当蒸馏路由缺失时先探活再重试'])
    assert.equal((await h.store.undistilledObservations()).length, 0)
    // lesson 永不入 topic roster（0.24.0 分流语义不受影响）。
    assert.equal((await h.service.roster()).length, 0)
  } finally {
    h.cleanup()
  }
})

test('lesson scope=global lands without workspaceId', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const sig = await feedSignal(h.store)
    const d = new Distiller(h.service, async () =>
      JSON.stringify({ ops: [lessonOp({ scope: 'global', observed_ids: [sig.id] })] }))
    const r = await d.run('s1')
    assert.equal(r.ok, true)
    const doc = await h.store.readTopic('当蒸馏路由缺失时先探活再重试')
    assert.equal(doc.fm.scope, 'global')
    assert.equal(doc.fm.workspaceId, undefined)
  } finally {
    h.cleanup()
  }
})

// ---- 判定问句空结果 + update 过滤 ----

test('判定问句 empty result: {"ops":[]} leaves observations pending, writes nothing', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const sig = await feedSignal(h.store)
    let calls = 0
    const d = new Distiller(h.service, async () => {
      calls += 1
      return JSON.stringify({ ops: [] })
    })
    const r = await d.run('s1')
    assert.equal(calls, 1)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'no-ops')
    assert.equal(r.marked, 0)
    assert.equal((await h.service.roster()).length, 0)
    // 观察未被消费——走既有 GC 路径（三次失败才删），零静默丢失。
    const pending = await h.store.undistilledObservations()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].id, sig.id)
  } finally {
    h.cleanup()
  }
})

test('lesson branch drops non-create ops (lifecycle is the B4 gate territory) → noOps', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await seedEstablishedLesson(h.service)
    const sig = await feedSignal(h.store)
    const d = new Distiller(h.service, async () =>
      JSON.stringify({ ops: [{ op: 'update', slug: 'commit-no-signoff', conclusion: '改成带署名。', observed_ids: [sig.id] }] }))
    const r = await d.run('s1')
    assert.equal(r.reason, 'no-ops')
    // established lesson 未被蒸馏 lane 改写。
    const doc = await h.store.readTopic('commit-no-signoff')
    assert.match(doc.body, /不带 Co-Authored-By/)
    assert.equal(doc.fm.confidence, 'established')
    assert.equal((await h.store.undistilledObservations()).length, 1)
  } finally {
    h.cleanup()
  }
})

// ---- 矛盾自查（基线版）：conflictsWith 落账 ----

test('conflictsWith against an established lesson: draft still lands as hint + lesson-conflict-flagged event', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await seedEstablishedLesson(h.service)
    const sig = await feedSignal(h.store)
    const d = new Distiller(h.service, async (req) => {
      // 基线清单入 prompt：established lesson 的 condition/title。
      assert.match(req.user, /commit-no-signoff/)
      assert.match(req.user, /Commit No Signoff/)
      return JSON.stringify({ ops: [lessonOp({
        title: 'Commit 要带署名',
        triggers: ['git commit', '署名', 'Co-Authored-By'],
        conclusion: 'commit 一律带上 Co-Authored-By 署名。',
        conflictsWith: ['commit-no-signoff'],
        observed_ids: [sig.id],
      })] })
    })
    const r = await d.run('s1')
    assert.equal(r.ok, true)
    // 处置=仍产 hint 草稿，lane 不改任何生命周期状态。
    const doc = await h.store.readTopic('commit-要带署名')
    assert.equal(doc.fm.confidence, 'hint')
    assert.equal(doc.fm.status, 'draft')
    const old = await h.store.readTopic('commit-no-signoff')
    assert.equal(old.fm.confidence, 'established') // 新覆旧由审批门裁决，蒸馏不动
    const events = await readEvents(h.root)
    const flagged = events.filter((e) => e.kind === 'lesson-conflict-flagged')
    assert.equal(flagged.length, 1)
    assert.equal(flagged[0].detail.op, 'commit-要带署名')
    assert.equal(flagged[0].detail.conflictsWith, 'commit-no-signoff')
    assert.match(r.detail, /conflict-flagged 1 lesson draft/)
  } finally {
    h.cleanup()
  }
})

test('conflictsWith hallucinated slug: no event fabricated, draft still lands', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const sig = await feedSignal(h.store)
    const d = new Distiller(h.service, async () =>
      JSON.stringify({ ops: [lessonOp({ conflictsWith: ['不存在的slug'], observed_ids: [sig.id] })] }))
    const r = await d.run('s1')
    assert.equal(r.ok, true)
    assert.equal((await readEvents(h.root)).filter((e) => e.kind === 'lesson-conflict-flagged').length, 0)
    assert.ok(r.detail === undefined || !r.detail.includes('conflict-flagged'))
    await h.store.readTopic('当蒸馏路由缺失时先探活再重试')
  } finally {
    h.cleanup()
  }
})

// ---- lesson op schema 门 ----

test('lesson schema gate: deficient op rescued by the one 补问 retry (lesson fields)', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const sig = await feedSignal(h.store)
    const deficient = lessonOp({ conclusion: undefined, triggers: ['只有一个'], observed_ids: [sig.id] })
    const complete = lessonOp({ observed_ids: [sig.id] })
    let calls = 0
    const d = new Distiller(h.service, async (req) => {
      calls += 1
      if (calls === 1) {
        assert.equal(req.system, LESSON_PROMPT)
        return JSON.stringify({ ops: [deficient] })
      }
      // 补问用 LESSON_PROMPT，指名 lesson 必填字段。
      assert.equal(req.system, LESSON_PROMPT)
      assert.match(req.user, /schema 补问/)
      assert.match(req.user, /conclusion（祈使句行动指令）/)
      assert.match(req.user, /triggers（恰好 3-8 个 condition 触发短语）/)
      return JSON.stringify({ ops: [complete] })
    })
    const r = await d.run('s1')
    assert.equal(calls, 2)
    assert.equal(r.ok, true)
    assert.deepEqual(r.created, ['当蒸馏路由缺失时先探活再重试'])
    assert.equal((await readEvents(h.root)).filter((e) => e.kind.startsWith('distill-op-')).length, 0)
  } finally {
    h.cleanup()
  }
})

test('lesson schema gate: budget-exhausted drop is ledgered, observations walk the GC path', async () => {
  const h = make({ distillMaxModelCalls: 1 })
  try {
    await h.store.ensure()
    const sig = await feedSignal(h.store)
    const d = new Distiller(h.service, async () =>
      JSON.stringify({ ops: [lessonOp({ conclusion: undefined, observed_ids: [sig.id] })] }))
    const r = await d.run('s1')
    assert.equal(r.ok, false)
    assert.match(r.detail, /全部 lesson op 未通过 schema 校验/)
    const events = await readEvents(h.root)
    assert.ok(events.some((e) => e.kind === 'distill-op-retry-exhausted' && /conclusion/.test(e.detail.missing)))
    assert.equal((await h.store.undistilledObservations()).length, 1)
  } finally {
    h.cleanup()
  }
})

test('lesson schema gate: illegal scope enum is a defect; absent scope defaults to workspace at write', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const sig = await feedSignal(h.store)
    let calls = 0
    const d = new Distiller(h.service, async (req) => {
      calls += 1
      if (calls === 1) return JSON.stringify({ ops: [lessonOp({ scope: 'team', observed_ids: [sig.id] })] })
      assert.match(req.user, /scope 只能是 workspace 或 global/)
      assert.match(req.user, /（缺：scope\(需 workspace\|global\)\）/)
      return JSON.stringify({ ops: [lessonOp({ observed_ids: [sig.id] })] }) // scope 缺省
    })
    const r = await d.run('s1')
    assert.equal(r.ok, true)
    const doc = await h.store.readTopic('当蒸馏路由缺失时先探活再重试')
    assert.equal(doc.fm.scope, 'workspace')
  } finally {
    h.cleanup()
  }
})

test('lesson branch honors the observed_ids corrective retry (bridge semantics unchanged)', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const sig = await feedSignal(h.store)
    let calls = 0
    const d = new Distiller(h.service, async (req) => {
      calls += 1
      if (calls === 1) return JSON.stringify({ ops: [lessonOp({ observed_ids: ['obs-编造'] })] })
      assert.equal(req.system, LESSON_PROMPT, 'corrective retry stays on the lesson prompt')
      assert.match(req.user, /纠错重试/)
      assert.ok(req.user.includes(sig.id))
      return JSON.stringify({ ops: [lessonOp({ observed_ids: [sig.id] })] })
    })
    const r = await d.run('s1')
    assert.equal(calls, 2)
    assert.equal(r.ok, true)
    assert.equal(r.marked, 1)
    assert.equal((await h.store.undistilledObservations()).length, 0)
  } finally {
    h.cleanup()
  }
})
