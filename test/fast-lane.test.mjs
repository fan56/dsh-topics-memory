// Regression tests for the fast-lane claimed-text rebuild (0.17.0).
//
// The 0.1.5-rc.2 incident: the eager projection drive (session/event
// hooksOrder[0]) applies the claim splice before this plugin's handler
// (hooksOrder[10]) runs, so the projection read yields the post-splice
// EMPTY window and the fast lane silently died on claimedText === ''.
// The fix rebuilds the pre-splice window by folding the session log —
// replayPendingInbox — which depends on no dispatch order at all. These
// tests replay exactly that incident shape plus the original semantics
// (user-only filter, target split, start offset, multi-block text).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replayPendingInbox, claimedUserText } from '../lib/index.js'

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
