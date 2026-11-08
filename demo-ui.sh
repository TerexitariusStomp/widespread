#!/usr/bin/env bash
# demo-ui.sh — browser-driven UI walkthrough for the Vultr Agent Rush video.
# Opens ONE fullscreen brave window on the current workspace and navigates
# each product surface in sequence. Pair with narrate.sh for voiceover.

set -uo pipefail
B="${BROWSER:-brave}"
BRIDGE="${BRIDGE_BASE:-https://widespread-bridge.widespread.workers.dev}"
FORGE="${FORGE_BASE:-https://code.widespread.fyi}"

nav() { "$B" "$1" >/dev/null 2>&1; sleep "${2:-11}"; }

# one fullscreen window covering the whole frame
"$B" --new-window --start-fullscreen "about:blank" >/dev/null 2>&1 &
sleep 4

# 1 · code.widespread.fyi — the forge ("widespread code")
nav "$FORGE" 11

# 2 · Bridge dashboard — claims, verdicts, payouts on one screen
nav "$BRIDGE" 12

# 3 · the forge's signed op-log — the dg-ship-1 attestation
nav "$FORGE/api/slop/protocol/dg/oplog" 11

# 4 · back to the payout detail — accepted_paid on the dashboard
nav "$BRIDGE" 11

# 5 · widespread-runner on GitHub — the sandboxed agent itself
nav "https://github.com/TerexitariusStomp/widespread-runner" 12

echo "UI demo complete."
