// quality.ts — repo-quality index + record embeddings for client-side
// contributor matching.
//
// Two cheap, unbounded layers on top of the feed:
//   1. R2 `quality/index.json` — a repo→QualityEntry map. Attaching to
//      records is a single object read at refresh time; a never-scored-
//      first crawler fills it via a small number of forge-API calls per
//      invocation (free tier: ~50 subrequests/invocation, 1M R2 ops/mo).
//   2. Vectorize `widespread-feed-embed` — bge-base embeddings of each
//      record's title+spec so feed_match can rank semantically. The
//      client's AI supplies interests; we never store a user profile.
//
// Signals are CHAOSS-aligned (responsiveness, merge velocity, freshness,
// popularity). Honesty rules: <2 signals → score:null; uncovered repos
// get quality undefined, never a fabricated 0.

import type { Env, FeedRecord } from "./types";

const INDEX_KEY = "quality/index.json";
const EMBED_INDEX_KEY = "quality/embeds.json";
const QUAL_TTL_MS = 30 * 24 * 3600 * 1000;   // coverage over freshness
const FILL_GATE_MS = 10 * 60 * 1000;          // ≥10min between crawl invocations
const LASTFILL_KEY = "quality:lastfill";
const GH_GQL_BATCH = 40;                      // repos per GraphQL query
const REST_FILL_LIMIT = 15;                   // non-github REST repos/invocation
const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

const UA = { "user-agent": "widespread-feed/1.0", accept: "application/json" };

export interface QualityEntry {
  score: number | null;
  stars?: number;
  merged_30d?: number;
  open_issues?: number;
  pushed_at?: string;
  maintainer_responsive?: boolean;
  archived?: boolean;
  topics_repo?: string[];
  language?: string;
  computed_at: number;
}

// ------------------------------------------------------------- fetch util

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 10000): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: { ...UA, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const ghHeaders = (env: Env): Record<string, string> =>
  env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {};

// ------------------------------------------------------------- scoring

/** CHAOSS-aligned composite 0–1. Archived repos score 0; <2 signals → null. */
export function scoreQuality(e: QualityEntry): number | null {
  if (e.archived) return 0;
  const parts: { w: number; v: number }[] = [];
  if (e.stars !== undefined) {
    parts.push({ w: 0.4, v: Math.min(1, Math.log10(e.stars + 1) / 3) });
  }
  if (e.pushed_at) {
    const age = Date.now() - Date.parse(e.pushed_at);
    const d = age / 86400000;
    parts.push({ w: 0.3, v: d < 7 ? 1 : d < 30 ? 0.7 : d < 90 ? 0.4 : d < 365 ? 0.15 : 0 });
  }
  if (e.merged_30d !== undefined) {
    parts.push({ w: 0.2, v: Math.min(1, e.merged_30d / 20) });
  }
  if (e.maintainer_responsive !== undefined) {
    parts.push({ w: 0.1, v: e.maintainer_responsive ? 1 : 0 });
  }
  const weight = parts.reduce((s, p) => s + p.w, 0);
  if (parts.length < 2) return null;
  const score = parts.reduce((s, p) => s + p.w * p.v, 0) / weight;
  return Math.round(score * 100) / 100;
}

// ----------------------------------------------------------- topics

/** ~20 explicit domains — kept small on purpose (clear matching signals,
 *  no NLP dependency). */
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  rust: ["rust", "cargo"], python: ["python", "pyodide", "pandas"], ml: ["machine-learning", "machine learning", " llm", "pytorch", "jax", "tensorflow", "neural"],
  security: ["security", "vulnerability", "cve", "exploit", "audit"], climate: ["climate", "carbon", "environment", "emissions", "solar", "energy-grid"],
  defi: ["defi", "dex", "amm", "staking", "liquidity"], web: ["frontend", "react", "css", "ui ", " ux"],
  infra: ["ci/cd", "ci ", "deployment", "docker", "kubernetes", "terraform"], docs: ["documentation", "readme", "docs"],
  test: ["testing", "test-", "unit test", "e2e"], agent: ["agent", " llm", "prompt", "mcp", "ai "],
  data: ["database", "sql", "analytics", "etl", "data-"], privacy: ["privacy", "encryption", "anonymous", "zero-knowledge", "zk"],
  education: ["education", "learning", "tutorial", "teaching"], health: ["health", "medical", "clinical", "bio-"],
  finance: ["fintech", "payments", "billing", "invoice"], governance: ["governance", "voting", "dao", "policy"],
};

/** topics = repo topics ∪ issue labels ∪ domain keywords from title+spec. */
export function extractTopics(rec: FeedRecord, entry?: QualityEntry): string[] {
  const out = new Set<string>();
  for (const t of entry?.topics_repo ?? []) out.add(t.toLowerCase());
  const text = `${rec.title} ${rec.spec ?? ""}`.toLowerCase();
  for (const [dom, words] of Object.entries(DOMAIN_KEYWORDS)) {
    if (words.some((w) => text.includes(w))) out.add(dom);
  }
  for (const label of rec.topics ?? []) out.add(label.toLowerCase());
  if (entry?.language) out.add(entry.language.toLowerCase());
  return [...out].slice(0, 12);
}

// ----------------------------------------------------------- index io

async function readIndex(env: Env): Promise<Map<string, QualityEntry>> {
  const obj = await env.QUALITY.get(INDEX_KEY).catch(() => null);
  if (!obj) return new Map();
  const raw = (await obj.json()) as Record<string, QualityEntry>;
  return new Map(Object.entries(raw));
}

async function writeIndex(env: Env, idx: Map<string, QualityEntry>): Promise<void> {
  await env.QUALITY.put(INDEX_KEY, JSON.stringify(Object.fromEntries(idx)));
}

/** Attach quality + topics + language to every record. Records without a
 * computed repo entry still get keyword-derived topics so ?topics= and
 * feed_match can see them before the crawler reaches their repo. */
export async function attachQuality(env: Env, records: FeedRecord[]): Promise<void> {
  const idx = await readIndex(env);
  for (const r of records) {
    const e = r.repo ? idx.get(r.repo) : undefined;
    if (e) {
      const { topics_repo, language, archived, ...q } = e;
      r.quality = q;
      if (language) r.language = language;
    }
    const t = extractTopics(r, e);
    if (t.length) r.topics = t;
  }
}

/** Single-repo lookup for rep gating. */
export async function repoQualityEntry(env: Env, repo: string): Promise<QualityEntry | undefined> {
  return (await readIndex(env)).get(repo);
}

// ------------------------------------------------------- forge adapters

interface RepoMeta {
  stars?: number; open_issues?: number; pushed_at?: string;
  archived?: boolean; topics_repo?: string[]; language?: string;
  maintainer_responsive?: boolean;
}

function forgeOf(env: Env, rec: FeedRecord): string {
  return rec.forge;
}

/** GitHub REST fallback — one call per repo. */
async function ghRepoMeta(env: Env, repo: string): Promise<RepoMeta | null> {
  const d = await fetchJson(`https://api.github.com/repos/${repo}`, ghHeaders(env))
    .catch(() => null) as Record<string, unknown> | null;
  if (!d) return null;
  return {
    stars: Number(d.stargazers_count ?? 0),
    open_issues: Number(d.open_issues_count ?? 0),
    pushed_at: String(d.pushed_at ?? ""),
    archived: !!d.archived,
    topics_repo: Array.isArray(d.topics) ? d.topics.map(String) : [],
    language: d.language ? String(d.language) : undefined,
    maintainer_responsive: d.pushed_at
      ? Date.now() - Date.parse(String(d.pushed_at)) < 30 * 86400000
      : undefined,
  };
}

/** GitHub GraphQL — up to GH_GQL_BATCH repos per single call. */
async function ghRepoMetaBatch(env: Env, repos: string[]): Promise<Map<string, RepoMeta>> {
  const out = new Map<string, RepoMeta>();
  if (!env.GITHUB_TOKEN || !repos.length) return out;
  const fields = repos.map((r, i) => {
    const [owner, name] = r.split("/");
    return `r${i}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}) {
      stargazerCount isArchived pushedAt
      issues(states:OPEN){totalCount}
      primaryLanguage{name}
      repositoryTopics(first:10){nodes{topic{name}}}
    }`;
  }).join("\n");
  const res = await fetchJson("https://api.github.com/graphql", {
    method: "POST", headers: ghHeaders(env),
    body: JSON.stringify({ query: `query {\n${fields}\n}` }),
  }).catch(() => null) as { data?: Record<string, unknown> } | null;
  const data = res?.data ?? {};
  repos.forEach((repo, i) => {
    const d = data[`r${i}`] as Record<string, unknown> | null | undefined;
    if (!d) return;
    const topics = (d.repositoryTopics as { nodes?: { topic?: { name?: string } }[] } | undefined)?.nodes;
    out.set(repo, {
      stars: Number(d.stargazerCount ?? 0),
      open_issues: Number((d.issues as { totalCount?: number } | undefined)?.totalCount ?? 0),
      pushed_at: String(d.pushedAt ?? ""),
      archived: !!d.isArchived,
      topics_repo: (topics ?? []).map((n) => String(n?.topic?.name ?? "")).filter(Boolean),
      language: (d.primaryLanguage as { name?: string } | undefined)?.name,
      maintainer_responsive: d.pushedAt
        ? Date.now() - Date.parse(String(d.pushedAt)) < 30 * 86400000
        : undefined,
    });
  });
  return out;
}

async function repoMeta(env: Env, forge: string, repo: string): Promise<RepoMeta | null> {
  if (forge === "gitlab") {
    const d = await fetchJson(`https://gitlab.com/api/v4/projects/${encodeURIComponent(repo)}`, {}, 10000)
      .catch(() => null) as Record<string, unknown> | null;
    if (!d) return null;
    return {
      stars: Number(d.star_count ?? 0),
      open_issues: Number(d.open_issues_count ?? 0),
      pushed_at: String(d.last_activity_at ?? ""),
      topics_repo: Array.isArray(d.topics) ? d.topics.map(String) : [],
      maintainer_responsive: d.last_activity_at
        ? Date.now() - Date.parse(String(d.last_activity_at)) < 30 * 86400000
        : undefined,
    };
  }
  if (forge === "forgejo" || forge === "codeberg") {
    const host = "codeberg.org";
    const d = await fetchJson(`https://${host}/api/v1/repos/${repo}`, {}, 10000)
      .catch(() => null) as Record<string, unknown> | null;
    if (!d) return null;
    return {
      stars: Number(d.stars_count ?? 0),
      open_issues: Number(d.open_issues_count ?? 0),
      pushed_at: String(d.updated_at ?? ""),
      maintainer_responsive: d.updated_at
        ? Date.now() - Date.parse(String(d.updated_at)) < 30 * 86400000
        : undefined,
    };
  }
  // tangled/radicle/deltagit/generic — insufficient public signals; honest null.
  return null;
}

// -------------------------------------------------------------- crawler

/**
 * Fill the quality index — never-scored repos first, stale ones last.
 * GitHub batches via GraphQL when a token exists (≈50 repos/subrequest);
 * other forges REST one-by-one. Runs in ctx.waitUntil on feedDoc reads
 * so coverage scales with traffic — no cron, no caps on the repo set.
 */
export async function fillQuality(env: Env): Promise<{ computed: number; indexed: number }> {
  const last = Number(await env.CLAIMS.get(LASTFILL_KEY).catch(() => null));
  if (last && Date.now() - last < FILL_GATE_MS) return { computed: 0, indexed: 0 };
  await env.CLAIMS.put(LASTFILL_KEY, String(Date.now()), { expirationTtl: 3600 });

  const { getFeedDoc } = await import("./feedstore");
  const doc = await getFeedDoc(env);
  const repos = [...new Set((doc?.records ?? []).map((r) => r.repo).filter(Boolean))] as string[];
  if (!repos.length) return { computed: 0, indexed: 0 };

  const idx = await readIndex(env);
  const forgeByRepo = new Map<string, string>();
  for (const r of doc!.records) if (r.repo && !forgeByRepo.has(r.repo)) forgeByRepo.set(r.repo, forgeOf(env, r));
  const stale = (e: QualityEntry | undefined) => !e || Date.now() - e.computed_at > QUAL_TTL_MS;
  const unscored = repos.filter((r) => !idx.has(r));
  const staleRepos = repos.filter((r) => idx.has(r) && stale(idx.get(r)));
  const queue = [...unscored, ...staleRepos];

  const gh = queue.filter((r) => forgeByRepo.get(r) === "github");
  const rest = queue.filter((r) => forgeByRepo.get(r) !== "github");

  let computed = 0;
  const batched = await ghRepoMetaBatch(env, gh.slice(0, GH_GQL_BATCH));
  for (const [repo, meta] of batched) {
    const e: QualityEntry = { ...meta, score: null, computed_at: Date.now() };
    e.score = scoreQuality(e);
    idx.set(repo, e); computed++;
  }
  // REST path — covers github without token too
  const restTodo = [...rest.slice(0, REST_FILL_LIMIT), ...(batched.size ? [] : gh.slice(0, REST_FILL_LIMIT))];
  for (const repo of restTodo) {
    const forge = forgeByRepo.get(repo) ?? "github";
    const meta = forge === "github" ? await ghRepoMeta(env, repo) : await repoMeta(env, forge, repo);
    if (!meta) continue;
    const e: QualityEntry = { ...meta, score: null, computed_at: Date.now() };
    e.score = scoreQuality(e);
    idx.set(repo, e); computed++;
  }
  if (computed) await writeIndex(env, idx);
  return { computed, indexed: idx.size };
}

// -------------------------------------------------------------- embeds

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Embed query/interest text for feed_match. Exported for MCP handlers. */
export async function embedText(env: Env, text: string): Promise<number[] | null> {
  try {
    const res = await env.AI.run(EMBED_MODEL, { text: [text] }) as { data?: number[][] };
    return res?.data?.[0] ?? null;
  } catch { return null; }
}

interface EmbedMaps { byId: Record<string, string>; byHash: Record<string, string> }

async function embedIndexMap(env: Env): Promise<EmbedMaps> {
  const obj = await env.QUALITY.get(EMBED_INDEX_KEY).catch(() => null);
  const raw = obj ? await obj.json() : {};
  const flat = raw as Record<string, string>;
  // New format {byId,byHash}; legacy flat {id:specHash} upgrades in place.
  return flat.byId ? (raw as unknown as EmbedMaps) : { byId: flat, byHash: {} };
}

/** Vectorize vector ids max at 64 bytes — sha256 hex is exactly 64. */
export async function vectorId(recordId: string): Promise<string> {
  return sha256(recordId);
}

/** Reverse map vector hash → record id, for feed_match query results. */
export async function vectorIdMap(env: Env): Promise<Record<string, string>> {
  return (await embedIndexMap(env)).byHash;
}

/**
 * Upsert embeddings for records whose title+spec hash changed. Bounded by
 * hash-diff so a full re-embed never re-burns the daily neuron budget.
 */
export async function embedRecords(env: Env, records: FeedRecord[]): Promise<{ embedded: number }> {
  const maps = await embedIndexMap(env);
  const todo: { id: string; vecId: string; text: string; hash: string }[] = [];
  for (const r of records.slice(0, 300)) {
    const text = `${r.title}\n${(r.spec ?? "").slice(0, 1200)}`;
    const hash = await sha256(text);
    if (maps.byId[r.id] !== hash) todo.push({ id: r.id, vecId: await vectorId(r.id), text, hash });
    if (todo.length >= 30) break;
  }
  if (!todo.length) return { embedded: 0 };
  let res: { data?: number[][] } | null;
  try {
    res = await env.AI.run(EMBED_MODEL, { text: todo.map((t) => t.text) }) as { data?: number[][] };
  } catch (e) { console.error(`embed: AI.run failed: ${String(e)}`); return { embedded: 0 }; }
  if (!res?.data) { console.error("embed: AI.run returned no data"); return { embedded: 0 }; }
  const rows = todo.map((t, i) => ({ id: t.vecId, values: res.data![i] ?? [] })).filter((r) => r.values.length === 768);
  if (rows.length) {
    try { await env.EMBED.upsert(rows); } catch (e) { console.error(`embed: upsert failed: ${String(e)}`); return { embedded: 0 }; }
  }
  for (const t of todo) { maps.byId[t.id] = t.hash; maps.byHash[t.vecId] = t.id; }
  await env.QUALITY.put(EMBED_INDEX_KEY, JSON.stringify(maps));
  return { embedded: rows.length };
}

/** Item→item: fetch the stored vector for a record id (null if unembedded). */
export async function recordVector(env: Env, id: string): Promise<number[] | null> {
  try {
    const rows = await env.EMBED.getByIds([await vectorId(id)]);
    const v = rows?.[0]?.values;
    return v ? Array.from(v) : null;
  } catch { return null; }
}
