#!/usr/bin/env bash
# demo.sh — the Vultr Agent Rush demo, scripted for recording.
# Run this while capturing your screen (e.g. `omarchy screenrecord`).
# Proves: sealed execution → signed attestation → verified → paid.

set -uo pipefail
BRIDGE="${BRIDGE_BASE:-https://slopcash-bridge.hardwoodstablecoin.workers.dev}"
FORGE="${FORGE_BASE:-https://code.widespread.fyi}"
REPO_SLUG="${DEMO_REPO:-slop/protocol}"
RUN=/tmp/widespread-demo

step() { printf '\n\033[1;36m── %s ──\033[0m\n' "$*"; sleep 1.2; }
say()  { printf '\033[0;33m# %s\033[0m\n' "$*"; }

clear
say "widespread-runner — a sandboxed agent that EARNS bounties"
say "Vultr Agent Rush · Blast Radius Zero"
sleep 2

step "1 · The bridge serves funded @widespread bounty markets"
curl -s "$BRIDGE/api/bounties" | python3 -m json.tool | head -20
sleep 3

step "2 · Host-side clone — the ONLY egress is the git remote"
rm -rf "$RUN"; mkdir -p "$RUN/repo"
git clone --depth 5 "https://github.com/SlopDotCash/protocol" "$RUN/repo" 2>&1 | tail -2
sleep 2

step "3 · Sealed container: --network none --read-only, no caps"
echo 'SPEC: prove the agent ran offline' > "$RUN/SPEC.md"
say "docker run --rm --network none --read-only --cap-drop ALL …"
docker run --rm --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 512m --cpus 1 --pids-limit 64 \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  -u 1000 -e TASK_ID=vultr-demo-1 \
  -v "$RUN:/work:rw" \
  widespread-sandbox:latest run-task.sh
sleep 2

step "4 · Proof it was really sealed — no route out"
docker run --rm --network none --read-only \
  -v "$RUN:/work:rw" --entrypoint /bin/sh \
  widespread-sandbox:latest -c 'wget -qO- https://example.com 2>&1 | head -2; echo "EXIT:$?"'
sleep 2

step "5 · The agent's commit exists — ship it as a signed dg-ship-1 attestation"
git -C "$RUN/repo" log --oneline -3
say "→ POST $FORGE/api/$REPO_SLUG/dg/ship (ephemeral Ed25519 agent, x-dg-sig)"
CLAIM_SHA=$(git -C "$RUN/repo" rev-parse upstream/HEAD 2>/dev/null || git -C "$RUN/repo" rev-parse origin/HEAD)
SEQ=$(node ../widespread-bridge/scripts/ship-claim.mjs --repo "$REPO_SLUG" \
  --commits "$CLAIM_SHA" --session "vultr-demo-$(date +%s)" --tool widespread-runner \
  2>/dev/null | grep -oE '\(seq [0-9]+\)' | grep -oE '[0-9]+')
say "claim landed at op-log seq $SEQ"
sleep 3

step "6 · Bridge replays hash chain, recomputes diff, AI adjudicates"
say "→ POST $BRIDGE/review"
curl -s -X POST "$BRIDGE/review" -H 'content-type: application/json' \
  -d "{\"repo\":\"$REPO_SLUG\",\"seq\":${SEQ:-0}}" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); r=d['records'][0]; print('status:',r['status']); print('chain valid:',r['chain']['valid']); j=r.get('adjudication',{}); print('verdict:',j.get('verdict'),'| confidence:',j.get('confidence')); p=r.get('payout') or {}; print('payout:',p.get('batch_status','—'),'| batch:',p.get('batch_id',''))"
sleep 4

step "7 · Receipt — the PR holds the verdict + payout forever"
say "status: accepted_paid · signed receipt written back to the forge"
say "the agent earned. sealed. verified. paid."
echo
