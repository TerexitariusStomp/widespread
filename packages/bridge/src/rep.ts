// rep.ts — bidirectional reputation events.
//
// Contributor rep: merge-attested wins on external repos (self-merge and
// zero-signal repos mint the retro listing but earn no credit).
// Funder rep: funded → paid counters per payer identity (wash funding —
// paying your own claim — settles money but earns no rep).
//
// Storage is EVENT-SOURCED, not counter-blobbed:
//   rep:event:<actor>:<ts>:<rand> — append-only signed RepEvent objects
//   rep:ctr:<actor>               — per-actor counters (materialized view)
//
// Why: the previous single-blob rep.json was a read-modify-write on shared
// state — concurrent verdicts/merges lost updates, and every write scaled
// O(all-actors). Per-actor keys narrow contention to same-actor concurrent
// writes (rare); the append-only event log is the source of truth and the
// counters are rebuildable from it. Export is the events themselves —
// signed, portable, verifiable offline against ORACLE_PUBKEY_HEX.

import type { Env } from "./types";
import { postRepEvent } from "./erc8004";
import { kv } from "./db";

const EVENT_PREFIX = "rep:event:";
const CTR_PREFIX = "rep:ctr:";

export interface RepCounters { merges: number; wins: number; rejects: number; last_at?: number }
export interface RepIndex { contrib: Record<string, RepCounters> }

/** Signed, portable rep event — the contributor owns this record; anyone
 * can verify the oracle signature offline. ATProto-shaped for PDS export. */
export interface RepEvent {
  lexicon: "fyi.widespread.rep.event";
  actor: string;          // github:<forgeUserId>
  kind: "merge" | "win" | "reject" | "funded" | "paid";
  repo: string; ref: string;
  at: number; sig?: string;
}

const ctrKey = (actor: string) => `${CTR_PREFIX}${actor.toLowerCase().slice(0, 80)}`;

// ---------- signing (same scheme as oracle.ts verdict signing) ----------

async function ed25519Sign(msg: string, seedHex: string): Promise<string> {
  const seed = new Uint8Array((seedHex.match(/../g) ?? []).map((b) => parseInt(b, 16)));
  const key = await crypto.subtle.importKey(
    "raw", seed, { name: "Ed25519" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Canonical signing payload — verify offline with ORACLE_PUBKEY_HEX:
 * ed25519(JSON.stringify({actor,kind,repo,ref,at})). */
function eventPayload(e: Omit<RepEvent, "sig">): string {
  return JSON.stringify({ actor: e.actor, kind: e.kind, repo: e.repo, ref: e.ref, at: e.at });
}

// ---------- event log (source of truth) ----------

async function appendEvent(env: Env, ev: Omit<RepEvent, "sig">): Promise<void> {
  const sig = env.ORACLE_SEED_HEX
    ? await ed25519Sign(eventPayload(ev), env.ORACLE_SEED_HEX).catch(() => undefined)
    : undefined;
  const key = `${EVENT_PREFIX}${ev.actor}:${ev.at}:${crypto.randomUUID().slice(0, 8)}`;
  await env.QUALITY.put(key, JSON.stringify({ ...ev, ...(sig ? { sig } : {}) }));
  // Mirror the signed event onto ERC-8004's Reputation Registry when a
  // signer key is configured — fire-and-forget: a down RPC never blocks.
  await postRepEvent(env, { ...ev, ...(sig ? { sig } : {}) }).catch(() => undefined);
}

async function bumpCounter(env: Env, actor: string, field: keyof RepCounters): Promise<void> {
  const key = ctrKey(actor);
  const raw = await env.QUALITY.get(key).then((o) => (o ? o.text() : null)).catch(() => null);
  const c = (raw ? JSON.parse(raw) : { merges: 0, wins: 0, rejects: 0 }) as RepCounters;
  c[field] = (c[field] ?? 0) + 1;
  c.last_at = Date.now();
  await env.QUALITY.put(key, JSON.stringify(c));
}

/** Both in one write: the event is the record, the counter is the index. */
async function record(env: Env, ev: Omit<RepEvent, "sig">, field?: keyof RepCounters): Promise<void> {
  await appendEvent(env, ev);
  if (field) await bumpCounter(env, ev.actor.replace(/^github:/, ""), field);
}

// ---------- aggregate views ----------

/** Aggregate contributor counters — materialized view over rep:ctr:*.
 * Called on claim-list paths; the per-actor keys keep reads proportional
 * to actor count, not total history. */
export async function repIndex(env: Env): Promise<RepIndex> {
  const contrib: RepIndex["contrib"] = {};
  let cursor: string | undefined;
  do {
    const page = await env.QUALITY.list({ prefix: CTR_PREFIX, cursor, limit: 500 });
    for (const o of page.objects) {
      const actor = o.key.slice(CTR_PREFIX.length);
      const c = (await env.QUALITY.get(o.key).then((b) => (b ? b.text() : null)).then((t) => (t ? JSON.parse(t) : null)).catch(() => null)) as RepCounters | null;
      if (c) contrib[actor] = { merges: c.merges ?? 0, wins: c.wins ?? 0,
        rejects: c.rejects ?? 0, ...(c.last_at ? { last_at: c.last_at } : {}) };
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { contrib };
}

/** Verdict rep — accept→wins, reject→rejects. Reject-heavy identities flag
 * spam-likely: the skin-in-the-game maintainers report missing. */
export async function writeVerdictRep(env: Env, forgeUserId: string, kind: "win" | "reject",
  opts: { repo?: string; ref?: string } = {}): Promise<void> {
  await record(env, {
    lexicon: "fyi.widespread.rep.event", actor: `github:${forgeUserId}`,
    kind, repo: opts.repo ?? "", ref: opts.ref ?? "", at: Date.now(),
  }, kind === "win" ? "wins" : "rejects");
}

/** spam-likely: reject-heavy with no wins — visible to payers pre-review. */
export function spamLikely(c: { wins: number; rejects: number }): boolean {
  return c.rejects >= 3 && c.wins === 0;
}

/** Claim-queue score: rep-weighted, quality-aware — used to rank claims. */
export function claimRank(c: { merges: number; wins: number; rejects: number }, quality = 0.5): number {
  return c.wins * (1 + quality) - c.rejects;
}

/** Export the actor's real signed events — portable, verifiable offline
 * against ORACLE_PUBKEY_HEX. Previously this synthesized fake events from
 * counters; now the event log IS the record. */
export async function exportRep(env: Env, forgeUserId: string): Promise<RepEvent[]> {
  const prefix = `${EVENT_PREFIX}github:${forgeUserId}:`;
  const events: RepEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.QUALITY.list({ prefix, cursor, limit: 500 });
    for (const o of page.objects) {
      const e = (await env.QUALITY.get(o.key).then((b) => (b ? b.text() : null)).then((t) => (t ? JSON.parse(t) : null)).catch(() => null)) as RepEvent | null;
      if (e) events.push(e);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return events.sort((a, b) => a.at - b.at);
}

/** Velocity signals — recent-event rates from the actor's event log.
 * Burst detection: many claims in 24h with zero prior history is the
 * coordinated-slop shape; healthy actors accrete over days. */
export function repVelocity(events: RepEvent[]): {
  events_24h: number; events_7d: number; first_seen: number | null; burst: boolean;
} {
  const now = Date.now(), d = 86_400_000;
  const e24 = events.filter((e) => now - e.at < d).length;
  const e7 = events.filter((e) => now - e.at < 7 * d).length;
  const first = events.length ? events[0].at : null;
  const burst = e24 >= 5 && e7 === e24; // all history inside 24h at high volume
  return { events_24h: e24, events_7d: e7, first_seen: first, burst };
}

/** Merge credit — caller gates on repo quality before calling. Each entry
 * appends a signed merge event and bumps the per-actor counter. */
export async function creditMerges(env: Env, entries: { forgeUserId: string; reputable: boolean; repo?: string; ref?: string }[]): Promise<number> {
  let n = 0;
  for (const e of entries) {
    if (!e.forgeUserId || !e.reputable) continue;
    await record(env, {
      lexicon: "fyi.widespread.rep.event", actor: `github:${e.forgeUserId}`,
      kind: "merge", repo: e.repo ?? "", ref: e.ref ?? "", at: Date.now(),
    }, "merges");
    n++;
  }
  return n;
}

// ------------------------------------------------------------ funder rep

const fundKey = (payerId: string) => `rep:funder:${payerId.toLowerCase().slice(0, 80)}`;

export interface FunderRep { funded: number; paid: number; release_rate: number }

export async function funderRep(env: Env, payerId: string): Promise<FunderRep | null> {
  const raw = await kv(env).get(fundKey(payerId)).catch(() => null);
  if (!raw) return null;
  const r = JSON.parse(raw) as { funded: number; paid: number };
  return { ...r, release_rate: r.funded ? Math.round((r.paid / r.funded) * 100) / 100 : 0 };
}

export async function bumpFunderRep(env: Env, payerId: string | undefined, kind: "funded" | "paid"): Promise<void> {
  if (!payerId) return;
  const k = fundKey(payerId);
  const r = JSON.parse(await kv(env).get(k).catch(() => null) ?? "{}") as { funded: number; paid: number };
  r[kind] = (r[kind] ?? 0) + 1;
  await kv(env).put(k, JSON.stringify({ funded: r.funded ?? 0, paid: r.paid ?? 0 }));
}
