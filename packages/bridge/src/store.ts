// KV persistence: review records keyed by claim id, a recency index, and
// the bounty registry keyed by repo.

import type { Bounty, Env, ReviewRecord } from "./types";
import { kv } from "./db";

const INDEX_KEY = "index";
const INDEX_CAP = 500;

const recordKey = (repo: string, seq: number) => `claim:${repo}:${seq}`;
const bountyKey = (repo: string) => `bounty:${repo}`;

export async function getRecord(env: Env, repo: string, seq: number): Promise<ReviewRecord | null> {
  return kv(env).get<ReviewRecord>(recordKey(repo, seq), "json");
}

export async function putRecord(env: Env, record: ReviewRecord): Promise<void> {
  await kv(env).put(recordKey(record.repo, record.seq), JSON.stringify(record));
  const ids = (await kv(env).get<string[]>(INDEX_KEY, "json")) ?? [];
  if (!ids.includes(record.id)) {
    ids.push(record.id);
    await kv(env).put(INDEX_KEY, JSON.stringify(ids.slice(-INDEX_CAP)));
  }
}

export async function listRecords(env: Env): Promise<ReviewRecord[]> {
  const ids = (await kv(env).get<string[]>(INDEX_KEY, "json")) ?? [];
  const records = await Promise.all(
    ids.map((id) => kv(env).get<ReviewRecord>(`claim:${id}`, "json").catch(() => null))
  );
  return records.filter((r): r is ReviewRecord => r !== null);
}

export async function getBounty(env: Env, repo: string): Promise<Bounty | null> {
  return kv(env).get<Bounty>(bountyKey(repo), "json");
}

export async function putBounty(env: Env, bounty: Bounty): Promise<void> {
  await kv(env).put(bountyKey(bounty.repo), JSON.stringify(bounty));
  const ids = (await kv(env).get<string[]>("bounty-index", "json")) ?? [];
  if (!ids.includes(bounty.repo)) {
    ids.push(bounty.repo);
    await kv(env).put("bounty-index", JSON.stringify(ids));
  }
}

export async function deleteBounty(env: Env, repo: string): Promise<void> {
  await kv(env).delete(bountyKey(repo));
  const ids = ((await kv(env).get<string[]>("bounty-index", "json")) ?? []).filter(
    (r) => r !== repo
  );
  await kv(env).put("bounty-index", JSON.stringify(ids));
}

export async function listBounties(env: Env): Promise<Bounty[]> {
  const repos = (await kv(env).get<string[]>("bounty-index", "json")) ?? [];
  const bounties = await Promise.all(repos.map((r) => getBounty(env, r)));
  return bounties.filter((b): b is Bounty => b !== null);
}
