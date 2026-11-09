// fiat.test.ts — tryOpsEscrow against the REAL NEAR testnet + REAL 1Click
// price API + REAL KV escrowstate records.
//
// Live legs (always on): config/price skips, confirmed-state short-circuit,
// on-chain specHash reconciliation (read-only), pending-window refusal.
//
// State-mutating leg (E2E_LIVE=1 only): the full escrow broadcast calls
// createMarket on wide-mkt-11561.testnet with a REAL NEAR deposit from the
// ops account — gated because it spends real testnet NEAR and creates a
// real market.

import { describe, expect, it } from "vitest";
import { tryOpsEscrow, getFiatFunding } from "../src/fiat";
import { nearViewCall } from "../src/nearops";
import { realEnv } from "./helpers";
import type { Env, MirrorListing } from "../src/types";
import { kv } from "../src/db";

const LIVE = process.env.E2E_LIVE === "1";
const stamp = Date.now().toString(36);

const mirror = (over: Partial<MirrorListing> = {}): MirrorListing => ({
  id: `mirror:fiat-test:${stamp}-${Math.random().toString(36).slice(2, 8)}`,
  record_id: "github-thirdparty:generic:o/r#1",
  title: "t", url: "https://x", repo: "o/r",
  original: { amount: "10", currency: "USD", est_usd: 10 },
  cut_bps: 1000, claimant_share: { est_usd: 9 },
  spec: "s", spec_hash: `sha256:fiat-${stamp}`,
  createMarketArgs: {
    specHash: `sha256:fiat-${stamp}`, spec: "s", deadline: null,
    acceptanceRule: "best", platformBps: 1000, platformTo: "widespread-dao.near",
  },
  status: "fiat-funded", created_at: 0, updated_at: 0,
  ...over,
});

/** Env with NEAR ops creds stripped — exercises the config-skip path
 * without touching the network. */
const noOpsEnv = () => ({
  ...realEnv(),
  NEAR_OPS_ACCOUNT: "", NEAR_OPS_SECRET_KEY: "", NEAR_CONTRACT: "",
}) as Env;

const escrowStateKey = (id: string) => `escrowstate:${id}`;

describe("tryOpsEscrow", () => {
  it("skips cleanly without ops config", async () => {
    const r = await tryOpsEscrow(noOpsEnv(), mirror()) as Record<string, unknown>;
    expect(String(r.skipped)).toMatch(/NEAR_OPS/);
  });

  it("skips when mirror has no USD price", async () => {
    const r = await tryOpsEscrow(realEnv(), mirror({
      original: { amount: "10", currency: "NEAR" },
    })) as Record<string, unknown>;
    expect(String(r.skipped)).toMatch(/USD price/);
  });

  it("returns already:true for a confirmed prior attempt (real KV, no chain call)", async () => {
    const e = realEnv();
    const m = mirror();
    await kv(e).put(escrowStateKey(m.id), JSON.stringify({
      mirror_id: m.id, status: "confirmed", usd: "10",
      near_price: 3.5, near_amount: "2.857", deposit_yocto: "2857",
      txHash: `live-test-${stamp}`, marketId: "15", attempts: 1, updated_at: Date.now(),
    }));
    const r = await tryOpsEscrow(e, m) as Record<string, unknown>;
    expect(r).toMatchObject({ escrowed: true, already: true, market_id: "15" });
  });

  it("reconciles against the REAL chain when the specHash already has a market", async () => {
    const e = realEnv();
    const contract = e.NEAR_CONTRACT ?? "wide-mkt-11561.testnet";
    // Read a real specHash off the live contract — no fabricated state.
    const markets = await nearViewCall(e, contract, "listAll", {}) as
      { marketId?: string; specHash?: string }[];
    const hit = markets.find((m) => m?.specHash && m?.marketId);
    expect(hit, "testnet contract has no markets to reconcile against").toBeTruthy();

    const m = mirror();
    (m.createMarketArgs as Record<string, unknown>).specHash = hit!.specHash;
    const r = await tryOpsEscrow(e, m) as Record<string, unknown>;
    expect(r).toMatchObject({ escrowed: true, reconciled: true, market_id: hit!.marketId });
    // The confirmed state was written to real KV.
    const state = await kv(e).get(escrowStateKey(m.id), "json") as
      { status?: string; marketId?: string } | null;
    expect(state?.status).toBe("confirmed");
    expect(state?.marketId).toBe(hit!.marketId);
  }, 60000);

  it("refuses to stack broadcasts inside the pending window", async () => {
    const e = realEnv();
    const m = mirror(); // specHash guaranteed absent on-chain (unique per run)
    await kv(e).put(escrowStateKey(m.id), JSON.stringify({
      mirror_id: m.id, status: "pending", usd: "10",
      near_price: 3.5, near_amount: "2.857", deposit_yocto: "2857",
      txHash: `inflight-${stamp}`, attempts: 1, updated_at: Date.now(),
    }));
    const r = await tryOpsEscrow(e, m) as Record<string, unknown>;
    expect(String(r.pending)).toMatch(/unresolved/);
  }, 60000);

  it("full escrow broadcast: REAL createMarket + REAL NEAR deposit", {
    skip: !LIVE && "E2E_LIVE=1 required — this broadcasts a real createMarket tx and spends real testnet NEAR",
  }, async () => {
    const e = realEnv();
    const m = mirror(); // unique specHash → fresh market every run
    const r = await tryOpsEscrow(e, m) as Record<string, unknown>;
    // Real outcomes only: either the market confirmed on-chain, or the tx
    // failed/pended with the state recorded in real KV.
    const state = await kv(e).get(escrowStateKey(m.id), "json") as
      { status?: string; marketId?: string; txHash?: string } | null;
    expect(state, "escrowstate record missing").toBeTruthy();
    expect(state!.status).toMatch(/confirmed|pending|failed/);
    if (r.escrowed === true) {
      expect(r.market_id).toBeTruthy();
      expect(r.txHash).toBeTruthy();
    } else {
      expect(String(r.error ?? r.note ?? "")).toBeTruthy();
    }
  }, 120000);
});

describe("getFiatFunding (real KV)", () => {
  it("returns null for unfunded mirror", async () => {
    expect(await getFiatFunding(realEnv(), `mirror:none-${stamp}`)).toBeNull();
  });

  it("round-trips a real fiatfund record", async () => {
    const e = realEnv();
    const id = `mirror:fiat-test:funding-${stamp}`;
    await kv(e).put(`fiatfund:${id}`, JSON.stringify({
      mirror_id: id, order_id: "O1", amount: "10", currency: "USD",
      status: "captured", created_at: Date.now(),
    }));
    const f = await getFiatFunding(e, id);
    expect(f?.status).toBe("captured");
    expect(f?.order_id).toBe("O1");
  });
});
