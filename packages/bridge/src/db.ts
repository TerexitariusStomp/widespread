// db.ts — KV-compatible store over D1.
//
// Why: free-tier KV writes cap at 1,000/day (~350 claim events/day — the
// binding constraint on claim volume). D1 free tier is 100k writes/day +
// 5M reads/day — ~100× headroom — and strongly consistent, which the
// payout in-flight guard needs anyway. The shim matches the KVNamespace
// surface the codebase already uses (get/put/delete/list with a "json"
// type arg), so call sites swap `env.CLAIMS` → `kv(env)` with no other
// change. Falls back to the KV binding when DB is unbound so a deploy
// without the D1 database keeps working.

import type { Env } from "./types";

/** The KVNamespace subset the codebase uses. */
export interface KvStore {
  get(key: string): Promise<string | null>;
  get(key: string, type: "json", options?: Record<string, unknown>): Promise<unknown>;
  get<T>(key: string, type: "json", options?: Record<string, unknown>): Promise<T | null>;
  get(key: string, type: "text", options?: Record<string, unknown>): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number; expiration?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }):
    Promise<KVNamespaceListResult<unknown, string>>;
}

function d1Store(db: D1Database): KvStore {
  const get = async (key: string, type?: string): Promise<unknown> => {
    const row = await db.prepare(
      "SELECT v FROM kv WHERE k = ? AND (expires_at IS NULL OR expires_at > ?)"
    ).bind(key, Date.now()).first<{ v: string }>();
    if (!row) return null;
    if (type === "json") return JSON.parse(row.v);
    return row.v;
  };
  return {
    get: get as KvStore["get"],
    async put(key: string, value: string, options?: { expirationTtl?: number; expiration?: number }) {
      const expires = options?.expiration !== undefined
        ? options.expiration * 1000
        : options?.expirationTtl !== undefined
          ? Date.now() + options.expirationTtl * 1000 : null;
      await db.prepare(
        "INSERT INTO kv (k, v, updated_at, expires_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at, expires_at = excluded.expires_at"
      ).bind(key, value, Date.now(), expires).run();
    },
    async delete(key: string) {
      await db.prepare("DELETE FROM kv WHERE k = ?").bind(key).run();
    },
    async list(options = {}) {
      const prefix = options.prefix ?? "";
      const limit = Math.min(options.limit ?? 1000, 1000);
      const offset = options.cursor ? Number(options.cursor) : 0;
      // Range scan — the PK serves the ordering; prefix+hi is the upper
      // bound (last char bumped), so no LIKE escaping is needed.
      const hi = prefix ? prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1) : undefined;
      const rows = await (hi
        ? db.prepare("SELECT k FROM kv WHERE k >= ? AND k < ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY k LIMIT ? OFFSET ?").bind(prefix, hi, Date.now(), limit + 1, offset)
        : db.prepare("SELECT k FROM kv WHERE (expires_at IS NULL OR expires_at > ?) ORDER BY k LIMIT ? OFFSET ?").bind(Date.now(), limit + 1, offset)
      ).all<{ k: string }>();
      const keys = (rows.results ?? []).slice(0, limit).map((r) => ({ name: r.k }));
      const hasMore = (rows.results ?? []).length > limit;
      return {
        keys,
        list_complete: !hasMore,
        ...(hasMore ? { cursor: String(offset + limit) } : {}),
      } as KVNamespaceListResult<unknown, string>;
    },
  };
}

/** The claim/settlement store — D1 when bound, KV as deploy fallback. */
export function kv(env: Env): KvStore {
  if (env.DB) return d1Store(env.DB);
  return env.CLAIMS as unknown as KvStore;
}
