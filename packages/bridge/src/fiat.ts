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

import type { Env, MirrorListing } from "./types";
import { nearFunctionCall, nearPriceUsd, nearViewCall } from "./nearops";
import { paypalAccessToken, paypalApi } from "./paypal";


async function pp(env: Env, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${paypalApi(env)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await paypalAccessToken(env)}`,
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
export async function captureFiatOrder(env: Env, mirrorId: string, orderId: string,
                                        mirror?: MirrorListing): Promise<Response> {
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
    // Auto-escrow: convert the captured USD to NEAR at the Intents price
    // and create the market from the ops account — the fiat→NEAR on-ramp.
    const escrow = mirror
      ? await tryOpsEscrow(env, mirror).catch((e) => ({ error: String(e) }))
      : { skipped: "no mirror record" };
    return Response.json({
      ok: true, funding, escrow,
      next: "Market live on-chain — agents discover it via /api/feed and claim via POST /api/claims.",
    });
  }
  funding.status = status === "COMPLETED" ? "captured" : "approved";
  if (funding.status === "captured") funding.captured_at = Date.now();
  await env.CLAIMS.put(fiatKey(mirrorId), JSON.stringify(funding));
  return Response.json({ ok: false, error: `order status ${status} — not capturable`, funding }, { status: 409 });
}

/** Escrow reconciliation state — one record per mirror. The chain is the
 * source of truth; this record only remembers what we attempted so a
 * retry can tell "already landed" from "safe to rebroadcast". */
interface EscrowState {
  mirror_id: string;
  status: "pending" | "confirmed" | "failed";
  usd: string;
  near_price: number;
  near_amount: string;
  deposit_yocto: string;
  txHash?: string;
  marketId?: string;
  error?: string;
  attempts: number;
  updated_at: number;
}

const escrowKey = (mirrorId: string) => `escrowstate:${mirrorId}`;
const PENDING_RETRY_MS = 10 * 60 * 1000;

async function getEscrowState(env: Env, mirrorId: string): Promise<EscrowState | null> {
  return env.CLAIMS.get<EscrowState>(escrowKey(mirrorId), "json");
}

async function putEscrowState(env: Env, s: EscrowState): Promise<void> {
  s.updated_at = Date.now();
  await env.CLAIMS.put(escrowKey(s.mirror_id), JSON.stringify(s));
}

/** Locate the market this mirror's specHash created, if any. listAll is
 * fine at current scale (tens of markets); revisit if it grows. */
async function findMarketBySpecHash(env: Env, contract: string, specHash: string): Promise<string | null> {
  try {
    const markets = (await nearViewCall(env, contract, "listAll", {})) as
      { marketId?: string; specHash?: string }[] | null;
    const hit = Array.isArray(markets) ? markets.find((m) => m?.specHash === specHash) : null;
    return hit?.marketId ?? null;
  } catch { return null; }
}

/** True when the broadcast receipts show a contract/runtime failure —
 * absence of failure markers is treated as ambiguous, not success; the
 * chain lookup above is what actually confirms escrow. */
function nearTxFailed(status: unknown): boolean {
  const s = JSON.stringify(status ?? "");
  return /EXECUTED_FAILURE|"Failure"|FunctionCallError|ActionError/.test(s);
}

/** Ops-account escrow: convert the mirror's USD face value to NEAR at the
 * Intents price and broadcast createMarket from NEAR_OPS_ACCOUNT. This is
 * the fiat→NEAR on-ramp — PayPal USD in, contract escrow out, platform
 * cut taken on-chain at release.
 *
 * Idempotent: every attempt is recorded in KV and reconciled against the
 * contract by specHash before rebroadcasting, so a capture→escrow retry
 * can never double-fund a market. */
export async function tryOpsEscrow(env: Env, mirror: MirrorListing): Promise<unknown> {
  const acct = env.NEAR_OPS_ACCOUNT, key = env.NEAR_OPS_SECRET_KEY, contract = env.NEAR_CONTRACT;
  if (!acct || !key || !contract) return { skipped: "NEAR_OPS_ACCOUNT/SECRET_KEY or NEAR_CONTRACT not configured" };
  const usd = mirror.original?.est_usd;
  if (!usd) return { skipped: "mirror has no USD price" };
  const args = mirror.createMarketArgs as Record<string, unknown>;
  const specHash = String(args.specHash ?? "");
  if (!specHash) return { skipped: "mirror has no specHash" };

  const prior = await getEscrowState(env, mirror.id);
  if (prior?.status === "confirmed" && prior.marketId) {
    return { escrowed: true, already: true, market_id: prior.marketId,
             txHash: prior.txHash, near_amount: prior.near_amount, usd: prior.usd };
  }

  // Reconcile any prior attempt against the chain first — a tx that
  // landed but whose response we lost must never be rebroadcast.
  const existing = await findMarketBySpecHash(env, contract, specHash);
  if (existing) {
    const s: EscrowState = {
      mirror_id: mirror.id, status: "confirmed",
      usd: String(prior?.usd ?? usd), near_price: prior?.near_price ?? 0,
      near_amount: prior?.near_amount ?? "", deposit_yocto: prior?.deposit_yocto ?? "",
      txHash: prior?.txHash, marketId: existing,
      attempts: prior?.attempts ?? 1, updated_at: 0,
    };
    await putEscrowState(env, s);
    return { escrowed: true, reconciled: true, market_id: existing, txHash: prior?.txHash };
  }

  // A recent unresolved attempt means the tx may still be propagating —
  // don't stack a second broadcast on top of it.
  if (prior && prior.attempts > 0 && Date.now() - prior.updated_at < PENDING_RETRY_MS) {
    return { pending: "prior escrow attempt unresolved — retry after confirmation window",
             txHash: prior.txHash, market_id: null, attempts: prior.attempts };
  }

  const price = await nearPriceUsd(env);
  if (!price || !Number.isFinite(price) || price <= 0) {
    return { skipped: "NEAR price unavailable or invalid (intents /tokens)" };
  }
  const nearAmount = usd / price;
  if (nearAmount <= 0.001) return { skipped: `converted ${nearAmount.toFixed(4)} NEAR below minimum` };
  const deposit = BigInt(Math.round(nearAmount * 1e24));

  const state: EscrowState = {
    mirror_id: mirror.id, status: "pending",
    usd: String(usd), near_price: price, near_amount: nearAmount.toFixed(6),
    deposit_yocto: deposit.toString(),
    attempts: (prior?.attempts ?? 0) + 1, updated_at: 0,
  };
  await putEscrowState(env, state);

  let res: { txHash: string; status: unknown };
  try {
    res = await nearFunctionCall(env,
      { accountId: acct, secretKey: key }, contract,
      {
        methodName: "createMarket",
        args: {
          specHash: args.specHash, spec: args.spec,
          deadline: args.deadline, acceptanceRule: args.acceptanceRule,
          platformBps: args.platformBps, platformTo: args.platformTo,
          payToHat: null, claimTtlNs: null, acceptanceHash: null,
        },
        gas: 50_000_000_000_000n, deposit,
      });
  } catch (e) {
    state.status = "failed";
    state.error = e instanceof Error ? e.message : String(e);
    await putEscrowState(env, state);
    return { escrowed: false, error: state.error, attempts: state.attempts,
             note: "broadcast failed — safe to retry via POST /api/mirrors/escrow" };
  }

  state.txHash = res.txHash || undefined;
  // FINAL wait means the tx executed — confirm by finding the market,
  // not by parsing receipt JSON.
  const marketId = await findMarketBySpecHash(env, contract, specHash);
  if (marketId) {
    state.status = "confirmed";
    state.marketId = marketId;
    await putEscrowState(env, state);
    return { escrowed: true, market_id: marketId, txHash: res.txHash,
             near_amount: state.near_amount, usd, near_price: price };
  }
  state.status = nearTxFailed(res.status) ? "failed" : "pending";
  state.error = state.status === "failed"
    ? `tx ${res.txHash} executed with failure: ${JSON.stringify(res.status).slice(0, 300)}`
    : undefined;
  await putEscrowState(env, state);
  return { escrowed: false, status: state.status, txHash: res.txHash,
           error: state.error, attempts: state.attempts,
           note: state.status === "pending"
             ? "tx broadcast but market not yet visible — will reconcile on next attempt"
             : "contract rejected the call — check ops account balance / args" };
}
