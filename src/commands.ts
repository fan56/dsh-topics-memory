/**
 * `/topics` slash command family — status | stats | list | show | history |
 * sync | config | set. Registered through the shared dsh-commands registry
 * as an optional peer (vault pattern): hosts without it still load the plugin.
 *
 * @module commands
 */

import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { TopicsService } from './service.ts'
import type { DistillResult } from './distill.ts'
import type { ConsolidateResult } from './consolidate.ts'
import { serializeTopicDoc, slugify, firstParagraph } from './okf.ts'
import { buildGraph, renderGraphHtml } from './viz.ts'
import { CONFIG_KEYS, displayKey, type ConfigKey, type TopicsConfigValue, parseConfigValue } from './config.ts'
import { aggregateStats } from './ilog.ts'
import {
  askDistillSingle,
  createOnboardHandler,
  llmDirectoryNotice,
  makePanel,
  parseDistillInput,
  pickLlmDirectory,
  type AskServiceResolver,
  type AskServiceShape,
  type LlmDirectoryResolver,
  type LlmDirectoryShape,
  type MutateFn,
} from './onboard.ts'

/**
 * Manual `/topics distill` trigger, wired by the host (index.ts owns the lane
 * instance). Returns the lane's own result shape; rejections surface through
 * the command's normal error path.
 */
export type ManualDistill = (invocation: CommandInvocation) => Promise<DistillResult>

/**
 * Manual `/topics consolidate` trigger, wired by the host (index.ts owns the
 * lane instance). Bypasses the cadence gate; the lane's own in-flight guard
 * still applies.
 */
export type ManualConsolidate = (invocation: CommandInvocation) => Promise<ConsolidateResult>

export const HELP = [
  'dsh-topics-memory — OKF topic 记忆（本地 bundle，git 可追溯，可选 GitHub 同步）',
  '  /topics onboard             交互式配置向导（ask-user 面板逐项问答；无 UI 环境逐条输入）',
  '  /topics status              bundle 健康：topic 数、观察积压、冲突、同步状态',
  '  /topics distill             手动触发一次蒸馏（观察池 → Topic，输出 marked/created/updated/gc 摘要）',
  '  /topics consolidate         手动触发一次整理（合并重复/晋升 stable/废弃过时/刷新元数据，无视 cadence 立即跑）',
  '  /topics stats               注入统计：hit rate、top-N、near-miss 分布与调参建议',
  '  /topics list                列出全部 Topic',
  '  /topics show <slug>         查看一个 Topic 全文（含反向引用）',
  '  /topics history <slug>      一个 Topic 的结论变更史（git log）',
  '  /topics graph               生成关系图网页并在浏览器打开',
  '  /topics sync [pull|push]    GitHub 模式：手动拉取/推送（默认模式自动）',
  '  /topics config              查看当前配置',
  '  /topics set <key> <value>   修改配置；key: ' + CONFIG_KEYS.join(' | '),
  '  （distill-provider / distill-model 不带 value 且有 ask UI + 可用模型路由时弹选择面板；distill-model 支持 "provider model" 混写自动拆分）',
  '',
  '凭据：$GITHUB_TOKEN 或已登录的 gh CLI；登录不在本插件职责内。',
].join('\n')

export function buildTopicsCommand(service: TopicsService, mutate: MutateFn, resolveAsk: AskServiceResolver = () => undefined, resolveLlm: LlmDirectoryResolver = () => [], distillNow?: ManualDistill, consolidateNow?: ManualConsolidate): CommandDefinition {
  const onboard = createOnboardHandler(service, mutate, undefined, resolveAsk, resolveLlm)
  return {
    name: 'topics',
    description: 'OKF topic 记忆：onboard | distill | consolidate | status | stats | list | show | history | graph | sync | config | set',
    input: { hint: '[onboard | distill | consolidate | status | stats | list | show <slug> | history <slug> | graph | sync [pull|push] | config | set <key> <value>]' },
    handler: (invocation) => handle(invocation, service, mutate, onboard, resolveAsk, resolveLlm, distillNow, consolidateNow),
  }
}

async function handle(invocation: CommandInvocation, service: TopicsService, mutate: MutateFn, onboard: (args: string[], invocation: CommandInvocation) => Promise<CommandResult>, resolveAsk: AskServiceResolver, resolveLlm: LlmDirectoryResolver, distillNow?: ManualDistill, consolidateNow?: ManualConsolidate): Promise<CommandResult> {
  const raw = invocation.rawInput.trim()
  const [action = '', ...rest] = raw.split(/\s+/)
  try {
    switch (action) {
      case '':
        return ok(HELP)
      case 'onboard':
        return await onboard(rest, invocation)
      case 'status':
        return ok(await renderStatus(service))
      case 'distill':
        return await doDistill(service, invocation, distillNow)
      case 'consolidate':
        return await doConsolidate(service, invocation, consolidateNow)
      case 'stats':
        return ok(await renderStats(service))
      case 'list':
        return ok(await renderList(service))
      case 'show':
        return await renderShow(service, rest[0])
      case 'history':
        return await renderHistory(service, rest[0])
      case 'graph':
        return await doGraph(service)
      case 'sync':
        return await doSync(service, rest[0])
      case 'config':
        return ok(renderConfig(service.cfg))
      case 'set':
        return await doSet(service, rest, mutate, resolveAsk, resolveLlm, invocation)
      default:
        return fail(`未知子动作 “${action}”。\n\n${HELP}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail(`topics ${action} 失败：${message}`)
  }
}

function ok(text: string): CommandResult {
  return { kind: 'success', text }
}

function fail(text: string): CommandResult {
  return { kind: 'error', text }
}

async function renderStatus(service: TopicsService): Promise<string> {
  const s = await service.store.status()
  const cfg = service.cfg
  const rows: [string, string][] = [
    ['模式', service.githubMode ? `github（${cell(cfg.repo)}）` : 'local-only'],
    ['Topics', `${s.topicCount}（draft ${s.byStatus.draft} / stable ${s.byStatus.stable} / deprecated ${s.byStatus.deprecated}）`],
    ['观察积压', `${s.observationsPending} 未蒸馏 / ${s.observationsTotal} 总量`],
    ['冲突', s.conflicts.length === 0 ? '无' : s.conflicts.map((c) => cell(c)).join('、')],
    ['损坏文件', s.broken.length === 0 ? '无' : s.broken.map((b) => cell(b)).join('、')],
    ['git', s.git ? `是（HEAD ${s.head?.slice(0, 10) ?? '??'}）` : '否'],
    ['注入', cfg.autoInject ? `${cfg.injectMode === 'digest' ? 'digest' : 'pointer'} 模式（topK ${cfg.topK}，预算 ${cfg.injectMode === 'digest' ? cfg.totalBudget : Math.min(cfg.totalBudget, 600)} tok，阈值 ${cfg.matchThreshold}）` : '关'],
    ['注入去重', cfg.injectDedup ? '开（同会话已注入的 Topic 不重注）' : '关'],
    ['慢道', cfg.qualityLane === 'off' ? '关' : cfg.qualityLane === 'always' ? `每轮（${cfg.distillProvider}/${cfg.distillModel}）` : `采样 1/3（${cfg.distillProvider}/${cfg.distillModel}）`],
    ['蒸馏', cfg.distillProvider !== '' && cfg.distillModel !== '' ? `${cfg.distillProvider}/${cfg.distillModel}，每 ${cfg.distillEveryTurns} 轮` : '未配置模型（/topics set distill-provider / distill-model）'],
    ['整理', cadenceLabel(cfg.consolidateCadence) + (cfg.consolidateCadence === 'off' ? '' : `（复用蒸馏模型，/topics consolidate 立即跑）`)],
  ]
  // Last lane outcome (distill-state summary) — what "checkable via
  // /topics status" promises; absent until the first run of this bundle.
  const lastRun = await service.store.readDistillState()
  if (lastRun !== undefined) {
    const outcome =
      lastRun.ok === true
        ? `标记 ${String(lastRun.marked ?? 0)} 条观察`
        : `失败（${String(lastRun.reason ?? 'unknown')}）`
    const gc = typeof lastRun.gcDropped === 'number' && lastRun.gcDropped > 0 ? `，GC 回收 ${lastRun.gcDropped}` : ''
    rows.push(['最近蒸馏', `${outcome}${gc} @ ${cell(String(lastRun.at ?? '').slice(0, 19).replace('T', ' '))}`])
  }
  const lastConsolidate = await service.store.readConsolidateState()
  if (lastConsolidate !== undefined) {
    const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0)
    const counts = [
      `合并 ${count(lastConsolidate.merged)}`,
      `晋升 ${count(lastConsolidate.promoted)}`,
      `废弃 ${count(lastConsolidate.deprecated)}`,
      `刷新 ${count(lastConsolidate.refreshed)}`,
    ].join('/')
    rows.push([
      '最近整理',
      `${counts} @ ${cell(String(lastConsolidate.at ?? '').slice(0, 19).replace('T', ' '))}${lastConsolidate.ok === false && lastConsolidate.detail ? `（${String(lastConsolidate.detail).slice(0, 80)}）` : ''}`,
    ])
  }
  if (service.sync !== undefined) {
    rows.push(['上次推送', cell(String(service.sync.lastPushAt ?? '从未'))])
    if (service.sync.lastError !== '') rows.push(['同步错误', cell(service.sync.lastError.split('\n').at(-1) ?? '')])
  }
  return [
    `dsh-topics-memory @ ${s.root}`,
    '',
    '| 字段 | 值 |',
    '| --- | --- |',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
  ].join('\n')
}

/**
 * `/topics distill` — one manual distill run over the current observation pool.
 * The empty-pool case answers immediately without touching the lane; the
 * summary mirrors the distill state fields (ok / marked / created / updated /
 * gc dropped / reason) so what the user sees is what the state file records.
 */
/** Human-readable cadence for status/consolidate output. */
function cadenceLabel(value: string): string {
  switch (value) {
    case 'daily':
      return '每天'
    case '3d':
      return '每 3 天'
    case '7d':
      return '每 7 天'
    default:
      return '关'
  }
}

/**
 * `/topics consolidate` — one manual run of the consolidation lane (LLM
 * gardener over the existing pool). Bypasses the cadence gate; the lane's
 * own in-flight guard dedups a concurrent automatic run. Output mirrors the
 * lane's actions with per-op reasons so the user can eyeball (and git-revert)
 * what the model decided.
 */
async function doConsolidate(service: TopicsService, invocation: CommandInvocation, consolidateNow: ManualConsolidate | undefined): Promise<CommandResult> {
  if (consolidateNow === undefined) return fail('整理 lane 未接线（宿主未提供手动整理触发器）')
  const cfg = service.cfg
  if (cfg.distillProvider === '' || cfg.distillModel === '') {
    return fail('整理复用蒸馏模型路由：请先 /topics set distill-provider 与 distill-model。')
  }
  const result = await consolidateNow(invocation)
  if (!result.ok) {
    const reasonNote =
      result.reason === 'no-clusters'
        ? '没有找到可能相近的 topic 候选簇（词面上没有疑似重复/相关对）'
        : result.reason === 'no-model'
          ? '蒸馏模型未配置（/topics set distill-provider / distill-model）'
          : result.reason === 'in-flight'
            ? '已有整理在跑，稍后再试'
            : (result.reason ?? 'unknown')
    return fail(`整理未执行：${reasonNote}${result.detail !== undefined ? `\n   ${result.detail}` : ''}`)
  }
  const lines: string[] = []
  const actions = result.actions ?? []
  const KIND_LABEL: Record<string, string> = { merge: '合并', promote: '晋升', deprecate: '废弃', refresh: '刷新' }
  for (const a of actions) {
    if (a.kind === 'merge' && a.merged !== undefined) {
      lines.push(`- 合并 ${a.merged.map((m) => cell(m)).join('、')} → ${cell(a.slug)}${a.reason !== undefined ? `：${a.reason}` : ''}`)
    } else {
      lines.push(`- ${KIND_LABEL[a.kind] ?? a.kind} ${cell(a.slug)}${a.reason !== undefined ? `：${a.reason}` : ''}`)
    }
  }
  const header = `✅ 整理完成：合并 ${result.merged.length} 组；晋升 ${result.promoted.length}；废弃 ${result.deprecated.length}；刷新 ${result.refreshed.length}${result.droppedOps ? `（丢弃 ${result.droppedOps} 个无效 op）` : ''}${result.detail !== undefined ? `\n   ${result.detail}` : ''}`
  return ok(lines.length === 0 ? header : `${header}\n${lines.join('\n')}\n全部变更已逐条 git commit，可 /topics history <slug> 追溯、git revert 回滚。`)
}

async function doDistill(service: TopicsService, invocation: CommandInvocation, distillNow: ManualDistill | undefined): Promise<CommandResult> {
  if (distillNow === undefined) return fail('蒸馏 lane 未接线（宿主未提供手动蒸馏触发器）')
  const pending = await service.store.undistilledObservations(1)
  if (pending.length === 0) return ok('观察池为空（no-observations）：没有未蒸馏的观察，无需触发。')
  const result = await distillNow(invocation)
  if (!result.ok) {
    const reasonNote =
      result.reason === 'no-observations'
        ? '观察池为空（no-observations）'
        : result.reason === 'no-model'
          ? '蒸馏模型未配置（/topics set distill-provider / distill-model）'
          : result.reason === 'in-flight'
            ? '已有蒸馏在跑，稍后再试'
            : (result.reason ?? 'unknown')
    return fail(`蒸馏未产出：${reasonNote}${result.detail !== undefined ? `\n   ${result.detail}` : ''}`)
  }
  const parts = [`标记 ${result.marked} 条观察`, `新建 ${result.created.length} 个 Topic`, `更新 ${result.updated.length} 个 Topic`]
  if (result.gcDropped !== undefined && result.gcDropped > 0) parts.push(`GC 回收 ${result.gcDropped} 条不可处理观察`)
  return ok(`✅ 蒸馏完成：${parts.join('；')}${result.detail !== undefined ? `\n   ${result.detail}` : ''}`)
}

async function renderStats(service: TopicsService): Promise<string> {
  const records = await service.store.readInjectionRecords()
  const stats = aggregateStats(records as never)
  if (records.length === 0) return '还没有注入记录 —— 用起来之后这里会有 hit rate / top-N / near-miss 分布。'
  const lines = [
    `注入统计（最近 ${records.length} 轮）：`,
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    `| hit rate | ${(stats.hitRate * 100).toFixed(1)}%（${stats.injectedRounds}/${stats.rounds} 轮注入） |`,
    `| 零命中轮 | ${stats.zeroHitRounds} |`,
    `| 平均命中 | ${stats.avgHitsPerRound} 条/轮 |`,
    `| 平均预算占用 | ${stats.avgBudgetUtilization} tok |`,
  ]
  // v4 lane split — how much of the injection traffic each lane carries.
  const slowRounds = records.filter((r) => r.lane === 'slow' || r.lane === 'mixed').length
  if (slowRounds > 0) {
    const consumed = records.filter((r) => r.consumedAt !== undefined && r.computedAt !== undefined)
    let medianLag = ''
    if (consumed.length > 0) {
      const lags = consumed
        .map((r) => Math.max(0, Date.parse(r.consumedAt as string) - Date.parse(r.computedAt as string)))
        .sort((a, b) => a - b)
      medianLag = `，赶上中位时延 ${(lags[Math.floor(lags.length / 2)] / 1000).toFixed(1)}s`
    }
    lines.push(`| 慢道参与轮 | ${slowRounds}（快 ${records.length - slowRounds} / 慢或混合 ${slowRounds}${medianLag}） |`)
  }
  // Pointer open rate (v4 §4.3): topic_open calls vs pointer entries injected.
  // Echoed hits ride the retrieval but never became pointers — excluded here.
  const opens = await service.store.readOpenRecords()
  if (opens.length > 0 || records.some((r) => r.lane !== undefined)) {
    const entries = records.reduce(
      (acc, r) =>
        acc +
        r.hits.filter((h) => !(r.deduped ?? []).includes(h.slug) && !(r.echoed ?? []).includes(h.slug)).length +
        (r.slow?.length ?? 0),
      0,
    )
    const rate = entries === 0 ? 0 : Math.min(1, opens.length / entries)
    lines.push(`| 指针打开率 | ${(rate * 100).toFixed(1)}%（${opens.length} 次 topic_open / ${entries} 条注入指针） |`)
  }
  const echoedCount = records.reduce((acc, r) => acc + (r.echoed?.length ?? 0), 0)
  if (echoedCount > 0) {
    lines.push(`| 回声抑制 | ${echoedCount} 次（本会话蒸馏出的 topic 不回注） |`)
  }
  if (stats.topTopics.length > 0) {
    lines.push('', 'Top-N 被注入 Topic：', '', '| Slug | 注入次数 |', '| --- | --- |')
    for (const t of stats.topTopics.slice(0, 5)) lines.push(`| \`${cell(t.slug)}\` | ${t.count} |`)
  }
  if (stats.nearMissHistogram.length > 0) {
    lines.push('', 'Near-miss 分布（低于阈值或被结构门挡下）：', '', '| 分数段 | 次数 |', '| --- | --- |')
    for (const b of stats.nearMissHistogram) lines.push(`| ${cell(b.bucket)} | ${b.count} |`)
    const hint = tuningHint(stats, service.cfg.matchThreshold)
    if (hint !== undefined) lines.push('', `💡 ${hint}`)
  }
  return lines.join('\n')
}

export function tuningHint(stats: ReturnType<typeof aggregateStats>, threshold: number): string | undefined {
  // A dense band just below the threshold with zero overflow above it means
  // the threshold, not the corpus, is the bottleneck.
  const justBelow = stats.nearMissHistogram.filter((b) => Number(b.bucket.split('–')[0]) >= threshold - 0.15 && Number(b.bucket.split('–')[0]) < threshold)
  const justBelowCount = justBelow.reduce((acc, b) => acc + b.count, 0)
  if (stats.rounds >= 20 && justBelowCount >= stats.rounds * 0.3 && stats.hitRate < 0.5) {
    return `near-miss 集中在阈值 ${threshold} 下方（${justBelowCount} 次），可尝试 /topics set match-threshold ${(Math.max(0.05, threshold - 0.1)).toFixed(2)}`
  }
  return undefined
}

/** /topics list caps the table at this many newest topics. */
const LIST_LIMIT = 100

async function renderList(service: TopicsService): Promise<string> {
  const metas = await service.store.listTopics()
  if (metas.length === 0) return 'Bundle 里还没有 Topic —— 在会话里让我记点什么，或 /topics set 配置好蒸馏。'
  // Newest first, capped: with a large bundle the table is for scanning
  // recent work, not an exhaustive roster — /topics show <slug> reaches any
  // topic the cap hides. (store.ts re-stamps generated.at on every topic
  // write, so it IS the updated-at time; the slug tiebreak keeps same-stamp
  // rows stable.)
  metas.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt) || a.slug.localeCompare(b.slug))
  const shown = metas.slice(0, LIST_LIMIT)
  const lines = [
    `共 ${metas.length} 个 Topic（按最近更新排序）：`,
    '',
    '| # | Slug | 标题 | 状态 | 标签 | 更新 |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  shown.forEach((m, i) => {
    const tags = m.tags.length > 0 ? m.tags.map((t) => `#${cell(t)}`).join(' ') : '—'
    lines.push(`| ${i + 1} | \`${cell(m.slug)}\` | ${cell(m.title)} | ${m.status} | ${tags} | ${cell(m.generatedAt.slice(0, 10))} |`)
  })
  if (metas.length > shown.length) {
    lines.push('', `… 其余 ${metas.length - shown.length} 个更早的 Topic 未显示（/topics show <slug> 直达）。`)
  }
  return lines.join('\n')
}

/** One markdown table cell: pipes escaped, whitespace flattened. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
}

async function renderShow(service: TopicsService, slug: string | undefined): Promise<CommandResult> {
  if (slug === undefined || slug === '') return fail('用法：/topics show <slug>')
  const doc = await service.store.readTopic(slug)
  if (doc === undefined) return fail(`Topic “${slug}” 不存在（/topics list 查看）`)
  const text = serializeTopicDoc(doc)
  const backlinks = await service.store.readBacklinks()
  const refs = backlinks[slugify(slug)] ?? []
  if (refs.length === 0) return ok(text)
  const VIA_LABEL: Record<'depends' | 'link', string> = { depends: '依赖', link: '链接' }
  const lines = [
    text,
    '---',
    `反向引用（${refs.length} 条）——改动本条结论时这些 Topic 可能需要跟进：`,
    ...refs.map((r) => `- ${r.slug}（${VIA_LABEL[r.via]}）`),
  ]
  return ok(lines.join('\n'))
}

async function renderHistory(service: TopicsService, slug: string | undefined): Promise<CommandResult> {
  if (slug === undefined || slug === '') return fail('用法：/topics history <slug>')
  const { entries } = await service.history(slug, 30)
  if (entries.length === 0) return fail(`Topic “${slug}” 没有历史（不存在或 bundle 不是 git 仓库）`)
  const lines = [
    `${slug} 的变更史（${entries.length} 条）：`,
    '',
    '| Hash | 时间 | 变更 | 当时的结论 |',
    '| --- | --- | --- | --- |',
  ]
  for (const e of entries) {
    const conclusion = e.conclusion !== undefined && e.conclusion !== '' ? cell(e.conclusion) : '—'
    lines.push(`| \`${cell(e.hash)}\` | ${cell(e.date.slice(0, 19).replace('T', ' '))} | ${cell(e.message)} | ${conclusion} |`)
  }
  return ok(lines.join('\n'))
}

/**
 * /topics graph — render the bundle's relationship graph into a self-contained
 * HTML page and open it in the default browser. Set DSH_TOPICS_NO_OPEN=1 to
 * skip the browser launch (tests, headless use).
 */
async function doGraph(service: TopicsService): Promise<CommandResult> {
  const roster = await service.roster()
  if (roster.length === 0) return fail('Bundle 里还没有 Topic，无从画起（先记点什么）')
  const graph = buildGraph(roster)
  const conclusions: Record<string, string> = {}
  for (const topic of roster) {
    conclusions[topic.slug] = firstParagraph(topic.conclusion)
  }
  const html = renderGraphHtml(graph, { conclusions })
  const file = join(service.store.root, 'meta', 'graph.html')
  await writeFile(file, html, 'utf8')
  const opened = openInBrowser(file)
  const summary = `✅ 关系图已生成：${file}（${graph.nodes.length} 节点 / ${graph.edges.length} 边）` +
    (opened ? '——已在浏览器打开' : '（浏览器未自动打开，手动用浏览器打开该文件即可）')
  return ok(summary)
}

function openInBrowser(file: string): boolean {
  if (process.env.DSH_TOPICS_NO_OPEN === '1') return false
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', file] : [file]
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.unref?.()
    return true
  } catch {
    return false
  }
}

async function doSync(service: TopicsService, direction: string | undefined): Promise<CommandResult> {
  if (!service.githubMode) return fail('当前是 local-only 模式（/topics set repo <owner/name> 启用 GitHub 同步）')
  if (service.sync === undefined) return fail('同步层未就绪')
  if (direction === undefined || direction === 'push') {
    await service.sync.commitMeta()
    const r = await service.sync.flush()
    return r.ok ? ok(`✅ ${r.message}`) : fail(r.message)
  }
  if (direction === 'pull') {
    const r = await service.sync.pull()
    service.invalidate()
    return r.ok ? ok(`✅ ${r.message}`) : fail(r.message)
  }
  return fail('用法：/topics sync [pull|push]')
}

function renderConfig(cfg: TopicsConfigValue): string {
  const lines = [
    '当前配置：',
    '',
    '| 配置项 | 值 |',
    '| --- | --- |',
  ]
  for (const key of CONFIG_KEYS) {
    lines.push(`| ${displayKey(key)} | ${cell(String(cfg[key]))} |`)
  }
  return lines.join('\n')
}

/**
 * One ask-user panel for `/topics set distill-provider|distill-model` without a
 * value. Picks are pre-validated like the onboard wizard (live-route check
 * for providers; resolveModelInfo for models — NO_ADAPTER blocks, off-catalog
 * warns but allows). Cancellation and blank answers write nothing;
 * ASK_CANCELLED / ASK_ABORTED surface as a clean no-write success.
 */
async function setDistillInteractive(
  service: TopicsService,
  key: 'distillProvider' | 'distillModel',
  ask: AskServiceShape,
  llm: LlmDirectoryShape,
  mutate: (ops: readonly { op: 'set'; path: string[]; value: unknown }[]) => Promise<void>,
  invocation: CommandInvocation | undefined,
): Promise<CommandResult> {
  const fail = (text: string): CommandResult => ({ kind: 'error', text })
  if (key === 'distillModel' && service.cfg.distillProvider === '') {
    return fail('请先配置 distill-provider 再选模型：/topics set distill-provider（有 UI 时会弹 provider 选择面板）')
  }
  const invocationLike = invocation as { agent?: unknown; signal?: AbortSignal }
  const panel = makePanel(ask, invocationLike.agent, invocationLike.signal)
  const askKey = key === 'distillProvider' ? 'distill-provider' : 'distill-model'
  try {
    const picked = await askDistillSingle(llm, panel, askKey, service.cfg)
    if (picked === undefined) return ok('未选择，配置保持原样。')
    await mutate([{ op: 'set', path: [key], value: picked.value }])
    return ok(`✅ topics.${displayKey(key)} = ${picked.value}${picked.warning === undefined ? '' : `\n⚠️ ${picked.warning}`}`)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ASK_CANCELLED' || code === 'ASK_ABORTED') return ok('已取消，未写入任何改动。')
    if (code === 'ASK_MISSING_AGENT') return fail('当前 surface 的 ask-user 需要会话上下文。请改用 /topics set 带值输入。')
    throw error
  }
}

async function doSet(
  service: TopicsService,
  tokens: string[],
  mutate: (ops: readonly { op: 'set'; path: string[]; value: unknown }[]) => Promise<void>,
  resolveAsk: AskServiceResolver = () => undefined,
  resolveLlm: LlmDirectoryResolver = () => [],
  invocation?: CommandInvocation,
): Promise<CommandResult> {
  const [rawKey = '', ...valueParts] = tokens
  const rawValue = valueParts.join(' ').trim()
  const normalized = rawKey.toLowerCase().replace(/[-_]/g, '')
  const key = CONFIG_KEYS.find((k) => k.toLowerCase() === normalized)
  if (key === undefined) {
    return fail(`未知配置项 “${rawKey}”。可选：${CONFIG_KEYS.map(displayKey).join('、')}`)
  }
  // No value → a single-question picker for the two distill route keys when a
  // live UI AND a usable llm directory exist. Every other shape errors out:
  // falling through to the typed path would silently CLEAR the key.
  if ((key === 'distillProvider' || key === 'distillModel') && rawValue === '') {
    const ask = resolveAsk()
    const pick = pickLlmDirectory(resolveLlm())
    if (ask !== undefined && typeof ask.ask === 'function' && pick.kind === 'ok') {
      return setDistillInteractive(service, key, ask, pick.llm, mutate, invocation)
    }
    const reason = llmDirectoryNotice(pick) ?? '当前 surface 没有 ask-user 面板'
    return fail(`${displayKey(key)} 需要一个值（如 /topics set distill-model zai-coding-cn glm-4.7-air），未写入任何改动。选择面板不可用：${reason}`)
  }
  // Mixed "provider model" / "provider/model" values for distill-model split
  // into BOTH keys — the historical root of `distillModel: "prov model"` dirt.
  // Splitting overwrites distill-provider; when that key already held a
  // different provider, say so.
  if (key === 'distillModel' && rawValue !== '' && /[\s/]/.test(rawValue)) {
    const parsed = parseDistillInput(rawValue)
    if ('error' in parsed) return fail(parsed.error)
    const previousProvider = service.cfg.distillProvider
    await mutate([
      { op: 'set', path: ['distillProvider'], value: parsed.provider },
      { op: 'set', path: ['distillModel'], value: parsed.model },
    ])
    const overwrote = previousProvider !== '' && previousProvider !== parsed.provider
    return ok([
      `✅ topics.distill-provider = ${parsed.provider}`,
      `✅ topics.distill-model = ${parsed.model}`,
      '（混写值已拆分写入 distill-provider 与 distill-model 两个键）',
      ...(overwrote ? [`⚠️ 已覆盖原 distill-provider «${previousProvider}»`] : []),
    ].join('\n'))
  }
  if (key === 'distillProvider' && rawValue !== '' && /[\s/]/.test(rawValue)) {
    return fail('distill-provider 只接受单段 provider id（不含空格或斜杠）。混合值请用 /topics set distill-model "provider model" 一次写入两个键。')
  }
  const parsed = parseConfigValue(key, rawValue)
  if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) return fail(parsed.error)
  await mutate([{ op: 'set', path: [key], value: parsed }])
  if (key === 'repo' || key === 'autoInject') service.invalidate()
  return ok(`✅ topics.${displayKey(key)} = ${String(parsed)}`)
}
