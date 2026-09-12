#!/usr/bin/env bash
# Before and after for hedera-dev/hedera-harness#53, in one run.
#
#   bash docs/harness-contribution/demo.sh
#
# Needs a clone of the fork at ~/Desktop/hedera-harness with a demo project in it:
#   git clone https://github.com/divyanshkhurana06/hedera-harness ~/Desktop/hedera-harness
#   cd ~/Desktop/hedera-harness && npm ci && node dist/index.js init demo --skip-install
# and a chainValidation block in demo/.harness/spec.yaml (docs/authoring-a-recipe.md shows it).
set -euo pipefail
H=${HARNESS_DIR:-$HOME/Desktop/hedera-harness}
KEY=$(grep -oE "^HEDERA_PRIVATE_KEY=.*" "$(dirname "$0")/../../.env" | cut -d= -f2)
BAD=0xe339e3e12df4b8cb04cc42d30e7898de0475b33b     # the EVM address of the same account, a classic mistake
GOOD=0.0.10391251

run() { (cd "$H/demo" && HEDERA_OPERATOR_ID=$1 HEDERA_OPERATOR_KEY=$KEY node ../dist/index.js doctor 2>&1 | grep -iE "operator|hedera" || true); }

cd "$H"
echo; echo "BEFORE  (master): doctor with an EVM address in HEDERA_OPERATOR_ID"
git checkout -q master && npm run build --silent >/dev/null 2>&1
run "$BAD"
echo; echo "AFTER   (#53):    the same input"
git checkout -q doctor-verify-hedera-credentials && npm run build --silent >/dev/null 2>&1
run "$BAD"
echo; echo "AFTER   (#53):    the correct account id"
run "$GOOD"
echo
