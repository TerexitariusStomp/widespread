// helpers.ts — real-service fixtures for bridge tests.
// Everything here talks to LIVE services: the real GitHub API against the
// dedicated sandbox repo, the real NEAR testnet RPC, the real deployed
// forge, and the worker's real KV bindings. Nothing is stubbed — helpers
// only CREATE real resources (issues, PRs, KV records) and read them back.

import { env } from "cloudflare:workers";
import type { Env, FeedDoc, FeedRecord, MirrorListing } from "../src/types";
import { putFeedDoc } from "../src/feedstore";
import { ghHeaders, GH_API } from "../src/forge";

/** The worker's real bindings (KV CLAIMS + vars + injected test secrets). */
export function realEnv(): Env {
  return env as unknown as Env;
}

// ---------------------------------------------------------------- GitHub --

export const SANDBOX = { owner: "TerexitariusStomp", repo: "widespread-sandbox" } as const;

async function ghApi<T>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${GH_API}${path}`, {
    method,
    headers: { ...ghHeaders(env), "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`github ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

export interface GhIssue { number: number; html_url: string; user: { id: number; login: string } }

/** Create a real issue in the sandbox repo. Returns its number + author. */
export async function createIssue(env: Env, title: string, body = ""): Promise<GhIssue> {
  const issue = await ghApi<GhIssue>(env, "POST",
    `/repos/${SANDBOX.owner}/${SANDBOX.repo}/issues`, { title, body });
  return issue;
}

export interface SandboxPr {
  number: number;
  headSha: string;
  branch: string;
}

let defaultBranch: string | null = null;
async function baseBranch(env: Env): Promise<string> {
  if (defaultBranch) return defaultBranch;
  const repo = await ghApi<{ default_branch: string }>(env, "GET",
    `/repos/${SANDBOX.owner}/${SANDBOX.repo}`);
  defaultBranch = repo.default_branch;
  return defaultBranch;
}

/** Create a real PR in the sandbox repo: new branch + one file commit + PR.
 * `binary: true` writes a .bin file so GitHub omits `patch` (exercises the
 * no-computable-diff path with a real artifact). */
export async function createPr(env: Env, opts: {
  title: string; body?: string; binary?: boolean;
}): Promise<SandboxPr> {
  const branch = `ws-test/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const base = await baseBranch(env);
  const ref = await ghApi<{ object: { sha: string } }>(env, "GET",
    `/repos/${SANDBOX.owner}/${SANDBOX.repo}/git/ref/heads/${base}`);
  await ghApi(env, "POST", `/repos/${SANDBOX.owner}/${SANDBOX.repo}/git/refs`, {
    ref: `refs/heads/${branch}`, sha: ref.object.sha,
  });
  const path = `ws-test/${branch}.txt`;
  const content = opts.binary
    ? btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(2048))))
    : btoa(`fixture for ${opts.title}\nline two\n`);
  await ghApi(env, "PUT",
    `/repos/${SANDBOX.owner}/${SANDBOX.repo}/contents/${path}`, {
      message: `test: ${opts.title}`, content, branch,
    });
  const pr = await ghApi<{ number: number; head: { sha: string } }>(env, "POST",
    `/repos/${SANDBOX.owner}/${SANDBOX.repo}/pulls`, {
      title: opts.title, head: branch, base, body: opts.body ?? "",
    });
  return { number: pr.number, headSha: pr.head.sha, branch };
}

// ------------------------------------------------------------- feed doc --

/** Seed the real KV feed doc with a doc containing the given records and
 * mirrors. Mirrors are what /api/mirrors* handlers look up, so tests build
 * real MirrorListings that point at real GitHub artifacts. */
export async function seedFeedDoc(
  env: Env,
  records: FeedRecord[],
  mirrors: MirrorListing[] = [],
): Promise<void> {
  const doc: FeedDoc = {
    generated_at: Date.now(),
    sources: { "test-seed": { ok: true, count: records.length, fetched_at: Date.now() } },
    records,
    mirrors,
  };
  await putFeedDoc(env, doc);
}

/** A FeedRecord that makes the record mirrorable (external escrow). */
export function feedRecord(over: Partial<FeedRecord> & { id: string }): FeedRecord {
  return {
    source: "github-thirdparty:generic",
    forge: "github",
    kind: "bounty",
    title: "test bounty",
    url: "https://github.com/TerexitariusStomp/widespread-sandbox/issues/1",
    escrow: { state: "external" },
    updated_at: Date.now(),
    ...over,
  };
}

/** A MirrorListing for a sandbox issue — record_id encodes owner/repo#N so
 * ingest's parseIssueRef resolves it to the real repo. */
export function sandboxMirror(opts: {
  recordId: string; title?: string; estUsd?: number; specHash?: string;
}): MirrorListing {
  const stamp = Date.now();
  const spec = opts.specHash ? `spec for ${opts.recordId}` : `spec ${stamp}`;
  return {
    id: `mirror:${opts.recordId}`,
    record_id: opts.recordId,
    title: opts.title ?? `sandbox bounty ${stamp}`,
    url: `https://github.com/${opts.recordId.replace(/.*:/, "")}`,
    repo: "TerexitariusStomp/widespread-sandbox",
    original: { amount: String(opts.estUsd ?? 10), currency: "USD", est_usd: opts.estUsd ?? 10 },
    cut_bps: 1000,
    claimant_share: { est_usd: (opts.estUsd ?? 10) * 0.9 },
    spec,
    spec_hash: opts.specHash ?? `sha256:spec-${stamp}`,
    createMarketArgs: {
      specHash: opts.specHash ?? `sha256:spec-${stamp}`,
      spec,
      deadline: null,
      acceptanceRule: "best",
      platformBps: 1000,
      platformTo: "widespread-dao.near",
    },
    status: "fiat-funded",
    created_at: stamp,
    updated_at: stamp,
  };
}
