import { describe, expect, it, vi, beforeEach } from "vitest";
import { sendPayout, refreshBatch } from "../src/payouts";
import { fakeEnv, fetchRouter, jsonRes } from "./mock";

const env = () => fakeEnv({
  PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com",
  PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "sec",
});

const payoutReq = {
  repo: "o/r", seq: 3, claimHash: "abcdef1234567890",
  receiver: "w@example.com", amount: "90.00", currency: "USD",
  note: "test payout",
};

const paypalRoutes = (opts: { batchStatus?: string; txnStatus?: string; failCreate?: number } = {}) =>
  fetchRouter([
    ["/v1/oauth2/token", () => jsonRes({ access_token: "tok", expires_in: 30000 })],
    ["/v1/payments/payouts/", () => jsonRes({
      batch_header: { payout_batch_id: "BATCH9", batch_status: opts.batchStatus ?? "PENDING" },
      items: [{ payout_item_id: "I1", transaction_id: "TXN9",
        transaction_status: opts.txnStatus ?? "SUCCESS", receiver: "w@example.com" }],
    })],
    ["/v1/payments/payouts", () => opts.failCreate
      ? new Response(JSON.stringify({ name: "UNPROCESSABLE", message: "bad receiver" }),
          { status: opts.failCreate, headers: { "content-type": "application/json" } })
      : jsonRes({
          batch_header: { payout_batch_id: "BATCH9", batch_status: "PENDING" },
          links: [{ rel: "self", href: "https://x" }],
        }, 201)],
  ]);

beforeEach(() => vi.unstubAllGlobals());

describe("sendPayout", () => {
  it("creates batch, reads back transaction id", async () => {
    vi.stubGlobal("fetch", paypalRoutes());
    const r = await sendPayout(env(), payoutReq);
    expect(r.attempted).toBe(true);
    expect(r.sandbox).toBe(true);
    expect(r.batch_id).toBe("BATCH9");
    expect(r.transaction_id).toBe("TXN9");
    expect(r.sender_batch_id).toBe("slopcash-o-r-3-abcdef12");
  });

  it("deterministic sender_batch_id — same claim retries dedupe", async () => {
    vi.stubGlobal("fetch", paypalRoutes());
    const a = await sendPayout(env(), payoutReq);
    const b = await sendPayout(env(), payoutReq);
    expect(a.sender_batch_id).toBe(b.sender_batch_id);
  });

  it("returns error receipt on HTTP failure (never throws)", async () => {
    vi.stubGlobal("fetch", paypalRoutes({ failCreate: 422 }));
    const r = await sendPayout(env(), payoutReq);
    expect(r.error).toMatch(/payouts: HTTP 422/);
    expect(r.batch_id).toBeUndefined();
  });

  it("returns error receipt on network throw", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("socket hangup"); });
    const r = await sendPayout(env(), payoutReq);
    expect(r.error).toMatch(/socket hangup/);
  });
});

describe("refreshBatch", () => {
  it("re-reads settlement state without re-posting", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.includes("oauth2")) return jsonRes({ access_token: "t", expires_in: 30000 });
      return jsonRes({ batch_header: { payout_batch_id: "B1", batch_status: "SUCCESS" },
        items: [{ transaction_id: "T9", transaction_status: "SUCCESS" }] });
    });
    const r = await refreshBatch(env(), {
      attempted: true, sandbox: true, batch_id: "B1", batch_status: "PENDING",
    });
    expect(r.batch_status).toBe("SUCCESS");
    expect(r.transaction_id).toBe("T9");
    expect(calls.filter((u) => u.includes("/v1/payments/payouts") && !u.includes("oauth"))).toHaveLength(1);
    // accessToken may be cached from earlier tests in this file — assert
    // refreshBatch only re-reads, never re-POSTs a payout batch.
    expect(calls.filter((u) => u.endsWith("/v1/payments/payouts"))).toHaveLength(0);
  });

  it("no-ops without a batch_id", async () => {
    const r = await refreshBatch(env(), { attempted: true, sandbox: true });
    expect(r.batch_id).toBeUndefined();
  });
});
