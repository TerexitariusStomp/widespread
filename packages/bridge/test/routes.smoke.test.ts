// routes.smoke.test.ts — verifies the Hono route table reproduces the
// pre-refactor pathname dispatch: every public path reaches a handler
// (non-404) and unknown paths still 404 with the same body shape.
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { fakeEnv } from "./mock";

const env = fakeEnv();
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

async function req(path: string, method = "GET", body?: unknown) {
  const res = await worker.fetch(
    new Request(`https://bridge.test${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
    ctx
  );
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

  it("matches POST routes", async () => {
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
      const res = await req(path, "POST", body);
      const text = await res.text();
      expect(text, `POST ${path} -> ${res.status}`).not.toContain('"not found"');
    }
  });

  it("DELETE /api/bounties/:owner/:repo reaches the handler", async () => {
    const res = await req("/api/bounties/owner/repo", "DELETE");
    const text = await res.text();
    // authorized (no ADMIN_TOKEN) → ok:true; proves route matched
    expect(text).not.toContain('"not found"');
  });
});
