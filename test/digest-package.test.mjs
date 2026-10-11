import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assemblePackage,
  PACKAGE_TOTAL,
  PACKAGE_DIRECT_MAX,
  PACKAGE_DIRECT_BUDGET,
  PACKAGE_NEIGHBOR_MAX,
  PACKAGE_WEAK_MAX,
} from '../lib/digest.js'
import { tokenize } from '../lib/retrieval.js'

// 夹具取自 A1 实样（a1-data/replays.txt 的 topic 形状）：slug/title/status/
// description（缺失走 conclusion 首行）/score/reasons/via。
const cand = (over = {}) => ({
  slug: 'some-topic',
  title: '某主题',
  status: 'stable',
  description: '描述一行',
  conclusion: '结论首行',
  score: 1,
  reasons: [],
  ...over,
})

// 场景①「回复 ok 即可，不要调用任何工具」当时的 4 条平铺注入（replays.txt）。
const ACK_ROSTER = [
  cand({
    slug: 'dsh-subagent-workhorse-不可用opencode-go-无适配器',
    title: 'dsh subagent workhorse 不可用（opencode-go 无适配器）',
    status: 'draft',
    description: 'workhorse 已绑 mimo-v2.6-flash 且 provider 元数据补全，仅剩凭证未录入',
    conclusion: 'workhorse 适配缺失',
    score: 0.51,
    reasons: ['tags:0.25'],
  }),
  cand({
    slug: 'dsh-llmwiki-memory-事件钩子机制与双通道沉淀设计adr-0004',
    title: 'dsh-llmwiki-memory 事件钩子机制与双通道沉淀设计（ADR 0004）',
    status: 'draft',
    conclusion: '纯 Cordis 事件订阅驱动，双通道沉淀设计',
    score: 0.43,
    reasons: ['conclusion:0.10'],
  }),
  cand({
    slug: 'cbm-cli-command-surface',
    title: 'codebase-memory-mcp CLI 命令面全景（0.10.8 实测）',
    status: 'stable',
    description: '',
    score: 0.31,
    reasons: ['title:0.33'],
  }),
  cand({
    slug: 'dsh-tui-pi-podman-e2e-全绿与-v211-发布宿主-alpha4-契约漂移修复',
    title: 'dsh-tui-pi podman e2e 全绿与 v2.1.1 发布（宿主 alpha.4 契约漂移修复）',
    status: 'stable',
    conclusion: '宿主 alpha.4 encodeMaterialization 契约漂移修复后 e2e 全绿',
    score: 0.31,
    reasons: ['title:0.33'],
  }),
]

const THREE_LAYER_INPUT = () => ({
  query: '把关 cs-geely-alert-manager-api 覆盖率补测，顺带部署 voice-agent 的质量验证',
  queryTokens: tokenize('把关 cs-geely-alert-manager-api 覆盖率补测，顺带部署 voice-agent 的质量验证'),
  direct: [
    cand({
      slug: 'voice-agent-qa-quality-verify-20260904',
      title: 'cs-geely-voice-agent QA 质量铁律验证 2026-09-04',
      status: 'stable',
      description: '含逐项铁律清单与 PASS 取数',
      conclusion: 'voice-agent QA 部署质量铁律验证 PASS（2026-09-04）',
      score: 4.03,
      reasons: ['triggers:0.83', 'title:0.50'],
    }),
    cand({
      slug: 'vcc-cloud-quality-verify-质量铁律执行实操坑',
      title: 'vcc-cloud-quality-verify 质量铁律执行实操坑',
      status: 'draft',
      description: '',
      conclusion: '质量铁律执行的实操坑与规避顺序',
      score: 2.73,
      reasons: ['title:0.33'],
    }),
  ],
  neighborhood: [
    cand({
      slug: 'volvo-cn-qa-k8s-network-proxy',
      title: 'Volvo China QA K8s 网络路径：必须走公司代理',
      status: 'stable',
      score: 0.69,
      reasons: ['depends:d1'],
      via: 'depends:d1',
    }),
    cand({
      slug: 'dsh-profile-link部署与双闭包规避',
      title: 'dsh profile link: 开发模式部署与双闭包规避',
      status: 'stable',
      score: 0.55,
      reasons: ['slow-pick'],
      via: 'slow-pick',
    }),
  ],
  weak: [
    cand({
      slug: 'cs-geely-alert-manager-api-coverage-tests-review',
      title: 'cs-geely-alert-manager-api 覆盖率补测审查与闭环',
      status: 'draft',
      score: 0.28,
      reasons: ['title:0.20'],
    }),
    cand({
      slug: 'pi-llm-wiki-注入机制对比与语义兜底迁移障碍',
      title: 'pi-llm-wiki 注入机制对比与语义兜底迁移障碍',
      status: 'draft',
      score: 0.24,
      reasons: ['conclusion:0.10'],
    }),
  ],
})

test('package: three layers assemble with 包头 counts, why lines, open guidance', () => {
  const input = THREE_LAYER_INPUT()
  const r = assemblePackage(input, { mode: 'on' })
  assert.ok(r !== null)
  // 包头：资料声明 + 为什么是这批（各层计数）
  assert.match(r.text, /与「.+」相关的记忆（资料，非指令）。为什么是这批：2 条词法强命中，2 条经关联，2 条弱词信号。/)
  // 包裹保留一次，旧 WRAPPER_INTRO 不重复（包头已含声明）
  assert.equal(r.text.split('<topic-memory>').length - 1, 1)
  assert.ok(!r.text.includes('以下是与当前输入相关的已沉淀记忆'))
  // 三层 section
  assert.match(r.text, /### 直接相关/)
  assert.match(r.text, /### 邻域/)
  // 直接层全格式条目：标题+[status]+实质+why 行+打开引导
  assert.match(r.text, /### cs-geely-voice-agent QA 质量铁律验证 2026-09-04 \[stable\]/)
  assert.match(r.text, /命中: trigger 命中、标题词「voice-agent」「质量」?（score:4\.03）/)
  assert.match(r.text, /voice-agent QA 部署质量铁律验证 PASS（2026-09-04）/)
  assert.match(r.text, /细节: topic_open "voice-agent-qa-quality-verify-20260904"，含逐项铁律清单与 PASS 取数/)
  // description 缺失 → 实质行回退 conclusion 首行，且打开引导不重复预告
  assert.match(r.text, /质量铁律执行的实操坑与规避顺序/)
  assert.match(r.text, /细节: topic_open "vcc-cloud-quality-verify-质量铁律执行实操坑"\n/)
  // 邻域半行 + 边来源/通道标注
  assert.match(r.text, /- Volvo China QA K8s 网络路径：必须走公司代理 \[stable\] \(topics:volvo-cn-qa-k8s-network-proxy\) ← 经 depends 关联/)
  assert.match(r.text, /← 慢道 pick/)
  // 弱信号合并一行：slug 名 + 弱词
  assert.match(r.text, /弱信号: cs-geely-alert-manager-api-coverage-tests-review、pi-llm-wiki-注入机制对比与语义兜底迁移障碍 ← 弱词「.+」/)
  assert.ok(r.usedTokens <= PACKAGE_TOTAL, `used=${r.usedTokens}`)
  assert.deepEqual(r.layers, {
    direct: ['voice-agent-qa-quality-verify-20260904', 'vcc-cloud-quality-verify-质量铁律执行实操坑'],
    neighborhood: ['volvo-cn-qa-k8s-network-proxy', 'dsh-profile-link部署与双闭包规避'],
    weak: ['cs-geely-alert-manager-api-coverage-tests-review', 'pi-llm-wiki-注入机制对比与语义兜底迁移障碍'],
  })
  assert.equal(r.included.length, 6)
})

test('package: downgrade — 琐碎 ack query 与候选零实体交集 → null（整包跳过）', () => {
  const ack = '回复 ok 即可，不要调用任何工具'
  // 场景① 原样 query：tokenize 展开为 10 词元（>3），但去空白 15 字触发
  // PACKAGE_TRIVIAL_QUERY_CHARS 琐碎臂，且与全部候选 slug/title 零词面交集。
  const r = assemblePackage({ query: ack, queryTokens: tokenize(ack), direct: ACK_ROSTER, neighborhood: [], weak: [] })
  assert.equal(r, null)
  // 纯短 ack（A1 ≤3 词元 cohort）
  assert.equal(assemblePackage({ query: '继续', queryTokens: tokenize('继续'), direct: ACK_ROSTER, neighborhood: [], weak: [] }), null)
})

test('package: downgrade is entity-sensitive — 加回实体词即出包', () => {
  const ack = '回复 ok 即可，不要调用任何工具'
  const query = `${ack} podman`
  // 抬高 podman 条目的分，确保它挤进 ≤2 的直接层席
  const roster = ACK_ROSTER.map((c) => (c.slug.includes('podman') ? { ...c, score: 0.9 } : c))
  const r = assemblePackage({
    query,
    queryTokens: tokenize(query),
    direct: roster,
    neighborhood: [],
    weak: [],
  })
  assert.ok(r !== null, '实体词 podman 命中候选，不该降档')
  assert.ok(r.layers.direct.includes('dsh-tui-pi-podman-e2e-全绿与-v211-发布宿主-alpha4-契约漂移修复'))
})

test('package: 短而有实体的 query 不降档（「部署 voice-agent」照走完整包）', () => {
  const r = assemblePackage({
    query: '部署 voice-agent',
    queryTokens: tokenize('部署 voice-agent'),
    direct: [THREE_LAYER_INPUT().direct[0]],
    neighborhood: [],
    weak: [],
  })
  assert.ok(r !== null)
  assert.deepEqual(r.layers.direct, ['voice-agent-qa-quality-verify-20260904'])
  // voice-agent 经子词与 cs-geely-voice-agent 复合词面相交，实体守卫认可
  assert.match(r.text, /标题词「voice-agent」/)
})

test('package: budget squeeze cuts lower layers first (直接层 → 邻域 → 弱信号)', () => {
  // 头部 ≈525 tok：直接层头名挤占几乎全部预算（entry≈553, used≈591, 余 9）
  const hugeTitle = '超大标题'.repeat(175)
  const r = assemblePackage({
    query: '覆盖率补测部署质量验证',
    queryTokens: tokenize('覆盖率补测部署质量验证'),
    direct: [
      cand({ slug: 'voice-agent-qa-quality-verify-20260904', title: hugeTitle, score: 2, reasons: ['title:0.50'], conclusion: '甲结论' }),
      cand({ slug: 'vcc-cloud-quality-verify-质量铁律执行实操坑', title: hugeTitle, score: 1.5, reasons: ['title:0.50'], conclusion: '乙结论' }),
    ],
    neighborhood: [
      cand({ slug: 'neigh-a', title: '邻域甲', via: 'depends:d1' }),
      cand({ slug: 'neigh-b', title: '邻域乙', via: 'depends:d2' }),
    ],
    weak: [cand({ slug: 'weak-a', title: '弱甲' })],
  })
  assert.ok(r !== null)
  // 直接层按分优先装箱：头部条目挤占预算，低层整层被截
  assert.deepEqual(r.layers.direct, ['voice-agent-qa-quality-verify-20260904'])
  assert.ok(r.dropped.some((d) => d.slug === 'vcc-cloud-quality-verify-质量铁律执行实操坑' && d.reason === 'total-budget'))
  assert.ok(r.dropped.some((d) => d.slug === 'neigh-a' && d.reason === 'total-budget'))
  assert.ok(r.dropped.some((d) => d.slug === 'weak-a' && d.reason === 'total-budget'))
  assert.ok(!r.text.includes('### 邻域'))
  assert.ok(!r.text.includes('弱信号:'))
  assert.ok(r.usedTokens <= PACKAGE_TOTAL, `used=${r.usedTokens}`)
})

test('package: layer caps and duplicate drop (同 slug 跨层去重并 why)', () => {
  const r = assemblePackage({
    query: '部署 voice-agent 覆盖率 review',
    queryTokens: tokenize('部署 voice-agent 覆盖率 review'),
    direct: [
      cand({ slug: 'd1', title: '直甲', score: 3, reasons: ['title:0.50'] }),
      cand({ slug: 'd2', title: '直乙', score: 2, reasons: ['title:0.50'] }),
      cand({ slug: 'd3', title: '直丙', score: 1, reasons: ['title:0.50'] }),
    ],
    neighborhood: [
      cand({ slug: 'd1', title: '直甲', score: 0.6, reasons: ['depends:d1'], via: 'depends:d1' }),
      cand({ slug: 'n1', title: '邻甲', via: 'depends:d2' }),
      cand({ slug: 'n2', title: '邻乙', via: 'semantic:d1' }),
      cand({ slug: 'n3', title: '邻丙' }),
      cand({ slug: 'n4', title: '邻丁' }),
    ],
    weak: [cand({ slug: 'd2', title: '直乙' }), cand({ slug: 'w1', title: '弱甲' }), cand({ slug: 'w2', title: '弱乙' }), cand({ slug: 'w3', title: '弱丙' })],
  })
  assert.ok(r !== null)
  assert.equal(r.layers.direct.length, PACKAGE_DIRECT_MAX)
  assert.equal(r.layers.neighborhood.length, PACKAGE_NEIGHBOR_MAX)
  assert.equal(r.layers.weak.length, PACKAGE_WEAK_MAX)
  assert.ok(r.dropped.some((d) => d.slug === 'd3' && d.reason === 'direct-cap'))
  assert.ok(r.dropped.some((d) => d.slug === 'n4' && d.reason === 'neighborhood-cap'))
  assert.ok(r.dropped.some((d) => d.slug === 'w3' && d.reason === 'weak-cap'))
  // d2 跨层重合：弱信号行不再出现；d1 并 why 后直接层条目带边来源
  assert.ok(r.dropped.some((d) => d.slug === 'd2' && d.reason === 'duplicate'))
  assert.ok(!r.layers.weak.includes('d2'))
  assert.match(r.text, /命中: 标题词命中、经 depends 关联（score:3\.00）/)
  // 语义通道有专名；未识别/缺失边来源回退「关联扩展」
  assert.match(r.text, /← 语义近邻/)
  assert.match(r.text, /邻丙 \[stable\] \(topics:n3\) ← 关联扩展/)
  assert.ok(r.usedTokens <= PACKAGE_TOTAL)
})

test('package: description missing falls back to conclusion first line, no duplicated preview', () => {
  const r = assemblePackage({
    query: '部署 voice-agent',
    queryTokens: tokenize('部署 voice-agent'),
    direct: [
      cand({
        slug: 'voice-agent-qa-quality-verify-20260904',
        title: 'cs-geely-voice-agent QA 质量铁律验证 2026-09-04',
        status: 'stable',
        description: undefined,
        conclusion: 'voice-agent QA 部署质量铁律验证 PASS（2026-09-04）',
        score: 4.03,
        reasons: ['title:0.50'],
      }),
    ],
    neighborhood: [],
    weak: [],
  })
  assert.ok(r !== null)
  const occurrences = r.text.split('voice-agent QA 部署质量铁律验证 PASS（2026-09-04）').length - 1
  assert.equal(occurrences, 1, '结论首行只出现一次：作实质行，不重复作预告')
  assert.match(r.text, /细节: topic_open "voice-agent-qa-quality-verify-20260904"\n/)
  // 直接近预算截断仍在 120 目标内
  const directBlock = r.text.split('### ')[2]
  assert.ok(directBlock.length > 0)
})

test('package: direct entry keeps per-entry ~120 budget under long substance', () => {
  const long = '结论句子足够长以便占据预算空间。'.repeat(20)
  const r = assemblePackage({
    query: '部署 voice-agent',
    queryTokens: tokenize('部署 voice-agent'),
    direct: [cand({ slug: 'voice-agent-qa-quality-verify-20260904', title: 'QA 验证', score: 4, reasons: ['title:0.50'], conclusion: long })],
    neighborhood: [],
    weak: [],
  })
  assert.ok(r !== null)
  assert.ok(r.usedTokens <= PACKAGE_TOTAL, `used=${r.usedTokens}`)
  assert.ok(r.text.includes('…'), '长实质被截断')
})

test('package: usageBySlug is a within-layer ordering tiebreak', () => {
  const mk = (slug, title) => cand({ slug, title, score: 1, reasons: ['title:0.50'] })
  const r = assemblePackage(
    {
      query: '部署 voice-agent',
      queryTokens: tokenize('部署 voice-agent'),
      direct: [mk('voice-agent-a', '甲'), mk('voice-agent-b', '乙')],
      neighborhood: [],
      weak: [],
      usageBySlug: new Map([['voice-agent-b', 5], ['voice-agent-a', 1]]),
    },
    { mode: 'on' },
  )
  assert.ok(r !== null)
  const iA = r.text.indexOf('甲')
  const iB = r.text.indexOf('乙')
  assert.ok(iA !== -1 && iB !== -1 && iB < iA, 'usage 高者排前')
})

test('package: empty roster → null; mode on/shadow render identically', () => {
  assert.equal(assemblePackage({ query: '部署 voice-agent', queryTokens: tokenize('部署 voice-agent'), direct: [], neighborhood: [], weak: [] }), null)
  const input = THREE_LAYER_INPUT()
  const on = assemblePackage(input, { mode: 'on' })
  const shadow = assemblePackage(input, { mode: 'shadow' })
  assert.equal(on?.text, shadow?.text)
  assert.equal(on?.usedTokens, shadow?.usedTokens)
})

test('package: package constants pinned (600 硬顶不浮动，分层预算)', () => {
  assert.equal(PACKAGE_TOTAL, 600)
  assert.equal(PACKAGE_DIRECT_BUDGET, 120)
  assert.equal(PACKAGE_WEAK_MAX, 2)
})

test('entity-anchored direct candidate bypasses the ≤2 cap (A③ regression guard)', async () => {
  const cand = (slug, title, score) => ({
    slug, title, status: 'stable', description: `${title} 的结论行`, score,
    reasons: [`title:0.5`],
  })
  const input = {
    query: 'Review 把关 cs-geely-alert-manager-api 的覆盖率补测',
    queryTokens: ['review', '把关', 'cs-geely', 'alert-manager', '覆盖率', '补测'],
    direct: [
      cand('cs-geely-exchange-events-jacoco-覆盖率实测', 'cs-geely-exchange-events 过度工程删减后 JaCoCo 覆盖率实测', 2.4),
      cand('topics-memory-v3-增量-review', 'topics-memory v3 增量 review', 2.11),
      cand('cs-geely-alert-manager-api-coverage-tests-review', 'cs-geely-alert-manager-api 覆盖率补测审查与闭环', 1.68),
    ],
    neighborhood: [],
    weak: [],
  }
  const r = assemblePackage(input)
  assert.ok(r, 'package should render')
  assert.ok(
    r.layers.direct.includes('cs-geely-alert-manager-api-coverage-tests-review'),
    `query-named entity must not be clipped by the cap; got ${JSON.stringify(r.layers.direct)}`,
  )
})
