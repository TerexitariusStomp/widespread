// claim.js — emit a real dg-ship-1 attestation to the delta-git forge.
// Mirrors the bridge's scripts/ship-claim.mjs flow: ephemeral Ed25519 agent
// registers itself, then POSTs /dg/ship with the signed x-dg-* envelope.
// The forge verifies commits against the repo's upstream .patch endpoint.

const te = new TextEncoder();
const toHex = (b) =>
  [...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
const sha256Hex = async (d) => toHex(await crypto.subtle.digest("SHA-256", d));

let cached = null; // {did, pair} — reuse the agent across the session

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
