// nearops.ts — NEAR ops-account client for the bridge, on near-api-js v7.
//
// Replaces the hand-rolled borsh/RPC signer: JsonRpcProvider carries all
// JSON-RPC traffic (view calls, access-key nonce + block-hash lookups,
// send_tx), Account + the ed25519:<base58> secret key handle signing.
// The escrow state machine stays in fiat.ts — this module is transport only.
//
// Key format: NEAR secret keys are `ed25519:<base58>` where the decoded
// 64 bytes = 32-byte seed || 32-byte public key.

import {
  JsonRpcProvider,
  KeyPairSigner,
  actions,
  baseDecode,
  createTransaction,
} from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { base58 } from "@scure/base";
import { OneClickService, OpenAPI } from "@defuse-protocol/one-click-sdk-typescript";
import axios from "axios";

// The 1Click SDK is generated-code axios; force the fetch adapter so the
// same code path runs in the Worker, in Node, and under tests that stub
// globalThis.fetch (axios's default Node adapter bypasses fetch stubs).
axios.defaults.adapter = "fetch";

export interface NearOpsKey {
  accountId: string;   // ops account id (NEAR_OPS_ACCOUNT)
  secretKey: string;   // ed25519:<base58>
}

export interface FunctionCallSpec {
  methodName: string;
  args: Record<string, unknown>;
  gas: bigint;       // yoctoGas
  deposit: bigint;   // yoctoNEAR
}

const rpcUrl = (env: { NEAR_RPC_URL?: string }) =>
  env.NEAR_RPC_URL ?? "https://near-testnet.drpc.org";

/** Single-attempt provider — the old hand-rolled client never retried,
 * and the escrow reconciler depends on fast failure over silent retries. */
function provider(env: { NEAR_RPC_URL?: string }): JsonRpcProvider {
  return new JsonRpcProvider({ url: rpcUrl(env) }, { retries: 1, wait: 0 });
}

/** Validate + split an `ed25519:<base58>` NEAR secret key (64B seed||pub). */
export function parseNearKey(secretKey: string): { seed: Uint8Array; pubkey: Uint8Array } {
  const m = secretKey.match(/^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/);
  if (!m) throw new Error("NEAR_OPS_SECRET_KEY must be ed25519:<base58>");
  let raw: Uint8Array;
  try {
    raw = base58.decode(m[1]);
  } catch {
    throw new Error("NEAR_OPS_SECRET_KEY is not valid base58");
  }
  if (raw.length !== 64) throw new Error(`near key decoded to ${raw.length}B, expected 64`);
  return { seed: raw.slice(0, 32), pubkey: raw.slice(32) };
}

/** Sign + broadcast a FunctionCall tx from the ops account via near-api-js.
 * Returns the tx hash + receipts outcome status (same shape the escrow
 * reconciler inspects). */
export async function nearFunctionCall(
  env: { NEAR_RPC_URL?: string },
  ops: NearOpsKey,
  contractId: string,
  call: FunctionCallSpec,
): Promise<{ txHash: string; status: unknown }> {
  parseNearKey(ops.secretKey); // fail fast on malformed keys before any RPC
  const rpc = provider(env);
  const signer = KeyPairSigner.fromSecretKey(ops.secretKey as KeyPairString);
  const publicKey = await signer.getPublicKey();
  // Account.callFunction* emits classic (V0) transactions, which nearcore
  // rejects — near-api-js only builds TransactionV1 for gas-key nonces.
  // Compose the primitives instead: nonce from view_access_key, block hash
  // from the finalized head, then createTransaction(..., "monotonic") which
  // serializes the 0x01-prefixed V1 wire format the network requires.
  const [{ nonce }, block] = await Promise.all([
    rpc.viewAccessKey({
      accountId: ops.accountId,
      publicKey,
      finalityQuery: { finality: "final" },
    }),
    rpc.viewBlock({ finality: "final" }),
  ]);
  const tx = createTransaction(
    ops.accountId,
    publicKey,
    contractId,
    nonce + 1n,
    [actions.functionCall(call.methodName, call.args, call.gas, call.deposit)],
    baseDecode(block.header.hash),
    undefined,
    "monotonic",
  );
  const { signedTransaction } = await signer.signTransaction(tx);
  // Public gateways 408/timeout on server-side long polls (send_tx
  // wait_until FINAL/EXECUTED), so broadcast async and poll tx status
  // ourselves with wait_until NONE. viewTransactionStatus can transiently
  // return UNKNOWN_TRANSACTION right after broadcast — retry through it.
  // send_tx wait_until NONE returns only {"final_execution_status":"NONE"}
  // — no hash — so compute the tx hash locally: base58(SHA-256(borsh(tx))).
  const txBytes = signedTransaction.transaction.encode();
  const hashBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", txBytes));
  const txHash = base58.encode(hashBytes);
  await rpc.sendTransactionAsync(signedTransaction);
  interface TxStatusResponse {
    receipts_outcome?: { outcome?: { status?: unknown } }[];
    status?: unknown;
  }
  const deadline = Date.now() + 30_000;
  let res: TxStatusResponse | null = null;
  while (Date.now() < deadline) {
    try {
      res = (await rpc.viewTransactionStatusWithReceipts({
        txHash,
        accountId: ops.accountId,
        waitUntil: "NONE",
      })) as unknown as TxStatusResponse;
    } catch {
      res = null; // UNKNOWN_TRANSACTION — not yet visible; keep polling
    }
    const st = res?.status;
    if (st !== "NotStarted" && st !== "Started" && st !== undefined) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  const status =
    res?.receipts_outcome?.map((r) => r?.outcome?.status ?? r) ?? res?.status ?? res;
  return { txHash, status };
}

/** Read-only contract call — returns the JSON-parsed result (null when the
 * method returns empty bytes, matching the old JSON.parse-on-bytes path's
 * callers' `.catch(() => null)` tolerance). */
export async function nearViewCall(
  env: { NEAR_RPC_URL?: string },
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await provider(env).callFunction({
    contractId,
    method: methodName,
    args,
    blockQuery: { finality: "final" },
  });
  return result ?? null;
}

/** NEAR price in USD from the Intents token list (wNEAR on near chain) —
 * 1Click Swap API via the official SDK. Quote/token reads are
 * unauthenticated; ONECLICK_JWT is only needed for authenticated routes. */
export async function nearPriceUsd(env?: { ONECLICK_JWT?: string }): Promise<number | null> {
  try {
    if (env?.ONECLICK_JWT) OpenAPI.TOKEN = env.ONECLICK_JWT;
    const list = await OneClickService.getTokens();
    const wnear = list.find((t) => t.blockchain === "near" && t.symbol === "wNEAR");
    return wnear?.price ?? null;
  } catch {
    return null;
  }
}
