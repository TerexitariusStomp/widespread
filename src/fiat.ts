// fiat.ts — fiat pay-in leg for mirror markets.
//
// Crypto payers escrow NEAR directly; fiat payers (the Algora/Opire
// majority) pay the face-value USD bounty through a PayPal Checkout order. On capture
// the mirror flips to "fiat-funded" — the ops side then fronts the NEAR
// escrow (treasury float → createMarket) or settles the winner by PayPal
// Payouts — the platform cut is taken at settlement either way.
//
// Money flow: payer card/PayPal → our PayPal (sandbox today) → ops converts
// → NEAR escrow → contract release pays claimant minus the cut.
// The custody window is the PayPal balance between capture and conversion —
// minimized by auto-forwarding once a NEAR ops key is configured.

import type { Env } from "./types";

const PAYPAL_API = (env: Env) => env.PAYPAL_API_BASE;

interface PayPalToken { access_token: string; expires_at: number }
let cached: PayPalToken | null = null;

async function accessToken(env: Env): Promise<string> {
  if (cached && cached.expires_at > Date.now() + 30_000) return cached.access_token;
  const res = await fetch(`${PAYPAL_API(env)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`paypal oauth: HTTP ${res.status}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = { access_token: body.access_token, expires_at: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

async function pp(env: Env, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${PAYPAL_API(env)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await accessToken(env)}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(`paypal ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return json;
}

export interface FiatFunding {
  mirror_id: string;
  order_id: string;
  amount: string;
  currency: string;
  status: "created" | "approved" | "captured" | "voided";
  payer_email?: string;
  capture_id?: string;
  created_at: number;
  captured_at?: number;
}

const fiatKey = (mirrorId: string) => `fiatfund:${mirrorId}`;

export async function getFiatFunding(env: Env, mirrorId: string): Promise<FiatFunding | null> {
  return env.CLAIMS.get<FiatFunding>(fiatKey(mirrorId), "json");
}

/** Create a PayPal Checkout order for the mirror's face-value USD price.
 * Returns the payer-action approval link. */
export async function createFiatOrder(env: Env, mirrorId: string, amountUsd: string,
                                       description: string, returnUrl: string, cancelUrl: string): Promise<Response> {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
    return Response.json({ ok: false, error: "PayPal not configured" }, { status: 503 });
  }
  const order = await pp(env, "POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{
      reference_id: mirrorId.slice(0, 127),
      description: description.slice(0, 127),
      amount: { currency_code: "USD", value: amountUsd },
    }],
    payment_source: {
      paypal: {
        experience_context: {
          payment_method_preference: "UNRESTRICTED",
          brand_name: "Widespread",
          locale: "en-US",
          landing_page: "LOGIN",
          return_url: returnUrl,
          cancel_url: cancelUrl,
        },
      },
    },
  });
  const id = String(order.id ?? "");
  const approve = (order.links as { rel: string; href: string }[] | undefined)
    ?.find((l) => l.rel === "payer-action")?.href;
  const funding: FiatFunding = {
    mirror_id: mirrorId, order_id: id, amount: amountUsd, currency: "USD",
    status: "created", created_at: Date.now(),
  };
  await env.CLAIMS.put(fiatKey(mirrorId), JSON.stringify(funding));
  return Response.json({ ok: true, order_id: id, approve_url: approve, funding }, { status: 201 });
}

/** Capture an approved order → mirror becomes fiat-funded. The ops step
 * (treasury NEAR escrow or PayPal-out settlement) keys off this record. */
export async function captureFiatOrder(env: Env, mirrorId: string, orderId: string): Promise<Response> {
  const funding = await getFiatFunding(env, mirrorId);
  if (!funding || funding.order_id !== orderId) {
    return Response.json({ ok: false, error: "unknown order for this mirror" }, { status: 404 });
  }
  if (funding.status === "captured") {
    return Response.json({ ok: true, funding, note: "already captured" });
  }
  const order = await pp(env, "GET", `/v2/checkout/orders/${orderId}`);
  const status = String((order.status as string) ?? "");
  if (status === "APPROVED") {
    const cap = await pp(env, "POST", `/v2/checkout/orders/${orderId}/capture`, {});
    const payer = (cap.payer as { email_address?: string } | undefined)?.email_address;
    const captureId = String(((cap.purchase_units as Record<string, unknown>[] | undefined)?.[0]
      ?.payments as { captures?: { id?: string }[] } | undefined)?.captures?.[0]?.id ?? "");
    funding.status = "captured";
    funding.payer_email = payer;
    funding.capture_id = captureId || undefined;
    funding.captured_at = Date.now();
    await env.CLAIMS.put(fiatKey(mirrorId), JSON.stringify(funding));
    return Response.json({
      ok: true, funding,
      next: "Fiat captured. Ops: front NEAR escrow via createMarket(platformBps=<cut_bps> — the cut is taken on-chain at release) OR PayPal-out the post-cut amount to the winner on verdict. Agents claim via POST /api/claims once the market is live.",
    });
  }
  funding.status = status === "COMPLETED" ? "captured" : "approved";
  if (funding.status === "captured") funding.captured_at = Date.now();
  await env.CLAIMS.put(fiatKey(mirrorId), JSON.stringify(funding));
  return Response.json({ ok: false, error: `order status ${status} — not capturable`, funding }, { status: 409 });
}
