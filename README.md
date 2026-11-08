# widespread-solana

PYUSD bounty settlement on Solana — the Encode/Aurora leg of the
widespread verified-work protocol.

A bounty market locks **PYUSD** (PayPal's own dollar, Token-2022 on Solana)
in an escrow keypair. When the bridge verdict accepts a claim, the release
sends PYUSD **plus a `sha256(claim | verdict)` memo in the same transaction**
— the payout and its audit anchor are one atomic on-chain record. Nothing is
mocked: every receipt resolves on devnet explorer.

## Run

```bash
npm i
node src/demo.js          # dry run — prints the escrow + what it would send
```

### Go live on devnet (~2 min)

1. `node src/demo.js` → copy the printed `escrow` address
2. Fund it with devnet SOL at https://faucet.solana.com (gas only)
3. Fund it with devnet PYUSD at the Google Cloud Web3 faucet
   (mint `CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM`)
4. `CONTRIBUTOR=<recipient-address> DRY=0 node src/demo.js`
   → prints `anchor sig`, `payout sig`, and an explorer link for the receipt

## Why it matters

- **PYUSD is PayPal's regulated dollar on-chain** — the same asset at
  market funding and at settlement; PayPal Payouts stays the fiat off-ramp.
- **Solana is the integrity layer**: content-hash anchors bind
  repo SHA → attestation → payout into permanent on-chain evidence.
- **No platform custody**: the escrow is a plain keypair; release conditions
  are enforced by code, not by an operator. Aurora Intents settles the
  contributor on any chain they choose.
