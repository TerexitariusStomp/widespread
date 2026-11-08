// hats.ts — Intentional Hats bridge surface: org charts, stance checks,
// opportunity ranking, foreign-chain identity. Reads contract state via
// nearView; all writes happen on-chain by hat wearers (the bridge never
// holds keys — same no-custody rule as the rest of the protocol).

import { nearView } from "./near";

export interface HatRecord {
  hatId: string; orgId: string; name: string;
  parentHatId: string | null; adminHatId: string | null;
  accountableTo: string | null; wearer: string;
  permissions: string[]; status: string;
  foreign: { chain: string; path: string; keyType: string } | null;
  identityRef: string | null; constitutionRef: string | null;
  stance: { prefs: Record<string, number>; vetoes: string[]; constitutionRef?: string | null };
  createdAt: string;
}

export interface OrgRecord {
  orgId: string; name: string; creator: string; createdAt: string;
}

export interface MarketLike {
  marketId: string; spec: string;
  payer?: string; amount?: string; locked?: string; deadline?: string; status?: string;
}

const DOMAIN_KEYWORDS: [RegExp, string][] = [
  [/oss|open.?source|infra|protocol|refactor|dependency/i, "oss-infra"],
  [/climate|carbon|regen|energy|environment/i, "climate"],
  [/secur|audit|vuln|crypto|key|auth/i, "security"],
  [/surveil|tracking|ads|dark.?pattern/i, "surveillance"],
  [/docs|readme|tutorial|guide/i, "docs"],
  [/ui|frontend|design|css|component/i, "frontend"],
];

function specDomains(spec: string): string[] {
  return DOMAIN_KEYWORDS.filter(([re]) => re.test(spec)).map(([, d]) => d);
}

// Deterministic stance eval: vetoes are absolute; otherwise alignment is the
// mean of matched-domain prefs (default 0 for unmatched domains).
export function stanceScore(
  hat: HatRecord, spec: string
): { support: boolean; score: number; reasons: string[] } {
  const reasons: string[] = [];
  const domains = specDomains(spec);
  for (const v of hat.stance.vetoes) {
    if (spec.toLowerCase().includes(v.toLowerCase().replace(/-adja.*$|s$/, ""))) {
      reasons.push(`veto: ${v}`);
      return { support: false, score: -1, reasons };
    }
  }
  let sum = 0, hits = 0;
  for (const d of domains) {
    const p = hat.stance.prefs[d];
    if (p !== undefined) { sum += p; hits++; reasons.push(`${d}:${p >= 0 ? "+" : ""}${p}`); }
  }
  const score = hits ? sum / hits : 0;
  return { support: score > 0 || hits === 0, score, reasons };
}

// Complexity estimate from spec signals — drives estCost in ranking.
function estCost(spec: string): number {
  let c = 1;
  if (/smart.?contract|consensus|crypt|mpc|tee|zero.?knowledge/i.test(spec)) c += 3;
  if (/audit|security|vuln/i.test(spec)) c += 2;
  if (/refactor|migrat|architecture/i.test(spec)) c += 1.5;
  if (/docs|readme|typo|comment/i.test(spec)) c -= 0.5;
  return Math.max(0.5, c);
}

export async function hatsOrg(
  env: { HATS_CONTRACT?: string; NEAR_RPC_URL?: string }, orgId: string
): Promise<{ org: OrgRecord | null; hats: HatRecord[] } | { error: string }> {
  const acct = env.HATS_CONTRACT;
  if (!acct) return { error: "no HATS_CONTRACT configured" };
  const [org, hats] = await Promise.all([
    nearView(env, acct, "getOrg", { orgId }).catch(() => null),
    nearView(env, acct, "listHats", { orgId }).catch(() => null),
  ]);
  return { org: org as OrgRecord | null, hats: (hats as HatRecord[]) ?? [] };
}

export async function hatsHat(
  env: { HATS_CONTRACT?: string; NEAR_RPC_URL?: string }, hatId: string
): Promise<HatRecord | { error: string } | null> {
  const acct = env.HATS_CONTRACT;
  if (!acct) return { error: "no HATS_CONTRACT configured" };
  return (await nearView(env, acct, "getHat", { hatId }).catch(() => null)) as HatRecord | null;
}

export async function hatsStanceCheck(
  env: { HATS_CONTRACT?: string; NEAR_RPC_URL?: string },
  hatId: string, spec: string
) {
  const hat = await hatsHat(env, hatId);
  if (!hat || "error" in hat || !hat) return { error: "hat not found" };
  return { hatId, name: hat.name, wearer: hat.wearer, ...stanceScore(hat, spec) };
}

// rankOpportunities: funded on-chain markets scored by
// alignment × reward / estCost — vetoes excluded. Reward = locked NEAR.
export async function hatsOpportunities(
  env: { HATS_CONTRACT?: string; NEAR_CONTRACT?: string; NEAR_RPC_URL?: string },
  hatId: string,
  markets: MarketLike[]
) {
  const hat = await hatsHat(env, hatId);
  if (!hat || "error" in hat || !hat) return { error: "hat not found" };
  const ranked = markets
    .map((m) => {
      const s = stanceScore(hat, m.spec ?? "");
      const rewardRaw = parseFloat(m.locked ?? m.amount ?? "0") || 0;
      const reward = rewardRaw > 1e15 ? rewardRaw / 1e24 : rewardRaw; // yocto→NEAR
      const cost = estCost(m.spec ?? "");
      return {
        marketId: m.marketId, spec: m.spec, reward,
        estCost: cost,
        alignment: s.score,
        score: s.support ? (s.score || 0.1) * reward / cost : -1,
        reasons: s.reasons,
      };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  return { hatId, wearer: hat.wearer, ranked, evaluated: markets.length };
}
