// pages.ts — human surfaces: SSR pages over the feed/mirror/claim APIs,
// plus /healthz. These historically matched on pathname alone (any HTTP
// method), so they register with app.all to preserve that contract.
//
// Pretty paths: record/mirror ids contain '/', '#', ':' so they travel
// percent-encoded as a single segment (%2F survives in pathname).

import { Hono } from "hono";
import { OPS_HTML } from "../ops";
import { homePage, bountiesPage, bountyPage, fundPage, receiptPage, docsPage, bountyMarkdown } from "../web/pages";
import { sponsorPage } from "../sponsor";
import type { Env } from "../types";
import { bad, cachedPage, execCtx, isAuthorized, json, safeDecode } from "./shared";

export function pageRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.all("/", (c) => cachedPage(new URL(c.req.url), c.req.raw, () => homePage(c.env, execCtx(c))));
  app.all("/index.html", (c) => cachedPage(new URL(c.req.url), c.req.raw, () => homePage(c.env, execCtx(c))));

  app.all("/bounties", (c) => cachedPage(new URL(c.req.url), c.req.raw, () => bountiesPage(c.env, execCtx(c))));
  app.all("/bounties/*", (c, next) => {
    const url = new URL(c.req.url);
    // The wildcard also matches the bare "/bounties" prefix edge — the
    // exact route above owns that path; anything else without the slash
    // falls through to 404 as before.
    if (!url.pathname.startsWith("/bounties/")) return next();
    const rest = url.pathname.slice("/bounties/".length);
    // /bounties/<id>.md — agent-readable markdown twin of the detail page.
    if (rest.endsWith(".md")) {
      const id = safeDecode(rest.slice(0, -".md".length));
      if (!id) return bad("id required", 400);
      return cachedPage(url, c.req.raw, () => bountyMarkdown(c.env, execCtx(c), id));
    }
    const id = safeDecode(rest);
    if (!id) return bad("id required", 400);
    return cachedPage(url, c.req.raw, () => bountyPage(c.env, execCtx(c), id));
  });

  app.all("/fund/*", (c, next) => {
    const url = new URL(c.req.url);
    if (!url.pathname.startsWith("/fund/")) return next();
    const id = safeDecode(url.pathname.slice("/fund/".length));
    if (!id) return bad("id required", 400);
    return cachedPage(url, c.req.raw, () => fundPage(c.env, execCtx(c), id));
  });

  app.all("/receipts/m/*", (c, next) => {
    const url = new URL(c.req.url);
    if (!url.pathname.startsWith("/receipts/m/")) return next();
    // /receipts/m/<mirrorId>/<claimHash> — mirror ids stay one encoded
    // segment; the claim hash is the final segment.
    const rest = url.pathname.slice("/receipts/m/".length).split("/");
    const claimHash = safeDecode(rest.pop() ?? "");
    const mirrorId = safeDecode(rest.join("/"));
    if (!mirrorId || !claimHash) return bad("mirror and claim required", 400);
    return cachedPage(url, c.req.raw, () => receiptPage(c.env, mirrorId, claimHash, null, null));
  });

  app.all("/receipts/r/*", (c, next) => {
    const url = new URL(c.req.url);
    if (!url.pathname.startsWith("/receipts/r/")) return next();
    // /receipts/r/<owner>/<repo>/<seq> — repo path segments are real slashes.
    const rest = url.pathname.slice("/receipts/r/".length).split("/");
    const seqRaw = rest.pop() ?? "";
    const repo = rest.join("/");
    const seq = Number(seqRaw);
    if (!repo || !Number.isFinite(seq)) return bad("repo and seq required", 400);
    return cachedPage(url, c.req.raw, () => receiptPage(c.env, null, null, repo, seq));
  });

  app.all("/docs", () => docsPage());
  // Ops dashboard — the claim→evidence→verdict→payout console. Gated like
  // the other admin surfaces: open when ADMIN_TOKEN is unset (dev/testnet),
  // Bearer-required once configured.
  app.all("/ops", (c) => {
    if (!isAuthorized(c.req.raw, c.env)) return bad("unauthorized", 401);
    return new Response(OPS_HTML, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });
  // Sponsor-tool surface: AG Grid payout-trace viewer.
  app.all("/sponsor", (c) => sponsorPage(c.env));
  app.all("/healthz", () => json({ ok: true, service: "widespread-bridge" }));

  return app;
}
