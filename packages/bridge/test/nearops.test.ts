// nearops.test.ts — LIVE tests against NEAR testnet.
// parseNearKey is pure; nearViewCall reads the real wide-mkt contract;
// nearFunctionCall broadcasts a REAL signed TransactionV1 to testnet —
// we call a nonexistent method so the tx executes-and-fails on-chain,
// exercising the full wire path (nonce → block hash → sign → send_tx →
// FINAL) without mutating contract state.

import { describe, expect, it } from "vitest";
import { base58 } from "@scure/base";
import { parseNearKey, nearViewCall, nearFunctionCall } from "../src/nearops";
import { realEnv } from "./helpers";
import type { Env } from "../src/types";

const CONTRACT = "wide-mkt-11561.testnet";

function opsKey(env: Env) {
  return {
    accountId: env.NEAR_OPS_ACCOUNT ?? "",
    secretKey: env.NEAR_OPS_SECRET_KEY ?? "",
  };
}
const HAS_OPS = () => {
  const e = realEnv();
  return Boolean(e.NEAR_OPS_ACCOUNT && e.NEAR_OPS_SECRET_KEY);
};

describe("parseNearKey", () => {
  const raw = new Uint8Array(64).map((_, i) => i);
  const key = `ed25519:${base58.encode(raw)}`;
  it("splits seed||pubkey", () => {
    const { seed, pubkey } = parseNearKey(key);
    expect(seed).toEqual(raw.slice(0, 32));
    expect(pubkey).toEqual(raw.slice(32));
  });
  it("rejects wrong prefix / length", () => {
    expect(() => parseNearKey("sr25519:abc")).toThrow(/ed25519:/);
    expect(() => parseNearKey(`ed25519:${base58.encode(new Uint8Array(10))}`)).toThrow(/64/);
  });
});

describe("nearViewCall (live testnet)", () => {
  it("reads listAll from the real market contract", async () => {
    const out = await nearViewCall(realEnv(), CONTRACT, "listAll", {}) as unknown[];
    expect(Array.isArray(out)).toBe(true);
    // The deployed testnet contract has real markets — at least one.
    expect(out.length).toBeGreaterThan(0);
    const m = out[0] as Record<string, unknown>;
    expect(m).toHaveProperty("marketId");
    expect(m).toHaveProperty("specHash");
  }, 30000);

  it("reads a single market by id", async () => {
    const markets = await nearViewCall(realEnv(), CONTRACT, "listAll", {}) as
      { marketId?: string }[];
    const id = markets[0]?.marketId;
    expect(id).toBeTruthy();
    const m = await nearViewCall(realEnv(), CONTRACT, "getMarket", { marketId: id }) as
      Record<string, unknown> | null;
    expect(m).toBeTruthy();
    expect(String(m!.marketId)).toBe(String(id));
  }, 30000);
});

describe("nearFunctionCall tx wire format (live testnet)", () => {
  it("broadcasts a real signed tx; on-chain failure still returns txHash", { skip: !HAS_OPS() && "NEAR_OPS_ACCOUNT/SECRET_KEY not configured" }, async () => {
    const env = realEnv();
    const r = await nearFunctionCall(env, opsKey(env), CONTRACT, {
      // Nonexistent method → the tx is real, signed, broadcast, and lands
      // as an on-chain failure. Proves the TransactionV1 wire path without
      // creating contract state.
      methodName: "widespreadTestNoSuchMethod",
      args: {},
      gas: 10_000_000_000_000n,
      deposit: 0n,
    });
    expect(r.txHash).toMatch(/^[A-Za-z0-9+/=]{20,}$/);
    // The receipts outcome should reflect the contract-level failure.
    expect(JSON.stringify(r.status)).toMatch(/FAIL|Error|failure/i);
  }, 60000);
});
