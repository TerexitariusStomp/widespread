// poidh.ts — Poidh sponsor-protocol state on Base (read-only).
// Poidh v3 immutable contracts (docs.poidh.xyz/contracts): solo+open
// bounties, ETH payouts, claim-proof NFTs, 2.5% protocol fee, 48h
// contributor voting on multi-funder bounties.
//
// This module only READS live Poidh state (bounty counter + protocol
// params). Creating bounties is a user-wallet operation (POIDH_PRIVATE_KEY
// stays with the payer, never with us) and is not implemented here.

import type { Env } from "./types";

export const POIDH_CHAINS = {
  ethereum: "0xE731dFadBFf20542E10D09D26Fc71445C70d4232",
  arbitrum: "0x5555Fa783936C260f77385b4E153B9725feF1719",
  base: "0x5555Fa783936C260f77385b4E153B9725feF1719",
  degen: "0x18E5585ca7cE31b90Bc8BB7aAf84152857cE243f",
} as const;
export const POIDH_NFT = {
  ethereum: "0x9c5f45d5e1382e4058d334d93c6c01442012a4d9",
  arbitrum: "0x27e117cc9a8da363442e7bd0618939e3eeeacf6a",
  base: "0x27e117cc9a8da363442e7bd0618939e3eeeacf6a",
} as const;

// Function selectors verified live against the Base deployment
// (bountyCounter → 556, MIN_BOUNTY_AMOUNT → 0.001 ETH, votingPeriod → 2d).
const SELECTORS = {
  bountyCounter: "0xa0d59787",
  minBounty: "0xd5670525",
  votingPeriod: "0x02a251a3",
} as const;

const POIDH_RPCS = [
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
  "https://1rpc.io/base",
  "https://base.meowrpc.com",
  "https://mainnet.base.org",
];

async function ethCall(env: Env, to: string, data: string): Promise<{ v: bigint | null; err?: string }> {
  const envRpc = (env as unknown as { POIDH_RPC_URL?: string }).POIDH_RPC_URL;
  const rpcs = envRpc ? [envRpc] : POIDH_RPCS;
  let lastErr = "no rpc";
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const rpc of rpcs) {
      const res = await fetch(rpc, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "poidh", method: "eth_call",
        params: [{ to, data }, "latest"],
      }),
    }).catch((e) => { lastErr = String(e); return null; });
    if (!res) continue;
    const out = await res.json().catch(() => null) as { result?: string; error?: unknown } | null;
    if (out?.result && out.result !== "0x") return { v: BigInt(out.result) };
    if (out?.error) lastErr = JSON.stringify(out.error);
    else lastErr = `http ${res.status}`;
    }
  }
  return { v: null, err: lastErr };
}

/** Live Poidh state on Base — bounty count + protocol params. */
export async function poidhInfo(env: Env) {
  const addr = POIDH_CHAINS.base;
  const [counter, min, voting] = await Promise.all([
    ethCall(env, addr, SELECTORS.bountyCounter),
    ethCall(env, addr, SELECTORS.minBounty),
    ethCall(env, addr, SELECTORS.votingPeriod),
  ]);
  return {
    chain: "base",
    contract: addr,
    nft: POIDH_NFT.base,
    bountyCounter: counter.v?.toString() ?? null,
    minBountyWei: min.v?.toString() ?? null,
    votingPeriodSec: voting.v?.toString() ?? null,
    rpcError: counter.err ?? min.err ?? voting.err ?? undefined,
    feeBps: 250,
  };
}
