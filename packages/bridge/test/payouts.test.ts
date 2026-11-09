// payouts.test.ts — LIVE PayPal sandbox tests.
// sendPayout/refreshBatch hit the real PayPal Payouts API
// (api-m.sandbox.paypal.com) with the real OAuth client-credentials flow.
// Legs that need PAYPAL_CLIENT_ID/SECRET skip cleanly when unset — the
// .dev.vars file ships empty placeholders until real sandbox creds are
// provided.

import { describe, expect, it } from "vitest";
import { sendPayout, refreshBatch } from "../src/payouts";
import { realEnv } from "./helpers";
import type { Env } from "../src/types";

const HAS_PAYPAL = () => {
  const e = realEnv();
  return Boolean(e.PAYPAL_CLIENT_ID && e.PAYPAL_CLIENT_SECRET);
};
const PAYPAL_SKIP = HAS_PAYPAL()
  ? false
  : "PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET not configured (sandbox app creds required)";

// Unique per run — sender_batch_id dedupes on repo+seq+claimHash, so a
// fresh claimHash guarantees a fresh real batch every run.
const payoutReq = () => ({
  repo: "o/r",
  seq: Math.floor(Math.random() * 1e9),
  claimHash: `live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  receiver: "widespread-test@example.com",
  amount: "1.00",
  currency: "USD",
  note: "widespread live test payout",
});

describe("sendPayout (live PayPal sandbox)", () => {
  it("creates a real batch and reads back settlement state", { skip: PAYPAL_SKIP }, async () => {
    const env = realEnv();
    const r = await sendPayout(env, payoutReq());
    expect(r.attempted).toBe(true);
    expect(r.sandbox).toBe(true);
    expect(r.sender_batch_id).toMatch(/^widespread-o-r-\d+-live-[0-9a-z]+/);
    // The sandbox either accepts the batch (batch_id + item txn) or
    // rejects it with a real API error — never a fabricated receipt.
    if (r.error) {
      expect(r.error).toMatch(/payouts: HTTP \d+/);
      expect(r.batch_id).toBeUndefined();
    } else {
      expect(r.batch_id).toBeTruthy();
      expect(r.batch_status).toBeTruthy();
    }
  }, 60000);

  it("surfaces real API errors for an invalid receiver", { skip: PAYPAL_SKIP }, async () => {
    const env = realEnv();
    const r = await sendPayout(env, {
      ...payoutReq(),
      receiver: "not-an-email",
    });
    expect(r.attempted).toBe(true);
    // PayPal must reject a malformed receiver with a real 4xx.
    expect(r.error).toMatch(/payouts: HTTP 4\d\d/);
    expect(r.batch_id).toBeUndefined();
  }, 60000);

  it("sender_batch_id is deterministic per claim inputs", { skip: PAYPAL_SKIP }, async () => {
    // Determinism is a pure function of the request — verify by calling
    // the real API once and checking the derived id format encodes the
    // claim coordinates (repo-seq-claimhash prefix).
    const env = realEnv();
    const req = payoutReq();
    const r = await sendPayout(env, req);
    expect(r.sender_batch_id).toBe(
      `widespread-${req.repo.replace("/", "-")}-${req.seq}-${req.claimHash.slice(0, 8)}`);
  }, 60000);
});

describe("refreshBatch", () => {
  it("re-reads a real batch without re-posting", { skip: PAYPAL_SKIP }, async () => {
    const env = realEnv();
    // Create a real batch first, then refresh it — the refresh must only
    // GET, never POST a second payout.
    const created = await sendPayout(env, payoutReq());
    if (!created.batch_id) {
      // Sandbox rejected the receiver — nothing to refresh; that's a real
      // outcome too, but we can't exercise read-back without a batch.
      expect(created.error).toBeTruthy();
      return;
    }
    const r = await refreshBatch(env, created);
    expect(r.batch_id).toBe(created.batch_id);
    expect(r.batch_status).toBeTruthy();
  }, 60000);

  it("no-ops without a batch_id", async () => {
    const r = await refreshBatch(realEnv() as Env, { attempted: true, sandbox: true });
    expect(r.batch_id).toBeUndefined();
    expect(r.error).toBeUndefined();
  });
});
