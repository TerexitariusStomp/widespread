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

  // Agent registry — discoverable directory of who works here: contributor
  // rep (event-sourced, signed) + registered runners. WorkProtocol's
  // agent-registry parity surface.
  app.get("/api/agents", async (c) => {
    const [{ repIndex, spamLikely, claimRank }, { listRunners }] = await Promise.all([
      import("../rep"), import("../feed"),
    ]);
    const idx = await repIndex(c.env);
    const runners = await listRunners(c.env).catch(() => [] as unknown[]);
    const contributors = Object.entries(idx.contrib).map(([actor, r]) => ({
      actor: `github:${actor}`,
      rep: { ...r, spam_likely: spamLikely(r), rank: claimRank(r) },
      export: `/api/rep/${actor}/export`,
    })).sort((a, b) => b.rep.rank - a.rep.rank);
    // Funder side — rep:funder:* KV keys carry {funded, paid}; listing is
    // bounded (funders are few). release_rate is the settlement-integrity
    // signal payers screen on.
    const funders: { payer: string; funded: number; paid: number; release_rate: number }[] = [];
    try {
      let cursor: string | undefined;
      do {
        const page = await c.env.CLAIMS.list({ prefix: "rep:funder:", cursor, limit: 200 });
        for (const k of page.keys) {
          const raw = await c.env.CLAIMS.get(k.name).catch(() => null);
          if (!raw) continue;
          const r = JSON.parse(raw) as { funded: number; paid: number };
          funders.push({ payer: k.name.slice(10), funded: r.funded ?? 0, paid: r.paid ?? 0,
            release_rate: r.funded ? Math.round((r.paid / r.funded) * 100) / 100 : 0 });
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    } catch { /* funder index optional */ }
    funders.sort((a, b) => b.release_rate - a.release_rate);
    return json({ contributors, funders, runners, total: contributors.length });
  });

  // Treasury + market-health rollup — the settlement-integrity narrative:
  // every msettle:* record aggregated into "verified jobs actually settle"
  // numbers the comparison page can show. Read-only, eventually
  // consistent (KV list), cached at the edge.
  app.get("/api/treasury", async (c) => {
    const settlements: { face: number; cut: number; net: number; won: number; paid: number; rejected: number; pending_payout: number } =
      { face: 0, cut: 0, net: 0, won: 0, paid: 0, rejected: 0, pending_payout: 0 };
    let fundedFiat = 0;
    try {
      let cursor: string | undefined;
      do {
        const page = await c.env.CLAIMS.list({ prefix: "msettle:", cursor, limit: 200 });
        for (const k of page.keys) {
          const raw = await c.env.CLAIMS.get(k.name).catch(() => null);
          if (!raw) continue;
          const s = JSON.parse(raw) as {
            status: string; face_usd?: number; platform_cut_usd?: number;
            net_usd?: number; payout?: { batch_id?: string; transaction_id?: string };
          };
          settlements.face += s.face_usd ?? 0;
          settlements.cut += s.platform_cut_usd ?? 0;
          settlements.net += s.net_usd ?? 0;
          if (s.status === "won") settlements.won += 1;
          else if (s.status === "rejected") settlements.rejected += 1;
          if (s.payout?.batch_id || s.payout?.transaction_id) settlements.paid += 1;
          else if (s.status === "won") settlements.pending_payout += 1;
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    } catch { /* settle index optional */ }
    try {
      let cursor: string | undefined;
      do {
        const page = await c.env.CLAIMS.list({ prefix: "fiatfund:", cursor, limit: 200 });
        for (const k of page.keys) fundedFiat += 1;
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    } catch { /* funding index optional */ }
    const decided = settlements.won + settlements.rejected;
    return json({
      totals_usd: {
        face: +settlements.face.toFixed(2),
        platform_cut: +settlements.cut.toFixed(2),
        net_to_contributors: +settlements.net.toFixed(2),
      },
      settlements: {
        decided,
        won: settlements.won,
        rejected: settlements.rejected,
        paid: settlements.paid,
        pending_payout: settlements.pending_payout,
        settle_rate: decided ? Math.round((settlements.paid / Math.max(1, settlements.won)) * 100) / 100 : null,
      },
      fiat_funded_mirrors: fundedFiat,
      note: "settle_rate = paid payouts / won settlements — the number the field averages ~52% on",
    });
  });

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
