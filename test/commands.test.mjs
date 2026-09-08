import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { TopicsService } from '../lib/service.js'
import { buildTopicsCommand, tuningHint, HELP } from '../lib/commands.js'

function makeService(cfgOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'topics-cmd-'))
  const store = new BundleStore(root)
  let cfg = {
    repo: '', autoInject: true, injectDedup: true, topK: 4, perTopicBudget: 300, totalBudget: 1500,
    matchThreshold: 0.3, tagBoost: 0.15, graphDepth: 2, recencyWindowDays: 7,
    autoObserve: true, observationMaxChars: 2000, distillEveryTurns: 20,
    distillOnSessionEnd: true, distillProvider: '', distillModel: '', pushDebounceSeconds: 45,
    ...cfgOverrides,
  }
  const service = new TopicsService(store, () => cfg)
  const mutations = []
  const mutate = async (ops) => {
    mutations.push(ops)
    for (const op of ops) cfg = { ...cfg, [op.path[0]]: op.value }
  }
  const cleanup = () => rmSync(root, { recursive: true, force: true })
  return { store, service, mutations, mutate, cleanup, setCfg: (patch) => { cfg = { ...cfg, ...patch } }, getCfg: () => cfg }
}

const inv = (rawInput) => ({ rawInput, signal: undefined })

/** Scripted ask-user provider: pops one answer batch per ask() call. */
function fakeAsk(script) {
  const calls = []
  return {
    calls,
    ask: async (req) => {
      calls.push(req)
      const next = script.shift()
      if (next === undefined) {
        const err = new Error('panel closed')
        err.code = 'ASK_CANCELLED'
        throw err
      }
      return { answers: next }
    },
  }
}

/** Mock llm directory for the distill pickers. */
function fakeLlm() {
  const llm = {
    providers: [{ id: 'prov', name: 'Prov One' }, { id: 'zai-coding-cn', name: 'Zai Coding' }],
    modelsByProvider: { prov: [{ provider: 'prov', id: 'm1', name: 'M1' }, { provider: 'prov', id: 'm2', name: 'M2' }] },
    validated: [],
    validateError: undefined, // optional fn(provider, model) → thrown error
    listProviders() { return llm.providers },
    listModels: async (p) => llm.modelsByProvider[p] ?? [],
    resolveModelInfo: async (p, m) => {
      llm.validated.push(`${p}/${m}`)
      if (llm.validateError !== undefined) {
        const err = llm.validateError(p, m)
        if (err !== undefined) throw err
      }
      return { provider: p, id: m, name: m }
    },
  }
  return llm
}

test('command: bare /topics prints help', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    const cmd = buildTopicsCommand(service, mutate)
    const r = await cmd.handler(inv(''))
    assert.equal(r.kind, 'success')
    assert.match(r.text, /\/topics status/)
    assert.equal(HELP.length > 100, true)
  } finally {
    cleanup()
  }
})

test('command: status shows mode, counts, injection settings', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    await service.store.ensure()
    const cmd = buildTopicsCommand(service, mutate)
    const r = await cmd.handler(inv('status'))
    assert.equal(r.kind, 'success')
    assert.match(r.text, /local-only/)
    assert.match(r.text, /\| Topics \| 0（draft 0/)
    assert.match(r.text, /topK 4/)
    assert.match(r.text, /\| 注入去重 \| 开/)
  } finally {
    cleanup()
  }
})

test('command: stats empty vs populated + list + show', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    await service.store.ensure()
    const cmd = buildTopicsCommand(service, mutate)
    const empty = await cmd.handler(inv('stats'))
    assert.match(empty.text, /还没有注入记录/)
    await service.saveTopic({ title: 'alpha topic', conclusion: '结论 A' })
    await service.store.appendInjectionRecord({ at: 't', queryTokenCount: 3, rosterSize: 1, hits: [{ slug: 'alpha-topic', score: 1.2, reasons: [], viaGraph: false }], nearMisses: [], injected: true, usedTokens: 120 })
    const stats = await cmd.handler(inv('stats'))
    assert.match(stats.text, /100\.0%/)
    assert.match(stats.text, /\| `alpha-topic` \| 1 \|/)
    const list = await cmd.handler(inv('list'))
    assert.match(list.text, /alpha topic/)
    const show = await cmd.handler(inv('show alpha-topic'))
    assert.match(show.text, /title: alpha topic/)
    const showMissing = await cmd.handler(inv('show nope'))
    assert.equal(showMissing.kind, 'error')
  } finally {
    cleanup()
  }
})

test('command: list renders a markdown table (newest first, index, tags, escaping)', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    await service.store.ensure()
    await service.saveTopic({ title: 'bravo | beta', conclusion: 'B', tags: ['X', 'y'] })
    await service.saveTopic({ title: 'alpha topic', conclusion: 'A' })
    const cmd = buildTopicsCommand(service, mutate)
    const r = await cmd.handler(inv('list'))
    assert.equal(r.kind, 'success')
    assert.match(r.text, /共 2 个 Topic/)
    assert.match(r.text, /\| # \| Slug \| 标题 \| 状态 \| 标签 \| 更新 \|/)
    assert.match(r.text, /\| --- \| --- \| --- \| --- \| --- \| --- \|/)
    const rows = r.text.split('\n').filter((l) => /^\| \d+ \|/.test(l))
    assert.equal(rows.length, 2)
    // Exact rows: newest first (alpha was saved last), 1-based index, pipes
    // in title escaped, tags lowercased, date-only stamp. (Regex literals
    // would need every `|` escaped — exact strings pin the rendering harder.)
    const dateOf = (slug) => service.store.listTopics().then((ms) => ms.find((m) => m.slug === slug).generatedAt.slice(0, 10))
    assert.equal(rows[0], `| 1 | \`alpha-topic\` | alpha topic | draft | — | ${await dateOf('alpha-topic')} |`)
    assert.equal(rows[1], `| 2 | \`bravo-beta\` | bravo \\| beta | draft | #x #y | ${await dateOf('bravo-beta')} |`)
    assert.doesNotMatch(r.text, /T\d{2}:/)
  } finally {
    cleanup()
  }
})

test('command: list caps the table at 100 newest with an overflow notice', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    await service.store.ensure()
    for (let i = 0; i < 102; i++) {
      await service.saveTopic({ title: `bulk topic ${i}`, conclusion: `c${i}` })
      // generated.at is millisecond-precision; a 1ms stagger guarantees the
      // newest-first order the exact-row assertions below rely on (the slug
      // tiebreak sorts bulk-topic-10 before bulk-topic-2 lexicographically).
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    const cmd = buildTopicsCommand(service, mutate)
    const r = await cmd.handler(inv('list'))
    assert.equal(r.kind, 'success')
    assert.match(r.text, /共 102 个 Topic/)
    const rows = r.text.split('\n').filter((l) => /^\| \d+ \|/.test(l))
    assert.equal(rows.length, 100, 'exactly the cap: 100 data rows')
    assert.ok(rows[0].startsWith(expectIndex(1)), `row 1 is the newest: ${rows[0]}`)
    assert.ok(rows[99].startsWith(expectIndex(100)), `row 100 is the 100th newest: ${rows[99]}`)
    assert.match(r.text, /其余 2 个更早的 Topic 未显示/)
  } finally {
    cleanup()
  }

  /** The expected table row prefix for the n-th newest bulk topic (slug bulk-topic-N). */
  function expectIndex(n) {
    const i = 102 - n
    return `| ${n} | \`bulk-topic-${i}\` | bulk topic ${i} | draft | — | `
  }
})

test('command: history works on git-backed bundle', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    await service.store.ensure()
    await service.saveTopic({ title: ' evolving ', conclusion: 'v1' })
    await service.saveTopic({ title: ' evolving ', conclusion: 'v2', slug: 'evolving' })
    const cmd = buildTopicsCommand(service, mutate)
    const r = await cmd.handler(inv('history evolving'))
    assert.equal(r.kind, 'success')
    assert.match(r.text, /变更史/)
    assert.match(r.text, /当时的结论/)
  } finally {
    cleanup()
  }
})

test('command: show renders backlinks section when referenced', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    await service.store.ensure()
    // base links OUT to ref-topic and panel → those two have backlinks.
    await service.saveTopic({ title: 'base topic', conclusion: '见 [[ref-topic]] 与 [面板](topics/panel.md)。' })
    await service.saveTopic({ title: 'ref topic', conclusion: '被 base 引用', slug: 'ref-topic' })
    await service.saveTopic({ title: 'panel', conclusion: '被 base 引用', slug: 'panel' })
    const cmd = buildTopicsCommand(service, mutate)
    const showRef = await cmd.handler(inv('show ref-topic'))
    assert.match(showRef.text, /反向引用/)
    assert.match(showRef.text, /base-topic（链接）/)
    const showPanel = await cmd.handler(inv('show panel'))
    assert.match(showPanel.text, /base-topic（链接）/)
    // base itself references out but is referenced by nobody → no section.
    const showBase = await cmd.handler(inv('show base-topic'))
    assert.doesNotMatch(showBase.text, /反向引用/)
  } finally {
    cleanup()
  }
})

test('command: sync refuses in local-only mode', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    const cmd = buildTopicsCommand(service, mutate)
    const r = await cmd.handler(inv('sync'))
    assert.equal(r.kind, 'error')
    assert.match(r.text, /local-only/)
  } finally {
    cleanup()
  }
})

test('command: config lists all keys; set validates and applies', async () => {
  const { service, mutate, mutations, cleanup } = makeService()
  try {
    const cmd = buildTopicsCommand(service, mutate)
    const cfgOut = await cmd.handler(inv('config'))
    for (const key of ['repo', 'inject-dedup', 'match-threshold', 'distill-model', 'push-debounce-seconds']) {
      assert.match(cfgOut.text, new RegExp(key.replace(/-/g, '\\-')))
    }
    const bad = await cmd.handler(inv('set repo not-a-repo'))
    assert.equal(bad.kind, 'error')
    const unknown = await cmd.handler(inv('set nonsense 1'))
    assert.equal(unknown.kind, 'error')
    const good = await cmd.handler(inv('set repo owner/name'))
    assert.equal(good.kind, 'success')
    assert.match(good.text, /repo = owner\/name/)
    assert.equal(mutations.length, 1)
    const threshold = await cmd.handler(inv('set match-threshold 0.25'))
    assert.match(threshold.text, /0\.25/)
    const sa = await cmd.handler(inv('set include-subagents off'))
    assert.match(sa.text, /include-subagents = false/)
    const saOn = await cmd.handler(inv('set include-subagents on'))
    assert.match(saOn.text, /include-subagents = true/)
    const dd = await cmd.handler(inv('set inject-dedup off'))
    assert.match(dd.text, /inject-dedup = false/)
    const ddOn = await cmd.handler(inv('set inject-dedup on'))
    assert.match(ddOn.text, /inject-dedup = true/)
    const off = await cmd.handler(inv('set autoinject off'))
    assert.match(off.text, /false/)
    const badBool = await cmd.handler(inv('set autoinject maybe'))
    assert.equal(badBool.kind, 'error')
  } finally {
    cleanup()
  }
})

test('command: unknown subaction errors with help', async () => {
  const { service, mutate, cleanup } = makeService()
  try {
    const cmd = buildTopicsCommand(service, mutate)
    const r = await cmd.handler(inv('frobnicate'))
    assert.equal(r.kind, 'error')
    assert.match(r.text, /\/topics status/)
  } finally {
    cleanup()
  }
})

// ---- /topics set: distill-route text path (C — mixed-value split) ----

test('set distill-model: "provider model" space form splits into BOTH keys', async () => {
  const { service, mutations, mutate, cleanup, getCfg } = makeService()
  try {
    const cmd = buildTopicsCommand(service, mutate)
    const r = await cmd.handler(inv('set distill-model zai-coding-cn glm-5.3-flash'))
    assert.equal(r.kind, 'success')
    assert.match(r.text, /distill-provider = zai-coding-cn/)
    assert.match(r.text, /distill-model = glm-5\.3-flash/)
    assert.match(r.text, /两个键/)
    assert.equal(mutations.length, 1)
    assert.deepEqual(mutations[0].map((o) => o.path[0]), ['distillProvider', 'distillModel'])
    assert.equal(getCfg().distillProvider, 'zai-coding-cn')
    assert.equal(getCfg().distillModel, 'glm-5.3-flash')
  } finally {
    cleanup()
  }
})

test('set distill-model: provider/model slash form splits too; nested-slash models need the space form', async () => {
  const { service, mutations, mutate, cleanup, getCfg } = makeService()
  try {
    const cmd = buildTopicsCommand(service, mutate)
    const slash = await cmd.handler(inv('set distill-model prov/m1'))
    assert.match(slash.text, /distill-provider = prov/)
    assert.equal(getCfg().distillModel, 'm1')
    // Space form wins so the model id itself may contain slashes.
    const nested = await cmd.handler(inv('set distill-model openrouter meta-llama/llama-3'))
    assert.equal(getCfg().distillProvider, 'openrouter')
    assert.equal(getCfg().distillModel, 'meta-llama/llama-3')
    assert.equal(mutations.length, 2)
    for (const batch of mutations) assert.deepEqual(batch.map((o) => o.path[0]), ['distillProvider', 'distillModel'])
  } finally {
    cleanup()
  }
})

test('set distill-model: bare model name writes only distill-model', async () => {
  const { service, mutations, mutate, cleanup, getCfg } = makeService()
  try {
    const cmd = buildTopicsCommand(service, mutate)
    const r = await cmd.handler(inv('set distill-model glm-5.3-flash'))
    assert.equal(r.kind, 'success')
    assert.doesNotMatch(r.text, /两个键/)
    assert.deepEqual(mutations[0].map((o) => o.path[0]), ['distillModel'])
    assert.equal(getCfg().distillModel, 'glm-5.3-flash')
    assert.equal(getCfg().distillProvider, '')
  } finally {
    cleanup()
  }
})

test('set distill-provider: only a single segment is accepted', async () => {
  const { service, mutations, mutate, cleanup } = makeService()
  try {
    const cmd = buildTopicsCommand(service, mutate)
    const spaced = await cmd.handler(inv('set distill-provider zai-coding-cn glm-5.3-flash'))
    assert.equal(spaced.kind, 'error')
    assert.match(spaced.text, /单段/)
    const slashed = await cmd.handler(inv('set distill-provider prov/model'))
    assert.equal(slashed.kind, 'error')
    const good = await cmd.handler(inv('set distill-provider zai-coding-cn'))
    assert.equal(good.kind, 'success')
    assert.deepEqual(mutations[0].map((o) => o.path[0]), ['distillProvider'])
    assert.equal(mutations.length, 1)
  } finally {
    cleanup()
  }
})

// ---- /topics set: distill-route interactive path (B) ----

test('set distill-provider without value opens the provider panel and writes the pick', async () => {
  const { service, mutations, mutate, cleanup, getCfg } = makeService()
  try {
    const ask = fakeAsk([[{ id: 'distill-provider', selected: ['prov'] }]])
    const cmd = buildTopicsCommand(service, mutate, () => ask, () => [fakeLlm()])
    const r = await cmd.handler(inv('set distill-provider'))
    assert.equal(r.kind, 'success')
    assert.match(r.text, /distill-provider = prov/)
    assert.equal(ask.calls.length, 1)
    assert.equal(ask.calls[0].questions[0].id, 'distill-provider')
    assert.deepEqual(ask.calls[0].questions[0].options.map((o) => o.label), ['prov', 'zai-coding-cn'])
    assert.deepEqual(mutations[0].map((o) => o.path[0]), ['distillProvider'])
    assert.equal(getCfg().distillProvider, 'prov')
  } finally {
    cleanup()
  }
})

test('set distill-model without value lists the configured provider models; needs provider first', async () => {
  const { service, mutations, mutate, cleanup, setCfg, getCfg } = makeService()
  try {
    const ask = fakeAsk([[{ id: 'distill-model', selected: ['m2'] }]])
    const cmd = buildTopicsCommand(service, mutate, () => ask, () => [fakeLlm()])
    const noProvider = await cmd.handler(inv('set distill-model'))
    assert.equal(noProvider.kind, 'error')
    assert.match(noProvider.text, /先配置 distill-provider/)
    assert.equal(ask.calls.length, 0)
    setCfg({ distillProvider: 'prov' })
    const r = await cmd.handler(inv('set distill-model'))
    assert.equal(r.kind, 'success')
    assert.match(r.text, /distill-model = m2/)
    assert.equal(ask.calls[0].questions[0].id, 'distill-model')
    assert.deepEqual(ask.calls[0].questions[0].options.map((o) => o.label), ['m1', 'm2'])
    assert.deepEqual(mutations[0].map((o) => o.path[0]), ['distillModel'])
    assert.equal(getCfg().distillModel, 'm2')
  } finally {
    cleanup()
  }
})

test('set distill interactive: cancel and blank answer write nothing', async () => {
  const { service, mutations, mutate, cleanup, setCfg } = makeService()
  try {
    setCfg({ distillProvider: 'prov' })
    const cancelled = fakeAsk([])
    const cmd = buildTopicsCommand(service, mutate, () => cancelled, () => [fakeLlm()])
    const r = await cmd.handler(inv('set distill-model'))
    assert.equal(r.kind, 'success')
    assert.match(r.text, /已取消/)
    assert.equal(mutations.length, 0)
    const blank = fakeAsk([[{ id: 'distill-provider', selected: [] }]])
    const cmd2 = buildTopicsCommand(service, mutate, () => blank, () => [fakeLlm()])
    const r2 = await cmd2.handler(inv('set distill-provider'))
    assert.equal(r2.kind, 'success')
    assert.match(r2.text, /保持原样/)
    assert.equal(mutations.length, 0)
  } finally {
    cleanup()
  }
})

test('set distill keys without value and without llm error out instead of clearing the key', async () => {
  const { service, mutations, mutate, cleanup } = makeService()
  try {
    const ask = fakeAsk([])
    const cmd = buildTopicsCommand(service, mutate, () => ask, () => [])
    const r = await cmd.handler(inv('set distill-provider'))
    assert.equal(r.kind, 'error')
    assert.match(r.text, /需要一个值/)
    assert.match(r.text, /本机未检测到可用模型路由/)
    assert.equal(ask.calls.length, 0, 'no panel without the llm directory')
    assert.equal(mutations.length, 0, 'never silently clears the key')
  } finally {
    cleanup()
  }
})

test('set distill keys without value: empty llm directory gets its own message', async () => {
  const { service, mutations, mutate, cleanup } = makeService()
  try {
    const emptyLlm = { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) }
    const cmd = buildTopicsCommand(service, mutate, () => fakeAsk([]), () => [emptyLlm])
    const r = await cmd.handler(inv('set distill-provider'))
    assert.equal(r.kind, 'error')
    assert.match(r.text, /需要一个值/)
    assert.match(r.text, /没有已启用的模型 provider/)
    assert.equal(mutations.length, 0)
  } finally {
    cleanup()
  }
})

test('set distill-provider without value picks the first candidate with a non-empty route table', async () => {
  const { service, mutations, mutate, cleanup, getCfg } = makeService()
  try {
    // root first but route-less, scoped second and live → the live one wins.
    const rootEmpty = { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) }
    const scopedLive = {
      listProviders: () => [{ id: 'scoped-prov', name: 'Scoped' }],
      listModels: async () => [{ provider: 'scoped-prov', id: 'sm1', name: 'SM1' }],
      resolveModelInfo: async (p, m) => ({ provider: p, id: m }),
    }
    const ask = fakeAsk([[{ id: 'distill-provider', selected: ['scoped-prov'] }]])
    const cmd = buildTopicsCommand(service, mutate, () => ask, () => [rootEmpty, scopedLive])
    const r = await cmd.handler(inv('set distill-provider'))
    assert.equal(r.kind, 'success')
    assert.match(r.text, /distill-provider = scoped-prov/)
    assert.deepEqual(ask.calls[0].questions[0].options.map((o) => o.label), ['scoped-prov'])
    assert.equal(getCfg().distillProvider, 'scoped-prov')
  } finally {
    cleanup()
  }
})

// ---- /topics set: distill-route panel validation (mirrors the wizard) ----

test('set distill-provider custom id outside the route table blocks and re-asks', async () => {
  const { service, mutations, mutate, cleanup, getCfg } = makeService()
  try {
    const ask = fakeAsk([
      [{ id: 'distill-provider', custom: 'no-such-prov' }],
      [{ id: 'distill-provider', selected: ['prov'] }],
    ])
    const cmd = buildTopicsCommand(service, mutate, () => ask, () => [fakeLlm()])
    const r = await cmd.handler(inv('set distill-provider'))
    assert.equal(r.kind, 'success')
    assert.equal(ask.calls.length, 2)
    assert.match(ask.calls[1].questions[0].detail, /⚠️ provider no-such-prov 当前没有可用的模型路由/)
    assert.equal(getCfg().distillProvider, 'prov')
    assert.equal(mutations.length, 1)
  } finally {
    cleanup()
  }
})

test('set distill-provider custom id: exhausting re-asks fails with zero writes', async () => {
  const { service, mutations, mutate, cleanup } = makeService()
  try {
    const answer = [{ id: 'distill-provider', custom: 'no-such-prov' }]
    const ask = fakeAsk([answer, answer, answer])
    const cmd = buildTopicsCommand(service, mutate, () => ask, () => [fakeLlm()])
    const r = await cmd.handler(inv('set distill-provider'))
    assert.equal(r.kind, 'error')
    assert.match(r.text, /多次选择仍没有可用的模型路由/)
    assert.equal(mutations.length, 0)
  } finally {
    cleanup()
  }
})

test('set distill-model: NO_ADAPTER blocks and re-asks; off-catalog failure warns but writes', async () => {
  const { service, mutations, mutate, cleanup, setCfg, getCfg } = makeService()
  try {
    setCfg({ distillProvider: 'prov' })
    // NO_ADAPTER on the model check → block + re-ask (only m1 is blocked).
    const blocked = fakeLlm()
    blocked.validateError = (p, m) => {
      if (m !== 'm1') return undefined
      const e = new Error('no adapter registered for provider "prov"')
      e.code = 'NO_ADAPTER'
      return e
    }
    const ask = fakeAsk([[{ id: 'distill-model', selected: ['m1'] }], [{ id: 'distill-model', selected: ['m2'] }]])
    const cmd = buildTopicsCommand(service, mutate, () => ask, () => [blocked])
    const r = await cmd.handler(inv('set distill-model'))
    assert.equal(r.kind, 'success')
    assert.equal(ask.calls.length, 2)
    assert.match(ask.calls[1].questions[0].detail, /⚠️ provider prov 当前没有可用的模型路由/)
    assert.equal(getCfg().distillModel, 'm2')
    // Off-catalog failure (non-NO_ADAPTER) → warn but allow.
    const advisory = fakeLlm()
    advisory.validateError = () => {
      const e = new Error('model not in catalog')
      e.code = 'MODEL_NOT_FOUND'
      return e
    }
    const ask2 = fakeAsk([[{ id: 'distill-model', custom: 'weird-model' }]])
    const cmd2 = buildTopicsCommand(service, mutate, () => ask2, () => [advisory])
    const r2 = await cmd2.handler(inv('set distill-model'))
    assert.equal(r2.kind, 'success')
    assert.match(r2.text, /⚠️ weird-model 未通过 prov 的模型目录校验（模型目录外，可能仍可用），已放行/)
    assert.equal(getCfg().distillModel, 'weird-model')
    assert.equal(mutations.length, 2)
  } finally {
    cleanup()
  }
})

// ---- /topics set: mixed-value split overwrite notice ----

test('set distill-model split warns when it overwrites an existing distill-provider', async () => {
  const { service, mutations, mutate, cleanup, setCfg, getCfg } = makeService()
  try {
    setCfg({ distillProvider: 'old-prov' })
    const cmd = buildTopicsCommand(service, mutate)
    const r = await cmd.handler(inv('set distill-model new-prov m1'))
    assert.equal(r.kind, 'success')
    assert.match(r.text, /⚠️ 已覆盖原 distill-provider «old-prov»/)
    assert.equal(getCfg().distillProvider, 'new-prov')
    // Same provider → no warning; empty previous provider → no warning either.
    const same = await cmd.handler(inv('set distill-model new-prov m2'))
    assert.doesNotMatch(same.text, /已覆盖/)
    assert.equal(getCfg().distillModel, 'm2')
    setCfg({ distillProvider: '' })
    const fresh = await cmd.handler(inv('set distill-model zai-coding-cn glm-5'))
    assert.doesNotMatch(fresh.text, /已覆盖/)
    assert.equal(getCfg().distillProvider, 'zai-coding-cn')
    assert.equal(mutations.length, 3)
  } finally {
    cleanup()
  }
})

test('tuningHint: dense near-miss band just below threshold suggests lowering', () => {
  const mk = (n) => Array.from({ length: n }, () => ({}))
  const stats = {
    rounds: 40,
    injectedRounds: 10,
    hitRate: 0.25,
    zeroHitRounds: 25,
    avgHitsPerRound: 0.3,
    topTopics: [],
    nearMissHistogram: [
      { bucket: '0.15–0.20', count: 2 },
      { bucket: '0.20–0.25', count: 14 },
      { bucket: '0.25–0.30', count: 12 },
    ],
    avgBudgetUtilization: 100,
  }
  const hint = tuningHint(stats, 0.3)
  assert.match(hint, /match-threshold 0\.20/)
  // Healthy hit rate → no hint.
  const healthy = { ...stats, hitRate: 0.8, injectedRounds: 32 }
  assert.equal(tuningHint(healthy, 0.3), undefined)
})

test('command: /topics distill — unwired, empty pool, success summary, failure reason', async () => {
  const { service, mutate, store, cleanup } = makeService()
  try {
    await store.ensure()
    // Unwired lane → readable error, not a crash.
    const bare = buildTopicsCommand(service, mutate)
    const r0 = await bare.handler(inv('distill'))
    assert.equal(r0.kind, 'error')
    assert.match(r0.text, /未接线/)
    // Empty pool → immediate no-observations hint; the lane is never invoked.
    let laneCalls = 0
    const lane = async () => {
      laneCalls += 1
      return { ok: false, reason: 'no-observations', created: [], updated: [], marked: 0 }
    }
    const cmd = buildTopicsCommand(service, mutate, () => undefined, () => [], lane)
    const r1 = await cmd.handler(inv('distill'))
    assert.equal(r1.kind, 'success')
    assert.match(r1.text, /观察池为空/)
    assert.equal(laneCalls, 0, 'an empty pool answers without touching the lane')
    // Populated pool → the summary mirrors the distill-state fields.
    await store.appendObservation({ kind: 'finding', source: 'auto', text: 'x' })
    const r2 = await buildTopicsCommand(service, mutate, () => undefined, () => [], async () => ({
      ok: true,
      created: ['t1'],
      updated: ['t2'],
      marked: 3,
      gcDropped: 1,
      detail: 'partial: 已蒸馏标记 3 条观察（2 次模型调用）；…',
    })).handler(inv('distill'))
    assert.equal(r2.kind, 'success')
    assert.match(r2.text, /标记 3 条观察/)
    assert.match(r2.text, /新建 1 个 Topic/)
    assert.match(r2.text, /更新 1 个 Topic/)
    assert.match(r2.text, /GC 回收 1 条不可处理观察/)
    assert.match(r2.text, /partial/)
    // Lane failure → error result naming the reason.
    const r3 = await buildTopicsCommand(service, mutate, () => undefined, () => [], async () => ({
      ok: false, reason: 'in-flight', created: [], updated: [], marked: 0,
    })).handler(inv('distill'))
    assert.equal(r3.kind, 'error')
    assert.match(r3.text, /已有蒸馏在跑/)
    // The action is discoverable.
    assert.match(HELP, /\/topics distill/)
  } finally {
    cleanup()
  }
})
