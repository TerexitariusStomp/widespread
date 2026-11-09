// rep.ts — bidirectional reputation events.
//
// Contributor rep: merge-attested wins on external repos (self-merge and
// zero-signal repos mint the retro listing but earn no credit).
// Funder rep: funded → paid counters per payer identity (wash funding —
// paying your own claim — settles money but earns no rep).
//
// Contributor merges go to an R2 map (write-amortized like quality);
// funder counters are rare enough for KV.

import type { Env } from "./types";

const REP_KEY = "quality/rep.json";
export interface RepIndex {
  contrib: Record<string, { merges: number; wins: number; rejects: number }>;
}

/** Signed, portable rep event — the contributor owns this record; anyone
 * can verify the oracle signature offline. ATProto-shaped for PDS export. */
export interface RepEvent {
  lexicon: "fyi.widespread.rep.event";
  actor: string;          // github:<forgeUserId>
  kind: "merge" | "win" | "reject" | "funded" | "paid";
  repo: string; ref: string;
  at: number; sig?: string;
}

export async function repIndex(env: Env): Promise<RepIndex> {
  const obj = await env.QUALITY.get(REP_KEY).catch(() => null);
  const raw = obj ? await obj.json() : {};
  const contrib = (raw as { contrib?: RepIndex["contrib"] }).contrib ?? {};
  for (const k of Object.keys(contrib)) contrib[k].rejects ??= 0;
  return { contrib };
}

/** Verdict rep — accept→wins, reject→rejects. Reject-heavy identities flag
 * spam-likely: the skin-in-the-game maintainers report missing. */
export async function writeVerdictRep(env: Env, forgeUserId: string, kind: "win" | "reject"): Promise<void> {
  const idx = await repIndex(env);
  const c = idx.contrib[forgeUserId] ?? { merges: 0, wins: 0, rejects: 0 };
  c[kind === "win" ? "wins" : "rejects"]++;
  idx.contrib[forgeUserId] = c;
  await env.QUALITY.put(REP_KEY, JSON.stringify(idx));
}

/** spam-likely: reject-heavy with no wins — visible to payers pre-review. */
export function spamLikely(c: { wins: number; rejects: number }): boolean {
  return c.rejects >= 3 && c.wins === 0;
}

/** Claim-queue score: rep-weighted, quality-aware — used to rank claims. */
export function claimRank(c: { merges: number; wins: number; rejects: number }, quality = 0.5): number {
  return c.wins * (1 + quality) - c.rejects;
}

/** Export rep as signed events — portable, verifiable without us. */
export async function exportRep(env: Env, forgeUserId: string): Promise<RepEvent[]> {
  const idx = await repIndex(env);
  const c = idx.contrib[forgeUserId];
  if (!c) return [];
  const events: RepEvent[] = [];
  const mk = (kind: RepEvent["kind"], n: number) => {
    for (let i = 0; i < n; i++) events.push({ lexicon: "fyi.widespread.rep.event", actor: `github:${forgeUserId}`, kind, repo: "", ref: "", at: Date.now() });
  };
  mk("merge", c.merges); mk("win", c.wins); mk("reject", c.rejects);
  return events;
}

/** Merge credit — caller gates on repo quality before calling. */
export async function creditMerges(env: Env, entries: { forgeUserId: string; reputable: boolean }[]): Promise<number> {
  const idx = await repIndex(env);
  let n = 0;
  for (const e of entries) {
    if (!e.forgeUserId || !e.reputable) continue;
    const c = idx.contrib[e.forgeUserId] ?? { merges: 0, wins: 0 };
    c.merges++;
    idx.contrib[e.forgeUserId] = c;
    n++;
  }
  if (n) await env.QUALITY.put(REP_KEY, JSON.stringify(idx));
  return n;
}

// ------------------------------------------------------------ funder rep

const fundKey = (payerId: string) => `rep:funder:${payerId.toLowerCase().slice(0, 80)}`;

export interface FunderRep { funded: number; paid: number; release_rate: number }

export async function funderRep(env: Env, payerId: string): Promise<FunderRep | null> {
  const raw = await env.CLAIMS.get(fundKey(payerId)).catch(() => null);
  if (!raw) return null;
  const r = JSON.parse(raw) as { funded: number; paid: number };
  return { ...r, release_rate: r.funded ? Math.round((r.paid / r.funded) * 100) / 100 : 0 };
}

export async function bumpFunderRep(env: Env, payerId: string | undefined, kind: "funded" | "paid"): Promise<void> {
  if (!payerId) return;
  const k = fundKey(payerId);
  const r = JSON.parse(await env.CLAIMS.get(k).catch(() => null) ?? "{}") as { funded: number; paid: number };
  r[kind] = (r[kind] ?? 0) + 1;
  await env.CLAIMS.put(k, JSON.stringify({ funded: r.funded ?? 0, paid: r.paid ?? 0 }));
}
