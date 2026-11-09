// erc8004.ts — post rep events to ERC-8004 registries (Base).
//
// Env-gated: when ERC8004_SIGNER_KEY + ERC8004_REP_REGISTRY are set, every
// rep event appended to the local event log is also pushed on-chain via
// the Reputation Registry's giveFeedback(). The local event log remains
// the fast path — posting is fire-and-forget (.catch(() => undefined))
// so a down RPC never blocks a verdict.
//
// Draft-standard ABI (ERC-8004 is pre-final): giveFeedback(uint256
// agentId, uint8 score, string tag1, string tag2, string endpoint,
// string feedbackURI, bytes32 feedbackHash). Actor → agentId mapping:
// we don't run an Identity-Registry registration flow yet, so agentId
// is keccak256(actor) — deterministic and reversible-by-us via the
// local index. Once actors register, swap this for the registry lookup.

import { createWalletClient, http, keccak256, stringToHex, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import type { Env } from "./types";
import type { RepEvent } from "./rep";

const REP_REGISTRY_ABI = [{
  name: "giveFeedback",
  type: "function",
  stateMutability: "nonpayable",
  inputs: [
    { name: "agentId", type: "uint256" },
    { name: "score", type: "uint8" },
    { name: "tag1", type: "string" },
    { name: "tag2", type: "string" },
    { name: "endpoint", type: "string" },
    { name: "feedbackURI", type: "string" },
    { name: "feedbackHash", type: "bytes32" },
  ],
  outputs: [],
}] as const;

const SCORE: Record<RepEvent["kind"], number> = {
  win: 100, merge: 80, paid: 90, funded: 70, reject: 10,
};

function enabled(env: Env): env is Env & {
  ERC8004_SIGNER_KEY: string; ERC8004_REP_REGISTRY: `0x${string}`;
} {
  return !!(env.ERC8004_SIGNER_KEY && env.ERC8004_REP_REGISTRY);
}

/** Fire-and-forget post of a rep event to the 8004 Reputation Registry.
 * Never throws to callers — failures are logged and dropped; the local
 * signed event log is the source of truth the chain record mirrors. */
export async function postRepEvent(env: Env, ev: RepEvent): Promise<void> {
  if (!enabled(env)) return;
  const account = privateKeyToAccount(env.ERC8004_SIGNER_KEY as `0x${string}`);
  const client = createWalletClient({
    account, chain: base,
    transport: http(env.ERC8004_RPC_URL || "https://mainnet.base.org"),
  });
  const agentId = BigInt(keccak256(stringToHex(ev.actor)));
  const exportUrl = `${env.PUBLIC_BASE}/api/rep/${ev.actor.replace(/^github:/, "")}/export`;
  const feedbackHash = keccak256(toHex(JSON.stringify(ev)));
  await client.writeContract({
    address: env.ERC8004_REP_REGISTRY,
    abi: REP_REGISTRY_ABI,
    functionName: "giveFeedback",
    args: [agentId, SCORE[ev.kind] ?? 50, ev.kind, "widespread",
      env.PUBLIC_BASE, exportUrl, feedbackHash],
  });
}
