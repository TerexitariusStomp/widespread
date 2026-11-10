// futarchy.ts — automated metric resolution for Foreguild proposals.
//
// The contract's resolver registry binds metrics to oracle accounts;
// this is the bridge side that actually computes + posts them. For
// open proposals past deadline whose metricId we can measure from
// live data, the oracle account (a registered resolver) attests the
// value with an evidence hash binding the source snapshot.
//
// Metric scale: floats are expressed in basis points (0.85 → 8500) so
// BigInt comparisons on-chain stay exact.

import type { Env } from "./types";
import { nearView } from "./near";
import { nearFunctionCall } from "./nearops";
import { oracleEnv } from "./oracle";
import { repIndex } from "./rep";
import { sha256Hex } from "./forge";
import { kv } from "./db";

interface FutarchyProposal {
  id: string; title?: string; metricId: string;
  threshold: string; comparator: string; deadline: string;
  status: string; challengeWindowNs?: string;
}

const BPS = 10_000n;

/** Compute the current value of a metricId we can measure. Returns
 * {value, evidence} — value as BigInt (bps-scaled where fractional). */
async function computeMetric(env: Env, metricId: string): Promise<
  { value: bigint; evidence: Record<string, unknown> } | null> {
  const at = Date.now();
  switch (metricId) {
    case "settle_rate": {
      // paid payouts / won settlements, basis points
      let won = 0, paid = 0;
      let cursor: string | undefined;
      do {
        const page = await kv(env).list({ prefix: "msettle:", cursor, limit: 200 });
        for (const k of page.keys) {
          const raw = await kv(env).get(k.name).catch(() => null);
          if (!raw) continue;
          const s = JSON.parse(raw) as { status?: string; payout?: { batch_id?: string; transaction_id?: string } };
          if (s.status === "won") { won++; if (s.payout?.batch_id || s.payout?.transaction_id) paid++; }
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      const rate = won ? Math.round((paid / won) * Number(BPS)) : 0;
      return { value: BigInt(rate), evidence: { metric: "settle_rate", won, paid, at } };
    }
    case "contributor_rep_wins": {
      const idx = await repIndex(env);
      const wins = Object.values(idx.contrib).reduce((a, c) => a + (c.wins ?? 0), 0);
      return { value: BigInt(wins), evidence: { metric: "contributor_rep_wins", wins, actors: Object.keys(idx.contrib).length, at } };
    }
    case "feed_match_quality": {
      const doc = await kv(env).get("feed:doc").catch(() => null);
      const records = doc ? (JSON.parse(doc).records ?? []) as { quality?: { score?: number } }[] : [];
      const scores = records.map((r) => r.quality?.score).filter((s): s is number => typeof s === "number");
      const mean = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * Number(BPS)) : 0;
      return { value: BigInt(mean), evidence: { metric: "feed_match_quality", mean_bps: mean, n: scores.length, at } };
    }
    default:
      return null;
  }
}

/** Resolve every open proposal whose deadline passed and whose metricId
 * we can measure. Signs as ORACLE_ACCOUNT — a registered resolver. */
export async function resolveExpiredProposals(env: Env): Promise<{
  resolved: string[]; skipped: string[]; errors: string[];
}> {
  const acct = (env as { FUTARCHY_CONTRACT?: string }).FUTARCHY_CONTRACT;
  const out = { resolved: [] as string[], skipped: [] as string[], errors: [] as string[] };
  if (!acct) return out;
  const ops = oracleEnv(env);
  if (!ops) return { ...out, errors: ["oracle env not configured"] };

  const proposals = (await nearView(env, acct, "listProposals", {}).catch(() => null)) as FutarchyProposal[] | null;
  if (!proposals) return { ...out, errors: ["listProposals failed"] };
  const nowNs = BigInt(Date.now()) * 1_000_000n;

  for (const p of proposals) {
    if (p.status !== "open") continue;
    if (BigInt(p.deadline) > nowNs) { out.skipped.push(`${p.id}:not-expired`); continue; }
    const metric = await computeMetric(env, p.metricId).catch(() => null);
    if (!metric) { out.skipped.push(`${p.id}:unknown-metric(${p.metricId})`); continue; }
    const evidenceHash = `sha256:${await sha256Hex(JSON.stringify(metric.evidence))}`;
    try {
      await nearFunctionCall(env,
        { accountId: ops.accountId, secretKey: ops.secretKey },
        acct,
        { methodName: "resolve",
          args: { proposalId: p.id, metricValue: metric.value.toString(), evidenceHash },
          gas: 30_000_000_000_000n, deposit: 0n });
      out.resolved.push(p.id);
    } catch (e) {
      out.errors.push(`${p.id}: ${String(e).slice(0, 160)}`);
    }
  }
  return out;
}
