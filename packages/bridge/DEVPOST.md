# Widespread — AI agents that get *paid* for verified work

**Track:** Agentic Commerce · also: x402-gap, autonomy-loop

## Inspiration

Every agent-economy project at this hackathon helps an agent *spend*
— x402 payments, spending guards, agent wallets. Nobody asks whether the
agent *earned* anything, because there's no way to prove agent work. We
built the mirror image: a market where an agent's **work is attested**,
then its **payment is settled** — through PayPal.

## What it does

A payer posts `@widespread $10 for <spec>` on a repo. An agent claims it,
does the work inside a network-sealed container, and ships a **signed
`dg-ship-1` attestation** binding its commits to a forge op-log (hash-
chained, tamper-evident). The bridge replays the chain, **recomputes the
diff evidence**, and an AI adjudicator decides. `accept` → a **real
PayPal Payout** lands — batch id, email, receipt written back into the
repo's own history.

**Verified live:** a `did:key` agent shipped a commit, the bridge
verified it (`verified: true`), the adjudicator accepted (0.9
confidence), status `accepted_paid` — batch `P77NBADNAUMTJ` on
production. Nothing is mocked.

## How we built it

- **`widespread-bridge`** (Cloudflare Worker): claim ingest → Ed25519
  op-log replay → evidence recompute (file/line counts vs upstream patch)
  → Workers AI adjudicator → **PayPal Payouts API** → forge receipt.
- **delta-git forge**: signed `dg-ship-1`/`dg-bounty-1` ops = the
  work-attestation layer; KB-scale, did:plc identities.
- **`widespread-runner`**: the agent executes bounties in a sealed
  container (`--network none`, read-only rootfs, dropped caps, timeout)
  then emits the claim — "blast radius zero."
- **PayPal Payouts API** — the compliance rail: sandbox client creds as
  Worker secrets, `POST /v1/payments/payouts`, batch id returned and
  stored per claim. *This is the judge-visible PayPal developer-platform
  integration.*

## Why PayPal matters

PYUSD is the on-chain story (it settles on our Encode/Solana rail), but
**Payouts is the fiat rail that makes this a product, not a token demo**:
a contributor's agent can earn a bounty and receive spendable dollars to
a normal PayPal account — no crypto offramp, no custody of ours.

## What we learned

Agent-economy protocols (x402, ACP, intents) are all **agent-as-buyer**.
The missing primitive is **proof-of-work for agents** — attestation that
the work happened and was accepted *before* money moves. That's what lets
a market exist without trusting the agent, the payer, or us.

## What's next

Merge=accept (a GitHub PR merge triggers the payout directly),
derivative-work detection (`git patch-id` — a payer who lands your work
without accepting still pays because the money is locked, not promised),
NEAR contract escrow for permissionless settlement.

## Built with

Cloudflare Workers + Workers AI, delta-git op-logs, Ed25519 (did:key),
PayPal Payouts API, Docker sandboxing, AG Grid dashboard.
