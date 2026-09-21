// Regression tests for the fast-lane claimed-text rebuild (0.17.0/0.17.1).
//
// The 0.1.5-rc.2 incident: the eager projection drive (session/event
// hooksOrder[0]) applies the claim splice before this plugin's handler
// (hooksOrder[10]) runs, so the projection read yields the post-splice
// EMPTY window and the fast lane silently died on claimedText === ''.
// The fix rebuilds the pre-splice window by folding the session log —
// replayPendingInbox. 0.17.1 (review CONCERN A) makes that replay the
// unconditional first source whenever event.seq exists: with ≥2 pending
// messages the post-splice projection read is NON-empty but shifted by
// one, so 0.17.0's empty-projection-only gating would claim msg1 and read
// msg2's residual text. These tests replay exactly that incident shape
// plus the original semantics (user-only filter, target split, start
// offset, multi-block text). Splice fixtures mirror the host firehose
// payload the probe printed: { target, start, removedCount, inserted }
// per dsh-agent-loop mutate(), enveloped as { seq, type, data }.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replayPendingInbox, claimedUserText, resolveClaimedText } from '../lib/index.js'

const user = (text, extra = {}) => ({
  source: { kind: 'user' },
  content: Array.isArray(text) ? text : [{ type: 'text', text }],
  ...extra,
})
const pluginMsg = (text) => ({
  source: { kind: 'plugin', plugin: 'x' },
  content: [{ type: 'text', text }],
})
// A log event as dsh-session appends it (envelope + normalized splice data).
let nextSeq = 0
const ev = (type, data) => ({ seq: nextSeq++, type, data })
const spliced = (data) => ev('agent/inbox/spliced', data)

test('incident shape: post-splice empty projection, log replay rebuilds the claimed user text', () => {
  // Log: user "say hi" appended to next-turn, then claimed at seq 2.
  const events = [
    spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [user('say hi')] }),
    ev('turn/start', {}),
    // The claim itself — the fold must stop BEFORE it (upToSeqExclusive).
    spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
  ]
  const claimSeq = events.at(-1).seq
  const window = replayPendingInbox(events, claimSeq)
  assert.notEqual(window, undefined)
  // The projection read at handler time is post-splice empty; the replayed
  // window holds the pre-splice state — this is the whole fix.
  assert.equal(window['next-turn'].length, 1)
  const claimed = claimedUserText(window['next-turn'].slice(0, 0 + 1))
  assert.equal(claimed, 'say hi')
  // The claim coordinates (start=0, removedCount=1) slice the same window
  // the old projection read used to.
  assert.equal(window['next-turn'][0].source.kind, 'user')
})

test('target split: next-step claims read the next-step window only', () => {
  const events = [
    spliced({ target: 'next-step', start: 0, removedCount: 0, inserted: [user('confirm')] }),
    spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [user('hi')] }),
    spliced({ target: 'next-step', start: 0, removedCount: 1, inserted: [] }),
  ]
  // Fold to just before the next-step claim: both lanes hold their inserts
  // — a next-step splice never touches next-turn and vice versa.
  const window = replayPendingInbox(events, events.at(-1).seq)
  assert.deepEqual(
    window['next-step'].map((m) => m.content[0].text),
    ['confirm'],
  )
  assert.deepEqual(
    window['next-turn'].map((m) => m.content[0].text),
    ['hi'],
  )
  // The next-step claim rebuilds its own lane's text from its own lane's
  // window (start=0, removedCount=1 over next-step).
  assert.equal(claimedUserText(window['next-step'].slice(0, 0 + 1)), 'confirm')
})

test('start offset: claiming the second message slices one, not the first', () => {
  const events = [
    spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [user('first'), user('second')] }),
    spliced({ target: 'next-turn', start: 1, removedCount: 1, inserted: [] }),
  ]
  const window = replayPendingInbox(events, events.at(-1).seq)
  const claimed = window['next-turn'].slice(1, 2)
  assert.equal(claimedUserText(claimed), 'second')
})

test('user-only filter: non-user messages in the claimed window contribute no text', () => {
  assert.equal(claimedUserText([pluginMsg('system-ish'), user('real')]), 'real')
  assert.equal(claimedUserText([pluginMsg('only-plugin')]), '')
  // kind missing entirely
  assert.equal(claimedUserText([{ content: [{ type: 'text', text: 'anon' }] }]), '')
})

test('multi-block text: blocks joined per message, non-text blocks skipped, messages joined by newline', () => {
  const twoBlocks = user([{ type: 'text', text: 'a' }, { type: 'image', url: 'x' }, { type: 'text', text: 'b' }])
  assert.equal(claimedUserText([twoBlocks]), 'a\nb')
  assert.equal(claimedUserText([user('one'), user('two')]), 'one\ntwo')
})

test('canceled splices apply too — the fold replays projection state, not claims', () => {
  // A cancel (outcome=canceled, discardRemoved=true) removes from the
  // window exactly like a claim does; the replayed state must reflect it.
  const events = [
    spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [user('kept'), user('cancelled')] }),
    spliced({ target: 'next-turn', start: 1, removedCount: 1, outcome: 'canceled' }),
    spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
  ]
  const window = replayPendingInbox(events, events.at(-1).seq)
  assert.deepEqual(
    window['next-turn'].map((m) => m.content[0].text),
    ['kept'],
  )
  assert.equal(claimedUserText(window['next-turn'].slice(0, 1)), 'kept')
})

test('insert-at-position and replace fold like the host mutate() semantics', () => {
  const events = [
    spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [user('a')] }),
    // prepend
    spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [user('b')] }),
    // replace in place (remove 1 at 0, insert 1)
    spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [user('b2')] }),
  ]
  const window = replayPendingInbox(events, 1_000)
  assert.deepEqual(
    window['next-turn'].map((m) => m.content[0].text),
    ['b2', 'a'],
  )
})

test('degrades safely: malformed entries skip, unknown targets skip, empty fold succeeds', () => {
  assert.deepEqual(replayPendingInbox([], 5), { 'next-turn': [], 'next-step': [] })
  const withJunk = [
    { seq: 0, type: 'agent/inbox/spliced', data: null },
    { seq: 1, type: 'agent/inbox/spliced', data: { target: 'next-void', start: 0, removedCount: 0, inserted: [user('x')] } },
    { seq: 2, type: 'agent/inbox/spliced', data: { start: 0, removedCount: 0, inserted: [user('ok')] } },
    { seq: 3, type: 'other' },
  ]
  const window = replayPendingInbox(withJunk, 10)
  // target missing defaults to next-turn (host default), unknown target skipped
  assert.deepEqual(
    window['next-turn'].map((m) => m.content[0].text),
    ['ok'],
  )
})

test('seq guard: events at or past upToSeqExclusive never fold (missing seq still folds)', () => {
  const events = [
    spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [user('old')] }),
    spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [user('later')] }),
  ]
  const atFirst = replayPendingInbox(events, events[0].seq + 1)
  assert.deepEqual(
    atFirst['next-turn'].map((m) => m.content[0].text),
    ['old'],
  )
  // Hosts that do not stamp seq on firehose events: the fold still works
  // over what it is given (the handler guards the seq itself).
  const noSeq = [{ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [user('raw')] } }]
  assert.deepEqual(
    replayPendingInbox(noSeq, 99)['next-turn'].map((m) => m.content[0].text),
    ['raw'],
  )
})

// ---- resolveClaimedText: source ordering + attribution (0.17.1) ----
//
// CONCERN A regression anchor: the claim must read msg1 (the message the
// splice claims) even when the post-splice projection is NON-empty because
// a second message is still pending — the 0.17.0 empty-projection-only
// gating would have taken the residual msg2 text as the query.

test('CONCERN A: backlog of 2 (batched insert) — post-splice projection non-empty but shifted, replay claims msg1', () => {
  // One batched append inserted both messages (mutate() carries the full
  // inserted array); the claim removes only the first.
  const events = [
    spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [user('alpha'), user('beta')] }),
    ev('turn/start', {}),
    spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
  ]
  const claim = events.at(-1)
  // What agent.inbox.nextTurn holds at handler time on 0.1.5-rc.2+: the
  // eager drive already applied the claim, leaving the shifted residual.
  const projectionAfterSplice = [user('beta')]
  const r = resolveClaimedText({
    projection: projectionAfterSplice,
    logEvents: events,
    seq: claim.seq,
    target: 'next-turn',
    start: 0,
    removedCount: 1,
  })
  assert.equal(r.source, 'log-replay')
  assert.equal(r.text, 'alpha') // msg1 — NOT the residual 'beta'
})

test('CONCERN A: backlog of 2 (two separate appends) — same misalignment, replay wins', () => {
  // Two separate append splices queue the messages (log coordinates are
  // plain array positions — the second append lands at start:1); the
  // claim then removes the first.
  const events = [
    spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [user('first ask')] }),
    spliced({ target: 'next-turn', start: 1, removedCount: 0, inserted: [user('second ask')] }),
    spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
  ]
  const r = resolveClaimedText({
    projection: [user('second ask')], // post-splice residual at [0,1)
    logEvents: events,
    seq: events.at(-1).seq,
    target: 'next-turn',
    start: 0,
    removedCount: 1,
  })
  assert.equal(r.source, 'log-replay')
  assert.equal(r.text, 'first ask')
})

test('CONCERN B: attribution names the source that actually supplied the text', () => {
  // Projection non-empty AND replay armed → the replay supplied the text;
  // the attribution must not stay 'projection' just because the projection
  // read was non-empty (the 0.17.0 gating conflated the two).
  const events = [
    spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [user('alpha'), user('beta')] }),
    spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
  ]
  const r = resolveClaimedText({
    projection: [user('beta')],
    logEvents: events,
    seq: events.at(-1).seq,
    target: 'next-turn',
    start: 0,
    removedCount: 1,
  })
  assert.equal(r.source, 'log-replay')
  assert.equal(r.text, 'alpha')
})

test('replay verdict is final: an empty replayed slice never falls back to the shifted projection', () => {
  // The claimed window holds only a plugin message — the replay's empty
  // verdict must stand; consulting the post-splice projection here would
  // inject msg2's residual text under a claim of msg1.
  const events = [
    spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [pluginMsg('system-ish'), user('beta')] }),
    spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
  ]
  const r = resolveClaimedText({
    projection: [user('beta')],
    logEvents: events,
    seq: events.at(-1).seq,
    target: 'next-turn',
    start: 0,
    removedCount: 1,
  })
  assert.equal(r.text, '')
  assert.equal(r.source, 'log-replay') // the fold ran and found no user text
})

test('fallback: hosts without seq read the projection (pre-0.1.5 semantics)', () => {
  const events = [
    spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [user('live dispatch first')] }),
    spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
  ]
  // Pre-0.1.5: the live dispatch precedes the mutation, so the projection
  // still holds the pre-splice window at handler time.
  const r = resolveClaimedText({
    projection: [user('live dispatch first')],
    logEvents: events,
    seq: undefined,
    target: 'next-turn',
    start: 0,
    removedCount: 1,
  })
  assert.equal(r.source, 'projection')
  assert.equal(r.text, 'live dispatch first')
})

test('fallback: snapshotEvents unreachable (logEvents undefined) reads the projection', () => {
  const r = resolveClaimedText({
    projection: [user('pre-splice window')],
    logEvents: undefined,
    seq: 7,
    target: 'next-turn',
    start: 0,
    removedCount: 1,
  })
  assert.equal(r.source, 'projection')
  assert.equal(r.text, 'pre-splice window')
})

test('incident shape through resolveClaimedText: post-splice empty projection, seq-armed replay rebuilds', () => {
  const events = [
    spliced({ target: 'next-turn', start: 0, removedCount: 0, inserted: [user('say hi')] }),
    ev('turn/start', {}),
    spliced({ target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
  ]
  const r = resolveClaimedText({
    projection: [], // post-splice empty — the original incident window
    logEvents: events,
    seq: events.at(-1).seq,
    target: 'next-turn',
    start: 0,
    removedCount: 1,
  })
  assert.equal(r.source, 'log-replay')
  assert.equal(r.text, 'say hi')
})
