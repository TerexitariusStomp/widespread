// payouts.ts — contributor payout binding. Dual rails:
//   PayPal: `paypal:<email>` in PR/issue text (parsed by bot — no binding needed)
//   Crypto: POST /api/payouts/bind with a NEP-413 signed message proving
//           wallet control, bound to the contributor's forge identity.
// CAIP-122-shaped message so eip191/Solana slot in later under one contract.
// Anti-gaming: 10min KV nonce, forgeUserId inside the signed payload,
// wallet↔identity is 1:1 (duplicate wallet → reject).

import { Hono } from "hono";
import type { Env } from "../types";
import { json } from "./shared";
import { repIndex, spamLikely, exportRep, funderRep } from "../rep";
import { kv } from "../db";

const NONCE_TTL = 600;
const nonceKey = (id: string) => `payout:nonce:${id}`;
const bindKey = (id: string) => `payout:github:${id}`;
const walletKey = (a: string) => `payout:wallet:${a.toLowerCase()}`;

interface PayoutBinding {
  forgeUserId: string; chain: string; address: string;
  bound_at: number; sig: string; message: string;
}

export interface ResolvedPayout {
  rail: "paypal" | "near" | "none";
  paypal_email?: string; near_account?: string;
  source: "claim" | "bound" | "none";
}

/** PayPal email or bound crypto wallet, in precedence order. Exported for
 * mirrorclaims: destination only — the amount is always post-cut. */
export async function resolvePayout(
  env: Env, forgeUserId: string | undefined, claimPayout?: { paypal_email?: string },
): Promise<ResolvedPayout> {
  if (claimPayout?.paypal_email) {
    return { rail: "paypal", paypal_email: claimPayout.paypal_email, source: "claim" };
  }
  if (forgeUserId) {
    const raw = await kv(env).get(bindKey(forgeUserId)).catch(() => null);
    if (raw) {
      const b = JSON.parse(raw) as PayoutBinding;
      if (b.chain === "near") return { rail: "near", near_account: b.address, source: "bound" };
    }
  }
  return { rail: "none", source: "none" };
}

export function payoutRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // Challenge nonce — binds the eventual signature to this id + a window.
  app.get("/api/payouts/nonce", async (c) => {
    const id = new URL(c.req.url).searchParams.get("forgeUserId");
    if (!id) return json({ error: "forgeUserId required" }, 400);
    const nonce = crypto.randomUUID();
    await kv(c.env).put(nonceKey(id), nonce, { expirationTtl: NONCE_TTL });
    return json({ forgeUserId: id, nonce, ttl: NONCE_TTL,
      message: `widespread payout bind | github:${id} | ${nonce}` });
  });

  app.post("/api/payouts/bind", async (c) => {
    const body = await c.req.json().catch(() => null) as {
      forgeUserId?: string; chain?: string; address?: string;
      message?: string; publicKey?: string; signature?: string;
    } | null;
    const { forgeUserId: id, chain, address, message, publicKey, signature } = body ?? {};
    if (!id || !chain || !address || !message || !publicKey || !signature) {
      return json({ error: "forgeUserId, chain, address, message, publicKey, signature required" }, 400);
    }
    if (chain !== "near") return json({ error: "chain must be near (eip191 pending)" }, 400);
    if (!/^[a-z0-9._-]{2,64}\.(testnet|near)$/.test(address)) {
      return json({ error: "invalid near account" }, 400);
    }
    // Anti-replay: nonce must exist, match, and be inside the signed message.
    const nonce = await kv(c.env).get(nonceKey(id));
    if (!nonce || !message.includes(nonce)) {
      return json({ error: "stale or missing nonce" }, 409);
    }
    if (!message.includes(`github:${id}`) || !message.startsWith("widespread payout bind")) {
      return json({ error: "message must bind github:<forgeUserId>" }, 400);
    }
    // NEP-413 verify — signature covers borsh(message, nonce, recipient, None).
    let valid = false;
    try {
      const { PublicKey } = await import("near-api-js");
      const pk = PublicKey.from(publicKey);
      const sigBytes = decodeBase58(signature);
      const payload = nep413Payload(message, nonce, "widespread-bridge");
      const digest = await crypto.subtle.digest("SHA-256", payload);
      valid = pk.verify(new Uint8Array(digest), sigBytes);
    } catch (e) { return json({ error: `sig verify: ${String(e)}` }, 400); }
    if (!valid) return json({ error: "signature invalid" }, 403);
    // 1:1 — wallet already bound to a different identity?
    const existing = await kv(c.env).get(walletKey(address));
    if (existing && existing !== id) {
      return json({ error: "wallet already bound to another identity" }, 409);
    }
    const binding: PayoutBinding = { forgeUserId: id, chain, address, bound_at: Date.now(), sig: signature, message };
    await kv(c.env).put(bindKey(id), JSON.stringify(binding));
    await kv(c.env).put(walletKey(address), id);
    await kv(c.env).delete(nonceKey(id));
    return json({ ok: true, binding: { forgeUserId: id, chain, address, bound_at: binding.bound_at } });
  });

  // Contributor identity: bound payout rail + rep counters + spam flag.
  app.get("/api/payouts/:forgeUserId", async (c) => {
    const id = c.req.param("forgeUserId");
    const raw = await kv(c.env).get(bindKey(id));
    const b = raw ? JSON.parse(raw) as PayoutBinding : null;
    const idx = await repIndex(c.env);
    const rep = idx.contrib[id];
    return json({
      forgeUserId: id,
      ...(b ? { chain: b.chain, address: b.address, bound_at: b.bound_at } : {}),
      rep: rep ? { ...rep, spam_likely: spamLikely(rep) } : null,
    });
  });

  // Portable rep — signed events the contributor owns, verifiable offline.
  app.get("/api/rep/:forgeUserId/export", async (c) => {
    const id = c.req.param("forgeUserId");
    const events = await exportRep(c.env, id);
    const fundRep = await funderRep(c.env, id).catch(() => null);
    return json({ forgeUserId: id, events, funder: fundRep });
  });

  return app;
}

function decodeBase58(s: string): Uint8Array {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = [0];
  for (const ch of s) {
    let carry = A.indexOf(ch);
    if (carry < 0) throw new Error("bad base58");
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let i = 0; i < s.length && s[i] === "1"; i++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

/** borsh-serialized NEP-413 payload: u32 tag 2**31-1+413? — the standard is
 * u32(2147484061) || message(str) || nonce(32B) || recipient(str) || None. */
function nep413Payload(message: string, nonce: string, recipient: string): Uint8Array {
  const enc = new TextEncoder();
  const m = enc.encode(message), r = enc.encode(recipient);
  const n = new Uint8Array(32);
  const nb = atobToBytes(nonce);
  n.set(nb.subarray(0, 32));
  const u32 = (v: number) => new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255]);
  const out = new Uint8Array(4 + 4 + m.length + 32 + 4 + r.length + 1);
  let o = 0;
  out.set(u32(2147484061), o); o += 4;
  out.set(u32(m.length), o); o += 4; out.set(m, o); o += m.length;
  out.set(n, o); o += 32;
  out.set(u32(r.length), o); o += 4; out.set(r, o); o += r.length;
  out[o] = 0; // callbackUrl = None
  return out;
}

function atobToBytes(s: string): Uint8Array {
  // nonce from the binding path is a UUID string — pad it into 32 bytes.
  const b = new Uint8Array(32);
  const enc = new TextEncoder().encode(s);
  b.set(enc.subarray(0, 32));
  return b;
}
