// ops.ts — review pipeline + bounty registry endpoints: /api/state,
// /api/markets, /api/scan, /api/premium/oplog-export, /review,
// /api/bounties (+ DELETE /api/bounties/:owner/:repo).

import { Hono } from "hono";
import { handlePremiumExport } from "../premium";
import { deleteBounty, listBounties, listRecords, putBounty } from "../store";
import type { Env } from "../types";
import { bad, execCtx, handleBountyPost, handleReview, isAuthorized, json, listOnchainMarkets, payoutTrace, scan } from "./shared";

export function opsRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/api/state", async (c) => {
    // Opportunistic pickup: an open dashboard polls this route, so new ship
    // claims get reviewed without needing a cron trigger slot.
    execCtx(c).waitUntil(scan(c.env).catch((e) => console.error(`scan: ${String(e)}`)));
    const [claims, bounties] = await Promise.all([listRecords(c.env), listBounties(c.env)]);
    const claimsWithTrace = claims.map((cl) => ({ ...cl, payout_trace: payoutTrace(cl) }));
    return json({ claims: claimsWithTrace, bounties });
  });

  // Public bounty board — funded, open markets + where the money goes.
  // Market truth is the CHAIN (widespread-near contract listOpen), not our
  // KV — the bridge is a thin renderer; participant infra holds the state.
  app.get("/api/markets", async (c) => {
    const markets = await listOnchainMarkets(c.env);
    return json({ markets, total: markets.length, source: "chain" });
  });

  app.post("/api/scan", async (c) => json({ reviewed: await scan(c.env) }));

  app.get("/api/premium/oplog-export", (c) => handlePremiumExport(c.req.raw, c.env));

  app.on(["GET", "POST"], "/review", (c) => handleReview(c.req.raw, c.env));

  app.get("/api/bounties", async (c) => json({ bounties: await listBounties(c.env) }));
  app.post("/api/bounties", (c) => handleBountyPost(c.req.raw, c.env));

  // Registered after the exact /api/bounties routes; Hono prefers static
  // segments, but the charset guard keeps parity with the old regex.
  app.delete("/api/bounties/:owner/:repo", async (c) => {
    const repo = `${c.req.param("owner")}/${c.req.param("repo")}`;
    if (!/^[a-z0-9-]+\/[a-z0-9-]+$/i.test(repo)) return bad("not found", 404);
    if (!isAuthorized(c.req.raw, c.env)) return bad("unauthorized", 401);
    await deleteBounty(c.env, repo);
    return json({ ok: true });
  });

  return app;
}
