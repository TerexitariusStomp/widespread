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
