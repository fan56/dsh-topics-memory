import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, scoreTopic, searchTopics, DEFAULT_RETRIEVAL } from '../lib/retrieval.js'

function topic(overrides = {}) {
  return {
    slug: 'dsh-cron',
    title: 'dsh-cron 定时插件',
    description: '用 OS cron 驱动 headless 会话执行定时任务',
    status: 'stable',
    tags: ['dsh', 'cron', '定时'],
    depends: ['topics/dsh-plugin-api.md'],
    generatedAt: new Date(Date.now() - 86_400_000).toISOString(), // 1 day ago
    conclusion: 'dsh 原生无 cron 能力，定时靠 headless 加 OS cron，窗口最长一年。',
    ...overrides,
  }
}

test('tokenize: latin words and CJK bigrams', () => {
  const tokens = tokenize('用 dsh-cron 驱动定时任务!')
  assert.ok(tokens.includes('dsh-cron'))
  assert.ok(tokens.includes('定时'))
  assert.ok(tokens.includes('时任'))
  assert.ok(tokens.includes('任务'))
  assert.ok(!tokens.includes('!'))
  const single = tokenize('龙')
  assert.deepEqual(single, ['龙'])
})

test('scoreTopic: related query scores well above unrelated', () => {
  const cfg = { ...DEFAULT_RETRIEVAL, now: new Date() }
  const t = topic()
  const related = scoreTopic(new Set(tokenize('dsh-cron 定时怎么配')), t, cfg)
  const unrelated = scoreTopic(new Set(tokenize('今天晚饭吃什么火锅')), t, cfg)
  assert.ok(related.score >= 0.5, `related=${related.score}`)
  assert.ok(unrelated.score < 0.15, `unrelated=${unrelated.score}`)
  assert.ok(related.reasons.some((r) => r.startsWith('title:')), related.reasons.join(','))
  assert.ok(related.reasons.includes('recency'))
})

test('scoreTopic: conflicted topics demoted but present', () => {
  const cfg = { ...DEFAULT_RETRIEVAL, now: new Date(), conflicts: new Set(['dsh-cron']) }
  const t = topic()
  const plain = scoreTopic(new Set(tokenize('dsh cron 定时')), t, { ...cfg, conflicts: undefined })
  const demoted = scoreTopic(new Set(tokenize('dsh cron 定时')), t, cfg)
  assert.ok(demoted.score < plain.score)
  assert.ok(demoted.reasons.includes('conflicted-demoted'))
  // v4: demotion multiplies the CONTENT score only; recency rides outside it
  // as a pure ranking tiebreaker (never helps any gate).
  assert.ok(Math.abs(demoted.gateScore - plain.gateScore * 0.3) < 0.01)
  assert.ok(Math.abs(demoted.score - (plain.gateScore * 0.3 + 0.2)) < 0.01)
})

test('searchTopics: hit vs near-miss split and topK cap', () => {
  const roster = [
    topic(),
    topic({ slug: 'dsh-cron-window', title: 'dsh-cron 窗口限制', tags: ['cron'], conclusion: '窗口一年。' }),
    topic({ slug: 'unrelated', title: '做饭手册', tags: ['life'], conclusion: '先洗菜。' }),
  ]
  const cfg = { threshold: 0.3, topK: 1, tagBoost: 0.15, graphDepth: 0, recencyWindowDays: 7, now: new Date() }
  const out = searchTopics('dsh cron 定时窗口', roster, cfg)
  assert.equal(out.rosterSize, 3)
  assert.equal(out.hits.length, 1)
  assert.ok(out.hits[0].slug === 'dsh-cron' || out.hits[0].slug === 'dsh-cron-window')
  assert.ok(out.nearMisses.every((n) => n.score < cfg.threshold))
})

test('searchTopics: graph expansion reaches depends neighbors and dependents', () => {
  const roster = [
    topic({ slug: 'base', title: 'dsh 插件 API 基础', tags: ['api'], depends: [], conclusion: 'ctx 与事件模型。' }),
    topic({ slug: 'cron-child', title: '完全无关名字的主题', tags: ['zzz'], depends: ['topics/base.md'], conclusion: '依赖 base 的内容。' }),
  ]
  const cfg = { threshold: 0.9, topK: 4, tagBoost: 0.15, graphDepth: 1, recencyWindowDays: 0, now: new Date() }
  // Only 'base' passes the threshold directly; cron-child enters via graph.
  const out = searchTopics('dsh 插件 api 基础', roster, cfg)
  assert.ok(out.hits.some((h) => h.slug === 'base' && !h.viaGraph))
  assert.ok(out.hits.some((h) => h.slug === 'cron-child' && h.viaGraph))
})

test('searchTopics: [[wikilink]] body edges also feed the graph walk', () => {
  const roster = [
    topic({ slug: 'seed', title: 'dsh 发版流程', tags: ['release'], depends: [], conclusion: 'tag 触发 release。' }),
    topic({ slug: 'linked-via-wikilink', title: '名字完全不同的主题', tags: ['zzz'], depends: [], conclusion: '被 seed 的正文链接引用。' }),
  ]
  // Give seed a body link edge (the roster carries links from bodyLinkSlugs).
  roster[0].links = ['linked-via-wikilink']
  const cfg = { threshold: 0.9, topK: 4, tagBoost: 0.15, graphDepth: 1, recencyWindowDays: 0, now: new Date() }
  const out = searchTopics('dsh 发版流程', roster, cfg)
  assert.ok(out.hits.some((h) => h.slug === 'linked-via-wikilink' && h.viaGraph), JSON.stringify(out.hits))
})

test('searchTopics: empty query or roster yields zero rounds', () => {
  const empty = searchTopics('', [topic()], {})
  assert.equal(empty.hits.length, 0)
  const none = searchTopics('anything', [], {})
  assert.equal(none.rosterSize, 0)
})

test('searchTopics: zero-injection discipline — unrelated query has no hits', () => {
  const out = searchTopics('量子计算纠错码', [topic()], { ...DEFAULT_RETRIEVAL, now: new Date() })
  assert.equal(out.hits.length, 0)
})

// ---------------------------------------------------------------------------
// v4 structural gate v0 (design §4.1)

// A topic sharing NO vocabulary with the probe query except the named field.
function disjoint(overrides = {}) {
  return topic({
    slug: 'cooking',
    title: '烹饪手册',
    description: '家常菜做法',
    tags: [],
    depends: [],
    conclusion: '先洗菜再下锅。',
    ...overrides,
  })
}

test('gate v0: tags-only hit is blocked no matter the numeric score', () => {
  // The v1 priming shape: tags are not a strong field, so even a fat
  // tags-containment score cannot buy a pointer — it surfaces as a
  // gate-blocked near-miss instead.
  const t = disjoint({ tags: ['定时'], description: '', conclusion: '先洗菜再下锅。' })
  const cfg = { ...DEFAULT_RETRIEVAL, now: new Date(), recencyWindowDays: 0 }
  const s = scoreTopic(new Set(tokenize('定时')), t, cfg)
  assert.ok(!s.strong, 'tags alone are not strong')
  assert.equal(s.bodyHits, 0)
  assert.ok(s.gateScore >= 0.3, `score is high but structurally empty: ${s.gateScore}`)
  const out = searchTopics('定时', [t], cfg)
  assert.equal(out.hits.length, 0, 'no pointer without structural evidence')
  assert.ok(out.nearMisses.some((h) => h.slug === 'cooking'), 'blocked candidate stays visible as a near-miss')
  assert.ok(out.nearMisses.find((h) => h.slug === 'cooking').reasons.includes('gate-blocked'))
})

test('gate v0: title / slug hits pass, single body term does not', () => {
  const t = topic({ triggers: undefined, depends: [] })
  const cfg = { ...DEFAULT_RETRIEVAL, now: new Date(), recencyWindowDays: 0 }
  const byTitle = searchTopics('dsh-cron 定时插件', [t], cfg)
  assert.ok(byTitle.hits.some((h) => h.slug === 'dsh-cron' && !h.viaGraph), 'title is a strong field')
  const bySlug = searchTopics('dsh-cron', [t], cfg)
  assert.ok(bySlug.hits.some((h) => h.slug === 'dsh-cron'), 'slug is a strong field')
  // Exactly one body term — the gate demands a second one.
  const thin = disjoint({ description: '定时任务调度策略概论', conclusion: '' })
  const thinOut = searchTopics('定时', [thin], cfg)
  assert.ok(!thinOut.hits.some((h) => h.slug === 'thin') && !thinOut.hits.some((h) => h.slug === 'cooking'), 'single body term blocked')
  const rich = disjoint({ description: '定时任务', conclusion: '定时调度' })
  const richOut = searchTopics('定时 调度', [rich], cfg)
  assert.ok(richOut.hits.some((h) => h.slug === 'cooking'), 'two body terms pass')
})

test('gate v0: triggers are the heaviest strong field', () => {
  const t = disjoint({ triggers: ['发版', 'release'] })
  const cfg = { ...DEFAULT_RETRIEVAL, now: new Date(), recencyWindowDays: 0 }
  const s = scoreTopic(new Set(tokenize('release')), t, cfg)
  assert.ok(s.strong, 'trigger hit is strong')
  assert.ok(s.reasons.some((r) => r.startsWith('triggers:')), s.reasons.join(','))
  assert.ok(s.score >= 5 * 0.5, `trigger weight dominates: ${s.score}`)
  const out = searchTopics('这次 release 怎么办', [t], cfg)
  assert.ok(out.hits.some((h) => h.slug === 'cooking'))
})

test('gate v0: recency never carries a candidate across the threshold', () => {
  // One weak lexical signal (1/15 query terms) sits below the threshold;
  // recency +0.2 pushes the RANKING score over, but the gate sees the
  // recency-free score and keeps the pointer out.
  const t = disjoint({ tags: ['cron'], description: '', conclusion: '' })
  const cfg = { ...DEFAULT_RETRIEVAL, now: new Date(), recencyWindowDays: 7, tagBoost: 0 }
  const query = 'cron weekly report setup guide standup notes retro demo review plan'
  const s = scoreTopic(new Set(tokenize(query)), t, cfg)
  assert.ok(s.reasons.includes('recency'), 'recency still rides the ranking score')
  assert.ok(s.score >= 0.3, `with recency the ranking score crosses: ${s.score}`)
  assert.ok(s.gateScore < 0.3, `gate score excludes recency: ${s.gateScore}`)
  const out = searchTopics(query, [t], cfg)
  assert.equal(out.hits.length, 0, 'recency alone cannot inject')
})

test('gate v0: structuralGate=false keeps the explicit tool path ungated', () => {
  // The same weak evidence the gate would block becomes an ordinary hit when
  // the model explicitly asked (topic_search recall semantics).
  const t = disjoint({ tags: ['cron'], description: 'cron 相关笔记', conclusion: '' })
  const cfg = { ...DEFAULT_RETRIEVAL, now: new Date(), recencyWindowDays: 0 }
  const query = 'cron weekly report setup guide standup notes retro demo review plan'
  assert.equal(searchTopics(query, [t], { ...cfg }).hits.length, 0, 'gated: blocked')
  const ungated = searchTopics(query, [t], { ...cfg, structuralGate: false })
  assert.equal(ungated.hits.length, 1, 'ungated: topic_search keeps recall semantics')
})

test('gate v0: graph expansion stays exempt from the structural gate', () => {
  const seed = topic({ slug: 'seed', title: '图种子', tags: ['graph'], depends: ['topics/neighbor.md'], conclusion: '图种子结论。' })
  const neighbor = topic({ slug: 'neighbor', title: '邻居主题', tags: [], depends: [], conclusion: '邻居结论。' })
  const cfg = { ...DEFAULT_RETRIEVAL, now: new Date(), recencyWindowDays: 0, threshold: 0.9, topK: 4 }
  const out = searchTopics('图种子', [seed, neighbor], cfg)
  assert.ok(out.hits.some((h) => h.slug === 'neighbor' && h.viaGraph), 'graph neighbor still injects')
})

// ---- UsageBoost (ADR 0015) ----

test('usageBoost: rescues a weak-lexical used topic across the gate, with evidence', () => {
  // 8 query tokens; the topic's body hits exactly 2 → gateScore 0.2, under gate.
  const query = '蒸馏 适配器 超时 回滚 折叠 语义 回放 命名'
  const roster = [
    { slug: 'renamed-legacy', title: 'codebase-memory 接入方案', tags: [], depends: [], generatedAt: '2026-09-01T00:00:00Z', conclusion: '适配器 超时', status: 'stable' },
    { slug: 'shiny-new', title: '完全无关的另一件事', tags: [], depends: [], generatedAt: '2026-09-08T00:00:00Z', conclusion: '别的东西', status: 'draft' },
  ]
  const cfg = { usageBoost: 0.15, structuralGate: true }
  const without = searchTopics(query, roster, cfg)
  assert.ok(!without.hits.some((h) => h.slug === 'renamed-legacy'), 'no usage → gateScore 0.2 stays below 0.3')

  const withUsage = searchTopics(query, roster, {
    ...cfg,
    usage: new Map([['renamed-legacy', { hits: 9, opens: 2 }]]),
  })
  const hit = withUsage.hits.find((h) => h.slug === 'renamed-legacy')
  assert.ok(hit, 'usage rescues the weak-lexical used topic across the gate (0.2 + 0.15 = 0.35)')
  assert.ok(hit.reasons.some((r) => r.startsWith('usage:')))
  // gateScore (the numeric-gate score) carries the boost; bodyHits>=2 passes the structural gate.
  assert.ok(hit.gateScore > 0.3 && hit.gateScore < 0.42, `gateScore just past the gate, got ${hit.gateScore}`)
})

test('usageBoost: capped at 0.2, zero-lexical never boosted, 0 disables', () => {
  const query = '蒸馏 适配器 超时 回滚 折叠 语义 回放 命名'
  const roster = [
    { slug: 'weak', title: 'codebase-memory 接入方案', tags: [], depends: [], generatedAt: '2026-09-01T00:00:00Z', conclusion: '适配器 超时', status: 'draft' },
    { slug: 'no-lexical', title: '风马牛不相及', tags: [], depends: [], generatedAt: '2026-09-01T00:00:00Z', conclusion: '别的领域', status: 'draft' },
  ]
  const hugeUsage = new Map([
    ['weak', { hits: 999, opens: 999 }],
    ['no-lexical', { hits: 999, opens: 999 }],
  ])
  // Config 0.5 → effective 0.2 cap: gateScore 0.2 + 0.2 = 0.4, never 0.7.
  const boosted = searchTopics(query, roster, { usageBoost: 0.5, structuralGate: true, usage: hugeUsage })
  const weak = boosted.hits.find((h) => h.slug === 'weak')
  assert.ok(weak, 'weak lexical + capped usage crosses the gate')
  assert.ok(weak.gateScore < 0.5, `cap holds: gateScore ${weak.gateScore} (uncapped would be ~0.77)`)
  // Zero-lexical candidate: score===0 → boost never granted, never in hits.
  const none = searchTopics(query, roster, { usageBoost: 0.5, structuralGate: false, usage: hugeUsage })
  assert.ok(!none.hits.some((h) => h.slug === 'no-lexical'), 'zero-lexical never rides usage into hits')
  // usageBoost: 0 → identical hit set to a run with no usage map at all.
  const off = searchTopics(query, roster, { usageBoost: 0, structuralGate: true, usage: hugeUsage })
  const base = searchTopics(query, roster, { usageBoost: 0.15, structuralGate: true })
  assert.deepEqual(off.hits.map((h) => h.slug), base.hits.map((h) => h.slug))
})
