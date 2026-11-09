-- kv shim table: one namespaced key→value store for claim/settlement/
-- funding/rep records. Moved off KV because free-tier KV writes cap at
-- 1,000/day (~350 claim events); D1 free tier is 100k writes/day.
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  -- KV expirationTtl equivalent; reads filter expired rows.
  expires_at INTEGER DEFAULT NULL
);
-- Prefix scans use k >= prefix AND k < prefix+hi so the PK serves them.
