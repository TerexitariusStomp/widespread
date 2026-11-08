#!/usr/bin/env bash
# demo-ui.sh — browser-driven UI walkthrough for the Vultr Agent Rush video.
# Opens each product surface in sequence; screen recording captures the UIs.
# Pair with narrate.sh to generate the voiceover track.

set -uo pipefail
B="${BROWSER:-brave}"
BRIDGE="${BRIDGE_BASE:-https://widespread-bridge.widespread.workers.dev}"
FORGE="${FORGE_BASE:-https://code.widespread.fyi}"

open_url() { "$B" --new-window "$1" >/dev/null 2>&1 & sleep "${2:-10}"; }

clear
echo "UI demo starting — recording should be live…"
sleep 3

# 1 · widespread.fyi — the ecosystem home
open_url "https://widespread.fyi" 11

# 2 · Bridge dashboard — claims, verdicts, payouts on one screen
open_url "$BRIDGE" 12

# 3 · code.widespread.fyi — the forge's signed op-log (dg-ship-1 attestation)
open_url "$FORGE/api/slop/protocol/dg/oplog" 11

# 4 · Back to the payout detail — accepted_paid on the dashboard
open_url "$BRIDGE" 11

# 5 · widespread-runner on GitHub — the sandboxed agent itself
open_url "https://github.com/TerexitariusStomp/widespread-runner" 12

echo "UI demo complete."
