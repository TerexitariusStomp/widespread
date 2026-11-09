import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env, MirrorListing } from "../src/types";

const feedDocMock = vi.fn();
vi.mock("../src/feed", () => ({ feedDoc: (...a: unknown[]) => feedDocMock(...a) }));
const sendPayoutMock = vi.fn();
vi.mock("../src/payouts", () => ({ sendPayout: (...a: unknown[]) => sendPayoutMock(...a) }));

import {
  handleMirrorClaimPost,
  handleMirrorVerdict, handleMirrorPayout,
} from "../src/mirrorclaims";
import { fakeEnv, fakeKV, fetchRouter, jsonRes } from "./mock";

const MIRROR: MirrorListing = {
  id: "mirror:test:1", record_id: "github-thirdparty:generic:o/r#1",
  title: "t", url: "https://x", repo: "o/r",
  original: { amount: "100", currency: "USD", est_usd: 100 },
  cut_bps: 1000, claimant_share: { est_usd: 90 },
  spec: "s", spec_hash: "sha256:spec",
  createMarketArgs: {}, status: "fiat-funded",
  created_at: 0, updated_at: 0,
};

function envWithFunding(status = "captured") {
  const kv = fakeKV({
    [`fiatfund:${MIRROR.id}`]: JSON.stringify({ mirror_id: MIRROR.id, order_id: "O1",
      amount: "100", currency: "USD", status, created_at: 0 }),
  });
  return fakeEnv({ CLAIMS: kv as unknown as Env["CLAIMS"] });
}

const ghOk = () => fetchRouter([
  ["/issues/12", () => jsonRes({ number: 12, state: "open", title: "t",
    user: { id: 777, login: "bob" } })],
  ["/pulls/12/files", () => jsonRes([{ filename: "a.ts", status: "modified",
    patch: "@@ -1 +1 @@\n-x\n+y" }])],
]);

const post = (body: unknown) => new Request("https://x/api/mirrors/claims", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  feedDocMock.mockResolvedValue({ mirrors: [MIRROR], records: [] });
});

describe("handleMirrorClaimPost", () => {
  it("409s when mirror is not fiat-funded", async () => {
    const env = envWithFunding("created"); // order created, not captured
    const res = await handleMirrorClaimPost(post({ mirror_id: MIRROR.id, forgeRef: "o/r#12" }), env);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/not fiat-funded/);
  });

  it("201s an attested claim on a funded mirror", async () => {
    vi.stubGlobal("fetch", ghOk());
    const env = envWithFunding();
    const res = await handleMirrorClaimPost(post({
      mirror_id: MIRROR.id, forgeRef: "https://github.com/o/r/pull/12",
      payout: { paypal_email: "w@example.com" },
    }), env);
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.attested).toBe(true);
    expect(j.claim.forgeUserId).toBe("777");
    expect(j.claim.evidence.patch_fingerprint).toMatch(/^sha256:/);
  });

  it("422s on forge validation failure", async () => {
    vi.stubGlobal("fetch", fetchRouter([
      ["api.github.com", () => new Response("nf", { status: 404 })],
    ]));
    const env = envWithFunding();
    const res = await handleMirrorClaimPost(post({ mirror_id: MIRROR.id, forgeRef: "o/r#99" }), env);
    expect(res.status).toBe(422);
  });
});

async function fileClaim(env: Env) {
  vi.stubGlobal("fetch", ghOk());
  const res = await handleMirrorClaimPost(post({
    mirror_id: MIRROR.id, forgeRef: "https://github.com/o/r/pull/12",
    payout: { paypal_email: "w@example.com" },
  }), env);
  const j = await res.json();
  return j.claim.claim_hash as string;
}

describe("handleMirrorVerdict", () => {
  it("computes face/cut/net and records settlement", async () => {
    const env = envWithFunding();
    const hash = await fileClaim(env);
    const res = await handleMirrorVerdict(new Request("https://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror_id: MIRROR.id, claim_hash: hash, accept: true,
        payout: { paypal_email: "w@example.com" } }),
    }), env);
    const j = await res.json();
    expect(j.settlement.face_usd).toBe(100);
    expect(j.settlement.platform_cut_usd).toBe(10);
    expect(j.settlement.net_usd).toBe(90);
    expect(j.settlement.paypal_usd.to).toBe("w@example.com");
    expect(j.settlement.status).toBe("won");
  });

  it("is one-shot: second verdict returns already_decided", async () => {
    const env = envWithFunding();
    const hash = await fileClaim(env);
    const mkReq = () => new Request("https://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror_id: MIRROR.id, claim_hash: hash, accept: true }),
    });
    await handleMirrorVerdict(mkReq(), env);
    const res2 = await handleMirrorVerdict(mkReq(), env);
    const j2 = await res2.json();
    expect(j2.status).toBe("already_decided");
  });

  it("rejects unattested claims", async () => {
    const env = envWithFunding();
    // plant an unattested claim directly
    await env.CLAIMS.put(`mclaim:${MIRROR.id}:h1`, JSON.stringify({
      mirror_id: MIRROR.id, claim_hash: "h1", attested: false, status: "pending",
    }));
    const res = await handleMirrorVerdict(new Request("https://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror_id: MIRROR.id, claim_hash: "h1" }),
    }), env);
    expect(res.status).toBe(409);
  });
});

describe("handleMirrorPayout", () => {
  it("409s with no settlement", async () => {
    const res = await handleMirrorPayout(new Request("https://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror_id: MIRROR.id }),
    }), envWithFunding());
    expect(res.status).toBe(409);
  });

  it("pays via PayPal Payouts when winner gave email", async () => {
    const env = envWithFunding();
    const hash = await fileClaim(env);
    await handleMirrorVerdict(new Request("https://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror_id: MIRROR.id, claim_hash: hash, accept: true,
        payout: { paypal_email: "w@example.com" } }),
    }), env);
    sendPayoutMock.mockResolvedValue({ attempted: true, batch_id: "B1",
      transaction_id: "T1", sandbox: true });
    const res = await handleMirrorPayout(new Request("https://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror_id: MIRROR.id }),
    }), env);
    const j = await res.json();
    expect(j.settlement.payout.rail).toBe("paypal-payouts");
    expect(j.settlement.payout.batch_id).toBe("B1");
    expect(sendPayoutMock).toHaveBeenCalledOnce();
  });

  it("dedupes: second payout returns already_paid", async () => {
    const env = envWithFunding();
    const hash = await fileClaim(env);
    await handleMirrorVerdict(new Request("https://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror_id: MIRROR.id, claim_hash: hash, accept: true,
        payout: { paypal_email: "w@example.com" } }),
    }), env);
    sendPayoutMock.mockResolvedValue({ attempted: true, batch_id: "B1" });
    const mkReq = () => new Request("https://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror_id: MIRROR.id }),
    });
    await handleMirrorPayout(mkReq(), env);
    sendPayoutMock.mockClear();
    const res2 = await handleMirrorPayout(mkReq(), env);
    const j2 = await res2.json();
    expect(j2.status).toBe("already_paid");
    expect(sendPayoutMock).not.toHaveBeenCalled();
  });

  it("409s when the winner gave no PayPal email", async () => {
    const env = envWithFunding();
    const hash = await fileClaim(env);
    await handleMirrorVerdict(new Request("https://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror_id: MIRROR.id, claim_hash: hash, accept: true,
        payout: {} }),
    }), env);
    const res = await handleMirrorPayout(new Request("https://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror_id: MIRROR.id }),
    }), env);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/paypal_email/);
  });
});
