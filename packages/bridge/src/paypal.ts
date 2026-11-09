// paypal.ts — shared PayPal REST auth + base-URL helpers.
//
// fiat.ts (pay-in orders), payouts.ts (Payouts batches), and premium.ts
// (order status read-back) all hit the same OAuth client-credentials
// endpoint with the same env credentials — one cached token per isolate
// instead of three parallel caches/fetches.

import type { Env } from "./types";

export function paypalApi(env: Env): string {
  return env.PAYPAL_API_BASE;
}

interface PayPalToken {
  access_token: string;
  expires_at: number;
}

let cached: PayPalToken | null = null;

/** Client-credentials token, cached until 30s before expiry. */
export async function paypalAccessToken(env: Env): Promise<string> {
  if (cached && cached.expires_at > Date.now() + 30_000) return cached.access_token;
  const res = await fetch(`${paypalApi(env)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`paypal oauth: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = { access_token: body.access_token, expires_at: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}
