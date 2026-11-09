import { describe, expect, it } from "vitest";

import { ensureArtifactsPushSubscription } from "@/worker/tasks/artifactsSubscriptions";

// No fetch mocking anywhere in this file. The no-credential paths are
// proven by observing that `ctx.waitUntil` is never invoked — if the
// helper regressed into calling the Cloudflare API, work would be
// scheduled. The live paths below run only when real Cloudflare
// credentials are present in the environment and then verify the result
// by reading the subscription back from the real API.

function envOf(overrides: Partial<Env>): Env {
  return {
    LOG_LEVEL: "warn",
    CF_ACCOUNT_ID: "",
    CF_API_TOKEN: "",
    ...overrides,
  } as unknown as Env;
}

function ctxOf(pending: Promise<unknown>[]): ExecutionContext {
  return {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  } as unknown as ExecutionContext;
}

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID ?? "";
const CF_API_TOKEN = process.env.CF_API_TOKEN ?? "";
const HAS_CF_CREDS =
  CF_ACCOUNT_ID.length > 0 &&
  CF_API_TOKEN.length > 0 &&
  CF_API_TOKEN !== "local-placeholder";
// Subscription creation mutates the Cloudflare account — require the
// explicit live gate on top of credentials.
const LIVE = process.env.E2E_LIVE === "1" && HAS_CF_CREDS;
const LIVE_SKIP = !HAS_CF_CREDS
  ? "set CF_ACCOUNT_ID + CF_API_TOKEN (real Cloudflare API credentials)"
  : "set E2E_LIVE=1 to create real event subscriptions";

const CF_API = "https://api.cloudflare.com/client/v4";

describe("ensureArtifactsPushSubscription", () => {
  it("no-ops without CF credentials (waitUntil never scheduled)", async () => {
    const pending: Promise<unknown>[] = [];
    ensureArtifactsPushSubscription(
      ctxOf(pending),
      envOf({ CF_ACCOUNT_ID: "", CF_API_TOKEN: "" }),
      "dg-abc"
    );
    expect(pending).toHaveLength(0);
  });

  it("no-ops on the dev placeholder token (waitUntil never scheduled)", async () => {
    const pending: Promise<unknown>[] = [];
    ensureArtifactsPushSubscription(
      ctxOf(pending),
      envOf({ CF_ACCOUNT_ID: "acct-1", CF_API_TOKEN: "local-placeholder" }),
      "dg-abc"
    );
    expect(pending).toHaveLength(0);
  });

  it("creates a real per-repo subscription and it is visible via the CF API", { skip: LIVE_SKIP }, async () => {
    const artifactsName = `dg-live-test-${Date.now().toString(36)}`;
    const pending: Promise<unknown>[] = [];
    ensureArtifactsPushSubscription(
      ctxOf(pending),
      envOf({ CF_ACCOUNT_ID, CF_API_TOKEN }),
      artifactsName
    );
    await Promise.all(pending);
    expect(pending.length).toBeGreaterThan(0);

    // Read the subscription back from the real Cloudflare API.
    const listRes = await fetch(
      `${CF_API}/accounts/${CF_ACCOUNT_ID}/event_subscriptions/subscriptions`,
      { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } }
    );
    expect(listRes.ok).toBe(true);
    const list = (await listRes.json()) as {
      success: boolean;
      result?: { id: string; name: string; source?: { type?: string; repo_name?: string }; destination?: { type?: string; queue_id?: string } }[];
    };
    const sub = list.result?.find((s) => s.name === `dg-push-${artifactsName}`);
    expect(sub, "subscription not found via real CF API").toBeTruthy();
    expect(sub!.source?.type).toBe("artifacts.repo");
    expect(sub!.source?.repo_name).toBe(artifactsName);
    expect(sub!.destination?.type).toBe("queues.queue");

    // Clean up the real subscription so repeat runs stay idempotent.
    const del = await fetch(
      `${CF_API}/accounts/${CF_ACCOUNT_ID}/event_subscriptions/subscriptions/${sub!.id}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${CF_API_TOKEN}` } }
    );
    expect(del.ok).toBe(true);
  });

  it("is idempotent — a second ensure for the same repo does not duplicate", { skip: LIVE_SKIP }, async () => {
    const artifactsName = `dg-live-test-${Date.now().toString(36)}`;
    const env = envOf({ CF_ACCOUNT_ID, CF_API_TOKEN });
    for (let i = 0; i < 2; i++) {
      const pending: Promise<unknown>[] = [];
      ensureArtifactsPushSubscription(ctxOf(pending), env, artifactsName);
      await Promise.all(pending);
    }

    const listRes = await fetch(
      `${CF_API}/accounts/${CF_ACCOUNT_ID}/event_subscriptions/subscriptions`,
      { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } }
    );
    const list = (await listRes.json()) as { result?: { name: string; id: string }[] };
    const matches = (list.result ?? []).filter((s) => s.name === `dg-push-${artifactsName}`);
    expect(matches).toHaveLength(1);

    await fetch(
      `${CF_API}/accounts/${CF_ACCOUNT_ID}/event_subscriptions/subscriptions/${matches[0]!.id}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${CF_API_TOKEN}` } }
    );
  });
});
