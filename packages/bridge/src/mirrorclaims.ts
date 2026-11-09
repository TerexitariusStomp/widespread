// mirrorclaims.ts — claim + settlement lifecycle for FIAT-funded mirrors.
//
// The fiat path has no NEAR escrow: the funder's USD sits in our PayPal
// (captured via /api/mirrors/capture), and settlement pays the winner in
// USD via PayPal Payouts. Claims reuse the same forge-artifact validation
// as NEAR market claims — real submissions only, forge-native identity,
// unlimited competition, attestation tokens.
//
// Endpoints:
//   POST /api/mirrors/claims   {mirror_id, forgeRef, ...} → validated claim
//   GET  /api/mirrors/claims?mirror_id=…                  → list claims
//   POST /api/mirrors/verdict  {mirror_id, claim_hash, accept, reasoning?}
//                              → winner + net payout quote (USD)
//   POST /api/mirrors/payout   {mirror_id}                → execute payout

import type { Env, MirrorListing } from "./types";
import { validateForgeSubmission, attestationForMirror } from "./claims";
import { sha256Hex } from "./forge";
import { feedDoc } from "./feed";
import { sendPayout } from "./payouts";
import { resolvePayout } from "./routes/payouts";
import { bumpFunderRep } from "./rep";

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
  const claimHash = String(evidence.patch_fingerprint ?? `sha256:${await sha256Hex(JSON.stringify(evidence))}`);

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
    payout: body.payout ?? null,   // {paypal_email}
    attested: !!token,
    created_at: Date.now(),
    status: "pending",
  };
  await env.CLAIMS.put(claimKey(mirrorId, claimHash), JSON.stringify(claim));

  return Response.json({
    ok: true, attested: !!token, claim,
    verification: { endpoint: "/api/claims/verify", token },
    next: "Claim recorded. Verdict via POST /api/mirrors/verdict selects the winner; payout in USD via PayPal.",
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
  if (!body) return Response.json({ ok: false, error: "json body required" }, { status: 400 });
  const mirrorId = String(body.mirror_id ?? "");
  const claimHash = String(body.claim_hash ?? "");
  const accept = body.accept !== false;
  if (!mirrorId || !claimHash) {
    return Response.json({ ok: false, error: "mirror_id and claim_hash required" }, { status: 400 });
  }
  const mirror = await getMirror(env, ctx, mirrorId);
  if (!mirror) return Response.json({ ok: false, error: "mirror not found" }, { status: 404 });

  // Verdict is one-shot: any recorded settlement (won or rejected) is
  // final. The old check looked for status==="settled" which is never
  // written — a second verdict could overwrite the winner and re-open
  // the payout path for a double-spend.
  const prior = await env.CLAIMS.get(settleKey(mirrorId)).then((v) => v ? JSON.parse(v) : null);
  if (prior) {
    return Response.json({ ok: true, status: "already_decided", settlement: prior });
  }

  const claim = await env.CLAIMS.get(claimKey(mirrorId, claimHash)).then((v) => v ? JSON.parse(v) : null);
  if (!claim) return Response.json({ ok: false, error: "claim not found" }, { status: 404 });
  if (!claim.attested) {
    return Response.json({ ok: false, error: "claim is unattested — ineligible for verdict" }, { status: 409 });
  }

  const usd = mirror.original?.est_usd ?? 0;
  const cutBps = mirror.cut_bps ?? 1000;
  const netUsd = +(usd * (1 - cutBps / 10000)).toFixed(2);
  // Resolution order: body.payout → claim.payout → contributor's bound
  // wallet. Destination only — the amount is always post-cut net_usd.
  const payoutIn = (body.payout ?? claim.payout ?? {}) as {
    paypal_email?: string; near_account?: string;
  };
  const resolved = await resolvePayout(env, claim.forgeUserId, payoutIn);
  if (resolved.rail === "paypal" && !payoutIn.paypal_email) payoutIn.paypal_email = resolved.paypal_email;
  if (resolved.rail === "near") payoutIn.near_account = resolved.near_account;
  const settlement = {
    mirror_id: mirrorId,
    winning_claim_hash: claimHash,
    winner: { forgeUserId: claim.forgeUserId, forgeLogin: claim.forgeLogin, actor: claim.actor },
    face_usd: usd,
    platform_cut_usd: +(usd * cutBps / 10000).toFixed(2),
    net_usd: netUsd,
    paypal_usd: payoutIn.paypal_email
      ? { asset: "USD", rail: "paypal-payouts", amount: netUsd.toFixed(2), to: payoutIn.paypal_email }
      : null,
    near: payoutIn.near_account
      ? { asset: "NEAR", rail: "near-transfer", usd: netUsd.toFixed(2), to: payoutIn.near_account, source: resolved.source }
      : null,
    verdict: accept ? "accept" : "reject",
    reasoning: String(body?.reasoning ?? ""),
    payout_input: payoutIn,
    decided_at: Date.now(),
    status: accept ? "won" : "rejected",
  };
  await env.CLAIMS.put(settleKey(mirrorId), JSON.stringify(settlement));
  claim.status = accept ? "won" : "rejected";
  await env.CLAIMS.put(claimKey(mirrorId, claimHash), JSON.stringify(claim));

  return Response.json({ ok: true, settlement,
    next: accept ? "POST /api/mirrors/payout {mirror_id} to send USD to the winner via PayPal." : null });
}

export async function handleMirrorPayout(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const mirrorId = String(body?.mirror_id ?? "");
  if (!mirrorId) return Response.json({ ok: false, error: "mirror_id required" }, { status: 400 });
  const settlement = await env.CLAIMS.get(settleKey(mirrorId)).then((v) => v ? JSON.parse(v) : null);
  if (!settlement || settlement.status !== "won") {
    return Response.json({ ok: false, error: "no winning settlement for this mirror" }, { status: 409 });
  }
  // Terminal marker: PayPal batch_id (transaction_id also lands on the
  // receipt once the batch read-back succeeds).
  if (settlement.payout?.batch_id || settlement.payout?.transaction_id) {
    return Response.json({ ok: true, status: "already_paid", settlement });
  }
  // In-flight guard: mark "sending" before touching the rail so a
  // concurrent retry can't double-pay during the KV propagation window.
  if (settlement.payout?.status === "sending"
      && Date.now() - Number(settlement.payout.attempted_at ?? 0) < 10 * 60 * 1000) {
    return Response.json({ ok: true, status: "payout_in_progress", settlement });
  }
  settlement.payout = { status: "sending", attempted_at: Date.now() };
  await env.CLAIMS.put(settleKey(mirrorId), JSON.stringify(settlement));

  try {
    // USD rail: PayPal Payouts to the winner's PayPal email — PayPal is the
    // licensed transmitter on this rail.
    if (settlement.paypal_usd) {
      const receipt = await sendPayout(env, {
        repo: mirrorId, seq: 0, claimHash: settlement.winning_claim_hash,
        receiver: settlement.paypal_usd.to, amount: settlement.paypal_usd.amount,
        currency: "USD", note: `Widespread mirror bounty ${mirrorId} — verified winning claim`,
      });
      settlement.payout = { rail: "paypal-payouts", ...receipt };
      await env.CLAIMS.put(settleKey(mirrorId), JSON.stringify(settlement));
      // Funder rep — pays out. Wash guard: don't credit a funder who paid
      // their own claim (payer email == winner's payout email).
      const funding = await env.CLAIMS.get(`fiatfund:${mirrorId}`).then((v) => v ? JSON.parse(v) : null).catch(() => null);
      const payer = funding?.payer_email;
      if (payer && payer.toLowerCase() !== settlement.paypal_usd.to?.toLowerCase()) {
        await bumpFunderRep(env, payer, "paid").catch(() => undefined);
      }
      return Response.json({ ok: true, settlement });
    }

    return Response.json({ ok: false, error: "winner provided no PayPal payout email (paypal_email)" }, { status: 409 });
  } catch (e) {
    // A thrown rail call must not leave the settlement stuck in "sending".
    settlement.payout = { status: "failed",
      error: e instanceof Error ? e.message : String(e) };
    await env.CLAIMS.put(settleKey(mirrorId), JSON.stringify(settlement));
    return Response.json({ ok: false, error: settlement.payout.error, settlement }, { status: 500 });
  }
}
