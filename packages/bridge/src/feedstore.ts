// feedstore.ts — KV persistence for the unified bounty feed.
// One materialized doc (feed:doc) + per-source freshness stamps + a
// single-flight lock so concurrent refreshes can't stampede upstreams.
// KV is a DERIVED index — canonical market truth stays on-chain/in KV
// bounties; this doc is rebuilt from sources every refresh.

import type { Env, FeedDoc } from "./types";
import { kv } from "./db";

const DOC_KEY = "feed:doc";
const LOCK_KEY = "feed:lock";
const TS_PREFIX = "feed:src:";
export const FEED_TTL_MS = 30 * 60 * 1000; // refresh at most every 30 min
const LOCK_TTL_S = 600;                     // 10 min single-flight

export interface SourceStamp { ok: boolean; count: number; error?: string; fetched_at: number }

export async function getFeedDoc(env: Env): Promise<FeedDoc | null> {
  return kv(env).get<FeedDoc>(DOC_KEY, "json").catch(() => null);
}

export async function putFeedDoc(env: Env, doc: FeedDoc): Promise<void> {
  await kv(env).put(DOC_KEY, JSON.stringify(doc));
}


export async function getSourceStamp(env: Env, name: string): Promise<SourceStamp | null> {
  return kv(env).get<SourceStamp>(`${TS_PREFIX}${name}`, "json").catch(() => null);
}

export async function putSourceStamp(env: Env, name: string, stamp: SourceStamp): Promise<void> {
  await kv(env).put(`${TS_PREFIX}${name}`, JSON.stringify(stamp));
}

/** True when no refresh is in flight. KV has no atomic set-if-absent, so we
 * read-then-write — collisions just mean one redundant refresh, which the
 * per-source min-intervals make harmless. */
export async function acquireFeedLock(env: Env): Promise<boolean> {
  const held = await kv(env).get(LOCK_KEY);
  if (held) return false;
  await kv(env).put(LOCK_KEY, String(Date.now()), { expirationTtl: LOCK_TTL_S });
  return true;
}

export async function releaseFeedLock(env: Env): Promise<void> {
  await kv(env).delete(LOCK_KEY);
}
