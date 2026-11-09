// misc.ts — ecosystem surfaces: the PR-bot verdict oracle (+ its public
// audit feed), the collaborator ecosystem directory, and Foreguild
// futarchy proposals read live from the NEAR contract.

import { Hono } from "hono";
import { handleBotVerdict, type BotVerdictBody } from "../botverdict";
import { ecosystem } from "../ecosystem";
import { nearView } from "../near";
import type { Env } from "../types";
import { json } from "./shared";

export function miscRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // PR-bot verdict oracle — widespread-bot posts a bot's public verdict on
  // a wide:funded PR; we sign it as a wide-verdict and settle if bound.
  app.post("/api/bot-verdict", async (c) =>
    handleBotVerdict(c.env, (await c.req.json().catch(() => ({}))) as BotVerdictBody));

  // Public audit feed of PR-bot oracle verdicts (who verified, what score,
  // where the money went) — the "they're the verifier, we're the money" trail.
  app.get("/api/bot-verdicts", async (c) => {
    const list = await c.env.CLAIMS.list({ prefix: "botverdict:" }).catch(() => null);
    const records = await Promise.all(
      (list?.keys ?? []).map((k) => c.env.CLAIMS.get(k.name, "json").catch(() => null))
    );
    return json({ verdicts: records.filter(Boolean), total: records.filter(Boolean).length });
  });

  // Collaborator ecosystem feed — rails, funding pools, security boards,
  // forges, workers, dispute/proof seams. All env-gated, all optional.
  app.get("/api/ecosystem", async (c) => json(await ecosystem(c.env)));

  // A2A agent card — how agent frameworks discover this service.
  // Public, static, cacheable. /.well-known/agent.json kept for
  // backward-compat with earlier A2A discovery conventions.
  const agentCard = (c: { env: Env }) => ({
    name: "widespread-bridge",
    description:
      "Verified-work labor market for agents: funded forge-native markets, " +
      "attested claims (dg-ship-1), deterministic + adjudicated verdicts, " +
      "dual-rail payouts (NEAR escrow + fiat), and portable signed reputation.",
    url: c.env.PUBLIC_BASE ?? "https://widespread-bridge.widespread.workers.dev",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    preferredTransport: "JSONRPC",
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    skills: [
      { id: "feed", name: "bounty-feed", description: "Unified cross-forge funded-work feed",
        tags: ["discovery", "bounties"], examples: ["GET /api/feed", "GET /api/feed?topics=typescript"] },
      { id: "claim", name: "attested-claim", description: "Submit a validated work claim",
        tags: ["claims", "attestation"], examples: ["POST /api/claims", "POST /api/mirrors/claims"] },
      { id: "payout", name: "settlement", description: "Dual-rail payout binding + status",
        tags: ["settlement", "payouts"], examples: ["GET /api/payouts/:id", "POST /api/payouts/bind"] },
      { id: "rep", name: "reputation", description: "Portable signed rep events",
        tags: ["reputation"], examples: ["GET /api/rep/:id/export"] },
      { id: "markets", name: "onchain-markets", description: "NEAR escrow market board",
        tags: ["escrow", "near"], examples: ["GET /api/markets"] },
    ],
    endpoints: {
      feed: "/api/feed", markets: "/api/markets", claims: "/api/claims",
      mirrors: "/api/mirrors", payouts: "/api/payouts", rep_export: "/api/rep/:id/export",
      mcp: "/mcp",
    },
  });
  app.get("/.well-known/agent-card.json", (c) =>
    new Response(JSON.stringify(agentCard(c), null, 2), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
    }));
  app.get("/.well-known/agent.json", (c) =>
    new Response(JSON.stringify(agentCard(c), null, 2), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
    }));

  // Foreguild futarchy — live governance proposals on the NEAR contract.
  app.get("/api/futarchy", async (c) => {
    const acct = (c.env as { FUTARCHY_CONTRACT?: string }).FUTARCHY_CONTRACT;
    if (!acct) return json({ proposals: [], total: 0,
      error: "no FUTARCHY_CONTRACT configured" });
    const proposals = await nearView(c.env, acct, "listProposals", {})
      .catch(() => null) as unknown[] | null;
    return json({ proposals: proposals ?? [], total: proposals?.length ?? 0,
      contract: acct, source: "chain" });
  });

  return app;
}
