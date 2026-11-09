// writeback.test.ts — LIVE forge write-back tests.
// No fetch stubs: the test generates a REAL Ed25519 agent identity,
// registers it on the REAL forge (POST /api/agents), then calls
// writebackReceipt which performs a REAL dg1-signed POST to
// /api/slop/protocol/dg/status and reads the status back via the real
// GET endpoint. Registration is idempotent (same pubkey → same did).

import { describe, expect, it } from "vitest";
import { didKeyFromPublicKey } from "@widespread/protocol";
import { writebackReceipt } from "../src/writeback";
import { ghHeaders, GH_API } from "../src/forge";
import { realEnv } from "./helpers";
import type { Env } from "../src/types";

const FORGE = process.env.FORGE_BASE ?? "https://code.widespread.fyi";
const REPO = "slop/protocol";
const GH_COMMITS =
  "/repos/SlopDotCash/protocol/commits?per_page=5";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const bytesToB64 = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b));
const bytesToHex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Real Ed25519 identity: keypair → did:key → registered on the forge. */
async function liveAgent(): Promise<{ env: Env; did: string; pubkeyHex: string }> {
  const pair = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  // Ed25519 JWK 'x' is the raw 32-byte public key (base64url).
  const pub = b64ToBytes(jwk.x.replace(/-/g, "+").replace(/_/g, "/"));
  const pubkeyHex = bytesToHex(pub);
  const did = didKeyFromPublicKey(pub);

  // Register on the real forge — returns the same did (idempotent).
  const res = await fetch(`${FORGE}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pubkey: pubkeyHex,
      label: `bridge-test-${Date.now().toString(36)}`,
      family: "widespread",
    }),
  });
  const body = await res.json().catch(() => ({})) as { did?: string; error?: string };
  expect(res.status, `agent registration: HTTP ${res.status} ${JSON.stringify(body)}`).toBe(200);
  expect(body.did).toBe(did);

  const env = {
    ...realEnv(),
    DG_AGENT_DID: did,
    DG_AGENT_KEY_PKCS8_B64: bytesToB64(pkcs8),
    FORGE_BASE: FORGE,
    PUBLIC_BASE: process.env.PUBLIC_BASE ?? "https://widespread-bridge.widespread.workers.dev",
  } as Env;
  return { env, did, pubkeyHex };
}

/** A real commit sha on the forge's upstream repo (GitHub). */
async function realSha(): Promise<string> {
  const res = await fetch(`${GH_API}${GH_COMMITS}`, {
    headers: { ...ghHeaders(realEnv()), accept: "application/vnd.github+json" },
  });
  expect(res.ok, `github commits: HTTP ${res.status}`).toBe(true);
  const commits = await res.json() as { sha: string }[];
  return commits[0].sha;
}

describe("writebackReceipt", () => {
  it("skips cleanly without agent identity (no network)", async () => {
    const w = await writebackReceipt(realEnv(), {
      repo: REPO, sha: "abc", accepted: true, description: "d", claimId: "c1",
    });
    expect(w.attempted).toBe(false);
    expect(w.skipped_reason).toMatch(/DG_AGENT/);
  });

  it("rejects a malformed agent key without calling the forge", async () => {
    const env = {
      ...realEnv(),
      DG_AGENT_DID: "did:key:zTestAgent",
      DG_AGENT_KEY_PKCS8_B64: btoa("not-a-key"),
      FORGE_BASE: FORGE,
    } as Env;
    const w = await writebackReceipt(env, {
      repo: REPO, sha: "abc", accepted: true, description: "d", claimId: "c1",
    });
    expect(w.attempted).toBe(false);
    expect(w.skipped_reason).toMatch(/not a valid Ed25519/);
  });

  it("writes a REAL signed receipt to the forge and reads it back", async () => {
    const { env, did } = await liveAgent();
    const sha = await realSha();
    const w = await writebackReceipt(env, {
      repo: REPO, sha, accepted: true,
      description: `live bridge writeback test ${Date.now().toString(36)}`,
      claimId: `wb-${Date.now().toString(36)}`,
    });
    expect(w.attempted).toBe(true);
    expect(w.error).toBeUndefined();
    expect(w.status_url).toBe(`${FORGE}/api/${REPO}/dg/status/${sha}`);

    // Real read-back: the forge's status endpoint must list our row,
    // attributed to our registered did.
    const res = await fetch(`${FORGE}/api/${REPO}/dg/status/${sha}`);
    expect(res.status).toBe(200);
    const doc = await res.json() as {
      statuses: { context: string; state: string; created_by: string; description: string | null }[];
    };
    const row = doc.statuses.find(
      (s) => s.context === "widespread/payout" && s.created_by === did);
    expect(row, `no receipt row for ${did} on ${sha}`).toBeTruthy();
    expect(row!.state).toBe("success");
  }, 60000);
});
