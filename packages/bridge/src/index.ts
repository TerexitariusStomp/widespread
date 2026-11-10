// Widespread ⇄ delta-git bridge worker.
//
// Routing lives in src/routes/* — one Hono sub-app per domain, mounted
// here in the original dispatch order. Route paths/methods are a public
// contract; see the Phase-0 inventory before changing any of them.
//
//   scheduled(*/5m)           scan WATCH_REPOS op-logs, review new ship claims

import { Hono } from "hono";
import type { Env } from "./types";
import { scan } from "./routes/shared";
import { pageRoutes } from "./routes/pages";
import { opsRoutes } from "./routes/ops";
import { feedRoutes } from "./routes/feed";
import { mirrorRoutes } from "./routes/mirrors";
import { claimRoutes } from "./routes/claims";
import { hatRoutes } from "./routes/hats";
import { miscRoutes } from "./routes/misc";
import { payoutRoutes } from "./routes/payouts";
import { scanMirrorSubmissions, settleMergedClaims } from "./ingest";

const app = new Hono<{ Bindings: Env }>();

// Mount order mirrors the original sequential pathname checks: human
// surfaces first, then API domains. Path spaces are disjoint, so order is
// belt-and-suspenders rather than load-bearing.
app.route("/", pageRoutes());
app.route("/", opsRoutes());
app.route("/", feedRoutes());
app.route("/", mirrorRoutes());
app.route("/", claimRoutes());
app.route("/", hatRoutes());
app.route("/", miscRoutes());
app.route("/", payoutRoutes());

app.notFound((c) =>
  new Response(JSON.stringify({ error: "not found" }, null, 2), {
    status: 404,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  }));

export default {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),

  // The "picks up the claim" lane: poll each watched repo's op-log and run
  // the pipeline on ship entries we haven't seen before. Needs a cron slot —
  // when none is free the /api/state opportunistic scan covers pickup.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scan(env).catch((e) => console.error(`scan: ${String(e)}`)));
    if (env.INGEST_Q) {
      // Queue path: each task gets the consumer's own subrequest budget.
      ctx.waitUntil(env.INGEST_Q.send({ task: "scan" }).then(() =>
        env.INGEST_Q!.send({ task: "settle" })).catch(() => undefined));
    } else {
      ctx.waitUntil(scanMirrorSubmissions(env).catch((e) => console.error(`ingest: ${String(e)}`)));
      ctx.waitUntil(settleMergedClaims(env).catch((e) => console.error(`settle: ${String(e)}`)));
    }
  },

  // Queue consumer — the GitHub fan-out moves here when INGEST_Q is
  // bound, so per-mirror fetches don't share a request's subrequest cap.
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const task = (msg.body as { task?: string }).task;
      try {
        if (task === "scan") await scanMirrorSubmissions(env);
        else if (task === "settle") await settleMergedClaims(env);
        msg.ack();
      } catch (e) {
        console.error(`queue ${task}: ${String(e)}`);
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;
