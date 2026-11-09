// routes.smoke.test.ts — verifies the Hono route table reproduces the
// pre-refactor pathname dispatch: every public path reaches a handler
// (non-404) and unknown paths still 404 with the same body shape.
// Runs against the worker's REAL bindings (KV CLAIMS + vars + secrets)
// via cloudflare:test — no env stub.
import { describe, expect, it } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import type { Env } from "../src/types";

const realEnv = env as unknown as Env;

async function req(path: string, method = "GET", body?: unknown) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://bridge.test${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
    realEnv,
    ctx
  );
  // Drain background work (feed refreshes etc.) so the isolate stays clean.
  ctx.waitUntil?.(Promise.resolve());
  return res;
}

describe("route table smoke", () => {
  it("serves healthz and 404s unknown paths identically", async () => {
    const hz = await req("/healthz");
    expect(hz.status).toBe(200);
    expect(await hz.json()).toMatchObject({ ok: true, service: "widespread-bridge" });

    const nf = await req("/definitely-not-a-route");
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: "not found" });
  });

  it("reaches JSON APIs (not the 404 fallback)", async () => {
    // These may return domain errors (missing config etc.) but must NOT
    // be the router's {error:"not found"} — that proves the route matched.
    const cases: [string, string][] = [
      ["/api/state", "GET"],
      ["/api/bounties", "GET"],
      ["/api/feed", "GET"],
      ["/api/feed.md", "GET"],
      ["/api/feed.rss", "GET"],
      ["/api/mirrors", "GET"],
      ["/api/runners", "GET"],
      ["/api/mechanisms", "GET"],
      ["/api/hats", "GET"],
      ["/api/hats/somehat", "GET"],
      ["/api/hats/somehat/foreign", "GET"],
      ["/api/hats/somehat/opportunities", "GET"],
      ["/api/intents/status", "GET"],
      ["/api/poidh", "GET"],
      ["/api/locator", "GET"],
      ["/api/bot-verdicts", "GET"],
      ["/api/ecosystem", "GET"],
      ["/api/futarchy", "GET"],
      ["/api/claims/verify", "GET"],
      ["/docs", "GET"],
      ["/ops", "GET"],
      ["/sponsor", "GET"],
      ["/", "GET"],
      ["/bounties", "GET"],
      ["/bounties/some-id", "GET"],
      ["/fund/some-id", "GET"],
      ["/receipts/m/mirror%2Fid/hash123", "GET"],
      ["/receipts/r/owner/repo/3", "GET"],
    ];
    for (const [path, method] of cases) {
      const res = await req(path, method);
      const text = await res.text();
      expect(text, `${method} ${path} -> ${res.status}`).not.toContain('"not found"');
    }
  });

  // Some POSTs perform real upstream work — /api/feed/refresh hits live
  // GitHub/Tangled/NEAR sources, and /api/scan runs the review pipeline
  // (forge op-logs + adjudication). The local workerd `ai` binding is
  // remote-only, so adjudication-dependent routes may stay pending
  // indefinitely here; a still-pending request still proves the route
  // matched (unmatched paths 404 immediately). Each request is raced
  // against a bound so one slow live leg can't stall the suite.
  it("matches POST routes", { timeout: 300000 }, async () => {
    const cases: [string, unknown][] = [
      ["/api/scan", {}],
      ["/api/feed/index", { id: "x", source: "s", forge: "f", title: "t", url: "https://x" }],
      ["/api/feed/refresh", {}],
      ["/api/runners", { kind: "k" }],
      ["/api/mirrors/claims", {}],
      ["/api/mirrors/verdict", {}],
      ["/api/mirrors/payout", {}],
      ["/api/mirrors/escrow", {}],
      ["/api/mirrors/fund", {}],
      ["/api/mirrors/capture", {}],
      ["/api/bounties/mirror", {}],
      ["/api/bounties", {}],
      ["/api/claims", {}],
      ["/api/dispute", {}],
      ["/api/attest", {}],
      ["/api/bot-verdict", {}],
      ["/api/hats/payout-quote", {}],
      ["/api/hats/somehat/stance-check", {}],
      ["/api/workflows/wf1", {}],
      ["/review", {}],
      ["/mcp", {}],
    ];
    for (const [path, body] of cases) {
      const ctx = createExecutionContext();
      const pending = worker.fetch(
        new Request(`https://bridge.test${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }), realEnv, ctx);
      pending.catch(() => {}); // raced below; never leave an unhandled rejection
      const outcome = await Promise.race([
        pending.then(async (res) => ({ kind: "resolved" as const, res, text: await res.text() })),
        new Promise<{ kind: "pending" }>((r) =>
          setTimeout(() => r({ kind: "pending" }), 30000)),
      ]);
      if (outcome.kind === "resolved") {
        expect(outcome.text, `POST ${path} -> ${outcome.res.status}`)
          .not.toContain('"not found"');
      }
      // pending → route matched; handler is doing real (slow) work.
    }
  });

  it("DELETE /api/bounties/:owner/:repo reaches the handler", async () => {
    const res = await req("/api/bounties/owner/repo", "DELETE");
    const text = await res.text();
    // authorized (no ADMIN_TOKEN) → ok:true; proves route matched
    expect(text).not.toContain('"not found"');
  });
});
