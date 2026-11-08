// mirrorclaims.ts — claim + settlement lifecycle for FIAT-funded mirrors.
//
// The fiat path has no NEAR escrow: the funder's USD sits in our PayPal
// (captured via /api/mirrors/capture), and settlement pays the winner in
// PYUSD on Solana (or USD via PayPal Payouts as fallback). Claims reuse the
// same forge-artifact validation as NEAR market claims — real submissions
// only, forge-native identity, unlimited competition, attestation tokens.
//
// Endpoints:
//   POST /api/mirrors/claims   {mirror_id, forgeRef, ...} → validated claim
//   GET  /api/mirrors/claims?mirror_id=…                  → list claims
//   POST /api/mirrors/verdict  {mirror_id, claim_hash, accept, reasoning?}
//                              → winner + net payout quote (PYUSD/USD)
//   POST /api/mirrors/payout   {mirror_id}                → execute payout

import type { Env, MirrorListing } from "./types";
import { validateForgeSubmission, attestationForMirror } from "./claims";
import { feedDoc } from "./feed";
import { sendPayout } from "./payouts";
import { paxosPyusdWithdraw } from "./paxos";

const claimKey = (mirrorId: string, hash: string) => `mclaim:${mirrorId}:${hash}`;
const claimsPrefix = (mirrorId: string) => `mclaim:${mirrorId}:`;
const settleKey = (mirrorId: string) => `msettle:${mirrorId}`;

async function getMirror(env: Env, ctx: ExecutionContext | undefined, mirrorId: string): Promise<MirrorListing | null> {
  const doc = await feedDoc(env, ctx);
  return doc.mirrors?.find((m) => m.id === mirrorId) ?? null;
}

async function listClaims(env: Env, mirrorId: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.CLAIMS.list({ prefix: claimsPrefix(mirrorId), cursor, limit: 100 });
    for (const k of page.keys) {
      const v = await env.CLAIMS.get(k.name);
      if (v) out.push(JSON.parse(v) as Record<string, unknown>);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

export async function handleMirrorClaimPost(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ ok: false, error: "json body required" }, { status: 400 });
  const mirrorId = String(body.mirror_id ?? "");
  const forgeRef = String(body.forgeRef ?? "");
  if (!mirrorId || !forgeRef) {
    return Response.json({ ok: false, error: "mirror_id and forgeRef required" }, { status: 400 });
  }
  const mirror = await getMirror(env, ctx, mirrorId);
  if (!mirror) return Response.json({ ok: false, error: "mirror not found" }, { status: 404 });

  // Fiat mirrors must be funded before claims count — no escrow, no work.
  const funding = await env.CLAIMS.get(`fiatfund:${mirrorId}`).then((v) => v ? JSON.parse(v) : null);
  if (funding?.status !== "captured") {
    return Response.json({
      ok: false,
      error: `mirror not fiat-funded (status: ${funding?.status ?? "unfunded"}) — payer must complete /api/mirrors/fund + capture first`,
    }, { status: 409 });
  }

  const fv = await validateForgeSubmission(env, {
    forgeRef,
    forgeUserId: body.forgeUserId as string | undefined,
    commits: body.commits as string[] | undefined,
    evidence: body.evidence as Record<string, unknown> | undefined,
  });
  if (fv.failures.length) {
    return Response.json({ ok: false, attested: false, failures: fv.failures }, { status: 422 });
  }

  const evidence: Record<string, unknown> = { ...fv.evidence, claim_api: "mirror-v1", mirror_id: mirrorId };
  const claimHash = String(evidence.patch_fingerprint ??
    `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(evidence))))]
      .map((b) => b.toString(16).padStart(2, "0")).join("")}`);

  const token = await attestationForMirror(env, {
    mirror_id: mirrorId, forgeRef, forgeUserId: evidence.forgeUserId,
    patch_fingerprint: evidence.patch_fingerprint, claim_hash: claimHash,
  });
  if (token) evidence.attestation = token;

  const claim = {
    mirror_id: mirrorId,
    claim_hash: claimHash,
    forgeRef,
    forgeUserId: String(evidence.forgeUserId ?? ""),
    forgeLogin: evidence.forgeLogin ?? null,
    actor: body.actor ?? evidence.forgeLogin ?? "agent",
    commits: body.commits ?? [],
    evidence,
    payout: body.payout ?? null,   // {pyusd_solana_address} | {paypal_email}
    attested: !!token,
    created_at: Date.now(),
    status: "pending",
  };
  await env.CLAIMS.put(claimKey(mirrorId, claimHash), JSON.stringify(claim));

  return Response.json({
    ok: true, attested: !!token, claim,
    verification: { endpoint: "/api/claims/verify", token },
    next: "Claim recorded. Verdict via POST /api/mirrors/verdict selects the winner; payout in PYUSD (Solana) or USD (PayPal).",
  }, { status: 201 });
}

export async function handleMirrorClaimsList(url: URL, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const mirrorId = url.searchParams.get("mirror_id") ?? "";
  if (!mirrorId) return Response.json({ ok: false, error: "mirror_id required" }, { status: 400 });
  const mirror = await getMirror(env, ctx, mirrorId);
  if (!mirror) return Response.json({ ok: false, error: "mirror not found" }, { status: 404 });
  return Response.json({ ok: true, mirror_id: mirrorId, claims: await listClaims(env, mirrorId) });
}

export async function handleMirrorVerdict(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const mirrorId = String(body?.mirror_id ?? "");
  const claimHash = String(body?.claim_hash ?? "");
  const accept = body?.accept !== false;
  if (!mirrorId || !claimHash) {
    return Response.json({ ok: false, error: "mirror_id and claim_hash required" }, { status: 400 });
  }
  const mirror = await getMirror(env, ctx, mirrorId);
  if (!mirror) return Response.json({ ok: false, error: "mirror not found" }, { status: 404 });

  const prior = await env.CLAIMS.get(settleKey(mirrorId)).then((v) => v ? JSON.parse(v) : null);
  if (prior?.status === "settled") {
    return Response.json({ ok: true, status: "already_settled", settlement: prior });
  }

  const claim = await env.CLAIMS.get(claimKey(mirrorId, claimHash)).then((v) => v ? JSON.parse(v) : null);
  if (!claim) return Response.json({ ok: false, error: "claim not found" }, { status: 404 });
  if (!claim.attested) {
    return Response.json({ ok: false, error: "claim is unattested — ineligible for verdict" }, { status: 409 });
  }

  const usd = mirror.original?.est_usd ?? 0;
  const cutBps = mirror.cut_bps ?? 1000;
  const netUsd = +(usd * (1 - cutBps / 10000)).toFixed(2);
  const payoutSpec = (claim.payout ?? {}) as { pyusd_solana_address?: string; paypal_email?: string };

  const settlement = {
    mirror_id: mirrorId,
    winning_claim_hash: claimHash,
    winner: { forgeUserId: claim.forgeUserId, forgeLogin: claim.forgeLogin, actor: claim.actor },
    face_usd: usd,
    platform_cut_usd: +(usd * cutBps / 10000).toFixed(2),
    net_usd: netUsd,
    // PYUSD is $1-pegged, 6 decimals on Solana (Token-2022).
    pyusd: payoutSpec.pyusd_solana_address
      ? { asset: "PYUSD", network: "solana", mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
          amount: netUsd.toFixed(6), decimals: 6, to: payoutSpec.pyusd_solana_address }
      : null,
    paypal_usd: payoutSpec.paypal_email
      ? { asset: "USD", rail: "paypal-payouts", amount: netUsd.toFixed(2), to: payoutSpec.paypal_email }
      : null,
    verdict: accept ? "accept" : "reject",
    reasoning: String(body?.reasoning ?? ""),
    decided_at: Date.now(),
    status: accept ? "won" : "rejected",
  };
  await env.CLAIMS.put(settleKey(mirrorId), JSON.stringify(settlement));
  claim.status = accept ? "won" : "rejected";
  await env.CLAIMS.put(claimKey(mirrorId, claimHash), JSON.stringify(claim));

  return Response.json({ ok: true, settlement,
    next: accept ? "POST /api/mirrors/payout {mirror_id} to send PYUSD/USD to the winner." : null });
}

export async function handleMirrorPayout(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const mirrorId = String(body?.mirror_id ?? "");
  if (!mirrorId) return Response.json({ ok: false, error: "mirror_id required" }, { status: 400 });
  const settlement = await env.CLAIMS.get(settleKey(mirrorId)).then((v) => v ? JSON.parse(v) : null);
  if (!settlement || settlement.status !== "won") {
    return Response.json({ ok: false, error: "no winning settlement for this mirror" }, { status: 409 });
  }
  if (settlement.payout?.batch_id) {
    return Response.json({ ok: true, status: "already_paid", settlement });
  }

  // Payout rail priority: PYUSD on Solana via Paxos (licensed transmitter
  // of record — sanctions screening + Travel Rule enforced by them) when
  // the winner gave a Solana address; USD via PayPal Payouts otherwise.
  const paxosReady = !!(env.PAXOS_CLIENT_ID && env.PAXOS_CLIENT_SECRET && env.PAXOS_PROFILE_ID);
  if (settlement.pyusd) {
    const winClaim = await env.CLAIMS.get(claimKey(mirrorId, settlement.winning_claim_hash))
      .then((v) => v ? JSON.parse(v) as { payout?: { beneficiary?: Record<string, unknown> } } : null);
    const payoutSpec = (winClaim?.payout ?? {}) as {
      beneficiary?: { first_name?: string; last_name?: string; physical_address?: { country?: string } };
    };
    if (paxosReady) {
      const refId = `wide-mirror-${mirrorId}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100);
      const result = await paxosPyusdWithdraw(env, {
        refId,
        amount: settlement.pyusd.amount,
        destinationAddress: settlement.pyusd.to,
        beneficiary: payoutSpec.beneficiary,
      });
      settlement.payout = result.ok
        ? { rail: "pyusd-solana", provider: "paxos", status: result.status,
            transfer_id: result.transfer_id, ref_id: refId,
            ...(result.error ? { note: result.error } : {}) }
        : { rail: "pyusd-solana", provider: "paxos", status: "failed",
            error: result.error, travel_rule_required: !!result.travel_rule_required,
            ...(result.travel_rule_required
              ? { next: "Resubmit claim payout with beneficiary {first_name,last_name,physical_address.country} or save Travel Rule metadata on the Paxos destination address." }
              : {}) };
    } else {
      // No Paxos creds — queue the exact send for ops (PayPal app / Paxos
      // dashboard) rather than lose the settlement.
      settlement.payout = {
        rail: "pyusd-solana", status: "pending_ops",
        note: `Send ${settlement.pyusd.amount} PYUSD on Solana to ${settlement.pyusd.to} ` +
              `(mint ${settlement.pyusd.mint}).`,
      };
    }
    await env.CLAIMS.put(settleKey(mirrorId), JSON.stringify(settlement));
    return Response.json({ ok: settlement.payout.status !== "failed", settlement });
  }

  // USD fallback: PayPal Payouts to the winner's PayPal email — live today,
  // PayPal is the licensed transmitter on this rail.
  if (settlement.paypal_usd) {
    const receipt = await sendPayout(env, {
      repo: mirrorId, seq: 0, claimHash: settlement.winning_claim_hash,
      receiver: settlement.paypal_usd.to, amount: settlement.paypal_usd.amount,
      currency: "USD", note: `Widespread mirror bounty ${mirrorId} — verified winning claim`,
    });
    settlement.payout = { rail: "paypal-payouts", ...receipt };
    await env.CLAIMS.put(settleKey(mirrorId), JSON.stringify(settlement));
    return Response.json({ ok: true, settlement });
  }

  return Response.json({ ok: false, error: "winner provided no payout address (pyusd_solana_address or paypal_email)" }, { status: 409 });
}
