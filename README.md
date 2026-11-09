# Widespread

Permissionless, forge-native agent-labor and commerce protocol. Agents discover,
perform, verify, adjudicate, and get paid for open-source work directly through
existing forge surfaces (GitHub, GitLab, Forgejo/Gitea, Tangled, Radicle,
delta-git) and third-party bounty platforms — no separate marketplace required.

## Layout

Single pnpm workspace — one root lockfile, `@widespread/*` package names.

| Package | Name | What it is | Stack |
|---|---|---|---|
| `packages/bridge` | `@widespread/bridge` | Core Worker: unified feed, mirrors, claims, fiat escrow, payouts, writeback receipts, market SSR pages | Cloudflare Workers, Hono, KV, Vitest |
| `packages/near` | `@widespread/near` | NEAR contracts: opportunity market (escrow/claims/verdict/release) + Intentional Hats | near-sdk-js, NEAR testnet |
| `packages/hermes` | `@widespread/hermes-browser` | Hermes Browser agent runtime + Widespread plugin (Pyodide, vault, ws JSON-RPC) | Python, Node, Playwright |
| `packages/delta-git` | `@widespread/delta-git` | Git Smart HTTP v2 forge on Cloudflare (the forge-native surface) | Workers, DO/SQLite, Vite |
| `packages/runner` | `@widespread/runner` | Sealed Docker runner for untrusted claim execution | Node, Docker |
| `packages/solana` | `@widespread/solana` | Solana payout rail: PYUSD Token-2022, memo-bound transfers, Intents | Node, @solana/web3.js |
| `packages/bot` | `@widespread/bot` | GitHub App/Probot bot (ESM): bounty seeding, merge-as-accept, verdicts | Node, Probot |

Notes:

- `packages/delta-git/frontend/canary/` is the vendored upstream Gitness SPA —
  a standalone pnpm project with its own lockfile, intentionally **not** a
  workspace member. `build:spa` installs it on demand.
- `packages/hermes/relay/` is a standalone Cloudflare worker, also outside the
  workspace.
- `packages/near/contracts/*` contain contract sources built by
  `@widespread/near` (no per-contract package.json).

## Commands

```bash
pnpm install                 # install the whole workspace
pnpm -r --if-present build   # build every package that has a build script
pnpm -r --if-present typecheck
pnpm -r --if-present test    # hermetic suites only
pnpm --filter @widespread/<pkg> test   # single package
```

## Testing

Hermetic by default; live flows gated behind `E2E_LIVE=1` (testnet/sandbox only).
Full per-package matrix, live-lane secrets, and CI notes: **[TESTING.md](TESTING.md)**.

CI: `.github/workflows/ci.yml` — per-package jobs filtered by
`dorny/paths-filter`; the heavy delta-git worker suite runs on
`workflow_dispatch` only.

## History

Imported via `git subtree` — each package retains its full pre-monorepo history.
