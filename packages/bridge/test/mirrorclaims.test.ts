// mirrorclaims.test.ts — LIVE claim/verdict/payout lifecycle.
// Mirrors live in the real KV feed doc (seeded via feedstore), funding
// records are real KV keys, and claims validate REAL GitHub PRs in the
// sandbox repo through the production forge-artifact pipeline. The payout
// leg calls the REAL PayPal Payouts API — with sandbox creds configured it
// creates a real batch; without them it records the real rail error.
// Nothing is mocked.

import { describe, expect, it } from "vitest";
import type { Env, MirrorListing } from "../src/types";
import {
  handleMirrorClaimPost, handleMirrorVerdict, handleMirrorPayout,
} from "../src/mirrorclaims";
import {
  realEnv, createIssue, createPr, seedFeedDoc, sandboxMirror, SANDBOX,
} from "./helpers";
import { ghHeaders, GH_API } from "../src/forge";

const stamp = Date.now().toString(36);
const env = () => realEnv();

interface TimelineEvent {
  event?: string;
  source?: { issue?: { number?: number; pull_request?: unknown; state?: string } };
}

async function ghGet<T>(path: string): Promise<T> {
  const res = await fetch(`${GH_API}${path}`, { headers: ghHeaders(env()) });
  if (!res.ok) throw new Error(`github GET ${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function waitForCrossRef(issueNumber: number, prNumber: number): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const events = await ghGet<TimelineEvent[]>(
      `/repos/${SANDBOX.owner}/${SANDBOX.repo}/issues/${issueNumber}/timeline?per_page=100`);
    if (events.some((e) =>
      e.event === "cross-referenced" && e.source?.issue?.number === prNumber
      && e.source.issue.pull_request && e.source.issue.state === "open")) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("cross-referenced event never appeared");
}

/** Seed a funded mirror whose record_id points at a REAL sandbox issue,
 * plus a REAL PR that references it (for claim filing). */
async function liveMirror(opts: { fundStatus?: string } = {}): Promise<{
  mirror: MirrorListing; mirrorId: string; issueNumber: number; pr: { number: number };
}> {
  const e = env();
  const issue = await createIssue(e, `mirrorclaims fixture issue ${stamp}`);
  const pr = await createPr(e, {
    title: `mirrorclaims fixture PR ${stamp}`,
    body: `Refs ${SANDBOX.owner}/${SANDBOX.repo}#${issue.number}`,
  });
  await waitForCrossRef(issue.number, pr.number);

  const recordId = `github-thirdparty:generic:${SANDBOX.owner}/${SANDBOX.repo}#${issue.number}`;
  const mirror = sandboxMirror({
    recordId, title: `mirrorclaims bounty ${stamp}`, estUsd: 100,
  });
  mirror.id = `mirror:mc-test:${stamp}-${Math.random().toString(36).slice(2, 8)}`;
  mirror.original = { amount: "100", currency: "USD", est_usd: 100 };
  mirror.cut_bps = 1000;
  mirror.claimant_share = { est_usd: 90 };
  await seedFeedDoc(e, [], [mirror]);
  const status = opts.fundStatus ?? "captured";
  await e.CLAIMS.put(`fiatfund:${mirror.id}`, JSON.stringify({
    mirror_id: mirror.id, order_id: `O-${stamp}`, amount: "100",
    currency: "USD", status, created_at: Date.now(),
  }));
  return { mirror, mirrorId: mirror.id, issueNumber: issue.number, pr };
}

const post = (path: string, body: unknown) => new Request(`https://x${path}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const j = async (res: Response) => res.json() as Promise<Record<string, unknown>>;

async function fileRealClaim(mirrorId: string, prNumber: number) {
  const res = await handleMirrorClaimPost(post("/api/mirrors/claims", {
    mirror_id: mirrorId,
    forgeRef: `https://github.com/${SANDBOX.owner}/${SANDBOX.repo}/pull/${prNumber}`,
    payout: { paypal_email: "widespread-test@example.com" },
  }), env());
  expect(res.status).toBe(201);
  const body = await j(res);
  const claim = body.claim as { claim_hash: string; attested: boolean };
  expect(claim.attested).toBe(true);
  return claim.claim_hash;
}

describe("handleMirrorClaimPost", () => {
  it("409s when mirror is not fiat-funded", async () => {
    const { mirrorId, pr } = await liveMirror({ fundStatus: "created" });
    const res = await handleMirrorClaimPost(post("/api/mirrors/claims", {
      mirror_id: mirrorId,
      forgeRef: `https://github.com/${SANDBOX.owner}/${SANDBOX.repo}/pull/${pr.number}`,
    }), env());
    expect(res.status).toBe(409);
    expect(String((await j(res)).error)).toMatch(/not fiat-funded/);
  }, 120000);

  it("201s an attested claim on a funded mirror backed by a real PR", async () => {
    const { mirrorId, pr } = await liveMirror();
    const res = await handleMirrorClaimPost(post("/api/mirrors/claims", {
      mirror_id: mirrorId,
      forgeRef: `https://github.com/${SANDBOX.owner}/${SANDBOX.repo}/pull/${pr.number}`,
      payout: { paypal_email: "widespread-test@example.com" },
    }), env());
    expect(res.status).toBe(201);
    const body = await j(res);
    const claim = body.claim as {
      attested: boolean; forgeUserId: string; evidence: Record<string, unknown>;
    };
    expect(body.attested).toBe(true);
    expect(claim.forgeUserId).toBeTruthy();
    expect(String(claim.evidence.patch_fingerprint)).toMatch(/^sha256:/);
    expect(claim.evidence.forge).toBe("github");
    expect(claim.evidence.head_sha).toBeTruthy();
  }, 120000);

  it("422s on forge validation failure (real 404 artifact)", async () => {
    const { mirrorId } = await liveMirror();
    const res = await handleMirrorClaimPost(post("/api/mirrors/claims", {
      mirror_id: mirrorId, forgeRef: `${SANDBOX.owner}/${SANDBOX.repo}#99999999`,
    }), env());
    expect(res.status).toBe(422);
  }, 120000);
});

describe("handleMirrorVerdict", () => {
  it("computes face/cut/net and records settlement", async () => {
    const { mirrorId, pr } = await liveMirror();
    const hash = await fileRealClaim(mirrorId, pr.number);
    const res = await handleMirrorVerdict(post("/api/mirrors/verdict", {
      mirror_id: mirrorId, claim_hash: hash, accept: true,
      payout: { paypal_email: "widespread-test@example.com" },
    }), env());
    const body = await j(res);
    const s = body.settlement as Record<string, unknown>;
    expect(s.face_usd).toBe(100);
    expect(s.platform_cut_usd).toBe(10);
    expect(s.net_usd).toBe(90);
    expect((s.paypal_usd as { to: string }).to).toBe("widespread-test@example.com");
    expect(s.status).toBe("won");
  }, 180000);

  it("is one-shot: second verdict returns already_decided", async () => {
    const { mirrorId, pr } = await liveMirror();
    const hash = await fileRealClaim(mirrorId, pr.number);
    const mkReq = () => post("/api/mirrors/verdict", {
      mirror_id: mirrorId, claim_hash: hash, accept: true,
    });
    await handleMirrorVerdict(mkReq(), env());
    const res2 = await handleMirrorVerdict(mkReq(), env());
    expect((await j(res2)).status).toBe("already_decided");
  }, 180000);

  it("rejects unattested claims", async () => {
    const { mirrorId } = await liveMirror();
    // Plant an unattested claim directly in real KV — a state the claim
    // endpoint can never produce, exercising the guard honestly.
    await env().CLAIMS.put(`mclaim:${mirrorId}:h1`, JSON.stringify({
      mirror_id: mirrorId, claim_hash: "h1", attested: false, status: "pending",
    }));
    const res = await handleMirrorVerdict(post("/api/mirrors/verdict", {
      mirror_id: mirrorId, claim_hash: "h1",
    }), env());
    expect(res.status).toBe(409);
  }, 120000);
});

describe("handleMirrorPayout", () => {
  it("409s with no settlement", async () => {
    const { mirrorId } = await liveMirror();
    const res = await handleMirrorPayout(post("/api/mirrors/payout", {
      mirror_id: mirrorId,
    }), env());
    expect(res.status).toBe(409);
  }, 120000);

  it("hits the REAL PayPal Payouts rail and records the outcome", async () => {
    const { mirrorId, pr } = await liveMirror();
    const hash = await fileRealClaim(mirrorId, pr.number);
    await handleMirrorVerdict(post("/api/mirrors/verdict", {
      mirror_id: mirrorId, claim_hash: hash, accept: true,
      payout: { paypal_email: "widespread-test@example.com" },
    }), env());
    const res = await handleMirrorPayout(post("/api/mirrors/payout", {
      mirror_id: mirrorId,
    }), env());
    const body = await j(res);
    const settlement = body.settlement as {
      payout?: { rail?: string; batch_id?: string; error?: string; attempted?: boolean };
      status?: string;
    };
    // Real rail outcomes only:
    //  - creds configured → real batch_id from PayPal sandbox
    //  - creds absent     → real error recorded, settlement stays retryable
    if (settlement.payout?.batch_id) {
      expect(settlement.payout.rail).toBe("paypal-payouts");
      // Second call must dedupe — no second batch.
      const res2 = await handleMirrorPayout(post("/api/mirrors/payout", {
        mirror_id: mirrorId }), env());
      expect((await j(res2)).status).toBe("already_paid");
    } else {
      expect(settlement.payout?.attempted).toBe(true);
      expect(String(settlement.payout?.error ?? "")).toBeTruthy();
    }
  }, 180000);

  it("409s when the winner gave no PayPal email", async () => {
    const { mirrorId, pr } = await liveMirror();
    const hash = await fileRealClaim(mirrorId, pr.number);
    await handleMirrorVerdict(post("/api/mirrors/verdict", {
      mirror_id: mirrorId, claim_hash: hash, accept: true, payout: {},
    }), env());
    const res = await handleMirrorPayout(post("/api/mirrors/payout", {
      mirror_id: mirrorId }), env());
    expect(res.status).toBe(409);
    expect(String((await j(res)).error)).toMatch(/paypal_email/);
  }, 180000);
});
