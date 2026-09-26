#!/usr/bin/env bash
# Scenario 30 — the crown jewel: a REAL headless dsh session proves same-turn
# injection with zero credentials.
#
#   1. add the headless app + @deepseek-ai/dsh-llm-replay (keyless replay LLM)
#   2. seed the bundle with one topic whose title carries a marker string
#   3. point replay at a one-line fixture: the "model" replies
#      `ECHOED:{{fromRequest:Marker [A-Z0-9]+}}` — the placeholder resolves
#      against the LIVE request corpus, so the echo can only appear when the
#      topic digest actually reached the same turn's model request
#   4. run `dsh --profile e2e "<query>"` and assert the marker in the output,
#      plus a written injection log record (ADR 0006/0007)
set -euo pipefail

export DSH_HOME=/root/.dsh-e2e
P="$DSH_HOME/profiles/e2e"

echo '==> adding headless app + replay LLM to the profile'
# Pin to the same closure as the global dsh CLI (ENV DSH_VERSION from the
# image); bare latest can resolve to an old line with unpublished deps.
# dsh version: pinned to 0.1.7-rc.1 — the line this repo's peerDependencies
# target and the fixtures were validated against. NEVER resolve this bare:
# `latest` is a vendor placeholder (moved 0.0.1-rc.3 → 0.1.5-rc.3, breaking
# schemastery .volatile()) and rc.2 tightened replay fixture validation.
# Bump deliberately with the next rc wave.
: "${DSH_VERSION:=$(echo 0.1.7-rc.1)}"
echo "closure: ${DSH_VERSION}"
dsh plugin --profile e2e add "@deepseek-ai/dsh-headless@${DSH_VERSION}"
dsh plugin --profile e2e add "@deepseek-ai/dsh-llm-replay@${DSH_VERSION}"

# dsh-llm-replay declares no dsh.bundle — mount it through the profile's own
# patch layer WITH its replay-only provider catalog, so the agent's
# `replay/replay-1` route dispatches through the replay adapter (keyless).
cat > "$P/cordis.patch.yml" <<'EOF'
# user patch layer: mount the keyless replay LLM for the e2e turn
- insert:
    - id: llm-replay
      name: '@deepseek-ai/dsh-llm-replay'
      config:
        providers:
          - id: replay
            name: Replay
            models:
              - id: replay-1
EOF

# Default model route — the replay catch-all intercepts llm/stream before any
# provider I/O, so arbitrary route ids are fine.
cat > "$DSH_HOME/settings.yaml" <<'EOF'
agent-default-model:
  provider: replay
  model: replay-1
EOF

echo '==> seeding the bundle with a marker topic'
B="$DSH_HOME/topics"
mkdir -p "$B/topics" "$B/meta"
git init -q -b main "$B"
git -C "$B" -c user.name=e2e -c user.email=e2e@localhost add -A 2>/dev/null || true
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
git -C "$B" -c user.name=e2e -c user.email=e2e@localhost commit -qm 'seed echo-marker topic'

echo '==> writing the replay fixture (one text block, live-request echo)'
F=/tmp/replay-fixture
mkdir -p "$F"
TS=$(date +%s000)
cat > "$F/session.jsonl" <<EOF
{"type":"session","version":0,"id":"fixture-echo-1","createdAt":$TS,"cwd":"/tmp","delegationDepth":0}
{"type":"assistant/chunk","seq":0,"time":$TS,"data":{"turn":1,"step":1,"chunk":{"type":"block-start","index":0,"blockType":"text"}}}
{"type":"assistant/chunk","seq":1,"time":$TS,"data":{"turn":1,"step":1,"chunk":{"type":"text-delta","index":0,"text":"ECHOED:{{fromRequest:Marker ([A-Z0-9]+)}}"}}}
{"type":"assistant/chunk","seq":2,"time":$TS,"data":{"turn":1,"step":1,"chunk":{"type":"block-end","index":0,"block":{"type":"text","text":"ECHOED:{{fromRequest:Marker ([A-Z0-9]+)}}"}}}}
{"type":"assistant/chunk","seq":3,"time":$TS,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":100,"outputTokens":10,"cacheReadTokens":0,"reasoningTokens":0}}}}
{"type":"assistant/chunk","seq":4,"time":$TS,"data":{"turn":1,"step":1,"chunk":{"type":"finish","reason":{"kind":"stop"}}}}
EOF

export DSH_SNAPSHOT_FILE="$F/session.jsonl"

echo '==> running one real headless turn (replayed model, real agent loop)'
set +e
OUT=$(timeout --signal=KILL 90 dsh --profile e2e "关于 echo marker 的疑问，现在有什么结论？")
rc=$?
set -e
echo "$OUT" | tail -5

if [ "$rc" -ne 0 ]; then
  echo "FAIL: headless turn exited $rc"
  exit 1
fi

echo "$OUT" | grep -q 'ECHOED:QX7QZ' || {
  echo 'FAIL: the marker never came back — the topic digest did NOT reach the same-turn model request'
  exit 1
}

echo '==> asserting the injection log record'
LOG="$B/meta/injections.jsonl"
[ -f "$LOG" ] || { echo 'FAIL: no injection log written'; exit 1; }
grep -q '"injected":true' "$LOG" || { echo 'FAIL: injection log has no injected:true round'; cat "$LOG"; exit 1; }
grep -q '"slug":"echo-marker"' "$LOG" || { echo 'FAIL: log does not reference the echo-marker hit'; exit 1; }

echo "PASS 30-headless-injection: same-turn injection proven via live-request echo + log"
