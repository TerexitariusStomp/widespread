// claims.ts — attested real-submission claims (forge artifact → HMAC
// attestation → agent-broadcast shipClaim), plus the Kleros dispute seam
// and Rekor commit attestation.

import { Hono } from "hono";
import { attestClaim, openDispute } from "../ecosystem";
import { handleClaimPost, handleClaimVerify } from "../claims";
import type { Env } from "../types";
import { bad, json } from "./shared";

export function claimRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // Attested real-submission claims — validate forge artifact, return
  // shipClaim args + HMAC attestation token for on-chain broadcast.
  app.post("/api/claims", (c) => handleClaimPost(c.req.raw, c.env));
  app.get("/api/claims/verify", (c) => handleClaimVerify(new URL(c.req.url), c.env));

  // Kleros dispute seam — binds claimHash+reason as arbitration evidence.
  app.post("/api/dispute", async (c) => {
    const d = (await c.req.json().catch(() => ({}))) as {
      repo?: string; market_id?: string; claim_hash?: string; reason?: string; responder?: string;
    };
    if (!d.repo || !d.claim_hash || !d.reason) return bad("need repo, claim_hash, reason", 400);
    return json(await openDispute(c.env, {
      repo: d.repo, marketId: d.market_id ?? "0", claimHash: d.claim_hash,
      reason: d.reason, responder: d.responder,
    }));
  });

  // Rekor attestation for a shipped commit — permanent public proof.
  app.post("/api/attest", async (c) => {
    const a = (await c.req.json().catch(() => ({}))) as { repo?: string; sha?: string; note?: string };
    if (!a.repo || !a.sha) return bad("need repo, sha", 400);
    return json(await attestClaim(c.env, { repo: a.repo, sha: a.sha, note: a.note }));
  });

  return app;
}
