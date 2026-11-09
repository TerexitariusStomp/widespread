import type { AgentRow } from "@/worker/db/d1/schema";
import type { Db } from "@/worker/db/d1";

import { eq } from "drizzle-orm";
import { agents } from "@/worker/db/d1/schema";
import { bytesToHex } from "@/worker/common/hex";
import { didKeyFromPubkey } from "./atpauth/didkey";

// delta-git agent auth — ed25519 DID + signed request envelopes.
//
// Agents register a public key and are identified by standard
// `did:key:z6Mk…` identifiers — the only supported format.
// Mutating agent endpoints carry signature headers:
//   x-dg-did, x-dg-ts (unix seconds), x-dg-nonce, x-dg-sig (hex)
// The signed payload is sha256("dg1\n" + did + "\n" + ts + "\n" + nonce + "\n"
// + method + "\n" + path + "\n" + bodySha256Hex). Replay protection relies on
// the timestamp window plus nonce freshness checks kept cheap in D1.

export const AGENT_SIG_WINDOW_SEC = 300;

const te = new TextEncoder();

/** Canonical agent DID for a new registration: `did:key` (ed25519). */
export function didForPubkey(pubkeyBytes: Uint8Array): string {
  return didKeyFromPubkey(pubkeyBytes, "ed25519");
}

/** Canonical `did:key` for a hex-encoded ed25519 pubkey — used by platform
 * seats whose key material is a compile-time constant. */
export function didForPubkeyHex(pubkeyHex: string): string {
  const pubkeyBytes = hexToBytesSafe(pubkeyHex);
  if (!pubkeyBytes || pubkeyBytes.length !== 32) {
    throw new Error("pubkey must be 32-byte hex");
  }
  return didKeyFromPubkey(pubkeyBytes, "ed25519");
}

export function hexToBytesSafe(hex: string): Uint8Array | undefined {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", te.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

export async function bodyDigestHex(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

async function importPubkey(pubkeyBytes: Uint8Array): Promise<CryptoKey | undefined> {
  try {
    return await crypto.subtle.importKey(
      "raw",
      pubkeyBytes as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
  } catch {
    return undefined;
  }
}

export type AgentAuth = { kind: "ok"; agent: AgentRow } | { kind: "rejected"; reason: string };

/** Look up a registered agent by DID — `did:key` spellings only. */
export async function getAgent(db: Db, did: string): Promise<AgentRow | undefined> {
  const rows = await db.select().from(agents).where(eq(agents.did, did)).limit(1);
  return rows[0];
}

/**
 * Normalize a self-declared family/model tag: lowercase, conservative
 * charset, bounded length. Returns null when the input doesn't conform —
 * callers treat null as "field absent" rather than an error.
 */
export function normalizeAgentTag(value: string | undefined | null): string | null {
  if (!value) return null;
  // Lowercase and collapse any run of non-tag characters into a single
  // hyphen so "Claude Code" and "claude_code" roll up together.
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z0-9][a-z0-9._-]{0,39}$/.test(normalized) ? normalized : null;
}

export async function registerAgent(
  db: Db,
  args: {
    pubkeyHex: string;
    label?: string;
    kind?: string;
    ownerDid?: string;
    family?: string;
    model?: string;
  }
): Promise<AgentRow | { error: string }> {
  const pubkeyBytes = hexToBytesSafe(args.pubkeyHex);
  if (!pubkeyBytes || pubkeyBytes.length !== 32) return { error: "pubkey must be 32-byte hex" };
  const did = didForPubkey(pubkeyBytes);
  const existing = await getAgent(db, did);
  if (existing) return existing;
  // Platform seats (kind="workers-ai") have verified family claims —
  // they are registered by the platform itself, not self-declared.
  const isPlatformSeat = args.kind === "workers-ai";
  await db.insert(agents).values({
    did,
    pubkey: args.pubkeyHex.toLowerCase(),
    label: args.label ?? null,
    ownerDid: args.ownerDid ?? null,
    kind: args.kind ?? "agent",
    family: normalizeAgentTag(args.family) ?? (isPlatformSeat ? "delta-git" : null),
    model: normalizeAgentTag(args.model) ?? null,
    familyVerified: isPlatformSeat ? 1 : 0,
    rep: 0,
    banned: 0,
    createdAt: Date.now(),
    lastSeenAt: null,
  });
  return (await getAgent(db, did)) ?? { error: "insert-failed" };
}

/**
 * Self-declared metadata update — the authenticated agent updates its own
 * label/family/model. `familyVerified` is never settable here; only
 * platform seats and the admin route can earn it.
 */
export async function updateAgentMeta(
  db: Db,
  did: string,
  args: { label?: string; family?: string; model?: string }
): Promise<AgentRow | undefined> {
  const agent = await getAgent(db, did);
  if (!agent) return undefined;
  await db
    .update(agents)
    .set({
      label: args.label !== undefined ? args.label.slice(0, 80) : agent.label,
      family: args.family !== undefined ? normalizeAgentTag(args.family) : agent.family,
      model: args.model !== undefined ? normalizeAgentTag(args.model) : agent.model,
    })
    .where(eq(agents.did, agent.did));
  return await getAgent(db, agent.did);
}

/**
 * Verify a signed agent request. `body` must already be buffered by the
 * caller (agent routes always parse JSON payloads anyway).
 */
export async function verifyAgentRequest(args: {
  db: Db;
  method: string;
  path: string;
  body: Uint8Array;
  did: string | null;
  ts: string | null;
  nonce: string | null;
  sig: string | null;
  nowSec?: number;
  /** Optional `x-dg-model` header — self-declared model attribution, folded
   * into the same row update as lastSeenAt (one write per request). */
  model?: string | null;
}): Promise<AgentAuth> {
  const { db } = args;
  if (!args.did || !args.ts || !args.nonce || !args.sig) {
    return { kind: "rejected", reason: "missing-signature-headers" };
  }
  const ts = Number(args.ts);
  const now = args.nowSec ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > AGENT_SIG_WINDOW_SEC) {
    return { kind: "rejected", reason: "stale-timestamp" };
  }
  if (args.nonce.length < 8 || args.nonce.length > 128) {
    return { kind: "rejected", reason: "bad-nonce" };
  }

  const agent = await getAgent(db, args.did);
  if (!agent) return { kind: "rejected", reason: "unknown-did" };
  if (agent.banned === 1) return { kind: "rejected", reason: "agent-banned" };

  const pubkeyBytes = hexToBytesSafe(agent.pubkey);
  const sigBytes = hexToBytesSafe(args.sig);
  if (!pubkeyBytes || !sigBytes || sigBytes.length !== 64) {
    return { kind: "rejected", reason: "bad-signature-format" };
  }
  const key = await importPubkey(pubkeyBytes);
  if (!key) return { kind: "rejected", reason: "bad-pubkey" };

  const bodySha = await bodyDigestHex(args.body);
  const payload = await sha256Hex(
    `dg1\n${args.did}\n${args.ts}\n${args.nonce}\n${args.method.toUpperCase()}\n${args.path}\n${bodySha}`
  );
  const ok = await crypto.subtle.verify(
    "Ed25519",
    key,
    sigBytes as BufferSource,
    te.encode(payload) as BufferSource
  );
  if (!ok) return { kind: "rejected", reason: "signature-mismatch" };

  // Fold the optional x-dg-model attribution into the lastSeenAt touch so
  // per-request model reporting costs zero extra writes.
  const model = normalizeAgentTag(args.model);
  await db
    .update(agents)
    .set({ lastSeenAt: Date.now(), ...(model && model !== agent.model ? { model } : {}) })
    .where(eq(agents.did, agent.did));
  return { kind: "ok", agent };
}

/** Bump/slash an agent's rep. Callers decide the delta. */
export async function adjustAgentRep(db: Db, did: string, delta: number): Promise<number> {
  const agent = await getAgent(db, did);
  if (!agent) return 0;
  const rep = Math.max(0, agent.rep + delta);
  await db.update(agents).set({ rep }).where(eq(agents.did, did));
  return rep;
}
