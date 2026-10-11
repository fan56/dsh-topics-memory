import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { TopicsService } from '../lib/service.js'
import { Distiller, SYSTEM_PROMPT } from '../lib/distill.js'
import { pipelineEventsFile } from '../lib/pipeline-events.js'

// W-D 沉淀侧：A2 links 白名单 + A6 §5.1 create-op schema 门（无 config 键，恒开，
// 失败落 pipeline-events 账不静默）。mock-LLM 家法，禁真网络。

function make(cfgOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'topics-distill-links-'))
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

/** Complete create op — passes the A6 schema gate (description + triggers 3-8). */
const createOp = (over = {}) => ({
  op: 'create',
  title: '新主题',
  description: '一句话概括',
  triggers: ['触发词一', '触发词二', '触发词三'],
  conclusion: '结论散文',
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

// ---- prompt contract ----

test('SYSTEM_PROMPT carries the links field, whitelist rule and schema hard requirement', () => {
  // A2: links on both op shapes, real-associations-only, 宁缺勿滥, whitelist + 落账.
  assert.match(SYSTEM_PROMPT, /"links":\["关联topic的slug"\]/)
  assert.match(SYSTEM_PROMPT, /只建真实语义关联（依赖\/同项目\/同主题链），宁缺勿滥/)
  assert.match(SYSTEM_PROMPT, /已存在 topic 的 slug 或本批其他 op 的 slug/)
  assert.match(SYSTEM_PROMPT, /列表之外的引用会被剔除并落账/)
  assert.match(SYSTEM_PROMPT, /没有真实关联就不要给 links/, 'optional output — no penalty for omitting links')
  // A6 §5.1: description 必填 + triggers 3-8 条升级为 schema 校验（重试一次，仍缺失丢弃落账）.
  assert.match(SYSTEM_PROMPT, /硬性要求：每个 create 必须带 description（一句话概括）与 triggers（恰好 3-8/)
  assert.match(SYSTEM_PROMPT, /补问一次.*丢弃并落账/)
  // 既有 observed_ids 契约不被削弱。
  assert.match(SYSTEM_PROMPT, /硬性要求：每个 op 必须带 observed_ids/)
  assert.match(SYSTEM_PROMPT, /逐字复制/)
})

// ---- A2 links whitelist ----

test('links to an existing slug land as body wikilinks and recompute backlinks', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await h.service.saveTopic({ title: '已有主题', conclusion: '既有结论' })
    const o = await h.store.appendObservation({ kind: 'finding', source: 'auto', text: '观察' })
    const d = new Distiller(h.service, async () =>
      JSON.stringify({ ops: [createOp({ title: '新主题', observed_ids: [o.id], links: ['已有主题'] })] }))
    const r = await d.run('s1')
    assert.equal(r.ok, true)
    assert.deepEqual(r.created, ['新主题'])
    const doc = await h.store.readTopic('新主题')
    assert.match(doc.body, /# Links/)
    assert.match(doc.body, /- \[\[已有主题\]\]/)
    // backlinks.json recomputed inside the same write: the existing topic gains a via:'link' inbound edge.
    const backlinks = await h.store.readBacklinks()
    assert.ok(
      backlinks['已有主题'].some((e) => e.slug === '新主题' && e.via === 'link'),
      `expected a link backlink, got ${JSON.stringify(backlinks['已有主题'])}`,
    )
  } finally {
    h.cleanup()
  }
})

test('same-batch forward link passes the whitelist (target = 本批 op slug)', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const o = await h.store.appendObservation({ kind: 'finding', source: 'auto', text: '观察' })
    const d = new Distiller(h.service, async () =>
      JSON.stringify({
        ops: [
          createOp({ title: '前置主题', observed_ids: [o.id], links: ['后继主题'] }),
          createOp({ title: '后继主题', conclusion: '后继结论', observed_ids: [o.id] }),
        ],
      }))
    const r = await d.run('s1')
    assert.equal(r.ok, true)
    assert.equal(r.created.length, 2)
    const doc = await h.store.readTopic('前置主题')
    assert.match(doc.body, /- \[\[后继主题\]\]/)
    const backlinks = await h.store.readBacklinks()
    assert.ok(backlinks['后继主题'].some((e) => e.slug === '前置主题' && e.via === 'link'))
  } finally {
    h.cleanup()
  }
})

test('out-of-whitelist link is stripped, ledgered link-ref-rejected, op still lands', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await h.service.saveTopic({ title: '已有主题', conclusion: '既有结论' })
    const o = await h.store.appendObservation({ kind: 'finding', source: 'auto', text: '观察' })
    const d = new Distiller(h.service, async () =>
      JSON.stringify({
        ops: [createOp({ title: '新主题', observed_ids: [o.id], links: ['不存在-slug', 'https://example.com', '已有主题'] })],
      }))
    const r = await d.run('s1')
    assert.equal(r.ok, true, 'a rejected link never kills the op')
    assert.match(r.detail ?? '', /rejected 2 invalid link ref\(s\)/)
    const doc = await h.store.readTopic('新主题')
    assert.match(doc.body, /- \[\[已有主题\]\]/)
    assert.doesNotMatch(doc.body, /不存在-slug/)
    assert.equal((doc.body.match(/\[\[已有主题\]\]/g) ?? []).length, 1, 'deduped')
    const events = await readEvents(h.root)
    const rejected = events.filter((e) => e.kind === 'link-ref-rejected')
    assert.equal(rejected.length, 2, 'both bad refs ledgered')
    assert.equal(rejected[0].detail.op, '新主题')
    assert.equal(rejected[0].detail.ref, '不存在-slug')
    assert.equal(rejected[1].detail.ref, 'https://example.com')
    // marks untouched: the observation was consumed by the landed op.
    assert.equal((await h.store.undistilledObservations()).length, 0)
  } finally {
    h.cleanup()
  }
})

test('update op links land on the existing topic; self-link is rejected', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await h.service.saveTopic({ title: '已有主题', conclusion: '既有结论' })
    const o = await h.store.appendObservation({ kind: 'finding', source: 'auto', text: '观察' })
    const d = new Distiller(h.service, async () =>
      JSON.stringify({
        ops: [
          createOp({ title: '新主题', observed_ids: [o.id] }),
          { op: 'update', slug: '已有主题', conclusion: '修订结论', links: ['新主题', '已有主题'], observed_ids: [o.id] },
        ],
      }))
    const r = await d.run('s1')
    assert.equal(r.ok, true)
    assert.deepEqual(r.updated, ['已有主题'])
    const doc = await h.store.readTopic('已有主题')
    assert.match(doc.body, /- \[\[新主题\]\]/)
    assert.doesNotMatch(doc.body, /\[\[已有主题\]\]/, 'self-link rejected, not written')
    const events = await readEvents(h.root)
    assert.ok(events.some((e) => e.kind === 'link-ref-rejected' && e.detail.ref === '已有主题'))
  } finally {
    h.cleanup()
  }
})

// ---- A6 §5.1 schema gate: 补问一次 ----

test('create missing triggers → exactly one schema 补问 rescues the op', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const o = await h.store.appendObservation({ kind: 'finding', source: 'auto', text: '观察' })
    let calls = 0
    const d = new Distiller(h.service, async (req) => {
      calls += 1
      if (calls === 1) {
        return JSON.stringify({ ops: [createOp({ triggers: undefined, observed_ids: [o.id] })] })
      }
      assert.match(req.user, /schema 补问/)
      assert.match(req.user, /triggers/)
      assert.ok(req.user.includes('新主题'), 'the deficient op is named in the 补问')
      return JSON.stringify({ ops: [createOp({ observed_ids: [o.id] })] })
    })
    const r = await d.run('s1')
    assert.equal(calls, 2, 'original + exactly one schema retry')
    assert.equal(r.ok, true)
    assert.deepEqual(r.created, ['新主题'])
    assert.equal(r.marked, 1)
    const doc = await h.store.readTopic('新主题')
    assert.deepEqual(doc.fm.triggers, ['触发词一', '触发词二', '触发词三'])
    // A rescued op leaves NO ledger row — the gate only accounts failures.
    const events = await readEvents(h.root)
    assert.equal(events.filter((e) => e.kind === 'distill-op-invalid' || e.kind === 'distill-op-retry-exhausted').length, 0)
  } finally {
    h.cleanup()
  }
})

test('create still deficient after the 补问 → dropped, distill-op-invalid ledgered, observations NOT consumed', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const o = await h.store.appendObservation({ kind: 'finding', source: 'auto', text: '观察' })
    let calls = 0
    const d = new Distiller(h.service, async () => {
      calls += 1
      // Deficient on both passes (missing description AND triggers out of range).
      return JSON.stringify({ ops: [createOp({ description: undefined, triggers: ['只有一个'], observed_ids: [o.id] })] })
    })
    const r = await d.run('s1')
    assert.equal(calls, 2, 'the 补问 fired once, never twice')
    assert.equal(r.created.length, 0, 'the deficient op never lands')
    assert.equal(await h.store.readTopic('新主题'), undefined)
    const events = await readEvents(h.root)
    const invalid = events.filter((e) => e.kind === 'distill-op-invalid')
    assert.equal(invalid.length, 1, 'one ledger row for the dropped op')
    assert.equal(invalid[0].detail.op, '新主题')
    assert.match(invalid[0].detail.missing, /description/)
    assert.match(invalid[0].detail.missing, /triggers/)
    // observed_ids 桥语义保持: the dropped op's observation is unconsumed →
    // one GC attempt, still pending — no silent loss.
    const pending = await h.store.undistilledObservations()
    assert.deepEqual(pending.map((x) => x.id), [o.id])
    assert.equal((await h.store.allObservations())[0].attempts, 1)
  } finally {
    h.cleanup()
  }
})

test('no budget for the 补问 → drop with distill-op-retry-exhausted (预算 口径)', async () => {
  const h = make({ distillMaxModelCalls: 1 })
  try {
    await h.store.ensure()
    const o = await h.store.appendObservation({ kind: 'finding', source: 'auto', text: '观察' })
    let calls = 0
    const d = new Distiller(h.service, async () => {
      calls += 1
      return JSON.stringify({ ops: [createOp({ triggers: undefined, observed_ids: [o.id] })] })
    })
    const r = await d.run('s1')
    assert.equal(calls, 1, 'a budget of 1 leaves no room for the 补问')
    assert.equal(r.created.length, 0)
    const events = await readEvents(h.root)
    const exhausted = events.filter((e) => e.kind === 'distill-op-retry-exhausted')
    assert.equal(exhausted.length, 1)
    assert.equal(exhausted[0].detail.op, '新主题')
    assert.match(exhausted[0].detail.missing, /预算/)
    assert.equal((await h.store.undistilledObservations()).length, 1)
  } finally {
    h.cleanup()
  }
})

test('the 补问 call itself failing → distill-op-retry-exhausted, op dropped', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const o = await h.store.appendObservation({ kind: 'finding', source: 'auto', text: '观察' })
    let calls = 0
    const d = new Distiller(h.service, async () => {
      calls += 1
      if (calls === 1) return JSON.stringify({ ops: [createOp({ description: undefined, observed_ids: [o.id] })] })
      throw new Error('route unavailable')
    })
    const r = await d.run('s1')
    assert.equal(calls, 2)
    assert.equal(r.created.length, 0)
    const events = await readEvents(h.root)
    const exhausted = events.filter((e) => e.kind === 'distill-op-retry-exhausted')
    assert.equal(exhausted.length, 1)
    assert.match(exhausted[0].detail.missing, /补问调用失败/)
    assert.equal((await h.store.undistilledObservations()).length, 1, 'the observation stays pending, not silently lost')
  } finally {
    h.cleanup()
  }
})

test('partial schema drop: valid ops still land, detail names the drop, only the dropped op pays GC', async () => {
  const h = make()
  try {
    await h.store.ensure()
    const good = await h.store.appendObservation({ kind: 'finding', source: 'auto', text: '会被消费' })
    const bad = await h.store.appendObservation({ kind: 'finding', source: 'auto', text: '随 op 一起被丢' })
    let calls = 0
    const d = new Distiller(h.service, async () => {
      calls += 1
      if (calls === 1) {
        return JSON.stringify({
          ops: [
            createOp({ title: '合规主题', observed_ids: [good.id] }),
            createOp({ title: '缺描述', description: undefined, observed_ids: [bad.id] }),
          ],
        })
      }
      if (calls === 2) {
        // 补问 re-asks only the deficient one, still deficient.
        return JSON.stringify({ ops: [createOp({ title: '缺描述', description: undefined, observed_ids: [bad.id] })] })
      }
      // Batch 2 drains the leftover: the model has nothing more to offer.
      return '{"ops":[]}'
    })
    const r = await d.run('s1')
    assert.equal(calls, 3)
    assert.equal(r.ok, true)
    assert.deepEqual(r.created, ['合规主题'])
    assert.equal(r.marked, 1)
    assert.match(r.detail ?? '', /schema-dropped 1 create op\(s\)/)
    const events = await readEvents(h.root)
    assert.equal(events.filter((e) => e.kind === 'distill-op-invalid').length, 1)
    const all = await h.store.allObservations()
    assert.equal(all.find((x) => x.id === good.id).distilled, true, 'the valid op consumed its observation')
    assert.equal(all.find((x) => x.id === good.id).attempts, undefined, 'consumed never accrues attempts')
    assert.equal(all.find((x) => x.id === bad.id).attempts, 1, 'the dropped op feeds its observation one GC attempt')
    assert.deepEqual((await h.store.undistilledObservations()).map((x) => x.id), [bad.id])
  } finally {
    h.cleanup()
  }
})

test('update ops keep their narrower schema — no description/triggers gate on revisions', async () => {
  const h = make()
  try {
    await h.store.ensure()
    await h.service.saveTopic({ title: '已有主题', conclusion: '既有结论' })
    const o = await h.store.appendObservation({ kind: 'finding', source: 'auto', text: '观察' })
    const d = new Distiller(h.service, async () =>
      JSON.stringify({
        ops: [{ op: 'update', slug: '已有主题', conclusion: '修订结论', observed_ids: [o.id] }],
      }))
    const r = await d.run('s1')
    assert.equal(r.ok, true)
    assert.deepEqual(r.updated, ['已有主题'])
    assert.equal(r.marked, 1)
    const events = await readEvents(h.root)
    assert.equal(events.length, 0, 'no gate, no ledger noise')
  } finally {
    h.cleanup()
  }
})
