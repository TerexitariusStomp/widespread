// dg op-log hash chain — moved from @widespread/bridge so every consumer
// (bridge review pipeline, delta-git exporters, external auditors) replays
// the chain identically.
//
// delta-git serves GET /api/:owner/:repo/dg/oplog as
//   { entries: [{ seq, hash, prev_hash, kind, actor, payload, created_at }] }
// where each hash is sha256hex(prevHash + canonical) and canonical is
//   JSON.stringify({ seq, kind, actor, payload, createdAt })
// in exactly that key order, with `prev_hash` "genesis" for seq 0.
// (Mirrors delta-git src/worker/routes/agent.ts /dg/oplog + /dg/oplog/verify.)

import type { ChainVerification, OpLogEntry } from "./types.js";

const te = new TextEncoder();

const toHex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Recompute the stored hash for one entry. */
export async function opLogEntryHash(entry: OpLogEntry, prevHash: string): Promise<string> {
  const canonical = JSON.stringify({
    seq: entry.seq,
    kind: entry.kind,
    actor: entry.actor,
    payload: entry.payload,
    createdAt: entry.created_at,
  });
  return toHex(await crypto.subtle.digest("SHA-256", te.encode(prevHash + canonical)));
}

/** Replay the full chain from genesis; O(n) SHA-256 digests. */
export async function verifyOpLogChain(entries: OpLogEntry[]): Promise<ChainVerification> {
  let expectedPrev = "genesis";
  let brokenAt: number | null = null;
  for (const entry of entries) {
    const computed = await opLogEntryHash(entry, expectedPrev);
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
