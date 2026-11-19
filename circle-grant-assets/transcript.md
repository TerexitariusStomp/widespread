# Video transcript — Widespread × Circle USDC escrow on Arc testnet

## Circle products used and where they appear in code

**USDC** (native Arc gas token + ERC-20 predeploy `0x3600000000000000000000000000000000000000`):
- `contracts/circle-escrow/WidespreadEscrow.sol` — `IERC20 usdc` (line ~28, constructor arg); `usdc.transferFrom(funder → escrow)` in `create()` (line ~63); `usdc.transfer(escrow → worker)` in `payout()` (line ~73) and `resolveDispute()` (line ~92); `usdc.transfer(escrow → funder)` in `refund()` (line ~99).
- `contracts/circle-escrow/demo.mjs` — USDC address constant; `balanceOf` reads before/after; `approve` tx; explorer links per tx.

## 00:00–02:00 — Codebase walkthrough
Shows WidespreadEscrow.sol: the Bounty struct (funder, worker, USDC amount, deadline, state), the five-state lifecycle, the four Circle/USDC touchpoints listed above, and the dispute lane that routes to arbitration (Kleros `WidespreadArbitrable` on Celo mainnet in production; verifier-arbiter on testnet).

## 02:00–04:30 — Live integration demonstration
`node demo.mjs` on Arc testnet (chain 5042002), all transactions visible on https://explorer.testnet.arc.io:
1. Deploy `WidespreadEscrow(USDC, verifier)` → contract `0xc48b12942255039a80e7228d60b8d4d0c7e41407`
2. `approve` — funder approves escrow for 10 USDC (tx 0x97392d74…)
3. `create` — funder escrows 5 USDC bounty bound to worker `0xd4cb…5544` (tx 0x64ef544a…)
4. `payout` — verifier releases escrow after work verification → worker receives 5 USDC (tx 0x13c725db…)
5. `create` + `dispute` — second bounty, claim disputed (txs 0x044d7676…, 0xe83b16c0…)
6. `resolveDispute(payWorker=false)` — ruling returns escrow to funder (tx 0xabecd3fa…)

Final state: worker +10 USDC across two demo runs; all steps verifiable independently on the Arc testnet explorer.
