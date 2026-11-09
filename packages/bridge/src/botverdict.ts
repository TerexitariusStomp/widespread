// PR-bot verdict oracle: a review bot's public verdict on a wide:funded PR
// becomes a signed wide-verdict — same envelope the NEAR contract binds.
// The bot (widespread-bot) validates the GitHub event; this endpoint signs,
// settles if a recipient is bound, and stores the verdict for audit.

import { oracleEnv, signVerdict } from "./oracle";
import { sendPayout } from "./payouts";
import { writebackReceipt } from "./writeback";
import type { Env, PayoutReceipt } from "./types";

export interface BotVerdictBody {
  repo?: string;
  pr?: number;
  issue?: number;
  bot?: string;
  score?: number | string;
  verdict?: string;
  head_sha?: string;
  amount?: string;
  currency?: string;
  paypal_email?: string;
}

interface BotVerdictRecord {
  id: string;
  repo: string;
  pr: number;
  issue: number;
  bot: string;
  score: number | string;
  verdict: string;
  head_sha: string;
  oracle_verdict_sig?: string;
  payout: PayoutReceipt | null;
  writeback: { attempted: boolean; skipped_reason?: string; status_url?: string; error?: string } | null;
  reviewed_at: number;
}

const verdictKey = (repo: string, issue: number) => `botverdict:${repo}:${issue}`;

export async function handleBotVerdict(env: Env, body: BotVerdictBody): Promise<Response> {
  const repo = body.repo ?? "";
  const issue = Number(body.issue ?? body.pr ?? 0);
  const verdict = body.verdict ?? "";
  const headSha = body.head_sha ?? "";
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/i.test(repo)) return Response.json({ error: "bad repo" }, { status: 400 });
  if (!issue || !headSha || !body.bot) return Response.json({ error: "need issue, head_sha, bot" }, { status: 400 });
  if (verdict !== "accept" && verdict !== "reject") {
    return Response.json({ error: "verdict must be accept|reject" }, { status: 400 });
  }

  // Idempotent: same market + head → return the stored verdict, never re-pay.
  const prior = await env.CLAIMS.get<BotVerdictRecord>(verdictKey(repo, issue), "json").catch(() => null);
  if (prior && prior.head_sha === headSha && prior.verdict === verdict) {
    return Response.json({ status: prior.payout?.batch_id ? "accepted_paid" : "duplicate", record: prior });
  }

  const score = body.score ?? "";
  const oracle = oracleEnv(env as unknown as Parameters<typeof oracleEnv>[0]);
  let oracleSig = "";
  if (oracle && verdict === "accept") {
    const { sig } = await signVerdict(
      oracle,
      `github:${repo}#${issue}`,
      headSha,
      "accept",
      `${body.bot}:${score}`
    ).catch(() => ({ sig: "", pubkey: "" }));
    oracleSig = sig;
  }

  let payout: PayoutReceipt | null = null;
  if (verdict === "accept") {
    const amount = body.amount ?? "1.00";
    const currency = body.currency ?? "USD";
    if (!body.paypal_email) {
      payout = { attempted: false, skipped_reason: "no paypal_email bound to market", sandbox: true };
    } else if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
      payout = { attempted: false, skipped_reason: "PAYPAL_CLIENT_ID/SECRET not set", sandbox: true };
    } else {
      payout = await sendPayout(env, {
        repo,
        seq: issue,
        claimHash: `botverdict:${headSha}`,
        receiver: body.paypal_email,
        amount,
        currency,
        note: `Widespread ${body.bot} verdict ${score} on ${repo}#${issue} (PR #${body.pr ?? issue})`,
      });
    }
  }

  const writeback = verdict === "accept"
    ? await writebackReceipt(env, {
        repo,
        sha: headSha,
        accepted: true,
        description: payout?.batch_id
          ? `PayPal Payouts batch ${payout.batch_id} — ${body.bot} verdict ${score}`
          : `${body.bot} verdict ${score} (adjudicated accept)`,
        claimId: `botverdict:${repo}#${issue}`,
      })
    : { attempted: false, skipped_reason: "verdict reject — no receipt" };

  const record: BotVerdictRecord = {
    id: `botverdict:${repo}:${issue}`,
    repo,
    pr: Number(body.pr ?? issue),
    issue,
    bot: body.bot ?? "",
    score,
    verdict,
    head_sha: headSha,
    oracle_verdict_sig: oracleSig || undefined,
    payout,
    writeback,
    reviewed_at: Date.now(),
  };
  await env.CLAIMS.put(verdictKey(repo, issue), JSON.stringify(record));

  return Response.json({
    status: verdict === "reject" ? "rejected" : payout?.batch_id ? "accepted_paid" : "accepted_unpaid",
    record,
  });
}
