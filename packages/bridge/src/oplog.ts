// Op-log fetch + ship-entry lookup. The hash-chain replay itself lives in
// @widespread/protocol (opLogEntryHash / verifyOpLogChain) — this module
// keeps only the network helpers.
//
// delta-git serves GET /api/:owner/:repo/dg/oplog as
//   { entries: [{ seq, hash, prev_hash, kind, actor, payload, created_at }] }
// where each hash is sha256hex(prevHash + canonical) and canonical is
//   JSON.stringify({ seq, kind, actor, payload, createdAt })
// in exactly that key order, with `prev_hash` "genesis" for seq 0.
// (Mirrors src/worker/routes/agent.ts /dg/oplog + /dg/oplog/verify.)

import type { OpLogEntry, OpLogResponse } from "@widespread/protocol";

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

/** Locate a claim entry by seq; accepts kind "ship" or any dg-ship-1 claim. */
export function findShipEntry(entries: OpLogEntry[], seq: number): OpLogEntry | undefined {
  return entries.find((e) => e.seq === seq);
}
