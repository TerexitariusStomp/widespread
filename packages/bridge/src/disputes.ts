// disputes.ts — optimistic-oracle dispute escalation (UMA OO / Kleros-shaped).
//
// Subjective classes (payer-accept, oracle-metric challenges) need an
// escalation path beyond "trust the bridge": post the disputed outcome
// as an optimistic-oracle assertion — bonded, challengeable inside a
// liveness window, resolved by the oracle's game theory, not ours.
//
// Env-gated like erc8004: DISPUTE_SIGNER_KEY + DISPUTE_OO_ADDRESS enable
// on-chain posting; without them /api/disputes still records the dispute
// locally (a payer can always escalate manually — the record is the thing).
//
// UMA OptimisticOracleV3 ABI surface (assertTruth + getAssertion):
// draft-stable; liveness/bond are market-configurable params.

import { createWalletClient, http, toHex, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import type { Env } from "./types";
import { kv } from "./db";

const OO_ABI = [{
  name: "assertTruth",
  type: "function",
  stateMutability: "nonpayable",
  inputs: [
    { name: "claim", type: "bytes" },
    { name: "asserter", type: "address" },
    { name: "callbackRecipient", type: "address" },
    { name: "sovereignSecurityManager", type: "address" },
    { name: "currency", type: "address" },
    { name: "bond", type: "uint256" },
    { name: "liveness", type: "uint256" },
    { name: "identifier", type: "bytes32" },
  ],
  outputs: [{ name: "assertionId", type: "bytes32" }],
}] as const;

export interface Dispute {
  id: string;
  mirror_id?: string; claim_hash?: string;
  assertion: string;         // human-readable disputed outcome
  disputer: string;
  at: number;
  status: "recorded" | "asserted" | "resolved";
  assertion_id?: string;     // on-chain id when posted
}

const key = (id: string) => `dispute:${id}`;

function enabled(env: Env): env is Env & {
  DISPUTE_SIGNER_KEY: string; DISPUTE_OO_ADDRESS: `0x${string}`;
} {
  return !!(env.DISPUTE_SIGNER_KEY && env.DISPUTE_OO_ADDRESS);
}

/** Record + optionally escalate a dispute to the optimistic oracle.
 * Returns the dispute record — assertion_id set when posted on-chain. */
export async function fileDispute(env: Env, d: Omit<Dispute, "id" | "at" | "status">): Promise<Dispute> {
  const dispute: Dispute = {
    id: crypto.randomUUID(), at: Date.now(), status: "recorded", ...d,
  };
  await kv(env).put(key(dispute.id), JSON.stringify(dispute));

  if (enabled(env)) {
    try {
      const account = privateKeyToAccount(env.DISPUTE_SIGNER_KEY as `0x${string}`);
      const client = createWalletClient({
        account, chain: base,
        transport: http(env.DISPUTE_RPC_URL || "https://mainnet.base.org"),
      });
      const bond = BigInt(env.DISPUTE_BOND_WEI ?? "1000000000000000000"); // 1 default-currency unit
      const liveness = BigInt(env.DISPUTE_LIVENESS_S ?? "86400");         // 24h challenge window
      const claimBytes = toHex(dispute.assertion);
      const identifier = keccak256(toHex(`widespread:${dispute.id}`));
      const tx = await client.writeContract({
        address: env.DISPUTE_OO_ADDRESS,
        abi: OO_ABI,
        functionName: "assertTruth",
        args: [claimBytes, account.address, account.address,
          account.address /* SSM: default sovereign security */,
          (env.DISPUTE_CURRENCY ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
          bond, liveness, identifier],
      });
      dispute.status = "asserted";
      dispute.assertion_id = tx;
      await kv(env).put(key(dispute.id), JSON.stringify(dispute));
    } catch (e) {
      // posting failure doesn't lose the dispute — it stays "recorded"
      console.error(`dispute: assertTruth failed: ${String(e)}`);
    }
  }
  return dispute;
}

export async function getDispute(env: Env, id: string): Promise<Dispute | null> {
  const raw = await kv(env).get(key(id)).catch(() => null);
  return raw ? JSON.parse(raw) as Dispute : null;
}
