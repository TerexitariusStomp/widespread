// PayPal Payouts — the money rail. Sandbox base URL is the default; the
// batch API is identical live, only api-m.paypal.com + a live app differ.

import type { Env, PayoutReceipt } from "./types";

interface PayPalToken {
  access_token: string;
  expires_at: number;
}

let cached: PayPalToken | null = null;

async function accessToken(env: Env): Promise<string> {
  if (cached && cached.expires_at > Date.now() + 30_000) return cached.access_token;
  const res = await fetch(`${env.PAYPAL_API_BASE}/v1/oauth2/token`, {
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

export interface PayoutRequest {
  repo: string;
  seq: number;
  claimHash: string;
  receiver: string;
  amount: string;
  currency: string;
  note: string;
}

interface PayoutBatchResponse {
  batch_header?: { payout_batch_id?: string; batch_status?: string };
  items?: {
    payout_item_id?: string;
    transaction_id?: string;
    transaction_status?: string;
    receiver?: string;
  }[];
  links?: { rel: string; href: string }[];
}

function isSandbox(env: Env): boolean {
  return env.PAYPAL_API_BASE.includes("sandbox");
}

/**
 * POST /v1/payments/payouts then read the batch back for the transaction
 * id — the receipt the dashboard displays. sender_batch_id is deterministic
 * per claim (repo+seq+entry hash) so a retried review can't double-pay —
 * PayPal dedupes on it — while a post-reset claim at the same seq still
 * earns its own payout (different hash → different batch id).
 */
export async function sendPayout(env: Env, req: PayoutRequest): Promise<PayoutReceipt> {
  const receipt: PayoutReceipt = {
    attempted: true,
    sandbox: isSandbox(env),
    receiver: req.receiver,
    amount: req.amount,
    currency: req.currency,
  };
  try {
    const token = await accessToken(env);
    const senderBatchId = `slopcash-${req.repo.replace("/", "-")}-${req.seq}-${req.claimHash.slice(0, 8)}`;
    receipt.sender_batch_id = senderBatchId;
    const res = await fetch(`${env.PAYPAL_API_BASE}/v1/payments/payouts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sender_batch_header: {
          sender_batch_id: senderBatchId,
          recipient_type: "EMAIL",
          email_subject: "Widespread bounty — your ship was accepted",
          email_message:
            "A delta-git ship attestation was verified by the Slop.cash AI adjudicator. " +
            "This payout was released through PayPal Payouts.",
        },
        items: [
          {
            recipient_type: "EMAIL",
            amount: { value: req.amount, currency: req.currency },
            receiver: req.receiver,
            note: req.note,
            sender_item_id: `claim-${req.seq}`,
          },
        ],
      }),
    });
    const created = (await res.json().catch(() => ({}))) as PayoutBatchResponse & {
      name?: string;
      message?: string;
    };
    if (!res.ok) {
      receipt.error = `payouts: HTTP ${res.status} ${created.name ?? ""} ${created.message ?? ""}`.trim();
      return receipt;
    }
    receipt.batch_id = created.batch_header?.payout_batch_id;
    receipt.batch_status = created.batch_header?.batch_status;
    receipt.links = created.links;

    // Read the batch back — item rows carry the PayPal transaction id.
    if (receipt.batch_id) {
      const batch = await readBatch(env, token, receipt.batch_id);
      if (batch) {
        receipt.batch_status = batch.batch_header?.batch_status ?? receipt.batch_status;
        const item = batch.items?.[0];
        receipt.transaction_id = item?.transaction_id;
        receipt.transaction_status = item?.transaction_status;
      }
    }
    return receipt;
  } catch (e) {
    receipt.error = String(e);
    return receipt;
  }
}

async function readBatch(
  env: Env,
  token: string,
  batchId: string
): Promise<PayoutBatchResponse | null> {
  return (await fetch(`${env.PAYPAL_API_BASE}/v1/payments/payouts/${batchId}`, {
    headers: { authorization: `Bearer ${token}` },
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as PayoutBatchResponse | null;
}

/**
 * Refresh an already-created batch instead of re-POSTing: re-reviews never
 * create a second payout, they just re-read settlement state.
 */
export async function refreshBatch(env: Env, prior: PayoutReceipt): Promise<PayoutReceipt> {
  const receipt: PayoutReceipt = { ...prior };
  if (!prior.batch_id) return receipt;
  try {
    const token = await accessToken(env);
    const batch = await readBatch(env, token, prior.batch_id);
    if (!batch) {
      receipt.error = `batch readback failed`;
      return receipt;
    }
    receipt.batch_status = batch.batch_header?.batch_status ?? prior.batch_status;
    const item = batch.items?.[0];
    receipt.transaction_id = item?.transaction_id ?? prior.transaction_id;
    receipt.transaction_status = item?.transaction_status ?? prior.transaction_status;
    delete receipt.error;
    return receipt;
  } catch (e) {
    receipt.error = String(e);
    return receipt;
  }
}
