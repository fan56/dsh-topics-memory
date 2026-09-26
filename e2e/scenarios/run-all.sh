#!/usr/bin/env bash
# Scenario suite entrypoint (runs inside the e2e container).
set -euo pipefail

cd /e2e/scenarios
for scenario in 10-install.sh 20-boot-smoke.sh 30-headless-injection.sh 40-headless-distill.sh 50-jev-shadow.sh; do
  printf '==> scenario %s\n' "$scenario"
  bash "$scenario"
done
printf '==> all scenarios passed\n'
