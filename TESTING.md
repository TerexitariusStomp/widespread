# Widespread — testing matrix

Single pnpm workspace (`pnpm-workspace.yaml`); every package installs from the
root lockfile.

## Live-test architecture (no service mocks)

Tests hit **real services**. There are no `vi.fn`/`vi.mock`/`vi.spyOn`/
`vi.stubGlobal`/`fetchMock`/`fake-indexeddb`/service fakes anywhere in
`packages/*/test`. Where a dependency is genuinely unavailable, the leg is
skipped explicitly via `E2E_LIVE=1` (or credential checks) — never silently
stubbed.

| Package | Real runtime / services under test |
|---|---|
| `bridge` | `@cloudflare/vitest-pool-workers` → real workerd bindings (KV). Live GitHub REST against `TerexitariusStomp/widespread-sandbox` (real issues/PRs/commits created per test), live NEAR testnet RPC + signed transactions, live PayPal sandbox, live delta-git forge `https://code.widespread.fyi` (real Ed25519 dg1 receipts). |
| `near` | `near-workspaces` → real `nearcore` process; tests deploy the **compiled `contract.wasm`** and assert on real chain state. `test/live.test.mjs` additionally runs the market lifecycle on NEAR testnet. |
| `solana` | Live NEAR Intents / 1Click API (real quotes); pure helpers unit-tested directly. Devnet tx legs gated on `E2E_LIVE=1`. |
| `bot` | Real Octokit calls against the GitHub sandbox repo; webhook E2E gated on `E2E_LIVE=1`. Verdict-parser unit tests are pure logic. |
| `runner` | Real delta-git forge `dg/ship` (ephemeral Ed25519 agent registration + signed envelope); real Docker for sandbox containment tests. |
| `delta-git` | `vitest-pool-workers` for `*.worker.test.ts` (real workerd/D1/DO); unit config for pure modules. Live Cloudflare-API legs gated on creds + `E2E_LIVE=1`. |
| `hermes` | Real Chromium via Playwright for browser-native modules; python unittests exercise real logic. |
| `protocol` | Pure vector/signing tests — no service boundary. |

## Quick start

```bash
pnpm install                      # one lockfile for the whole monorepo
pnpm -r --if-present test         # every package's suite (live where creds exist)
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
| `pnpm --filter @widespread/bridge test` | vitest-pool-workers suite — claims/PR evidence via real GitHub, ingest timeline scans, mirror claim/verdict/payout lifecycle, real PayPal order+payout calls, NEAR testnet market reads + signed txs, real forge writeback receipts, feed over real KV, route smoke | yes (GitHub/NEAR/PayPal/forge; see gates) |
| `pnpm --filter @widespread/bridge typecheck` | `tsc --noEmit` | no |
| `E2E_LIVE=1 pnpm --filter @widespread/bridge test` | additionally runs `test/e2e.live.test.ts` against the deployed worker | yes (read-only probes) |
| `node packages/bridge/scripts/e2e-lifecycle.mjs` | flagship demo: fund → claim → verdict → payout → receipt against live sandbox rails | yes |

Notes:

- `vitest.config.ts` parses `wrangler.jsonc`, merges `.dev.vars` + selected
  process env, and writes a generated `.vitest.wrangler.json` so tests run in
  real workerd with real KV bindings (`singleWorker`, `isolatedStorage:
  false`, `remoteBindings: false`).
- The `AI` binding is remote-only; with `remoteBindings: false`, touching
  `env.AI` throws `Binding AI needs to be run remotely`. Adjudication legs
  that need it are gated on `NEAR_AI_API_KEY` / `E2E_LIVE`; `/api/scan` is
  exercised only via route-shape probes, never synchronously (it fans out to
  real adjudication and can run for minutes).
- PayPal buyer-approval/capture legs need a funded sandbox buyer and are
  skipped without `E2E_LIVE`/buyer creds; order-create, payout, and
  NEAR-escrow legs run against the real sandbox.
- `test/helpers.ts` creates real GitHub issues/PRs/branches/commits in the
  sandbox repo — tests leave real artifacts behind by design.

## @widespread/near (NEAR contracts)

| Command | Scope | Live? |
|---|---|---|
| `pnpm --filter @widespread/near test` | `node --test test/*.test.mjs` — near-workspaces sandbox (real nearcore): market create/claim/release/refund/pagination, hats org/tree/assign/foreign-sig/payout, futarchy propose/buy/resolve/redeem, ABI gates vs compiled wasm | local real chain |
| `E2E_LIVE=1 node --test packages/near/test/live.test.mjs` | full market lifecycle on NEAR testnet via near-api-js (`callFunction` + raw query views) | yes (testnet) |
| `pnpm --filter @widespread/near build` | near-sdk-js compile of `contracts/{market,hats,futarchy}` → `build/contract.wasm` | no |

Notes:

- `test/sandbox.mjs` boots one nearcore sandbox per test-file process,
  deploys the real `contract.wasm`, and tears it down in an `after()` hook
  (nearcore otherwise keeps the event loop alive forever).
- Contract calls are sequential where they share an account — concurrent
  txs from one key race on the access-key nonce and degenerate into retry
  storms.
- Release/payout assertions use real recipient accounts; a release can
  return its result object while individual transfer receipts fail if a
  recipient account does not exist — tests assert the contract result and
  receipt behavior separately.
- Requires `~/.widespread-near.json` deploy creds (created by
  `contracts/market/deploy.js`) for the live test and deploys.

## @widespread/hermes-browser

| Command | Scope | Live? |
|---|---|---|
| `pnpm --filter @widespread/hermes-browser test` | node:test vault/NEAR key-custody tests + python unittest (widespread plugin: RFC 8032 ed25519, dg1 envelope; browser_runtime primitives; browser_native via a scripted `py_gateway` transport that exercises the real Python logic) | no |
| `pnpm --filter @widespread/hermes-browser build && pnpm --filter @widespread/hermes-browser smoke` | Playwright smoke on real Chromium: Pyodide backend boot, REST + ws JSON-RPC round-trips, vault/IndexedDB boundary | local browser |

Smoke needs `build` first (vendors hermes-agent, packs Pyodide env, assembles
`dist/`) plus `pnpm --filter @widespread/hermes-browser exec playwright install`.

`packages/hermes/relay` is a standalone Cloudflare worker (not a workspace
member); its e2e (`node scripts/e2e.mjs`) expects `wrangler dev` running on
:8787 — manual only.

## @widespread/delta-git (forge)

| Command | Scope | Live? |
|---|---|---|
| `pnpm --filter @widespread/delta-git test` | node unit tests (`vitest.unit.config.ts`) | no |
| `pnpm --filter @widespread/delta-git test:workers` | worker integration tests (`vitest.config.ts`, vitest-pool-workers) — heavy, many minutes | partially (see gates) |
| `pnpm --filter @widespread/delta-git test:auth` | auth worker subset | no |
| `pnpm --filter @widespread/delta-git test:e2e` | Playwright suite (needs built SPA: `build:spa`) | no |

Live legs inside the worker suite:

- `test/artifacts-subscriptions.test.ts` hits the real Cloudflare API only
  when `CF_ACCOUNT_ID` + `CF_API_TOKEN` are set **and** `E2E_LIVE=1`
  (subscription creation mutates the account); otherwise `it.skipIf` skips.
- `test/federate.worker.test.ts` / `test/notify-email.worker.test.ts` inject
  an outbound `fetch` into the worker under test to exercise federation /
  email-provider request shaping — the worker code path is real; the remote
  peer is the injected transport (no global fetch override, no vi.*).

`frontend/canary` is an upstream pnpm workspace excluded from the root
workspace; `build:spa` auto-installs it when `node_modules` is missing.

Known environment-dependent failures (not regressions): SPA-asset tests 404
when `frontend/canary` was never built, and the CT-log certificate probe
needs live internet.

## @widespread/runner

| Command | Scope | Live? |
|---|---|---|
| `pnpm --filter @widespread/runner test` | `claim.test.mjs` — real ephemeral Ed25519 agent registration + signed `dg-ship-1` POST to `https://code.widespread.fyi` (walks recent upstream commits until the forge returns `verified && ship`); env attestation reports TPM presence honestly; `sandbox.docker.test.mjs` — real Docker containers (sealed rootfs, network-none) | yes (forge + Docker) |

The Docker sandbox path needs the `widespread-sandbox` image and a docker
daemon; without Docker those tests fail loudly rather than skip silently.

## @widespread/solana

| Command | Scope | Live? |
|---|---|---|
| `pnpm --filter @widespread/solana test` | Live NEAR Intents/1Click API: real token list, real signed dry-run quotes, real error propagation, status reads; pure helpers (contentHash, memo ix, keypair codec, PYUSD constants) unit-tested directly | yes (1Click API) |
| `E2E_LIVE=1 pnpm --filter @widespread/solana test` | additionally: devnet keypair load + balance, memo-only tx confirm, `payWithMemo` real PYUSD self-transfer | yes (devnet; needs funded keypair) |

## @widespread/bot (GitHub App)

| Command | Scope | Live? |
|---|---|---|
| `pnpm --filter @widespread/bot test` | Real Octokit/GitHub sandbox: issue seeding, merge→accept flow, bot-review verdicts posting to the real bridge, dedupe paths; verdict parser unit tests are pure logic | yes (GitHub + bridge) |
| `E2E_LIVE=1 pnpm --filter @widespread/bot test` | additionally: signed webhook delivery seeds a real bounty end-to-end | yes |

## @widespread/protocol

| Command | Scope | Live? |
|---|---|---|
| `pnpm --filter @widespread/protocol test` | RFC 8032 / dg1 signing vectors — pure crypto, no service boundary | no |

## Secrets / credentials for live lanes

Default `pnpm -r test` runs **live legs that need no extra setup** (GitHub
sandbox repo, NEAR testnet reads, 1Click API, forge, PayPal sandbox order
legs, nearcore sandbox, Docker). The following unlock the gated legs:

| Secret / credential | Unlocks |
|---|---|
| `GITHUB_TOKEN` (fine-grained PAT) | bridge GitHub calls beyond the anonymous rate limit, writeback commit lookups |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | PayPal sandbox order create / payout legs in bridge |
| `NEAR_AI_API_KEY` | bridge AI adjudication legs (local `AI` binding is remote-only and is never faked) |
| `NEAR_OPS_ACCOUNT` / `NEAR_OPS_SECRET_KEY` | signed NEAR ops (market writes) in bridge nearops |
| `~/.widespread-near.json` keypair (testnet) | near live testnet E2E, contract deploys |
| `packages/solana/.devnet-keypair.json` (funded) | solana devnet `E2E_LIVE` legs |
| `E2E_LIVE=1` | all opt-in live legs above |
| `CF_ACCOUNT_ID` + `CF_API_TOKEN` (real, not `local-placeholder`) | delta-git artifacts-subscription live legs (also needs `E2E_LIVE=1`) |
| `ONECLICK_JWT` | 1Click authenticated quote paths, if required by the API |
| `ATTEST_SECRET`, `DG_AGENT_DID`, `DG_AGENT_KEY_PKCS8_B64` | forge attestation / agent lanes where referenced |
| GitHub App creds (`APP_ID`, private key) | bot `probot run` / webhook E2E |
| Cloudflare API token + account id | `wrangler deploy` / `wrangler d1 migrations` per package |

## CI

`.github/workflows/ci.yml` runs the suites with `E2E_LIVE` unset — live legs
skip explicitly rather than failing. The heavy delta-git worker suite
(`build:spa` + `test:workers`) runs only on manual `workflow_dispatch`.
