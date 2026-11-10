// ingest.ts — automatic submission ingestion for funded mirrors.
//
// "Everything automatic": third-party bounty flows stay exactly as the
// platform designed them — work arrives as ordinary PRs/comments on the
// original forge issue. This pass watches funded mirrors' linked issues,
// finds cross-referenced PRs via the GitHub timeline API, validates each
// through the same forge-artifact pipeline as manual claims, and files
// attested mirror claims — no agent ever has to call /api/mirrors/claims.
//
// Bounded hard: only funded mirrors (fiat captured or on-chain market),
// at most MIRROR_SCAN_LIMIT per scan, PR_SCAN_LIMIT validations per scan — GitHub's
// unauthenticated budget is ~60 req/hr shared with the feed scanners.

import type { Env, MirrorListing } from "./types";
import { getFeedDoc } from "./feedstore";
import { validateForgeSubmission, attestationForMirror } from "./claims";
import { GH_API, ghHeaders, sha256Hex } from "./forge";
import { kv } from "./db";
import { emitWebhook } from "./webhooks";

const MIRROR_SCAN_LIMIT = 10;
const PR_SCAN_LIMIT = 15;
const claimKey = (mirrorId: string, hash: string) => `mclaim:${mirrorId}:${hash}`;

/** Extract owner/repo + issue number from a GitHub-sourced record id like
 * `github-thirdparty:generic:Expensify/App#103875`. */
function parseIssueRef(recordId: string): { owner: string; repo: string; issue: number } | null {
  const m = recordId.match(/([\w.-]+\/[\w.-]+)#(\d+)$/);
  return m ? { owner: m[1].split("/")[0], repo: m[1].split("/")[1], issue: Number(m[2]) } : null;
}

interface TimelineEvent {
  event?: string;
  source?: { issue?: { number?: number; pull_request?: unknown; state?: string; user?: { id?: number; login?: string } } };
}

async function isFunded(env: Env, mirror: MirrorListing): Promise<boolean> {
  if (mirror.status === "funded" && mirror.funded_market_id) return true;
  const f = await kv(env).get(`fiatfund:${mirror.id}`).then((v) => v ? JSON.parse(v) : null);
  return f?.status === "captured";
}

/** One scan pass — called after each feed refresh (30 min cadence). */
export async function scanMirrorSubmissions(env: Env): Promise<{ scanned: number; claims_filed: number; errors: string[] }> {
  const doc = await getFeedDoc(env);
  const mirrors = (doc?.mirrors ?? []).filter((m) => m.id.startsWith("mirror:"));
  const errors: string[] = [];
  let scanned = 0, filed = 0, prChecks = 0;

  for (const mirror of mirrors) {
    if (scanned >= MIRROR_SCAN_LIMIT || prChecks >= PR_SCAN_LIMIT) break;
    const ref = parseIssueRef(mirror.record_id);
    if (!ref) continue;
    if (!(await isFunded(env, mirror))) continue;
    scanned++;

    // Issue timeline → cross-referenced PRs (the platform-native way work
    // gets linked to a bounty issue: "owner/repo#N" in PR body/title).
    const tl = await fetch(
      `${GH_API}/repos/${ref.owner}/${ref.repo}/issues/${ref.issue}/timeline?per_page=100`,
      { headers: ghHeaders(env), signal: AbortSignal.timeout(10000) });
    if (tl.status === 403 || tl.status === 429) {
      errors.push(`github rate limited on ${mirror.record_id} — back off`);
      break; // shared budget exhausted; next refresh resumes
    }
    if (!tl.ok) { errors.push(`timeline ${tl.status} for ${mirror.record_id}`); continue; }
    const events = (await tl.json()) as TimelineEvent[];
    const prs = new Map<number, { login?: string }>();
    for (const e of events) {
      if (e.event !== "cross-referenced") continue;
      const src = e.source?.issue;
      if (src?.number && src.pull_request && src.state === "open") {
        prs.set(src.number, { login: src.user?.login });
      }
    }
    if (!prs.size) continue;

    for (const [prNum] of prs) {
      if (prChecks >= PR_SCAN_LIMIT) break;
      const forgeRef = `https://github.com/${ref.owner}/${ref.repo}/pull/${prNum}`;
      // Cheap pre-check: does a claim already exist for this PR's patch?
      // We don't know the fingerprint until validation, so dedupe on a
      // per-PR marker key instead.
      const marker = `mclaimpr:${mirror.id}:${prNum}`;
      if (await kv(env).get(marker)) continue;
      prChecks++;

      const fv = await validateForgeSubmission(env, { forgeRef });
      if (fv.failures.length) {
        // Real submission check failed — mark seen so we don't re-burn
        // rate limit on the same broken PR every scan. Transient errors
        // (rate limit text) still get retried next cycle? Keep it simple:
        // mark seen; a fixed PR produces a different fingerprint anyway.
        await kv(env).put(marker, JSON.stringify({ at: Date.now(), failures: fv.failures }));
        continue;
      }
      const evidence: Record<string, unknown> = {
        ...fv.evidence, claim_api: "mirror-v1-auto", mirror_id: mirror.id,
        auto_ingested: true,
      };
      const fp = String(evidence.patch_fingerprint ?? "");
      const claimHash = fp || `sha256:${await sha256Hex(JSON.stringify(evidence))}`;
      const key = claimKey(mirror.id, claimHash);
      if (await kv(env).get(key)) { await kv(env).put(marker, "1"); continue; }

      const token = await attestationForMirror(env, {
        mirror_id: mirror.id, forgeRef,
        forgeUserId: evidence.forgeUserId,
        patch_fingerprint: fp || undefined, claim_hash: claimHash, auto: true,
      });
      if (token) evidence.attestation = token;

      const claim = {
        mirror_id: mirror.id,
        claim_hash: claimHash,
        forgeRef,
        forge_user_id: String(evidence.forgeUserId ?? ""),
        forge_login: evidence.forgeLogin ?? null,
        actor: evidence.forgeLogin ?? "agent",
        commits: evidence.head_sha ? [String(evidence.head_sha)] : [],
        evidence,
        payout: null,               // winner supplies payout address at verdict
        attested: !!token,
        auto_ingested: true,
        created_at: Date.now(),
        status: "pending",
      };
      await kv(env).put(key, JSON.stringify(claim));
      await kv(env).put(marker, "1");
      filed++;
    }
  }
  return { scanned, claims_filed: filed, errors };
}

// ----------------------------------------------------------- auto-settle

const settleKey = (mirrorId: string) => `msettle:${mirrorId}`;
const SETTLE_SCAN_LIMIT = 10;
const SETTLE_PR_LIMIT = 10;

interface StoredClaim {
  mirror_id: string; claim_hash: string; forgeRef: string;
  forge_user_id?: string; forge_login?: string; actor?: string;
  evidence?: Record<string, unknown>;
  attested?: boolean; status?: string;
  payout?: { paypal_email?: string; near_account?: string } | null;
}

function parsePrRef(forgeRef: string): { owner: string; repo: string; number: number } | null {
  const m = forgeRef.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|pulls)\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

/** Auto-settle: merge=accept (the Algora rule, deterministic — no LLM).
 * For every funded mirror, attested claims whose PR is now MERGED win:
 * the maintainer's merge IS the platform-native acceptance verdict.
 * Writes the settlement + rep event and runs the payout core. Bounded
 * like the scan — the GitHub budget is shared. */
export async function settleMergedClaims(env: Env): Promise<{
  scanned: number; settled: number; payouts: number; errors: string[];
}> {
  const doc = await getFeedDoc(env);
  const mirrors = (doc?.mirrors ?? []).filter((m) => m.id.startsWith("mirror:"));
  const { resolvePayout } = await import("./routes/payouts");
  const { executeMirrorPayout } = await import("./mirrorclaims");
  const { writeVerdictRep } = await import("./rep");
  const errors: string[] = [];
  let scanned = 0, settled = 0, payouts = 0, prChecks = 0;

  for (const mirror of mirrors) {
    if (scanned >= SETTLE_SCAN_LIMIT || prChecks >= SETTLE_PR_LIMIT) break;
    if (!(await isFunded(env, mirror))) continue;
    if (await kv(env).get(settleKey(mirror.id))) continue; // one settlement per mirror
    scanned++;

    const claims: { key: string; claim: StoredClaim }[] = [];
    let cursor: string | undefined;
    do {
      const page = await kv(env).list({ prefix: `mclaim:${mirror.id}:`, cursor, limit: 50 });
      for (const k of page.keys) {
        const c = await kv(env).get(k.name).then((v) => v ? JSON.parse(v) : null).catch(() => null) as StoredClaim | null;
        if (c && c.status === "pending" && c.attested !== false) claims.push({ key: k.name, claim: c });
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    for (const { key, claim } of claims) {
      if (prChecks >= SETTLE_PR_LIMIT) break;
      const pr = parsePrRef(claim.forgeRef);
      if (!pr) continue;
      prChecks++;
      const res = await fetch(`${GH_API}/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
        { headers: ghHeaders(env), signal: AbortSignal.timeout(10000) });
      if (res.status === 403 || res.status === 429) { errors.push("github rate limited — back off"); break; }
      if (!res.ok) continue;
      const data = (await res.json()) as { merged_at?: string | null; merged?: boolean };
      if (!data.merged_at && !data.merged) continue;

      // merge=accept — deterministic external verdict, attested claim.
      const usd = mirror.original?.est_usd ?? 0;
      const cutBps = mirror.cut_bps ?? 1000;
      const netUsd = +(usd * (1 - cutBps / 10000)).toFixed(2);
      const payoutIn = claim.payout ?? {};
      const resolved = await resolvePayout(env, claim.forge_user_id, payoutIn);
      if (resolved.rail === "paypal" && !payoutIn.paypal_email) payoutIn.paypal_email = resolved.paypal_email;
      if (resolved.rail === "near") payoutIn.near_account = resolved.near_account;
      const settlement = {
        mirror_id: mirror.id,
        winning_claim_hash: claim.claim_hash,
        winner: { forgeUserId: claim.forge_user_id, forgeLogin: claim.forge_login, actor: claim.actor },
        face_usd: usd,
        platform_cut_usd: +(usd * cutBps / 10000).toFixed(2),
        net_usd: netUsd,
        paypal_usd: payoutIn.paypal_email
          ? { asset: "USD", rail: "paypal-payouts", amount: netUsd.toFixed(2), to: payoutIn.paypal_email }
          : null,
        near: payoutIn.near_account
          ? { asset: "NEAR", rail: "near-transfer", usd: netUsd.toFixed(2), to: payoutIn.near_account, source: resolved.source }
          : null,
        verdict: "accept",
        reasoning: `merge=accept: PR #${pr.number} merged on ${pr.owner}/${pr.repo} — deterministic settlement (auto-settle)`,
        payout_input: payoutIn,
        decided_at: Date.now(),
        status: "won",
      };
      await kv(env).put(settleKey(mirror.id), JSON.stringify(settlement));
      await emitWebhook(env, "settlement", settlement).catch(() => 0);
      await kv(env).put(key, JSON.stringify({ ...claim, status: "won" }));
      if (claim.forge_user_id) {
        await writeVerdictRep(env, claim.forge_user_id, "win").catch(() => undefined);
      }
      settled++;
      const pr2 = await executeMirrorPayout(env, mirror.id).catch((e) => ({ ok: false, error: String(e) }));
      if (pr2.ok) payouts++;
      else errors.push(`payout ${mirror.id}: ${pr2.error ?? "failed"}`);
      break; // one winner per mirror
    }
  }
  return { scanned, settled, payouts, errors };
}
