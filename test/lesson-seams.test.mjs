// B-line lesson seams (wave/b2-seams): lesson kind data plane, the
// lessonInject three-state gate (off|shadow|on, default off), the direct-layer
// priority seat, and the dual-write seams (feedObservations / setLessonStatus).
//
// 铁律守卫: with lessonInject at its default (off) the injection surface is
// byte-for-byte 0.23.0 — lesson files present in the bundle change NOTHING on
// the topic side (roster separation is the data plane, not a behavior change:
// no 0.23.0 bundle ever carried lessons).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleStore } from '../lib/store.js'
import { TopicsService } from '../lib/service.js'
import { parseConfigValue } from '../lib/config.js'
import { tokenize } from '../lib/retrieval.js'

const rmRetry = (p) => {
  for (let i = 0; i < 3; i += 1) {
    try {
      rmSync(p, { recursive: true, force: true })
      return
    } catch {
      /* windows-style retry shim; harmless on darwin */
    }
  }
}

const BASE_CFG = {
  repo: '', autoInject: true, injectDedup: true, topK: 4, perTopicBudget: 300, totalBudget: 1500,
  matchThreshold: 0.3, tagBoost: 0.15, injectMode: 'pointer', graphDepth: 0, recencyWindowDays: 0,
  autoObserve: false, observationMaxChars: 2000, distillEveryTurns: 5, distillOnSessionEnd: false,
  distillProvider: '', distillModel: '', pushDebounceSeconds: 45, usageBoost: 0,
}

let wsSeq = 0
function makeService(cfgOverrides = {}, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'topics-lesson-'))
  process.env.DSH_TOPICS_HOME = root
  process.env.DSH_TOPICS_WORKSPACE_ID = opts.ws ?? `ws-${++wsSeq}`
  const store = new BundleStore(root, { gitDisabled: opts.git !== true })
  const cfg = { ...BASE_CFG, ...cfgOverrides }
  const service = new TopicsService(store, () => cfg)
  return {
    service,
    store,
    root,
    cfg,
    ws: () => process.env.DSH_TOPICS_WORKSPACE_ID,
    setWs: (v) => {
      process.env.DSH_TOPICS_WORKSPACE_ID = v
    },
    cleanup: () => {
      delete process.env.DSH_TOPICS_WORKSPACE_ID
      delete process.env.DSH_TOPICS_HOME
      rmRetry(root)
    },
  }
}

async function seedTopic(service, over = {}) {
  return service.saveTopic({
    title: 'Geely Voice Agent Deploy',
    description: '部署 voice-agent 的流程与坑',
    triggers: ['voice-agent', 'deploy'],
    conclusion: '部署 voice-agent 先跑 podman compose 再验端口。',
    ...over,
  })
}

async function seedLesson(service, over = {}) {
  return service.saveTopic({
    title: 'Commit No Signoff',
    triggers: ['git commit'],
    conclusion: 'commit 一律不带 Co-Authored-By 署名。',
    kind: 'lesson',
    ...over,
  })
}

const readInjections = (store) => store.readInjectionRecords()

/** retrieveSync writes its ilog record fire-and-forget — give the append a beat. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 40))

// ---------------------------------------------------------------------------
// 1. Lesson kind data plane
// ---------------------------------------------------------------------------

test('lesson round-trip: kind/frontmatter/derivation (hint↔draft, confidence 事实源)', async () => {
  const { service, root, cleanup } = makeService()
  try {
    await service.store.ensure()
    const r = await seedLesson(service)
    assert.equal(r.created, true)
    const raw = readFileSync(join(root, 'topics', `${r.slug}.md`), 'utf8')
    assert.match(raw, /^type: Lesson$/m)
    assert.match(raw, /^scope: workspace$/m)
    assert.match(raw, /^confidence: hint$/m)
    assert.match(raw, /^source: manual$/m)
    assert.match(raw, /^status: draft$/m) // hint ⇄ draft
    assert.match(raw, /^workspaceId: /m)
    // parse round-trip is typed, not extras-dumped
    const doc = await service.store.readTopic(r.slug)
    assert.equal(doc.fm.confidence, 'hint')
    assert.equal(doc.fm.scope, 'workspace')
    assert.equal(doc.fm.source, 'manual')
    // established flips confidence AND derives status
    const se = await seedLesson(service, { slug: r.slug, confidence: 'established' })
    const doc2 = await service.store.readTopic(se.slug)
    assert.equal(doc2.fm.confidence, 'established')
    assert.equal(doc2.fm.status, 'stable')
    // global scope drops workspaceId
    await seedLesson(service, { slug: r.slug, scope: 'global', confidence: 'established' })
    const doc3 = await service.store.readTopic(r.slug)
    assert.equal(doc3.fm.scope, 'global')
    assert.equal(doc3.fm.workspaceId, undefined)
  } finally {
    cleanup()
  }
})

test('lesson separation: lessons never ride the topic roster (even established)', async () => {
  const { service, cleanup } = makeService()
  try {
    await service.store.ensure()
    await seedTopic(service)
    await seedLesson(service, { confidence: 'established' })
    const roster = await service.roster()
    assert.equal(roster.length, 1, 'only the topic is on the topic roster')
    assert.equal(roster[0].slug, 'geely-voice-agent-deploy')
    const lessons = service.lessonsSync()
    assert.equal(lessons.length, 1)
    assert.equal(lessons[0].confidence, 'established')
    assert.equal(lessons[0].source, 'manual')
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// 2. Default-off byte guard (铁律)
// ---------------------------------------------------------------------------

test('GUARD lessonInject default off: established lesson present → zero injection-side change', async () => {
  const withLesson = makeService()
  const without = makeService()
  try {
    await withLesson.store.ensure()
    await seedTopic(withLesson.service)
    await seedLesson(withLesson.service, { confidence: 'established', triggers: ['git commit'] })
    await without.store.ensure()
    await seedTopic(without.service)
    const q = '部署 voice-agent git commit 规范 流程 端口 验证'
    const a = withLesson.service.retrieveSync(q, 's1')
    const b = without.service.retrieveSync(q, 's1')
    assert.equal(a.text, b.text, 'injection text byte-identical')
    assert.deepEqual(a.included, b.included)
    await flush()
    const ra = (await readInjections(withLesson.store)).at(-1)
    const rb = (await readInjections(without.store)).at(-1)
    assert.equal(ra.lessonInject, undefined)
    assert.equal(ra.lessons, undefined)
    assert.equal(ra.rosterSize, rb.rosterSize, 'rosterSize excludes lessons in both bundles')
    assert.equal(existsSync(join(withLesson.root, 'meta', 'lesson-shadow.jsonl')), false, 'no shadow ledger when off')
    // even a direct lexical slam on the lesson's trigger injects nothing
    const slam = withLesson.service.retrieveSync('git commit 署名 规范', 's2')
    assert.equal(slam.text.includes('Commit No Signoff'), false)
  } finally {
    withLesson.cleanup()
    without.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 3. Gate on — flat entry (MJ-C: packageMode off), hint never injects
// ---------------------------------------------------------------------------

test('gate on + flat pointer: established lesson injects with source marker; hint does not', async () => {
  const hintGate = makeService({ lessonInject: 'on' })
  const onGate = makeService({ lessonInject: 'on' })
  try {
    await hintGate.store.ensure()
    await seedTopic(hintGate.service)
    await seedLesson(hintGate.service) // hint (default)
    const q = 'git commit 署名规范 submit'
    const r = hintGate.service.retrieveSync(q, 's1')
    assert.equal(r.text.includes('Commit No Signoff'), false, 'hint lesson never injects')
    assert.equal(r.included.includes('commit-no-signoff'), false)

    await onGate.store.ensure()
    await seedTopic(onGate.service)
    await seedLesson(onGate.service, { confidence: 'established' })
    const r2 = onGate.service.retrieveSync(q, 's1')
    assert.equal(r2.text.includes('Commit No Signoff'), true)
    assert.match(r2.text, /\(lesson source:manual\)/)
    assert.ok(r2.included.includes('commit-no-signoff'))
    assert.deepEqual(r2.lessonIncluded, ['commit-no-signoff'])
    await flush()
    const rec = (await readInjections(onGate.store)).at(-1)
    assert.equal(rec.lessonInject, 'on')
    assert.deepEqual(rec.lessons, [{ slug: 'commit-no-signoff', score: rec.lessons[0].score, source: 'manual', included: true }])
    // lesson rides the session dedup registry like a topic
    const r3 = onGate.service.retrieveSync(q, 's1', { exclude: new Set(['commit-no-signoff']) })
    assert.equal(r3.text.includes('Commit No Signoff'), false, 'dedup 同规则')
    assert.ok(r3.deduped.includes('commit-no-signoff'))
  } finally {
    hintGate.cleanup()
    onGate.cleanup()
  }
})

test('gate on: no trigger hit → no lesson (教训不撒背景网)', async () => {
  const { service, cleanup } = makeService({ lessonInject: 'on' })
  try {
    await service.store.ensure()
    await seedTopic(service)
    await seedLesson(service, { confidence: 'established', triggers: ['git commit'] })
    // body/description overlap alone must NOT mint a lesson hit — 条件命中 = trigger channel
    const r = service.retrieveSync('voice-agent 部署 端口 验证 流程', 's1')
    assert.equal(r.text.includes('Commit No Signoff'), false)
    assert.deepEqual(r.lessonIncluded, [])
    await flush()
    const rec = (await readInjections(service.store)).at(-1)
    assert.equal(rec.lessons, undefined)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// 4. Scope filter (MJ-2)
// ---------------------------------------------------------------------------

test('scope filter: workspace lesson injects only in its workspace; global passes anywhere', async () => {
  const svc = makeService({ lessonInject: 'on' })
  try {
    await svc.store.ensure()
    const wsA = 'ws-aaa'
    svc.setWs(wsA)
    await seedLesson(svc.service, { confidence: 'established' })
    const q = 'git commit 署名规范 submit'
    svc.setWs(wsA)
    const rA = svc.service.retrieveSync(q, 's1')
    assert.equal(rA.text.includes('Commit No Signoff'), true, 'same workspace injects')
    svc.setWs('ws-other')
    const rB = svc.service.retrieveSync(q, 's1')
    assert.equal(rB.text.includes('Commit No Signoff'), false, 'foreign workspace filtered')
    assert.ok(rB.outcome.hits.length >= 0)
    // global scope is unfiltered
    await svc.service.saveTopic({
      title: 'Commit No Signoff', triggers: ['git commit'],
      conclusion: 'commit 一律不带 Co-Authored-By 署名。',
      kind: 'lesson', slug: 'commit-no-signoff', scope: 'global', confidence: 'established',
    })
    const rC = svc.service.retrieveSync(q, 's1')
    assert.equal(rC.text.includes('Commit No Signoff'), true, 'global injects anywhere')
  } finally {
    svc.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 5. Shadow state (旁路账)
// ---------------------------------------------------------------------------

test('gate shadow: double-compute into meta/lesson-shadow.jsonl, nothing lands in context', async () => {
  const { service, root, cleanup } = makeService({ lessonInject: 'shadow' })
  try {
    await service.store.ensure()
    await seedTopic(service)
    await seedLesson(service, { confidence: 'established' })
    const q = 'git commit 署名规范 submit'
    const r = service.retrieveSync(q, 's1')
    assert.equal(r.text.includes('Commit No Signoff'), false, 'shadow never lands')
    assert.equal(r.included.includes('commit-no-signoff'), false)
    const file = join(root, 'meta', 'lesson-shadow.jsonl')
    assert.equal(existsSync(file), true)
    const line = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1))
    assert.equal(line.lessonInject, 'shadow')
    assert.equal(line.lessons[0].slug, 'commit-no-signoff')
    assert.equal(line.lessons[0].source, 'manual')
    assert.equal(typeof line.lessons[0].entryTokens, 'number')
    assert.equal(line.lessons[0].wouldFit, true)
    assert.deepEqual(line.emitted.included, r.included, 'emitted = no-lesson disposition')
    assert.equal(line.lessons[0].entryTokens > 0, true)
    await flush()
    const rec = (await readInjections(service.store)).at(-1)
    assert.equal(rec.lessonInject, 'shadow')
    assert.equal(rec.lessons[0].included, false)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// 6. Priority seat (MJ-C matrix: packageMode on)
// ---------------------------------------------------------------------------

test('gate on + packageMode on: lesson takes a direct-layer priority seat with source tag', async () => {
  const { service, cleanup } = makeService({ lessonInject: 'on', packageMode: 'on' })
  try {
    await service.store.ensure()
    await seedTopic(service)
    // two strong topics would normally fill both direct seats
    await seedTopic(service, { slug: 'deploy-runbook-a1', title: 'Deploy Runbook Alpha', triggers: ['deploy', 'runbook'], description: '部署手册' })
    await seedTopic(service, { slug: 'deploy-runbook-b2', title: 'Deploy Runbook Beta', triggers: ['deploy', 'rollout'], description: '发布手册' })
    await seedLesson(service, { confidence: 'established' })
    const q = 'git commit deploy voice-agent 端口 验证'
    const r = service.retrieveSync(q, 's1')
    assert.match(r.text, /### Commit No Signoff \[stable\] \(lesson source:manual\)/)
    assert.ok(r.included.includes('commit-no-signoff'))
    assert.deepEqual(r.lessonIncluded, ['commit-no-signoff'])
    await flush()
    const rec = (await readInjections(service.store)).at(-1)
    assert.equal(rec.lessons[0].included, true)
    // the lesson sits in the direct layer (before 邻域/弱信号 markers if any)
    const directIdx = r.text.indexOf('### 直接相关')
    const lessonIdx = r.text.indexOf('### Commit No Signoff')
    assert.ok(directIdx !== -1 && lessonIdx > directIdx)
  } finally {
    cleanup()
  }
})

test('MJ-C: packageMode shadow + lessonInject on → flat lesson rides the legacy emit; shadow ledger untouched by lessons', async () => {
  const { service, cleanup } = makeService({ lessonInject: 'on', packageMode: 'shadow' })
  try {
    await service.store.ensure()
    await seedTopic(service)
    await seedLesson(service, { confidence: 'established' })
    const q = 'git commit 署名规范 submit'
    const r = service.retrieveSync(q, 's1')
    // emitted = legacy pointer form WITH the flat lesson entry
    assert.equal(r.text.includes('### Commit No Signoff'), true)
    assert.match(r.text, /\(lesson source:manual\)/)
    assert.equal(r.text.includes('### 直接相关'), false, 'no package lands in shadow')
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// 7. Seam ② setLessonStatus
// ---------------------------------------------------------------------------

test('setLessonStatus: established/deprecated transitions + confidence derivation', async () => {
  const { service, cleanup } = makeService()
  try {
    await service.store.ensure()
    const l = await seedLesson(service)
    // gate on AFTER promotion proves the injection-side effect of the seam
    let r = await service.setLessonStatus(l.slug, 'established', { actor: 'self-improve@review' })
    assert.equal(r.ok, true)
    assert.equal(r.from, 'hint')
    const doc = await service.store.readTopic(l.slug)
    assert.equal(doc.fm.confidence, 'established')
    assert.equal(doc.fm.status, 'stable')
    assert.match(doc.fm.generated.by, /self-improve@review/)
    r = await service.setLessonStatus(l.slug, 'deprecated', { actor: 'self-improve@review' })
    assert.equal(r.ok, true)
    const doc2 = await service.store.readTopic(l.slug)
    assert.equal(doc2.fm.status, 'deprecated')
    assert.equal(doc2.fm.confidence, 'established', 'deprecated is outside the confidence axis')
  } finally {
    cleanup()
  }
})

test('setLessonStatus removed: archive-first inside the bundle, then out of the roster (git revertable)', async () => {
  const { service, root, cleanup } = makeService({}, { git: true })
  try {
    await service.store.ensure()
    const l = await seedLesson(service, { confidence: 'established' })
    const file = join(root, 'topics', `${l.slug}.md`)
    const before = readFileSync(file, 'utf8')
    const r = await service.setLessonStatus(l.slug, 'removed', { actor: 'self-improve@uninstall' })
    assert.equal(r.ok, true)
    assert.match(r.archivedTo, /^archive\/lessons\/commit-no-signoff-/)
    assert.equal(existsSync(file), false, 'out of the roster')
    const archived = readFileSync(join(root, r.archivedTo), 'utf8')
    assert.equal(archived, before, 'byte-exact archive (git revert restores exactly)')
    assert.equal(service.lessonsSync().length, 0)
    // one traceable commit carries the archive + roster removal (git pairs
    // byte-exact copies as R100 when rename detection fires, else A+D —
    // equally revertible; the invariant is BOTH paths in the SAME commit)
    const { execFileSync } = await import('node:child_process')
    const head = execFileSync('git', ['-C', root, 'show', '--name-status', '--format=', 'HEAD'], { encoding: 'utf8' })
    assert.match(head, new RegExp(`[ARD]\\d*(\\s+\\S+)?\\s+${r.archivedTo.replace(/[.]/g, '\\.')}`))
    assert.match(head, new RegExp(`[ARD]\\d*(\\s+\\S+)?\\s+topics/${l.slug}\\.md`))
  } finally {
    cleanup()
  }
})

test('setLessonStatus refusals: unauthorized (no actor) / not-found / not-a-lesson — all audited', async () => {
  const { service, root, cleanup } = makeService()
  try {
    await service.store.ensure()
    const l = await seedLesson(service)
    const t = await seedTopic(service)
    // unauthorized: blank actor refuses and appends nothing
    let r = await service.setLessonStatus(l.slug, 'established', { actor: '   ' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'unauthorized')
    assert.equal((await service.store.readTopic(l.slug)).fm.confidence, 'hint', 'no transition happened')
    r = await service.setLessonStatus(l.slug, 'established', {})
    assert.equal(r.reason, 'unauthorized')
    // not-found
    r = await service.setLessonStatus('no-such-lesson', 'established', { actor: 'a' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'not-found')
    // not-a-lesson: topics are not status-seam targets
    r = await service.setLessonStatus(t.slug, 'removed', { actor: 'a' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'not-a-lesson')
    assert.equal(existsSync(join(root, 'topics', `${t.slug}.md`)), true)
    // every refusal landed an audit row (2 unauthorized + not-found + not-a-lesson)
    const events = readFileSync(join(root, 'meta', 'pipeline-events.jsonl'), 'utf8')
      .trim().split('\n').map((x) => JSON.parse(x))
    const audits = events.filter((e) => e.kind === 'seam-lesson-status')
    assert.equal(audits.length, 4)
    assert.equal(audits[0].detail.actor, '<missing>')
    assert.equal(audits[0].detail.ok, false)
    assert.equal(audits.filter((e) => e.detail.reason === 'not-a-lesson').length, 1)
  } finally {
    cleanup()
  }
})

test('established via seam becomes injectable under the gate (lifecycle end-to-end)', async () => {
  const { service, cleanup } = makeService({ lessonInject: 'on' })
  try {
    await service.store.ensure()
    const l = await seedLesson(service)
    const q = 'git commit 署名规范 submit'
    assert.equal(service.retrieveSync(q, 's1').text.includes('Commit No Signoff'), false, 'hint 隐身')
    await service.setLessonStatus(l.slug, 'established', { actor: 'review' })
    assert.equal(service.retrieveSync(q, 's2').text.includes('Commit No Signoff'), true, 'established 注入')
    await service.setLessonStatus(l.slug, 'deprecated', { actor: 'review' })
    assert.equal(service.retrieveSync(q, 's3').text.includes('Commit No Signoff'), false, 'deprecated 隐身')
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// 8. Seam ① feedObservations
// ---------------------------------------------------------------------------

test('feedObservations: whitelist append with fed marker + actor audit + dedup + rejects', async () => {
  const { service, root, cleanup } = makeService()
  try {
    await service.store.ensure()
    const r = await service.feedObservations(
      [
        { type: 'tool-error', sessionId: 'sess-1', detail: { toolName: 'git.commit', errorName: 'GitError' } },
        { type: 'repeat-call', sessionId: 'sess-1', detail: { toolName: 'grep', count: 3, thresholdBand: '3' } },
        // duplicate of the first (same type+session+features)
        { type: 'tool-error', sessionId: 'sess-1', detail: { errorName: 'GitError', toolName: 'git.commit' } },
        // whitelist violations: no type / non-scalar detail smuggle
        { detail: { toolName: 'x' } },
        { type: 'tool-error', detail: { payload: { raw: 'conversation text' } } },
        'not-an-object',
      ],
      { actor: 'self-improve@collector' },
    )
    assert.equal(r.accepted, 2)
    assert.equal(r.duplicates, 1)
    assert.equal(r.rejected, 3)
    assert.equal(r.ids.length, 2)
    const obs = await service.store.allObservations()
    assert.equal(obs.length, 2)
    assert.equal(obs[0].kind, 'signal')
    assert.equal(obs[0].source, 'fed')
    assert.equal(obs[0].by, 'self-improve@collector')
    assert.equal(obs[0].sessionId, 'sess-1')
    assert.equal(obs[0].text, '[tool-error] errorName=GitError toolName=git.commit', 'sorted feature line, features only')
    // unknown caller fields never pass the whitelist
    const r2 = await service.feedObservations(
      [{ type: 'jev-calibration', detail: { band: 'high' }, rawText: '用户的原话……', transcript: ['...'] }],
      { actor: 'self-improve@collector' },
    )
    assert.equal(r2.accepted, 1)
    const obs2 = await service.store.allObservations()
    assert.equal(obs2.length, 3)
    assert.equal(obs2[2].text.includes('原话'), false)
    assert.equal(obs2[2].text, '[jev-calibration] band=high')
    // seam audit rows
    const events = readFileSync(join(root, 'meta', 'pipeline-events.jsonl'), 'utf8')
      .trim().split('\n').map((x) => JSON.parse(x))
    const audits = events.filter((e) => e.kind === 'seam-observations-fed')
    assert.equal(audits.length, 2)
    assert.equal(audits[0].detail.actor, 'self-improve@collector')
    assert.equal(audits[0].detail.accepted, 2)
  } finally {
    cleanup()
  }
})

test('feedObservations unauthorized: blank actor refuses the whole call, nothing appended, audited', async () => {
  const { service, root, cleanup } = makeService()
  try {
    await service.store.ensure()
    let r = await service.feedObservations([{ type: 'tool-error' }], { actor: '' })
    assert.deepEqual(r, { accepted: 0, duplicates: 0, rejected: 1, ids: [], error: 'unauthorized' })
    r = await service.feedObservations([{ type: 'tool-error' }])
    assert.equal(r.error, 'unauthorized')
    assert.equal((await service.store.allObservations()).length, 0)
    const events = readFileSync(join(root, 'meta', 'pipeline-events.jsonl'), 'utf8')
      .trim().split('\n').map((x) => JSON.parse(x))
    assert.equal(events.filter((e) => e.kind === 'seam-observations-fed' && e.detail.refused === true).length, 2)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// 9. Config surface
// ---------------------------------------------------------------------------

test('lessonInject config: parses the three states, rejects others', () => {
  assert.equal(parseConfigValue('lessonInject', 'off'), 'off')
  assert.equal(parseConfigValue('lessonInject', 'shadow'), 'shadow')
  assert.equal(parseConfigValue('lessonInject', 'on'), 'on')
  assert.ok(parseConfigValue('lessonInject', 'true').error)
  assert.ok(parseConfigValue('lessonInject', 'yes').error)
})

test('tokenize sanity for the fixtures (triggers carry the condition)', () => {
  const q = new Set(tokenize('git commit 署名规范 submit'))
  assert.ok(q.has('git') && q.has('commit'))
})
