# Widespread — testing matrix

Single pnpm workspace (`pnpm-workspace.yaml`); every package installs from the
root lockfile. Default test commands are **hermetic** — they never touch
mainnet, real money, or unmocked third parties. Live coverage is opt-in via
`E2E_LIVE=1`.

## Quick start

```bash
pnpm install                      # one lockfile for the whole monorepo
pnpm -r --if-present test         # every package's hermetic suite
pnpm -r --if-present typecheck    # packages that ship a typecheck script
```

Per-package:

```bash
pnpm --filter @widespread/bridge typecheck && pnpm --filter @widespread/bridge test
pnpm --filter @widespread/near test
pnpm --filter @widespread/hermes-browser test
pnpm --filter @widespread/delta-git test          # node unit tests
pnpm --filter @widespread/delta-git test:workers  # worker integration suite (heavy)
pnpm --filter @widespread/runner test
pnpm --filter @widespread/solana test
pnpm --filter @widespread/bot test
```

## @widespread/bridge (Cloudflare Worker)

| Command | Scope | Live? |
|---|---|---|
| `pnpm --filter @widespread/bridge test` | vitest unit tests — claims, fiat, mirrorclaims, payouts, nearops (tx serialization + base58), ingest, writeback, XSS escaping, feed, hats, web pages | no |
| `pnpm --filter @widespread/bridge typecheck` | `tsc --noEmit` | no |
| `E2E_LIVE=1 pnpm --filter @widespread/bridge test` | additionally runs `test/e2e.live.test.ts` against the deployed worker | yes (read-only probes) |
| `node packages/bridge/scripts/e2e-lifecycle.mjs` | flagship demo: fund → claim → verdict → payout → receipt against live sandbox rails | yes |

Notes: KV/NEAR-RPC/PayPal are stubbed in unit tests via `test/mock.ts`.
Live tests reuse KV dedupe keys — safe to re-run.

## @widespread/near (NEAR contracts)

| Command | Scope | Live? |
|---|---|---|
| `pnpm --filter @widespread/near test` | `node --test test/*.test.mjs` — contract classes through an esbuild harness with a stubbed `near-sdk-js` runtime: market create/claim/release/refund/pagination, hats org/tree/assign/sign-request/stance/payout | no |
| `E2E_LIVE=1 node --test packages/near/test/live.test.mjs` | full market lifecycle on NEAR testnet via near-api-js (`callFunction` + raw query views) | yes (testnet) |
| `pnpm --filter @widespread/near build` | near-sdk-js compile of `contracts/market` → `contract.wasm` | no |

Requires `~/.widespread-near.json` deploy creds (created by
`contracts/market/deploy.js`) for the live test and deploys.

## @widespread/hermes-browser

| Command | Scope | Live? |
|---|---|---|
| `pnpm --filter @widespread/hermes-browser test` | node:test (vault ops, NEAR key custody — fake-indexeddb) + python unittest (widespread plugin: RFC 8032 ed25519, dg1 envelope) | no |
| `pnpm --filter @widespread/hermes-browser build && pnpm --filter @widespread/hermes-browser smoke` | Playwright smoke: Pyodide backend boot, REST + ws JSON-RPC round-trips, vault boundary | local only |

The JS tests need the workspace install (`fake-indexeddb`, `near-api-js`).
Smoke needs `build` first (vendors hermes-agent, packs Pyodide env, assembles
`dist/`) plus `pnpm --filter @widespread/hermes-browser exec playwright install`.

`packages/hermes/relay` is a standalone Cloudflare worker (not a workspace
member); its e2e (`node scripts/e2e.mjs`) expects `wrangler dev` running on
:8787 — manual only.

## @widespread/delta-git (forge)

| Command | Scope | Live? |
|---|---|---|
| `pnpm --filter @widespread/delta-git test` | node unit tests (`vitest.unit.config.ts`) | no |
| `pnpm --filter @widespread/delta-git test:workers` | worker integration tests (`vitest.config.ts`, vitest-pool-workers) — heavy, ~80s+ | no |
| `pnpm --filter @widespread/delta-git test:auth` | auth worker subset | no |
| `pnpm --filter @widespread/delta-git test:e2e` | Playwright suite (needs built SPA: `build:spa`) | no |

`frontend/canary` is an upstream pnpm workspace excluded from the root
workspace; `build:spa` auto-installs it when `node_modules` is missing.

Known environment-dependent failures (not regressions): SPA-asset tests 404
when `frontend/canary` was never built, and the CT-log certificate probe
needs live internet.

## @widespread/runner

| Command | Scope | Live? |
|---|---|---|
| `pnpm --filter @widespread/runner test` | dg-ship-1 claim flow against a stub forge (signature verified against registered pubkey), env attestation shape, failure propagation | no |

The Docker sandbox path (`runInSandbox`) is integration-only — needs the
`widespread-sandbox` image and a docker daemon.

## @widespread/solana

| Command | Scope | Live? |
|---|---|---|
| `pnpm --filter @widespread/solana test` | Intents token list, quote, and status reads with stubbed fetch | no |

## @widespread/bot (GitHub App)

| Command | Scope | Live? |
|---|---|---|
| `pnpm --filter @widespread/bot test` | verdict parser + all webhook handlers (bounty seeding, merge=accept, bot-verdict emission, negative paths) with fake Probot context | no |

## Secrets for live lanes

Hermetic tests need **no secrets**. Live/manual lanes use:

| Secret / credential | Used by |
|---|---|
| `GITHUB_TOKEN` (fine-grained PAT) | bridge writeback/status checks, evidence fetches |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` (+ sandbox flag) | bridge payouts, premium export |
| `~/.widespread-near.json` keypair (testnet) | near live test, contract deploys |
| Solana devnet keypair (gitignored JSON) | solana payout lane |
| Cloudflare API token + account id | `wrangler deploy` / `wrangler d1 migrations` per package |
| GitHub App creds (`APP_ID`, private key) | bot sandbox/dev (`probot run`) |

## CI

`.github/workflows/ci.yml` runs the hermetic suites only (`E2E_LIVE` unset),
gated per package by `dorny/paths-filter` on `packages/<pkg>/**` (and
`packages/protocol/**` when it exists). The heavy delta-git worker suite
(`build:spa` + `test:workers`) runs only on manual `workflow_dispatch`.
