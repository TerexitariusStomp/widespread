import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { bytesToHex } from "@/worker/common/hex";
import { registerAgent } from "@/worker/agent/auth";
import { createDb } from "@/worker/db/d1/client";

import { uniqueRepoId } from "./util/test-helpers";
import { setupRepoForTests } from "./util/repoSeed";
import { ensureD1Migrations } from "./util/d1Setup";

// dg/status writeback auth — the exact envelope the widespread bridge
// signs when it posts adjudication receipts back to a forge commit.
// Regression coverage for the live `401 agent-auth:unknown-did` failure:
// an unregistered DID must be rejected before any status is written.

const te = new TextEncoder();

async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? te.encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

async function newAgent() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const db = createDb(env.DB);
  const agent = await registerAgent(db, { pubkeyHex: bytesToHex(pub), label: "dg-status-agent" });
  if (!("did" in agent)) throw new Error("register failed");
  return { pair, did: agent.did as string };
}

/** Build the dg1 signed-envelope headers for a POST to `path` with `body`. */
async function dgHeaders(args: {
  pair: CryptoKeyPair;
  did: string;
  path: string;
  body: Uint8Array;
  ts?: number;
  nonce?: string;
}): Promise<Record<string, string>> {
  const ts = String(args.ts ?? Math.floor(Date.now() / 1000));
  const nonce = args.nonce ?? crypto.randomUUID();
  const bodySha = await sha256Hex(args.body);
  const payload = await sha256Hex(
    `dg1\n${args.did}\n${ts}\n${nonce}\nPOST\n${args.path}\n${bodySha}`
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("Ed25519", args.pair.privateKey, te.encode(payload) as BufferSource)
  );
  return {
    "content-type": "application/json",
    "x-dg-did": args.did,
    "x-dg-ts": ts,
    "x-dg-nonce": nonce,
    "x-dg-sig": bytesToHex(sig),
  };
}

async function postStatus(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const bytes = te.encode(JSON.stringify(body));
  const res = await workerExports.default.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: bytes,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let owner: string;
let repo: string;
let base: string;

beforeAll(async () => {
  await ensureD1Migrations(env);
  owner = "o";
  repo = uniqueRepoId("dgstat");
  await setupRepoForTests(env, owner, repo);
  base = `https://example.com/api/${owner}/${repo}/dg/status`;
});

describe("dg/status writeback auth", () => {
  it("rejects unsigned requests (missing-signature-headers)", async () => {
    const res = await postStatus(base, {
      sha: "a".repeat(40), state: "success", context: "slopcash/payout",
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("agent-auth:missing-signature-headers");
  });

  it("rejects an unregistered DID — the live unknown-did failure", async () => {
    const { pair } = await newAgent();
    const ghost = await newAgent(); // registered then... use a fresh DID string instead
    void ghost;
    // A well-formed did:key that was never registered.
    const unregistered = await crypto.subtle.generateKey(
      { name: "Ed25519" }, true, ["sign", "verify"]
    );
    const pub = new Uint8Array(
      await crypto.subtle.exportKey("raw", unregistered.publicKey)
    );
    const { didKeyFromPubkey } = await import("@/worker/agent/atpauth/didkey");
    const did = didKeyFromPubkey(pub, "ed25519");
    const body = te.encode(JSON.stringify({
      sha: "b".repeat(40), state: "success", context: "slopcash/payout",
    }));
    const headers = await dgHeaders({
      pair: { publicKey: unregistered.publicKey, privateKey: unregistered.privateKey },
      did, path: `/api/${owner}/${repo}/dg/status`, body,
    });
    void pair;
    const res = await postStatus(base, JSON.parse(new TextDecoder().decode(body)), headers);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("agent-auth:unknown-did");
  });

  it("rejects a stale timestamp", async () => {
    const { pair, did } = await newAgent();
    const body = te.encode(JSON.stringify({
      sha: "c".repeat(40), state: "success", context: "ctx",
    }));
    const headers = await dgHeaders({
      pair, did, path: `/api/${owner}/${repo}/dg/status`, body,
      ts: Math.floor(Date.now() / 1000) - 3600,
    });
    const res = await postStatus(base, JSON.parse(new TextDecoder().decode(body)), headers);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("agent-auth:stale-timestamp");
  });

  it("rejects a signature over a different body", async () => {
    const { pair, did } = await newAgent();
    const signedBody = te.encode(JSON.stringify({
      sha: "d".repeat(40), state: "success", context: "ctx",
    }));
    const headers = await dgHeaders({
      pair, did, path: `/api/${owner}/${repo}/dg/status`, body: signedBody,
    });
    // Send a different body than what was signed.
    const res = await workerExports.default.fetch(base, {
      method: "POST",
      headers,
      body: te.encode(JSON.stringify({
        sha: "e".repeat(40), state: "success", context: "ctx",
      })),
    });
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe("agent-auth:signature-mismatch");
  });

  it("accepts a valid signed status and serves it back", async () => {
    const { pair, did } = await newAgent();
    const sha = "f".repeat(40);
    const payload = {
      sha, state: "success", context: "slopcash/payout",
      description: "adjudicated accept (confidence 0.85)",
      target_url: "https://widespread-bridge.widespread.workers.dev/receipt?x=1",
    };
    const body = te.encode(JSON.stringify(payload));
    const headers = await dgHeaders({
      pair, did, path: `/api/${owner}/${repo}/dg/status`, body,
    });
    const res = await postStatus(base, payload, headers);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const get = await workerExports.default.fetch(
      `https://example.com/api/${owner}/${repo}/dg/status/${sha}`
    );
    expect(get.status).toBe(200);
    const doc = (await get.json()) as {
      statuses: { context: string; state: string; created_by: string;
                  target_url: string | null }[];
    };
    expect(doc.statuses.length).toBe(1);
    const s = doc.statuses[0];
    expect(s.context).toBe("slopcash/payout");
    expect(s.state).toBe("success");
    expect(s.created_by).toBe(did);
    expect(s.target_url).toContain("widespread-bridge");
  });

  it("rejects invalid state values even when signed", async () => {
    const { pair, did } = await newAgent();
    const payload = { sha: "1".repeat(40), state: "bogus", context: "ctx" };
    const body = te.encode(JSON.stringify(payload));
    const headers = await dgHeaders({
      pair, did, path: `/api/${owner}/${repo}/dg/status`, body,
    });
    const res = await postStatus(base, payload, headers);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid state");
  });
});
