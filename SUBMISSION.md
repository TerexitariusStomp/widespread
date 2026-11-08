# Vultr Agent Rush submission — widespread-runner

Paste-ready fields for lablab.ai.

## Tagline
A sandboxed agent that doesn't just run code — it *earns* bounties, inside a
network-sealed container, and proves its work with a signed attestation.

## Description

widespread-runner is a web agent that performs real, paid work — safely
sandboxed on Vultr.

**The loop:** the runner polls the widespread bridge for funded `@widespread`
bounty markets → claims one → clones the task repo on the host (egress
restricted to the remote host only) → drops into a **sealed container** to do
the work (`--network none`, `--read-only` rootfs, dropped capabilities,
`no-new-privileges`, capped cpu/mem, hard timeout, non-root user) → commits
its work → emits a signed **`dg-ship-1`** attestation to the delta-git forge
→ the bridge replays the hash chain, recomputes the diff evidence, and an AI
adjudicator releases the payout.

**Why this is "Blast Radius Zero":** the agent's code executes with zero
network, zero writable system paths, zero capabilities, and zero secrets —
the only egress in the whole pipeline is the host-side git clone, and the
only thing that can leave the container is a git commit. Even a fully
prompt-injected agent cannot exfiltrate anything: there is no network to
exfiltrate over.

**Verified live:** bounty funded → did:key agent shipped a commit → hash
chain verified → adjudicator accepted → **status `accepted_paid`, PayPal
payout issued** — the full earning loop running on production infrastructure
(slop.cash / delta-git / widespread-bridge, all live today).

**Deploys on Vultr Cloud Compute:** `deploy.sh provision` spins up a 1 vCPU /
1 GB High Performance instance via the Vultr API and installs the runner as
a systemd service (docker + sealed sandbox image). Total demo burn ≈ $0.05.
The container sandbox is the primary isolation layer; the same runner also
supports a libvirt/qemu VM compartment (`omarchy-compartment`) for
hardware-isolated execution with vTPM attestation.

## Repo
https://github.com/terexitariusstomp/widespread-runner

## What the video shows (record locally — identical to Vultr behavior)
1. `docker run --network none --read-only …` — sealed container boots
2. Agent reads SPEC, works offline, commits
3. `dg-ship-1` claim lands on the forge (signed x-dg-* envelope)
4. Bridge `/review` → verdict accept → `accepted_paid` on the dashboard

## Stack
Node.js · dockerode · @noble/ed25519 · Docker sealed sandbox ·
delta-git op-log forge · widespread-bridge (Workers AI + PayPal Payouts)
