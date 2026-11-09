// feed.ts — discovery surfaces: the normalized cross-forge bounty feed
// (JSON/RSS/markdown), the minimal MCP endpoint, runner directory,
// Poidh rail status, and the sovereign-repo locator.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  feedDoc, queryFeed, feedRss, handleMcp, FEED_MD,
  listRunners, registerRunner, refreshFeed,
} from "../feed";
import { putFeedDoc } from "../feedstore";
import { poidhInfo } from "../poidh";
import { resolveLocator } from "../locator";
import type { FeedRecord, Env } from "../types";
import { bad, execCtx, isAuthorized, json } from "./shared";

export function feedRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // Unified forge bounty feed — normalized cross-forge discovery index.
  // JSON canonical · Atom RSS · minimal MCP · self-describing doc.
  app.get("/api/feed", async (c) => {
    const url = new URL(c.req.url);
    const doc = await feedDoc(c.env, execCtx(c));
    const q = {
      forge: url.searchParams.get("forge") ?? undefined,
      source: url.searchParams.get("source") ?? undefined,
      repo: url.searchParams.get("repo") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      min_usd: url.searchParams.get("min_usd") ? Number(url.searchParams.get("min_usd")) : undefined,
      currency: url.searchParams.get("currency") ?? undefined,
      escrow: url.searchParams.get("escrow") ?? undefined,
      sort: (url.searchParams.get("sort") as "reward" | "newest" | "trust" | null) ?? undefined,
      limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      max_competition: url.searchParams.get("max_competition") ? Number(url.searchParams.get("max_competition")) : undefined,
      topics: url.searchParams.get("topics") ?? undefined,
    };
    const page = queryFeed(doc, q);
    return json({
      generated_at: doc.generated_at,
      total: page.records.length,
      next_cursor: page.next_cursor,
      sources: doc.sources,
      records: page.records,
    });
  });

  // SSE push — agents subscribe once instead of polling /api/feed.
  // Emits the feed doc on connect and whenever it changes; keepalive
  // pings every 20s; the stream closes at ~4min (client auto-reconnects
  // via SSE retry) so no connection outlives a request's practical life.
  app.get("/api/feed/stream", async (c) => {
    return streamSSE(c, async (stream) => {
      let lastGen = 0;
      const deadline = Date.now() + 4 * 60_000;
      while (Date.now() < deadline) {
        const doc = await feedDoc(c.env, execCtx(c)).catch(() => null);
        if (doc && doc.generated_at !== lastGen) {
          lastGen = doc.generated_at;
          await stream.writeSSE({
            event: "feed",
            data: JSON.stringify({ generated_at: doc.generated_at,
              total: doc.records.length, sources: doc.sources }),
          });
          await stream.writeSSE({ event: "feed-doc", data: JSON.stringify(doc) });
        } else {
          await stream.writeSSE({ event: "ping", data: String(Date.now()) });
        }
        await stream.sleep(20_000);
      }
      await stream.writeSSE({ event: "bye", data: "reconnect" });
    });
  });

  app.get("/api/feed.rss", async (c) => {
    const url = new URL(c.req.url);
    const doc = await feedDoc(c.env, execCtx(c));
    const base = c.env.PUBLIC_BASE ?? url.origin;
    return new Response(feedRss(doc, base), {
      headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=60" },
    });
  });

  app.get("/api/feed.md", () =>
    new Response(FEED_MD, { headers: { "content-type": "text/markdown; charset=utf-8" } }));

  // MCP endpoint — minimal JSON-RPC: initialize/tools/list/tools/call/ping.
  app.post("/mcp", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const res = await handleMcp(c.env, body, execCtx(c));
    return res ?? new Response(null, { status: 202 });
  });

  // Push indexing — bots/relayers upsert records directly.
  app.post("/api/feed/index", async (c) => {
    if (!isAuthorized(c.req.raw, c.env)) return bad("unauthorized", 401);
    const rec = (await c.req.json().catch(() => null)) as Partial<FeedRecord> | null;
    if (!rec?.id || !rec.source || !rec.forge || !rec.title || !rec.url) {
      return bad("need {id, source, forge, title, url}", 400);
    }
    // Clients may omit escrow/kind — normalize so downstream readers
    // (isMirrorable, queryFeed sort, RSS) never dereference undefined.
    const record: FeedRecord = {
      ...(rec as FeedRecord),
      kind: rec.kind ?? "bounty",
      escrow: rec.escrow ?? { state: "none" },
      updated_at: Date.now(),
    };
    const doc = await feedDoc(c.env, execCtx(c));
    const idx = doc.records.findIndex((r) => r.id === record.id);
    if (idx >= 0) doc.records[idx] = record; else doc.records.unshift(record);
    doc.records.sort((a, b) => (b.est_usd ?? 0) - (a.est_usd ?? 0)).splice(500);
    await putFeedDoc(c.env, doc);
    return json({ ok: true, id: record.id }, 201);
  });

  // Client-side execution directory — zero platform compute.
  app.get("/api/runners", async (c) => json({ runners: await listRunners(c.env) }));
  app.post("/api/runners", async (c) => {
    const r = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!r?.kind) return bad("need {kind, isolation, attestation, capabilities}", 400);
    await registerRunner(c.env, r);
    return json({ ok: true }, 201);
  });

  // Manual refresh — same opportunistic path, on demand.
  app.post("/api/feed/refresh", async (c) => json(await refreshFeed(c.env, execCtx(c))));

  // Poidh rail — live sponsor-protocol state on Base (read-only).
  app.get("/api/poidh", async (c) =>
    json(await poidhInfo(c.env).catch((e) => ({ error: String(e) }))));

  // Sovereign repo layer — resolve any locator to its verification surface.
  app.get("/api/locator", (c) => {
    const u = new URL(c.req.url).searchParams.get("u") ?? "";
    return u ? json(resolveLocator(u)) : bad("need ?u=<locator>", 400);
  });

  return app;
}
