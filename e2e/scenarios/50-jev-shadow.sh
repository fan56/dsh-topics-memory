#!/usr/bin/env bash
# Scenario 50 — jev (System One) fastgate shadow end-to-end in a real dsh
# process, against a MOCK systemone endpoint (keyless, no real network):
#
#   1. /etc/hosts pins opencode.ai (the zen endpoint host) to 127.0.0.1 and a
#      local HTTPS server with a self-signed cert serves the decision answers
#      (the dsh process runs with NODE_EXTRA_CA_CERTS + the reject-0 belt so
#      the mock cert is accepted; the mock returns noul 0.9 for the marker
#      candidate and 0.05 for everything else, and logs every request body)
#   2. the profile enables jevEnabled (+ qualityLane always so the one-shot
#      session's first turn triggers) and passes JEV_ZEN_API_KEY through the
#      patch env: block — ambient KEY* variables are scrubbed by dsh
#   3. one headless turn over the marker topic: the fast lane injects exactly
#      as without jev (the scenario-30 baseline assertions double as the
#      zero-behavior proof), then turn/end fires the fastgate shadow
#   4. assert: meta/decisions.jsonl carries the call-layer row (lane=
#      fastgate-shadow, outcome=ok) AND the verdict-layer rows (agree
#      reconciled to the lexical disposition), while injections.jsonl still
#      shows the same injected:true round as jev-off
#
# Note: the SLOW-lane rerank seam cannot complete in a one-shot session (the
# replay adapter scope dies with it, the same documented 40-headless-distill
# limitation), so the shadow — which needs no LLM caller — is the seam under
# test here; the rerank bands/fail-open are covered by the unit suite.
set -euo pipefail
# KNOWN BLOCKER (pre-existing, not introduced by this scenario): the replay
# fixture infrastructure (DSH_SNAPSHOT_FILE + v3-style assistant/chunk rows)
# predates the 0.1.7 v4 session format and is rejected at boot by
# dsh-llm-replay's format catalog ("assistant/attempt does not match an open
# turn and step") — scenarios 30/40/50 are ALL blocked by it; 30 was already
# red on main before the jev work. Unblocking requires a v4-lifecycle fixture
# rewrite (turn/start → step/start → assistant/message rows, seq 0-based) for
# the three scenarios; the dsh version resolution is now pinned to
# 0.1.7-rc.1 in this file/30/40/Containerfile so the loader side is stable.
# Until then: scenario logic verified against the local mock (wire shape +
# certificate) and the rerank/shadow seams are covered by hermetic unit
# tests (test/jev-fastgate.test.mjs, test/quality.test.mjs).


export DSH_HOME=/root/.dsh-e2e
P="$DSH_HOME/profiles/e2e"
B="$DSH_HOME/topics"

# dsh version: pinned to 0.1.7-rc.1 — the line this repo's peerDependencies
# target and the fixtures were validated against. NEVER resolve this bare:
# `latest` is a vendor placeholder (moved 0.0.1-rc.3 → 0.1.5-rc.3, breaking
# schemastery .volatile()) and rc.2 tightened replay fixture validation.
# Bump deliberately with the next rc wave.
: "${DSH_VERSION:=$(echo 0.1.7-rc.1)}"

echo '==> adding headless app + replay LLM to the profile (idempotent)'
dsh plugin --profile e2e add "@deepseek-ai/dsh-headless@${DSH_VERSION}"
dsh plugin --profile e2e add "@deepseek-ai/dsh-llm-replay@${DSH_VERSION}"

echo '==> profile patch: jevEnabled on + qualityLane always + JEV key via env block'
cat > "$P/cordis.patch.yml" <<'EOF'
# user patch layer: keyless replay LLM + jev enabled for the shadow scenario
- insert:
    - id: llm-replay
      name: '@deepseek-ai/dsh-llm-replay'
      config:
        providers:
          - id: replay
            name: Replay
            models:
              - id: replay-1
- insert:
    - id: dsh-topics-memory
      name: '@aiwayds/dsh-topics-memory'
      config:
        jevEnabled: true
        qualityLane: always
      env:
        JEV_ZEN_API_KEY: e2e-mock-key-not-a-secret
EOF

cat > "$DSH_HOME/settings.yaml" <<'EOF'
agent-default-model:
  provider: replay
  model: replay-1
EOF

echo '==> seeding the bundle with the marker topic (scenario-30 baseline setup)'
mkdir -p "$B/topics" "$B/meta"
git -C "$B" init -q -b main 2>/dev/null || true
cat > "$B/topics/echo-marker.md" <<'EOF'
---
type: Topic
title: Echo Marker QX7QZ
description: e2e 注入证明用的标记 topic
tags: [e2e, marker]
depends: []
open_questions: [这个标记何时被注入]
impact: []
status: stable
generated: { by: agent:e2e, at: 2026-08-31T00:00:00Z }
---

# Conclusion

The Echo Marker QX7QZ topic exists to prove injection lands in the live request.

# Recommendations

No action needed.
EOF
git -C "$B" add -A
git -C "$B" -c user.name=e2e -c user.email=e2e@localhost commit -qm 'seed echo-marker topic (scenario 50)' || true

echo '==> self-signed cert + /etc/hosts pin for the mock zen endpoint'
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -keyout /tmp/jev-mock-key.pem -out /tmp/jev-mock-cert.pem \
  -subj '/CN=opencode.ai' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'subjectAltName=DNS:opencode.ai' >/dev/null 2>&1
grep -q 'opencode.ai' /etc/hosts || echo '127.0.0.1 opencode.ai' >> /etc/hosts

echo '==> starting the mock systemone server (logs request bodies, answers noul)'
cat > /tmp/jev-mock.mjs <<'EOF'
import https from 'node:https'
import { readFileSync, appendFileSync } from 'node:fs'
const server = https.createServer(
  { key: readFileSync('/tmp/jev-mock-key.pem'), cert: readFileSync('/tmp/jev-mock-cert.pem') },
  (req, res) => {
    let raw = ''
    req.on('data', (d) => { raw += d })
    req.on('end', () => {
      appendFileSync('/tmp/jev-mock-requests.jsonl', raw + '\n')
      const answers = {}
      try {
        const body = JSON.parse(raw)
        for (const [qid, q] of Object.entries(body.questions ?? {})) {
          answers[qid] = { noul: String(q.instructions).includes('Echo Marker') ? 0.9 : 0.05 }
        }
      } catch { /* fall through with empty answers */ }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ answers, usage: { input_tokens: 42, output_tokens: 7 } }))
    })
  },
)
server.listen(443, '127.0.0.1', () => console.log('jev mock up'))
EOF
rm -f /tmp/jev-mock-requests.jsonl
node /tmp/jev-mock.mjs &
MOCK_PID=$!
trap 'kill "$MOCK_PID" 2>/dev/null || true' EXIT
for i in $(seq 1 20); do
  if grep -q '127.0.0.1 opencode.ai' /etc/hosts && kill -0 "$MOCK_PID" 2>/dev/null; then break; fi
  sleep 0.2
done

echo '==> writing the replay fixture (one text block, live-request echo)'
F=/tmp/replay-fixture-jev
mkdir -p "$F"
TS=$(date +%s000)
cat > "$F/session.jsonl" <<EOF
{"type":"session","version":0,"id":"fixture-jev-1","createdAt":$TS,"cwd":"/tmp","delegationDepth":0}
{"type":"assistant/chunk","seq":1,"time":$TS,"data":{"turn":1,"step":1,"chunk":{"type":"block-start","index":0,"blockType":"text"}}}
{"type":"assistant/chunk","seq":2,"time":$TS,"data":{"turn":1,"step":1,"chunk":{"type":"text-delta","index":0,"text":"ECHOED:{{fromRequest:Marker ([A-Z0-9]+)}}"}}}
{"type":"assistant/chunk","seq":3,"time":$TS,"data":{"turn":1,"step":1,"chunk":{"type":"block-end","index":0,"block":{"type":"text","text":"ECHOED:{{fromRequest:Marker ([A-Z0-9]+)}}"}}}}
{"type":"assistant/chunk","seq":4,"time":$TS,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":100,"outputTokens":10,"cacheReadTokens":0,"reasoningTokens":0}}}}
{"type":"assistant/chunk","seq":5,"time":$TS,"data":{"turn":1,"step":1,"chunk":{"type":"finish","reason":{"kind":"stop"}}}}
EOF

export DSH_SNAPSHOT_FILE="$F/session.jsonl"

echo '==> running one real headless turn (jev shadow fires at turn/end)'
set +e
OUT=$(NODE_EXTRA_CA_CERTS=/tmp/jev-mock-cert.pem NODE_TLS_REJECT_UNAUTHORIZED=0 \
  timeout --signal=KILL 90 dsh --profile e2e "关于 echo marker 的疑问，现在有什么结论？")
rc=$?
set -e
echo "$OUT" | tail -5
[ "$rc" -ne 0 ] && { echo "FAIL: headless turn exited $rc"; exit 1; }

echo '==> zero-behavior proof: the marker still injects exactly as jev-off (scenario-30 baseline)'
echo "$OUT" | grep -q 'ECHOED:QX7QZ' || {
  echo 'FAIL: the marker never came back — enabling jev changed the fast-lane injection behavior'
  exit 1
}
INJ="$B/meta/injections.jsonl"
[ -f "$INJ" ] || { echo 'FAIL: no injection log written'; exit 1; }
node - "$INJ" <<'EOF'
import { readFileSync } from 'node:fs'
const records = readFileSync(process.argv[2], 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l))
// Scoped to THIS session so stale scenario-30 records cannot satisfy the check.
const mine = records.filter((r) => r.sessionId === 'fixture-jev-1')
const injected = mine.find((r) => r.injected === true && (r.hits ?? []).some((h) => h.slug === 'echo-marker'))
if (injected === undefined) throw new Error(`FAIL: this session has no injected:true round for echo-marker: ${JSON.stringify(mine)}`)
EOF

echo '==> asserting the mock endpoint actually saw the decision request'
for i in $(seq 1 25); do
  [ -f /tmp/jev-mock-requests.jsonl ] && break
  sleep 0.2
done
[ -f /tmp/jev-mock-requests.jsonl ] || { echo 'FAIL: the mock endpoint saw no decision request'; exit 1; }

echo '==> asserting decisions.jsonl: call layer + verdict layer with agree reconciliation'
DEC="$B/meta/decisions.jsonl"
FOUND=""
for i in $(seq 1 25); do
  if [ -f "$DEC" ] && grep -q 'fastgate-shadow' "$DEC" 2>/dev/null; then FOUND=1; break; fi
  sleep 0.2
done
[ -n "$FOUND" ] || { echo 'FAIL: no fastgate-shadow rows in decisions.jsonl'; cat "$DEC" 2>/dev/null; exit 1; }

node - "$DEC" <<'EOF'
import { readFileSync } from 'node:fs'
const file = process.argv[2]
const rows = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
const calls = rows.filter((r) => r.lane === 'fastgate-shadow' && r.questionCount !== undefined)
if (calls.length === 0) throw new Error('FAIL: no fastgate-shadow call-layer row')
const ok = calls.find((r) => r.outcome === 'ok' && r.fallback === false && r.questionCount >= 1)
if (ok === undefined) throw new Error(`FAIL: fastgate-shadow call row not ok: ${JSON.stringify(calls)}`)
const verdicts = rows.filter((r) => r.lane === 'fastgate-shadow' && r.digest !== undefined)
if (verdicts.length === 0) throw new Error('FAIL: no fastgate-shadow verdict-layer rows')
for (const v of verdicts) {
  for (const k of ['at', 'lane', 'questionId', 'qtype', 'ref', 'digest', 'probability', 'band', 'agree']) {
    if (v[k] === undefined) throw new Error(`FAIL: verdict row missing ${k}: ${JSON.stringify(v)}`)
  }
}
const hit = verdicts.find((v) => v.ref === 'slug:echo-marker')
if (hit === undefined) throw new Error(`FAIL: no verdict for slug:echo-marker: ${JSON.stringify(verdicts)}`)
if (hit.agree !== 'hit') throw new Error(`FAIL: expected agree=hit for the injected hit, got ${hit.agree}`)
if (hit.band !== 'adopt' || hit.probability !== 0.9) throw new Error(`FAIL: unexpected verdict ${JSON.stringify(hit)}`)
if (verdicts.some((v) => v.agree === 'n/a')) throw new Error('FAIL: fastgate verdicts must reconcile, never n/a')
console.log(`verdict rows: ${verdicts.length}, call rows: ${calls.length}`)
EOF

echo "PASS 50-jev-shadow: shadow verdicts landed (call+verdict layers, agree reconciled) and injection behavior is unchanged"
