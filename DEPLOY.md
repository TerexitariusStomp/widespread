# Deploy — Widespread

## Bridge (`packages/bridge`)

```bash
cd packages/bridge
wrangler deploy                    # uploads + binds all wrangler.jsonc resources
```

Bindings live in `wrangler.jsonc`: KV `CLAIMS` (legacy/fallback), D1 `DB`
(`widespread-bridge-db` — the claim/settlement store via `kv()` in
`src/db.ts`), R2 `QUALITY`, Vectorize `EMBED`, Workers AI, Queue `INGEST_Q`.

### First-time resources (already created on the Widespread account)

```bash
wrangler d1 create widespread-bridge-db          # then put database_id in wrangler.jsonc
wrangler d1 migrations apply widespread-bridge-db --remote
wrangler queues create widespread-ingest
wrangler vectorize create widespread-feed-embed --dimensions=768 --metric=cosine
```

### Optional secrets

```bash
wrangler secret put ERC8004_SIGNER_KEY    # posts rep events to the 8004 Reputation Registry (Base)
wrangler secret put DISPUTE_SIGNER_KEY    # posts disputes to UMA OptimisticOracle (Base)
# + vars: ERC8004_REP_REGISTRY / DISPUTE_OO_ADDRESS / DISPUTE_CURRENCY / RPC URLs in wrangler.jsonc
```

## Futarchy contract (`packages/near/contracts/futarchy`)

```bash
pnpm --filter @widespread/near build     # → contracts/futarchy/build/contract.wasm
pnpm --filter @widespread/near deploy:futarchy   # uses ~/.foreguild-futarchy.json creds
```

Admin state on `foreguild-ft-69240.testnet` (set): `dao=wide-ops-328424.testnet`;
resolvers registered for `feed_match_quality`, `settle_rate`, `contributor_rep_wins`.
The bridge's `resolveExpiredProposals` posts metric attestations as
`ORACLE_ACCOUNT` on every scheduled/queue pass.

## Verification

```bash
curl -s https://widespread-bridge.widespread.workers.dev/api/treasury
curl -s https://widespread-bridge.widespread.workers.dev/api/openapi.json | head
```
