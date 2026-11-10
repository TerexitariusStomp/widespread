// mirrors.ts — third-party bounty mirror board: listings overlaid with
// fiat pay-in state, PayPal fund/capture, the fiat claim lifecycle
// (claims → verdict → payout), manual ops escrow, and mirroring an
// external bounty record into a Widespread market.

import { Hono } from "hono";
import { feedDoc, handleMirrorQuote } from "../feed";
import { createFiatOrder, captureFiatOrder, tryOpsEscrow } from "../fiat";
import { handleMirrorClaimPost, handleMirrorClaimsList, handleMirrorVerdict, handleMirrorPayout } from "../mirrorclaims";
import type { Env } from "../types";
import { bad, execCtx, json } from "./shared";
import { kv } from "../db";
import { registerWebhook, deleteWebhook, listWebhooks } from "../webhooks";

export function mirrorRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  /** Shared body-param mirror lookup for the fiat fund/capture routes —
   * mirror ids contain '/', '#', ':' which don't survive path encoding. */
  async function findMirror(c: { env: Env; executionCtx: ExecutionContext }, mirrorId: string) {
    const doc = await feedDoc(c.env, c.executionCtx);
    return (doc.mirrors ?? []).find((m) => m.id === mirrorId) ?? null;
  }

  // Mirror board — every detected third-party bounty auto-listed at a
  // marked-up price; status flips to funded when escrow lands on-chain.
  app.get("/api/mirrors", async (c) => {
    const url = new URL(c.req.url);
    const doc = await feedDoc(c.env, execCtx(c));
    const status = url.searchParams.get("status");
    let mirrors = doc.mirrors ?? [];
    // Overlay fiat pay-in state — funding records live in KV, mirrors
    // are rebuilt each refresh so state can't live on the listing.
    const fiatKeys = await kv(c.env).list({ prefix: "fiatfund:", limit: 100 }).catch(() => null);
    const fiatByMirror = new Map<string, { status: string; amount: string; payer_email?: string }>();
    for (const k of fiatKeys?.keys ?? []) {
      const f = await kv(c.env).get<{ mirror_id: string; status: string; amount: string; payer_email?: string }>(k.name, "json").catch(() => null);
      if (f?.status === "captured") fiatByMirror.set(f.mirror_id, f);
    }
    mirrors = mirrors.map((m) => {
      const f = fiatByMirror.get(m.id);
      if (f && m.status === "seeking-funder") {
        return { ...m, status: "fiat-funded" as const, fiat: { amount: f.amount, currency: "USD", payer_email: f.payer_email } };
      }
      return m;
    });
    if (status) mirrors = mirrors.filter((m) => m.status === status);
    return json({ total: mirrors.length, mirrors });
  });

  // Fiat pay-in for a mirror: PayPal order → approve link → capture.
  // Body-param routes — mirror ids contain '/', '#', ':' which don't
  // survive path encoding cleanly.
  app.post("/api/mirrors/fund", async (c) => {
    const url = new URL(c.req.url);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, string>;
    const mirrorId = b.mirror_id ?? "";
    const mirror = await findMirror({ env: c.env, executionCtx: execCtx(c) }, mirrorId);
    if (!mirror) return bad("mirror not found", 404);
    // Payer pays the bounty at FACE VALUE — our cut comes out of the
    // escrow at release, never added to the price.
    const usd = mirror.original?.est_usd;
    if (!usd) return bad("mirror has no USD price — fiat funding needs a priced bounty", 422);
    const base = c.env.PUBLIC_BASE ?? url.origin;
    return createFiatOrder(c.env, mirrorId,
      usd.toFixed(2), `Widespread mirror: ${mirror.title.slice(0, 80)}`,
      `${base}/api/mirrors`, `${base}/api/mirrors`);
  });

  app.post("/api/mirrors/capture", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, string>;
    const mirrorId = b.mirror_id ?? "";
    const mirror = await findMirror({ env: c.env, executionCtx: execCtx(c) }, mirrorId);
    if (!mirror) return bad("mirror not found", 404);
    if (!b.order_id) return bad("order_id required", 400);
    return captureFiatOrder(c.env, mirrorId, b.order_id, mirror);
  });

  // Fiat-mirror claim lifecycle: claims → verdict → USD payout.
  app.post("/api/mirrors/claims", (c) => handleMirrorClaimPost(c.req.raw, c.env, execCtx(c)));
  app.get("/api/mirrors/claims", (c) => handleMirrorClaimsList(new URL(c.req.url), c.env, execCtx(c)));
  app.post("/api/mirrors/verdict", (c) => handleMirrorVerdict(c.req.raw, c.env, execCtx(c)));
  app.post("/api/mirrors/payout", (c) => handleMirrorPayout(c.req.raw, c.env, execCtx(c)));

  // Manual ops escrow — front NEAR for any mirror (crypto or fiat path).
  app.post("/api/mirrors/escrow", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, string>;
    const mirror = (await feedDoc(c.env, execCtx(c))).mirrors?.find((m) => m.id === b.mirror_id);
    if (!mirror) return bad("mirror not found", 404);
    try {
      return json({ escrow: await tryOpsEscrow(c.env, mirror) });
    } catch (e) {
      return bad(`escrow failed: ${e instanceof Error ? e.message : e}`, 500);
    }
  });

  // Mirror an external/third-party bounty into a Widespread market at
  // face value — platformBps is our percent cut at release.
  // Webhooks — operator push on money movement (settlement | payout | claim).
  // HMAC-signed bodies when a secret is registered (x-widespread-signature).
  app.post("/api/webhooks", async (c) => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const url = String(b?.url ?? "");
    const events = (b?.events ?? ["settlement", "payout"]) as string[];
    if (!/^https?:\/\//i.test(url)) return bad("https url required");
    const sub = await registerWebhook(c.env, url, events, b?.secret as string | undefined);
    return json({ ok: true, webhook: sub });
  });
  app.get("/api/webhooks", async (c) => json({ webhooks: await listWebhooks(c.env) }));
  app.delete("/api/webhooks/:id", async (c) =>
    json({ ok: await deleteWebhook(c.env, c.req.param("id")) }));

  app.post("/api/bounties/mirror", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { record_id?: string; spec?: string };
    return handleMirrorQuote(c.env, execCtx(c), b);
  });

  return app;
}
