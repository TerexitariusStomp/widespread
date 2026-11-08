// Evidence collection: recompute the diff each claimed commit actually made.
//
// Two sources, tried in order:
//   1. Local repos — the forge serves a unified diff per commit at
//      GET /api/v1/repos/{owner}/{repo}/commits/{sha}/diff (text/plain).
//   2. Remote-backed repos keep objects on their git upstream; the forge's
//      own verifier reads `{upstream}/commit/{sha}.patch` (GitHub serves
//      format-patch there). We do the same, independently.

import type { CommitEvidence, Crosscheck, Env, ShipClaim } from "./types";

const DIFF_EXCERPT_CHARS = 6000;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;

export interface ParsedDiff {
  files: string[];
  linesAdded: number;
  linesRemoved: number;
}

/**
 * Count changed paths and +/- lines in a unified / format-patch body.
 * Same counting contract the forge verifier uses (diff --git b-paths,
 * +/− lines inside hunks, +++/--- header lines excluded).
 */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const files: string[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      const m = line.match(/^diff --git a\/.+ b\/(.+)$/);
      if (m) files.push(m[1]);
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) linesAdded += 1;
    else if (line.startsWith("-")) linesRemoved += 1;
  }
  return { files, linesAdded, linesRemoved };
}

/** Pull the commit subject line out of a format-patch body. */
export function patchSubject(patch: string): string | null {
  const m = patch.match(/^Subject: (?:\[PATCH[^\]]*\] )?(.*)$/m);
  return m ? m[1].trim() : null;
}

/**
 * Context-insensitive diff fingerprint — the `git patch-id` idea: a
 * payer who re-lands your work in a fresh commit (new message, new
 * metadata, same logical change) produces the same fingerprint.
 * We hash normalized +/- line content only — filenames, line numbers,
 * index lines, and commit metadata are all stripped, so a copy can't
 * hide behind cosmetic edits.
 */
export async function patchFingerprint(diffText: string): Promise<string> {
  const lines = diffText.split("\n").filter((l) => {
    // keep added/removed content lines only — the change itself
    return (l.startsWith("+") && !l.startsWith("+++"))
        || (l.startsWith("-") && !l.startsWith("---"));
  });
  // normalize whitespace so trivial reformatting doesn't dodge matching
  const normalized = lines
    .map((l) => l[0] + l.slice(1).replace(/\s+/g, " ").trim())
    .join("\n");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compare a claim's patch fingerprint against the fingerprints of later
 * upstream commits. Returns the matching upstream sha when a later commit
 * lands the same logical change — the "used my code, never accepted" proof.
 */
export async function findDerivative(opts: {
  claimFingerprint: string;
  laterCommits: { sha: string; fingerprint: string }[];
}): Promise<{ sha: string; matched: boolean } | null> {
  const hit = opts.laterCommits.find((c) => c.fingerprint === opts.claimFingerprint);
  return hit ? { sha: hit.sha, matched: true } : null;
}

async function fetchText(url: string, maxBytes: number): Promise<string | null> {
  const res = await fetch(url, { headers: { accept: "text/plain" } }).catch(() => null);
  if (!res || !res.ok || !res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) return null;
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/**
 * Where a remote-backed repo's objects actually live. Resolution order:
 * explicit bounty.upstream → UPSTREAM_HINTS env map → the SlopDotCash
 * convention (slop/<name> mirrors github.com/SlopDotCash/<name>).
 */
export function upstreamFor(repo: string, env: Env, explicit?: string): string | null {
  if (explicit) return explicit.replace(/\.git\/?$/, "").replace(/\/+$/, "");
  const hints = (env as unknown as { UPSTREAM_HINTS?: string }).UPSTREAM_HINTS;
  if (hints) {
    try {
      const map = JSON.parse(hints) as Record<string, string>;
      if (map[repo]) return map[repo].replace(/\.git\/?$/, "").replace(/\/+$/, "");
    } catch {
      // malformed env var — fall through to the convention
    }
  }
  const [owner, name] = repo.split("/");
  if (owner === "slop" && name) return `https://github.com/SlopDotCash/${name}`;
  return null;
}

async function commitMessage(forgeBase: string, repo: string, sha: string): Promise<string | null> {
  const res = await fetch(`${forgeBase}/api/v1/repos/${repo}/commits/${sha}`, {
    headers: { accept: "application/json" },
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const body = (await res.json().catch(() => null)) as {
    message?: string;
    title?: string;
  } | null;
  return body?.message ?? body?.title ?? null;
}

/** Gather one commit's evidence; never throws — unavailable is a verdict input. */
export async function gatherCommitEvidence(
  env: Env,
  repo: string,
  sha: string,
  upstream?: string
): Promise<CommitEvidence> {
  const base: CommitEvidence = {
    sha,
    source: "unavailable",
    message: null,
    files: [],
    lines_added: 0,
    lines_removed: 0,
    diff_excerpt: null,
    evidence_url: null,
  };

  // 1) forge-local objects
  const diffUrl = `${env.FORGE_BASE}/api/v1/repos/${repo}/commits/${sha}/diff`;
  const local = await fetchText(diffUrl, MAX_PATCH_BYTES);
  if (local && local.includes("diff --git")) {
    const parsed = parseUnifiedDiff(local);
    return {
      ...base,
      source: "forge-diff",
      message: await commitMessage(env.FORGE_BASE, repo, sha),
      files: parsed.files,
      lines_added: parsed.linesAdded,
      lines_removed: parsed.linesRemoved,
      diff_excerpt: local.slice(0, DIFF_EXCERPT_CHARS),
      evidence_url: diffUrl,
    };
  }

  // 2) remote-backed: the upstream's public format-patch endpoint
  const upstreamBase = upstreamFor(repo, env, upstream);
  if (upstreamBase) {
    const patchUrl = `${upstreamBase}/commit/${sha}.patch`;
    const patch = await fetchText(patchUrl, MAX_PATCH_BYTES);
    if (patch && patch.includes("diff --git")) {
      const parsed = parseUnifiedDiff(patch);
      return {
        ...base,
        source: "upstream-patch",
        message: patchSubject(patch),
        files: parsed.files,
        lines_added: parsed.linesAdded,
        lines_removed: parsed.linesRemoved,
        diff_excerpt: patch.slice(0, DIFF_EXCERPT_CHARS),
        evidence_url: patchUrl,
      };
    }
  }

  return base;
}

/** Compare the claim's self-reported stats to what we recomputed. */
export function crosscheck(claim: ShipClaim, commits: CommitEvidence[]): Crosscheck {
  const files = new Set<string>();
  let lines = 0;
  let verified = 0;
  for (const c of commits) {
    if (c.source === "unavailable") continue;
    verified += 1;
    for (const f of c.files) files.add(f);
    lines += c.lines_added + c.lines_removed;
  }
  const claimedFiles = typeof claim.files === "number" ? claim.files : null;
  const claimedLines =
    typeof claim.lines_added === "number" || typeof claim.lines_removed === "number"
      ? (claim.lines_added ?? 0) + (claim.lines_removed ?? 0)
      : null;
  const partial = verified < commits.length;
  return {
    claimed_files: claimedFiles,
    recomputed_files: files.size,
    files_consistent: claimedFiles === null || partial ? null : files.size === claimedFiles,
    claimed_lines: claimedLines,
    recomputed_lines: lines,
    lines_consistent: claimedLines === null || partial ? null : lines === claimedLines,
    commits_verified: verified,
    commits_total: commits.length,
    partial,
  };
}
