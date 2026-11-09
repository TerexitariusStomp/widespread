// Op-log fetch + independent hash-chain replay.
//
// delta-git serves GET /api/:owner/:repo/dg/oplog as
//   { entries: [{ seq, hash, prev_hash, kind, actor, payload, created_at }] }
// where each hash is sha256hex(prevHash + canonical) and canonical is
//   JSON.stringify({ seq, kind, actor, payload, createdAt })
// in exactly that key order, with `prev_hash` "genesis" for seq 0.
// (Mirrors src/worker/routes/agent.ts /dg/oplog + /dg/oplog/verify.)

import type { ChainVerification, OpLogEntry, OpLogResponse } from "./types";

const te = new TextEncoder();

const toHex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Recompute the stored hash for one entry. */
export async function entryHash(entry: OpLogEntry, prevHash: string): Promise<string> {
  const canonical = JSON.stringify({
    seq: entry.seq,
    kind: entry.kind,
    actor: entry.actor,
    payload: entry.payload,
    createdAt: entry.created_at,
  });
  return toHex(await crypto.subtle.digest("SHA-256", te.encode(prevHash + canonical)));
}

export async function fetchOpLog(
  forgeBase: string,
  repo: string,
  since = -1
): Promise<OpLogEntry[]> {
  const url = `${forgeBase}/api/${repo}/dg/oplog${since >= 0 ? `?since=${since}` : ""}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`oplog ${repo}: HTTP ${res.status}`);
  const body = (await res.json()) as OpLogResponse;
  return body.entries ?? [];
}

/** Replay the full chain from genesis; O(n) SHA-256 digests. */
export async function verifyChain(entries: OpLogEntry[]): Promise<ChainVerification> {
  let expectedPrev = "genesis";
  let brokenAt: number | null = null;
  for (const entry of entries) {
    const computed = await entryHash(entry, expectedPrev);
    if (entry.prev_hash !== expectedPrev || entry.hash !== computed) {
      brokenAt = entry.seq;
      break;
    }
    expectedPrev = entry.hash;
  }
  const tip = entries.length > 0 ? entries[entries.length - 1] : undefined;
  return {
    valid: brokenAt === null,
    checked: entries.length,
    tip_hash: tip?.hash ?? null,
    tip_seq: tip?.seq ?? -1,
    broken_at_seq: brokenAt,
  };
}

/** Locate a claim entry by seq; accepts kind "ship" or any dg-ship-1 claim. */
export function findShipEntry(entries: OpLogEntry[], seq: number): OpLogEntry | undefined {
  return entries.find((e) => e.seq === seq);
}
