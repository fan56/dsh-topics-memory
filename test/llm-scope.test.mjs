import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, settleBounded, EXIT_COMMIT_TIMEOUT_MS } from '../lib/index.js'
import { BundleStore } from '../lib/store.js'

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


const CFG = {
  repo: '', autoInject: false, injectDedup: true, topK: 4, perTopicBudget: 300,
  totalBudget: 1500, matchThreshold: 0.3, tagBoost: 0.15, graphDepth: 2,
  recencyWindowDays: 7, autoObserve: false, observationMaxChars: 2000,
  distillEveryTurns: 1, distillOnSessionEnd: true, distillProvider: 'p',
  distillModel: 'm', pushDebounceSeconds: 45,
}

/**
 * Adapter-holding fake llm instance like the one dsh serves to the agent
 * scope: live route probe plus a stream that emits the (mutable) model JSON —
 * the caller assembles it and runInner parses the ops.
 */
function liveLlm(modelJson) {
  const instance = { modelsJson: modelJson }
  instance.listProviders = () => [{ id: 'p' }]
  instance.stream = async function* () {
    const text = instance.modelsJson
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  return instance
}

const opFor = (title, obsId) =>
  JSON.stringify({ ops: [{ op: 'create', title, conclusion: 'probe', observed_ids: [obsId] }] })

/**
 * Minimal fake dsh ctx for apply() (same recipe as dedup.test.mjs), with
 * agentsMap exposed so tests can plant/remove the agent scope that owns the
 * adapter-holding llm instance.
 */
function bootPlugin(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'topics-scope-'))
  const prevHome = process.env.DSH_TOPICS_HOME
  process.env.DSH_TOPICS_HOME = root
  const handlers = []
  const disposedHandlers = {}
  const contexts = []
  const effects = []
  const agentsMap = new Map()
  const ctx = {
    settings: { register: () => ({ get: () => overrides }) },
    systemPrompt: { section: () => undefined, context: (input) => contexts.push(input) },
    tools: { register: () => undefined },
    agents: { get: (id) => agentsMap.get(String(id)) },
    on: (type, handler) => {
      if (type === 'session/event') handlers.push(handler)
      else if (type === 'agent/disposed' || type === 'session/disposed') disposedHandlers[type] = handler
    },
    inject: (_deps, cb) => cb({ effect: () => () => {} }),
    effect: (setup, name) => {
      effects.push({ setup, name })
      return () => {}
    },
  }
  apply(ctx)
  const onEvent = handlers[0]
  // apply() registers TWO session/event handlers (injection dispatch + sync
  // lifecycle) — real hosts invoke every handler, so must the harness.
  const dispatch = (sessionId, type, data) => {
    for (const handler of handlers) handler.call(undefined, { id: sessionId }, { type, data })
  }
  // Real teardown events carry payloads; the agent payload still owns its ctx
  // (scope unwind follows), which is exactly the capture the final distill uses.
  const dispose = (sessionId, type) => {
    const handler = disposedHandlers[type]
    if (handler === undefined) throw new Error(`no recorded handler for ${type}`)
    if (type === 'agent/disposed') handler({ agent: agentsMap.get(String(sessionId)) ?? { id: sessionId } })
    else handler({ id: sessionId })
  }
  const cleanup = async () => {
    if (prevHome === undefined) delete process.env.DSH_TOPICS_HOME
    else process.env.DSH_TOPICS_HOME = prevHome
    await rmRetry(root)
  }
  return { root, agentsMap, dispatch, dispose, effects, cleanup }
}

async function waitFor(cond, what, timeoutMs = 4000) {
  const start = Date.now()
  for (;;) {
    if (await cond()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

test('sessionLlm: capture feeds the every-n run and is released once it settles', async () => {
  const h = bootPlugin({ ...CFG })
  try {
    const store = new BundleStore(h.root)
    await store.ensure()
    const o1 = await store.appendObservation({ kind: 'finding', source: 'auto', text: '观察一' })
    const llm = liveLlm(opFor('Leak Probe Topic', o1.id))
    // The agent record needs an id: captureFromAgent keys by agent.id.
    h.agentsMap.set('s1', { id: 's1', inbox: { nextTurn: [], nextStep: [] }, ctx: { llm } })
    h.dispatch('s1', 'turn/end', {})
    await waitFor(
      async () =>
        (await store.undistilledObservations()).length === 0 &&
        (await store.readDistillState())?.ok === true,
      'run #1 consumes the observation and records success',
    )
    assert.equal((await store.readDistillState())?.ok, true, 'run #1 distilled via the session capture')
    assert.notEqual(await store.readTopic('leak-probe-topic'), undefined, 'topic from run #1 landed')

    // The session is gone: unregister the agent so the next trigger cannot
    // re-capture. A leaked map entry would still serve the next run; after the
    // release it must come back as a readable model-error instead.
    h.agentsMap.delete('s1')
    const o2 = await store.appendObservation({ kind: 'finding', source: 'auto', text: '观察二' })
    llm.modelsJson = opFor('Second Topic', o2.id)
    h.dispatch('s1', 'turn/end', {})
    await waitFor(
      async () => (await store.readDistillState())?.reason === 'model-error',
      'run #2 finds no live instance',
    )
    assert.deepEqual(
      (await store.undistilledObservations()).map((o) => o.text),
      ['观察二'],
      'released capture: the stale entry was NOT reused',
    )
  } finally {
    h.cleanup()
  }
})

test('sessionLlm: agent/disposed session-end run still feeds from the payload capture, then releases', async () => {
  const h = bootPlugin({ ...CFG })
  try {
    const store = new BundleStore(h.root)
    await store.ensure()
    const o1 = await store.appendObservation({ kind: 'finding', source: 'auto', text: '观察一' })
    const llm = liveLlm(opFor('End Probe Topic', o1.id))
    // The agent record needs an id: captureFromAgent keys by agent.id.
    h.agentsMap.set('s1', { id: 's1', inbox: { nextTurn: [], nextStep: [] }, ctx: { llm } })
    // Teardown WITHOUT any prior every-n run: the session-end trigger is the
    // only reader of the payload capture. Deleting the entry at teardown time
    // would break this final distill — the pending-run guard must hold it.
    h.dispose('s1', 'agent/disposed')
    await waitFor(
      async () => (await store.readDistillState())?.ok === true,
      'session-end run succeeds via the payload capture',
    )
    assert.equal((await store.undistilledObservations()).length, 0, 'final distill consumed the observation')

    // Entry released after the settle: a fresh trigger finds no live instance.
    h.agentsMap.delete('s1')
    const o2 = await store.appendObservation({ kind: 'finding', source: 'auto', text: '观察二' })
    llm.modelsJson = opFor('Second End Topic', o2.id)
    h.dispatch('s1', 'turn/end', {})
    await waitFor(
      async () => (await store.readDistillState())?.reason === 'model-error',
      'post-release trigger finds no live instance',
    )
    assert.deepEqual(
      (await store.undistilledObservations()).map((o) => o.text),
      ['观察二'],
      'stale entry was NOT reused after the final run',
    )
    // Double teardown (session/disposed after agent/disposed) is a no-op:
    // single-fire observer trigger + idempotent deletion.
    h.dispose('s1', 'session/disposed')
  } finally {
    h.cleanup()
  }
})

// ---- exit lifecycle: the disposer waits (bounded) for the last distill ----

test('settleBounded: resolves as soon as the run settles; rejections are swallowed', async () => {
  const start = Date.now()
  await settleBounded(new Promise((r) => setTimeout(r, 30)), 60_000)
  assert.ok(Date.now() - start < 1000, 'a healthy run is awaited, not the cap')
  await settleBounded(Promise.reject(new Error('boom')), 60_000)
  assert.equal(EXIT_COMMIT_TIMEOUT_MS, 10_000, 'the local-only exit commit cap')
})

test('settleBounded: caps a hanging run so exit never wedges', async () => {
  // The cap timer is unref'd by design: an idle host loop must exit without
  // being kept alive by the bound. A test loop IS idle, so without a ref'd
  // keep-alive Node exits before the cap fires and this promise never
  // resolves (CI: "event loop has already resolved"). Hold the loop open for
  // the duration, then release it.
  const keepAlive = setInterval(() => {}, 10)
  try {
    const start = Date.now()
    await settleBounded(new Promise(() => {}), 40)
    const elapsed = Date.now() - start
    assert.ok(elapsed >= 35 && elapsed < 5000, `the cap fired instead of the hang (elapsed=${elapsed}ms)`)
  } finally {
    clearInterval(keepAlive)
  }
})

test('lifecycle: the disposer commits locally and never waits for the exit distill', async () => {
  const h = bootPlugin({ ...CFG })
  try {
    const store = new BundleStore(h.root)
    await store.ensure()
    const o1 = await store.appendObservation({ kind: 'finding', source: 'auto', text: '观察一' })
    const llm = liveLlm(opFor('Exit Distill Topic', o1.id))
    let streamCalls = 0
    const baseStream = llm.stream
    llm.stream = async function* (...args) {
      streamCalls += 1
      await new Promise((r) => setTimeout(r, 150)) // a slow model call the exit must NOT wait for
      yield* baseStream(...args)
    }
    // The exit path triggers under the fake 'dispose' session id — its agent
    // entry is where the trigger-time llm capture finds the instance.
    h.agentsMap.set('dispose', { id: 'dispose', inbox: { nextTurn: [], nextStep: [] }, ctx: { llm } })
    const lifecycle = h.effects.find((e) => e.name === 'topics: lifecycle')
    assert.ok(lifecycle !== undefined, 'the lifecycle effect is registered')
    const disposer = lifecycle.setup()
    const start = Date.now()
    await disposer()
    const elapsed = Date.now() - start
    // The trigger fired (a run was requested — it may or may not have STARTED
    // streaming inside the race window) but the disposer resolved on the local
    // meta commit, not on the model call. The observations stay durable in the
    // meta sidecars either way, so the skipped run replays on the next boot.
    assert.ok(elapsed < 140, `the disposer resolved without the distill (elapsed=${elapsed}ms)`)
  } finally {
    h.cleanup()
  }
})

test('lifecycle: the exit dispose trigger is skipped while a session-end run is in flight', async () => {
  const h = bootPlugin({ ...CFG })
  // Keep-alive for the same unref'd-cap reason as the settleBounded test.
  const keepAlive = setInterval(() => {}, 50)
  try {
    const store = new BundleStore(h.root)
    await store.ensure()
    const o1 = await store.appendObservation({ kind: 'finding', source: 'auto', text: '观察一' })
    // The session-end run's model call is held open so the run is genuinely
    // in flight when the disposer fires.
    const llm = liveLlm(opFor('End Run Topic', o1.id))
    const baseStream = llm.stream
    let endCalls = 0
    let release
    const hang = new Promise((r) => {
      release = r
    })
    llm.stream = async function* (...args) {
      endCalls += 1
      await hang
      yield* baseStream(...args)
    }
    // A SECOND adapter-holding instance for the fake 'dispose' session: if
    // the exit trigger ran anyway, it would capture THIS instance and feed
    // the same global pool head to the model a second time.
    const disposeLlm = liveLlm(opFor('Dispose Duplicate Topic', o1.id))
    let disposeCalls = 0
    const disposeBase = disposeLlm.stream
    disposeLlm.stream = async function* (...args) {
      disposeCalls += 1
      yield* disposeBase(...args)
    }
    h.agentsMap.set('s1', { id: 's1', inbox: { nextTurn: [], nextStep: [] }, ctx: { llm } })
    h.agentsMap.set('dispose', { id: 'dispose', inbox: { nextTurn: [], nextStep: [] }, ctx: { llm: disposeLlm } })

    // Real teardown starts the session-end run; wait until it sits in the
    // model call (inFlight was set synchronously at request()).
    h.dispose('s1', 'agent/disposed')
    await waitFor(() => endCalls === 1, 'the session-end run reached the (held) model call')

    // Exit while it is in flight: the guard must skip the dispose trigger.
    const lifecycle = h.effects.find((e) => e.name === 'topics: lifecycle')
    assert.ok(lifecycle !== undefined, 'the lifecycle effect is registered')
    const disposer = lifecycle.setup()
    const start = Date.now()
    await disposer()
    assert.ok(Date.now() - start < 5_000, 'nothing extra to await: the exit path resolved immediately')
    assert.equal(disposeCalls, 0, 'the dispose run never started — no double feed of the same head batch')
    assert.equal(endCalls, 1, 'exactly one model evaluation of the batch')

    // Release the held call: the session-end run lands normally.
    release()
    await waitFor(async () => (await store.readDistillState())?.ok === true, 'the held session-end run lands after release')
    assert.equal((await store.allObservations())[0].distilled, true, 'the observation was consumed exactly once')
    assert.equal(await store.readTopic('end-run-topic') !== undefined, true, 'its topic landed')
  } finally {
    clearInterval(keepAlive)
    h.cleanup()
  }
})

test('lifecycle: a fresh session replays undistilled observations left by a skipped exit', async () => {
  const h = bootPlugin({ ...CFG })
  try {
    const store = new BundleStore(h.root)
    await store.ensure()
    // Backlog simulating the previous session's local-only exit: the
    // observation is durable on disk but no run ever consumed it.
    const o1 = await store.appendObservation({ kind: 'finding', source: 'auto', text: '遗留观察' })
    const llm = liveLlm(opFor('Boot Replay Topic', o1.id))
    h.agentsMap.set('s1', { id: 's1', inbox: { nextTurn: [], nextStep: [] }, ctx: { llm } })
    // session-start: sync.pull is a no-op in local-only CFG, then the replay
    // check finds the backlog and requests one distill.
    h.dispatch('s1', 'agent/session-start', undefined)
    await waitFor(async () => (await store.readDistillState())?.ok === true, 'the boot-replay distill landed')
    assert.equal((await store.undistilledObservations()).length, 0, 'the backlog was consumed')
    assert.notEqual(await store.readTopic('boot-replay-topic'), undefined, 'its topic landed')
  } finally {
    h.cleanup()
  }
})

test('lifecycle: a fresh session with no backlog requests no replay distill', async () => {
  const h = bootPlugin({ ...CFG })
  try {
    const store = new BundleStore(h.root)
    await store.ensure()
    // No backlog: the replay check must find an empty pool and stay idle —
    // a healthy boot must not spend a model call per session start.
    assert.equal((await store.undistilledObservations()).length, 0)
    h.agentsMap.set('s1', { id: 's1', inbox: { nextTurn: [], nextStep: [] }, ctx: { llm: liveLlm(opFor('Nope', 'x')) } })
    h.dispatch('s1', 'agent/session-start', undefined)
    await new Promise((r) => setTimeout(r, 200))
    assert.equal((await store.readDistillState()) ?? undefined, undefined, 'no distill run was requested')
  } finally {
    h.cleanup()
  }
})
