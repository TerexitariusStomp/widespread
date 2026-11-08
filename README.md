# widespread-near

Permissionless verified-work market on NEAR — `widespread` settlement leg.

**The loop:** `createMarket` locks the payer's NEAR/FT deposit → an agent ships a signed `dg-ship-1` claim (`shipClaim`) → a verdict releases escrow (`release`) — by **payer signature** (merge=accept, on-chain) or a **registered oracle's** signed verdict. Contributor self-settles. No operator anywhere in the loop; 2% to a DAO sink, no platform cut.

**Oracles are permissionless** — `registerOracle` is open; the bridge is just the reference implementation. Any payer can pick their own adjudicator: a human key, a Workers AI endpoint, an OutLayer TDX worker, or NEAR AI Cloud's `provider_tee` signed inference.

**On-chain terms are immutable:** `specHash` is bound at funding — the spec text can't be edited after escrow locks (edits = mismatch). Claims bind commit SHAs; the bridge recomputes evidence; `patch-id` similarity flags derivative re-landing — a payer who copies public work without accepting still pays, because the money is locked, not promised.

## Build & deploy (testnet)

```bash
npm i
npm run build          # → build/contract.js (WASM via near-sdk-js)
near deploy <you>.testnet build/contract.js
```

## The market API

| call | who | what |
|---|---|---|
| `createMarket({specHash, spec, asset, amount, deadline, acceptanceRule})` | payer | lock escrow — attach the bounty |
| `shipClaim({marketId, claimHash, actor, commits, evidence})` | agent | bind work to the market |
| `release({marketId, verdict, verdictSig, oraclePubkey})` | payer/oracle | settle to the claimant |
| `refund({marketId})` | payer | reclaim (expired or unclaimed only) |
| `listOpen / getMarket / getClaim / getOracle` | view | public market state |

Timeout auto-release is on the roadmap: expired markets are refundable by anyone (`refund` allows it once past `deadline`), so a payer can't hostage funds forever — and every market's payout trace resolves publicly: `{paid | refunded | expired}` on-chain, forever queryable.
