// paxos.ts — Paxos as licensed transmitter of record for PYUSD payouts.
//
// Paxos is a NYDFS trust company; crypto withdrawals through their API are
// transmitted under their money-transmitter licenses with sanctions
// screening and Travel Rule enforcement built in. We are their customer
// sending payments for services rendered — the compliant path for paying
// bounty winners in PYUSD on Solana.
//
// Env:
//   PAXOS_CLIENT_ID / PAXOS_CLIENT_SECRET — OAuth2 client credentials
//   PAXOS_PROFILE_ID  — profile that holds the PYUSD balance
//   PAXOS_IDENTITY_ID — optional identity the withdrawals are scoped to
//   PAXOS_API_BASE    — default sandbox; set https://api.paxos.com for prod
//
// Compliance note: above-threshold withdrawals require Travel Rule
// beneficiary metadata saved on the destination address (Paxos enforces —
// a 403 TRAVEL_RULE error comes back and we surface it, we don't retry
// blind). Collect beneficiary info on the claim's payout spec when needed.

import type { Env } from "./types";

const DEFAULT_BASE = "https://api.sandbox.paxos.com";
const DEFAULT_OAUTH = "https://oauth.sandbox.paxos.com";

function base(env: Env): { api: string; oauth: string } {
  const api = env.PAXOS_API_BASE ?? DEFAULT_BASE;
  const oauth = api.includes("sandbox") ? DEFAULT_OAUTH : "https://oauth.paxos.com";
  return { api, oauth };
}

interface Token { access_token: string; expires_at: number }
let cached: Token | null = null;

async function paxosToken(env: Env): Promise<string> {
  if (cached && cached.expires_at > Date.now() + 30_000) return cached.access_token;
  const { oauth } = base(env);
  const res = await fetch(`${oauth}/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${env.PAXOS_CLIENT_ID}:${env.PAXOS_CLIENT_SECRET}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`paxos oauth: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  cached = { access_token: body.access_token, expires_at: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

export interface PyusdWithdrawal {
  refId: string;               // idempotency key — deterministic per settlement
  amount: string;              // decimal PYUSD (6 decimals on-chain)
  destinationAddress: string;  // Solana address
  beneficiary?: {
    first_name?: string; last_name?: string;
    physical_address?: { country?: string };
  };
}

export interface PaxosResult {
  ok: boolean;
  transfer_id?: string;
  status?: string;
  error?: string;
  travel_rule_required?: boolean;
}

/** Withdraw PYUSD on Solana to a destination address via Paxos.
 * asset=PYUSD, crypto_network=SOLANA. refId must be unique per settlement —
 * Paxos dedupes on it (409 already exists → treat as prior attempt). */
export async function paxosPyusdWithdraw(env: Env, w: PyusdWithdrawal): Promise<PaxosResult> {
  if (!env.PAXOS_CLIENT_ID || !env.PAXOS_CLIENT_SECRET || !env.PAXOS_PROFILE_ID) {
    return { ok: false, error: "PAXOS_CLIENT_ID/SECRET/PROFILE_ID not configured" };
  }
  const token = await paxosToken(env);
  const { api } = base(env);
  const body: Record<string, unknown> = {
    ref_id: w.refId,
    profile_id: env.PAXOS_PROFILE_ID,
    asset: "PYUSD",
    amount: w.amount,
    crypto_network: "SOLANA",
    destination_address: w.destinationAddress,
    metadata: { source: "widespread-mirror", ref_id: w.refId },
  };
  if (env.PAXOS_IDENTITY_ID) body.identity_id = env.PAXOS_IDENTITY_ID;
  if (w.beneficiary) {
    // Travel Rule beneficiary info — required by Paxos above threshold.
    // Saved inline; Paxos also accepts it pre-saved on the destination
    // address record (PUT /v2/transfer/crypto-destination-address).
    body.beneficiary = w.beneficiary;
  }
  const res = await fetch(`${api}/v2/transfer/crypto-withdrawals`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    id?: string; status?: string; detail?: string; title?: string;
    meta?: { reason?: string };
  };
  if (res.status === 409) {
    // Duplicate ref_id — a prior attempt exists; look it up instead of
    // double-paying. Return ok with no new transfer id so caller records
    // "duplicate — verify on Paxos dashboard".
    return { ok: true, status: "duplicate_ref", error: data.detail ?? "ref_id already exists" };
  }
  if (res.status === 403) {
    const tr = /travel.?rule/i.test(data.detail ?? data.title ?? "");
    return { ok: false, travel_rule_required: tr,
             error: `paxos ${res.status}: ${data.detail ?? data.title ?? "forbidden"}` };
  }
  if (!res.ok) {
    return { ok: false, error: `paxos ${res.status}: ${data.detail ?? data.title ?? await res.text()}` };
  }
  return { ok: true, transfer_id: data.id, status: data.status ?? "PENDING" };
}

/** Read a withdrawal's current status — for polling settlement state. */
export async function paxosTransferStatus(env: Env, transferId: string): Promise<PaxosResult> {
  const token = await paxosToken(env);
  const { api } = base(env);
  const res = await fetch(`${api}/v2/transfer/transfers/${transferId}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return { ok: false, error: `paxos ${res.status}` };
  const data = (await res.json()) as { id?: string; status?: string };
  return { ok: true, transfer_id: data.id, status: data.status };
}
