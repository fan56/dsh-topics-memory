#!/usr/bin/env bash
# Host-side driver: build the Ubuntu 24.04 e2e image from this source tree
# and run the whole scenario suite inside one container (the container's
# isolated $DSH_HOME keeps the host config untouched).
#
# Usage:  ./e2e/run-e2e.sh          (from anywhere; resolves the repo root)
#
# Requirements: podman with a running machine (`podman machine start`).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-localhost/dsh-topics-memory-e2e:latest}"

# Same resolution rule as ci.yml / release.yml and the dsh-cron/dsh-tui-pi
# runners: newest of the `latest` (stable) and `next` (rc) dist-tags, never
# hand-pinned. The container's global dsh closure decides whether the packed
# plugin's peer floor passes the compatibility precheck at install time.
NPM_VIEW_REG=""
if ! npm view @deepseek-ai/dsh@latest version >/dev/null 2>&1; then
  NPM_VIEW_REG="--registry=https://registry.npmjs.org"
fi
STABLE="$(npm view @deepseek-ai/dsh@latest version $NPM_VIEW_REG)"
RC="$(npm view @deepseek-ai/dsh@next version $NPM_VIEW_REG 2>/dev/null || true)"
DSH_VERSION="$STABLE"
if [ -n "$RC" ] && [ "$(printf '%s\n' "$STABLE" "$RC" | sort -V | tail -1)" = "$RC" ]; then
  DSH_VERSION="$RC"
fi
printf '==> dsh closure: %s\n' "$DSH_VERSION"

printf '==> building image %s (context: %s)\n' "$IMAGE" "$REPO_ROOT"
podman build --build-arg DSH_VERSION="$DSH_VERSION" -f "$REPO_ROOT/e2e/Containerfile" -t "$IMAGE" "$REPO_ROOT"

printf '==> running scenario suite (all state stays inside the container)\n'
podman run --rm --name dsh-topics-memory-e2e \
  -v "$REPO_ROOT/e2e:/e2e:ro" \
  "$IMAGE" \
  bash /e2e/scenarios/run-all.sh

printf '==> e2e finished OK\n'
