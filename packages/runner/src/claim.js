// claim.js — emit a real dg-ship-1 attestation to the delta-git forge.
// Mirrors the bridge's scripts/ship-claim.mjs flow: ephemeral Ed25519 agent
// registers itself, then POSTs /dg/ship with the signed x-dg-* envelope.
// The forge verifies commits against the repo's upstream .patch endpoint.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const te = new TextEncoder();
const toHex = (b) =>
  [...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
const sha256Hex = async (d) => toHex(await crypto.subtle.digest("SHA-256", d));

let cached = null; // {did, pair} — reuse the agent across the session

/**
 * Hardware-rooted environment proof: tpm2 PCR quote/values when a TPM is
 * present (vTPM in omarchy-compartment VMs), container fallback markers
 * otherwise. Best-effort — absence is reported, never faked.
 */
export function collectEnvAttestation() {
  const out = { collected_at: new Date().toISOString(), runtime: "node" };
  try {
    const pcrs = execFileSync("tpm2_pcrread", ["sha256:0,1,2,3,4,7"], { timeout: 5000 }).toString();
    out.tpm2_pcr_values = pcrs.trim();
    out.tpm = true;
  } catch {
    try {
      const q = execFileSync("tpm2_quote", ["--qualification"], { timeout: 5000 }).toString();
      out.tpm2_quote = q.trim().slice(0, 8192);
      out.tpm = true;
    } catch {
      out.tpm = false;
      out.note = "no tpm2 — software seal only";
    }
  }
  try {
    out.container_id = readFileSync("/proc/self/cgroup", "utf8").trim().slice(0, 200);
  } catch { /* bare host */ }
  return out;
}

async function registerAgent(forgeBase, label) {
  if (cached) return cached;
  const pair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const pubkeyHex = toHex(await crypto.subtle.exportKey("raw", pair.publicKey));
  const res = await fetch(`${forgeBase}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pubkey: pubkeyHex, label }),
  });
  if (!res.ok) throw new Error(`agent register: ${res.status} ${await res.text()}`);
  const { did } = await res.json();
  cached = { did, pair };
  return cached;
}

/**
 * Ship commits to the forge as a dg-ship-1 claim.
 * @returns {{seq:number, verified:boolean}} forge op-log seq + verify result
 */
export async function shipClaim({
  forgeBase,
  repo,
  commits,
  sessionId,
  tool = "widespread-runner",
  extra = {},
}) {
  const { did, pair } = await registerAgent(forgeBase, sessionId);
  const path = `/api/${repo}/dg/ship`;
  const body = {
    session_id: sessionId,
    tool,
    commits: commits.map((c) => c.toLowerCase()),
    env_attestation: collectEnvAttestation(),
    ...extra,
  };
  const bodyBytes = te.encode(JSON.stringify(body));
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const payload = await sha256Hex(
    te.encode(
      `dg1\n${did}\n${ts}\n${nonce}\nPOST\n${path}\n${await sha256Hex(bodyBytes)}`,
    ),
  );
  const sig = toHex(
    await crypto.subtle.sign("Ed25519", pair.privateKey, te.encode(payload)),
  );
  const res = await fetch(`${forgeBase}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dg-did": did,
      "x-dg-ts": ts,
      "x-dg-nonce": nonce,
      "x-dg-sig": sig,
    },
    body: bodyBytes,
  });
  const out = await res.json();
  return { did, seq: out.op_seq, verified: !!out.verified, raw: out };
}
