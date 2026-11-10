// webhooks.ts — outbound job-event delivery for payers/integrators.
// Subscriptions live in the claim store (webhook:<id>); events emit on
// settlement decisions and payout execution. Delivery is best-effort:
// fire-and-forget POST with a signed-ish body (event id + ts + kind).
// SSE (/api/feed/stream) covers agents polling for work; webhooks cover
// operators reacting to money movement.

import type { Env } from "./types";
import { kv } from "./db";

export interface WebhookSub {
  id: string;
  url: string;
  events: string[];          // "settlement" | "payout" | "claim"
  created_at: number;
  secret?: string;           // HMAC signing secret if the sub wants one
}

const key = (id: string) => `webhook:${id}`;

export async function registerWebhook(env: Env, url: string, events: string[], secret?: string): Promise<WebhookSub> {
  const id = crypto.randomUUID();
  const sub: WebhookSub = { id, url, events, created_at: Date.now(), ...(secret ? { secret } : {}) };
  await kv(env).put(key(id), JSON.stringify(sub));
  return sub;
}

export async function deleteWebhook(env: Env, id: string): Promise<boolean> {
  const existing = await kv(env).get(key(id)).catch(() => null);
  if (!existing) return false;
  await kv(env).delete(key(id));
  return true;
}

export async function listWebhooks(env: Env): Promise<WebhookSub[]> {
  const subs: WebhookSub[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv(env).list({ prefix: "webhook:", cursor, limit: 200 });
    for (const k of page.keys) {
      const raw = await kv(env).get(k.name).catch(() => null);
      if (raw) subs.push(JSON.parse(raw) as WebhookSub);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return subs;
}

async function signBody(secret: string | undefined, body: string): Promise<string | undefined> {
  if (!secret) return undefined;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Emit an event to matching subscribers — fire-and-forget, one attempt.
 * Callers may pass ctx for waitUntil longevity; without it the promise
 * still resolves delivery best-effort inside the request budget. */
export async function emitWebhook(env: Env, event: string, payload: unknown): Promise<number> {
  const subs = await listWebhooks(env).catch(() => [] as WebhookSub[]);
  const body = JSON.stringify({ id: crypto.randomUUID(), event, at: Date.now(), data: payload });
  let delivered = 0;
  await Promise.all(subs
    .filter((s) => s.events.includes(event) || s.events.includes("*"))
    .map(async (s) => {
      try {
        const sig = await signBody(s.secret, body);
        const res = await fetch(s.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(sig ? { "x-widespread-signature": sig } : {}),
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) delivered++;
      } catch { /* best-effort */ }
    }));
  return delivered;
}
