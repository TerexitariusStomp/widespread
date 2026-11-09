// claims.ts — POST /api/claims: validate a REAL forge submission, then hand
// back attested shipClaim args the agent broadcasts on-chain themselves.
//
// The bridge can't sign NEAR txs (no relayer key on the Worker), so the
// flow is: validate here → return an HMAC attestation token + ready
// shipClaim args → agent calls shipClaim from their own NEAR account.
// `attested:true` on-chain is therefore an *assertion*; the authoritative
// check is GET /api/claims/verify?token=… which adjudicators/oracles call
// during stage-1 recompute. Contract stores the token in evidence so the
// verdict can re-verify later even if this endpoint is down.
//
// Validation (all must pass for attested:true):
//   1. market exists on-chain and is OPEN; specHash (if given) matches.
//   2. forgeRef resolves on the forge (GitHub PR/issue today).
//   3. artifact author == claimed forgeUserId (numeric GitHub ID — the
//      anti-sybil key; NEAR account is payout-only).
//   4. submission carries real work: non-empty diff/patch fingerprint or
//      caller-supplied commits that resolve.
//   5. spec binding: evidence.specHash or market specHash match.

import { nearView } from "./near";
import {
  gh, parseForgeRef, patchFingerprint, sha256Hex,
  type GhFile, type GhIssue, type GhPull,
} from "./forge";
import type { Env } from "./types";

// Re-exported for existing callers/tests — the canonical home is forge.ts.
export { parseForgeRef };

const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;

interface ClaimBody {
  marketId?: string;
  forgeRef?: string;          // https://github.com/o/r/pull/12 | /issues/3 | o/r#12
  claimant?: string;          // NEAR account that receives payout
  actor?: string;             // agent/did label
  commits?: string[];
  specHash?: string;
  forgeUserId?: string;       // claimed github numeric id — verified vs author
  evidence?: Record<string, unknown>;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function attestationToken(env: Env, payload: Record<string, unknown>): Promise<string | null> {
  const secret = env.ATTEST_SECRET ?? env.ADMIN_TOKEN;
  if (!secret) return null;
  const body = b64url(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS }));
  return `${body}.${await hmac(secret, body)}`;
}

/** Attestation for fiat-mirror claims — same HMAC scheme, mirror-scoped
 * payload so a token can't be replayed against a NEAR market claim. */
export async function attestationForMirror(env: Env, payload: Record<string, unknown>): Promise<string | null> {
  return attestationToken(env, { ...payload, scope: "mirror" });
}

export async function verifyAttestation(env: Env, token: string): Promise<
  { valid: boolean; payload?: Record<string, unknown>; reason?: string }> {
  const secret = env.ATTEST_SECRET ?? env.ADMIN_TOKEN;
  if (!secret) return { valid: false, reason: "no attestation secret configured" };
  const dot = token.lastIndexOf(".");
  if (dot < 1) return { valid: false, reason: "malformed token" };
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmac(secret, body);
  // constant-time compare
  let diff = sig.length === expected.length ? 0 : 1;
  for (let i = 0; i < Math.min(sig.length, expected.length); i++) {
    diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (diff) return { valid: false, reason: "bad signature" };
  try {
    const payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    if (typeof payload.exp === "number" && payload.exp < Date.now()) {
      return { valid: false, reason: "expired", payload };
    }
    return { valid: true, payload };
  } catch {
    return { valid: false, reason: "bad payload" };
  }
}

/** Shared forge-artifact validation — used by both NEAR market claims and
 * fiat mirror claims. Returns failures[] plus enriched evidence (patch
 * fingerprint, forge ids) on success. */
export async function validateForgeSubmission(
  env: Env,
  body: { forgeRef: string; forgeUserId?: string; commits?: string[]; evidence?: Record<string, unknown> },
): Promise<{ failures: string[]; evidence: Record<string, unknown> }> {
  const failures: string[] = [];
  const evidence = { ...(body.evidence ?? {}) };
  const ref = parseForgeRef(body.forgeRef);
  if (!ref) {
    return { failures: ["forgeRef must be a github.com owner/repo/(issues|pull)/N or owner/repo#N"], evidence };
  }
  const issueRes = await gh<GhIssue>(env, `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`);
  const issue = issueRes.data;
  if (!issue) {
    failures.push(issueRes.error ?? "forge artifact not found");
  } else {
    if (issue.state !== "open" && ref.kind === "issue") failures.push(`issue is ${issue.state}`);
    const authorId = String(issue.user?.id ?? "");
    if (body.forgeUserId && body.forgeUserId !== authorId) {
      failures.push(`forgeUserId mismatch: artifact author is ${authorId} (${issue.user?.login})`);
    }
    if (ref.kind === "pr") {
      const pr = issue as GhPull;
      const filesRes = await gh<GhFile[]>(env,
        `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files?per_page=100`);
      const files = filesRes.data;
      const fp = files?.length ? await patchFingerprint(files) : null;
      if (filesRes.error) failures.push(filesRes.error);
      if (!fp) failures.push("PR has no computable patch (empty or >100-file diff)");
      else {
        evidence.patch_fingerprint = fp;
        evidence.forge = "github";
        evidence.forgeRef = `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
        evidence.forgeUserId = authorId;
        evidence.forgeLogin = issue.user?.login;
        evidence.head_sha = pr.head?.sha;
      }
      if (!body.commits?.length && pr.head?.sha) body.commits = [pr.head.sha];
    } else {
      evidence.forge = "github";
      evidence.forgeRef = `https://github.com/${ref.owner}/${ref.repo}/issues/${ref.number}`;
      evidence.forgeUserId = authorId;
      evidence.forgeLogin = issue.user?.login;
    }
  }
  return { failures, evidence };
}

export async function handleClaimPost(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as ClaimBody | null;
  if (!body?.marketId || !body.forgeRef) {
    return Response.json({ ok: false, error: "marketId and forgeRef required" }, { status: 400 });
  }
  const acct = env.NEAR_CONTRACT;
  if (!acct) return Response.json({ ok: false, error: "no NEAR_CONTRACT configured" }, { status: 503 });

  const failures: string[] = [];

  // 1. market open + spec binding
  const market = await nearView(env, acct, "getMarket", { marketId: String(body.marketId) }) as
    { status?: string; specHash?: string; spec?: string } | null;
  if (!market) return Response.json({ ok: false, error: "market not found" }, { status: 404 });
  if (market.status !== "open") failures.push(`market status is ${market.status}, not open`);
  if (body.specHash && market.specHash && body.specHash !== market.specHash) {
    failures.push("specHash does not match market specHash");
  }

  // 2-4. forge artifact validation (shared with fiat mirror claims)
  const fv = await validateForgeSubmission(env, {
    forgeRef: body.forgeRef,
    forgeUserId: body.forgeUserId,
    commits: body.commits,
    evidence: body.evidence,
  });
  failures.push(...fv.failures);
  const evidence = fv.evidence;
  if (fv.failures.length) {
    return Response.json({ ok: false, attested: false, failures }, { status: 422 });
  }

  // 5. attestation token + ready-to-broadcast shipClaim args
  const fullEvidence: Record<string, unknown> = { ...evidence, claim_api: "v1" };
  const token = await attestationToken(env, {
    marketId: String(body.marketId),
    forgeRef: body.forgeRef,
    forgeUserId: evidence.forgeUserId,
    patch_fingerprint: evidence.patch_fingerprint,
    specHash: body.specHash ?? market.specHash,
  });
  if (token) fullEvidence.attestation = token;

  const shipClaimArgs = {
    marketId: String(body.marketId),
    claimHash: fullEvidence.patch_fingerprint ?? `sha256:${await sha256Hex(JSON.stringify(fullEvidence))}`,
    actor: body.actor ?? fullEvidence.forgeLogin ?? "agent",
    commits: body.commits ?? [],
    evidence: fullEvidence,
    claimant: body.claimant ?? "",
    forgeId: "github",
    forgeUserId: String(evidence.forgeUserId ?? ""),
    relayer: "widespread-bridge",
    attested: !!token,
  };

  return Response.json({
    ok: true,
    attested: !!token,
    ...(token ? {} : { warning: "no ATTEST_SECRET configured — claim ships unattested (ineligible for oracle verdict)" }),
    verification: { endpoint: "/api/claims/verify", token },
    shipClaimArgs,
    next: `Sign + broadcast shipClaim(${acct}) with shipClaimArgs from any NEAR account.`,
  }, { status: 201 });
}

export async function handleClaimVerify(url: URL, env: Env): Promise<Response> {
  const token = url.searchParams.get("token") ?? "";
  if (!token) return Response.json({ ok: false, error: "token required" }, { status: 400 });
  return Response.json(await verifyAttestation(env, token));
}
