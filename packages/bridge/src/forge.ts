// forge.ts — GitHub forge-artifact primitives shared by every claim
// path: NEAR market claims (claims.ts), fiat mirror claims
// (mirrorclaims.ts), and automatic submission ingestion (ingest.ts).
//
// validateForgeSubmission() in claims.ts is the single entry point all
// three call — it composes these helpers into the {failures, evidence}
// contract. Keep forge I/O here so the callers stay transport-agnostic.

import type { Env } from "./types";

export const GH_API = "https://api.github.com";

interface GhAuthor { id: number; login: string }
export interface GhIssue {
  number: number; state: string; title: string;
  user: GhAuthor; pull_request?: unknown;
}
export interface GhPull extends GhIssue {
  head: { sha: string }; merged_at?: string | null;
  additions: number; deletions: number; changed_files: number;
}
export interface GhFile { filename: string; patch?: string; status: string }

export function ghHeaders(env: Env): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "widespread-bridge",
    ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
  };
}

export async function gh<T>(env: Env, path: string): Promise<{ data: T | null; error?: string }> {
  const res = await fetch(`${GH_API}${path}`, { headers: ghHeaders(env) });
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    return { data: null, error: `github rate limited${reset ? ` (resets ${new Date(Number(reset) * 1000).toISOString()})` : ""} — set GITHUB_TOKEN secret` };
  }
  if (!res.ok) return { data: null, error: `github ${res.status} for ${path}` };
  return { data: (await res.json()) as T };
}

/** Parse owner/repo + kind + number from a forge ref. Returns null when the
 * ref isn't a recognized GitHub issue/PR locator. */
export function parseForgeRef(ref: string):
  { owner: string; repo: string; kind: "issue" | "pr"; number: number } | null {
  const m = ref.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/i)
    ?? ref.match(/^([\w.-]+)\/([\w.-]+)[#\/](\d+)$/);
  if (!m) return null;
  if (m.length === 5) {
    return { owner: m[1], repo: m[2], kind: m[3].toLowerCase() === "pull" ? "pr" : "issue", number: Number(m[4]) };
  }
  return { owner: m[1], repo: m[2], kind: "issue", number: Number(m[3]) };
}

/** Deterministic fingerprint over a PR's file patches — the cheap
 * "is this real work" signal (non-empty diff) without a git binary. */
export async function patchFingerprint(files: GhFile[]): Promise<string | null> {
  const material = files
    .filter((f) => f.patch)
    .map((f) => `${f.filename}${f.status}${f.patch}`)
    .join("\n---\n");
  if (!material) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return "sha256:" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
