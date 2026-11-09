// dg1 — the signed-request envelope delta-git agent endpoints verify.
//
// Mutating agent requests carry four headers:
//   x-dg-did, x-dg-ts (unix seconds), x-dg-nonce, x-dg-sig (hex)
// The signed payload is the ASCII string
//   sha256hex("dg1\n" + did + "\n" + ts + "\n" + nonce + "\n"
//             + METHOD + "\n" + path + "\n" + bodySha256Hex)
// and the Ed25519 signature covers the UTF-8 bytes of that *hex digest
// string* — not the raw digest. This matches the verifier byte-for-byte;
// do not "fix" it to sign the raw digest.
//
// Replay protection is the caller's job (timestamp window + nonce store);
// verifyDg1Request implements the timestamp/nonce/sig checks only.

import { ed25519 } from "@noble/curves/ed25519.js";

const te = new TextEncoder();

export const DG1_SIG_WINDOW_SEC = 300;

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex: string): Uint8Array | undefined {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

export interface Dg1PayloadArgs {
  did: string;
  /** Unix seconds, as a decimal string (header value verbatim). */
  ts: string;
  nonce: string;
  method: string;
  path: string;
  /** Lowercase hex sha256 of the raw request body. */
  bodySha256Hex: string;
}

/** Canonical dg1 payload string (pre-hash). METHOD is uppercased. */
export function dg1Payload(args: Dg1PayloadArgs): string {
  return (
    `dg1\n${args.did}\n${args.ts}\n${args.nonce}\n` +
    `${args.method.toUpperCase()}\n${args.path}\n${args.bodySha256Hex}`
  );
}

/** sha256 hex of the raw body bytes — the `bodySha256Hex` input. */
export async function dg1BodySha256Hex(body: Uint8Array): Promise<string> {
  return sha256Hex(body);
}

/** The exact bytes the Ed25519 signature covers: utf8(hexDigest). */
async function dg1SigningBytes(args: Dg1PayloadArgs): Promise<Uint8Array> {
  const digestHex = await sha256Hex(te.encode(dg1Payload(args)));
  return te.encode(digestHex);
}

/** The four `x-dg-*` headers delta-git expects on a signed request. */
export interface Dg1Headers {
  "x-dg-did": string;
  "x-dg-ts": string;
  "x-dg-nonce": string;
  "x-dg-sig": string;
}

export interface SignDg1RequestArgs {
  did: string;
  /**
   * Signing key: a WebCrypto Ed25519 CryptoKey (pkcs8/jwk import — the
   * bridge's `DG_AGENT_KEY_PKCS8_B64` flow), or a 32-byte ed25519 seed
   * handled by @noble/curves for runtimes without WebCrypto Ed25519.
   */
  privateKey: CryptoKey | Uint8Array;
  method: string;
  path: string;
  /** Raw request body bytes (the exact bytes sent on the wire). */
  body: Uint8Array;
  /** Injectable clock/nonce for tests and the test-vector fixture. */
  nowSec?: number;
  nonce?: string;
}

/**
 * Produce the `x-dg-*` header set for a dg1-signed request. Nonce is a
 * 32-char random hex string (16 bytes), matching what the forge's
 * 8–128-char nonce window accepts and what existing producers emit.
 */
export async function signDg1Request(args: SignDg1RequestArgs): Promise<Dg1Headers> {
  const ts = String(args.nowSec ?? Math.floor(Date.now() / 1000));
  const nonce = args.nonce ?? bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const payloadArgs: Dg1PayloadArgs = {
    did: args.did,
    ts,
    nonce,
    method: args.method,
    path: args.path,
    bodySha256Hex: await dg1BodySha256Hex(args.body),
  };
  const signingBytes = await dg1SigningBytes(payloadArgs);

  let sigBytes: Uint8Array;
  if (args.privateKey instanceof Uint8Array) {
    if (args.privateKey.length !== 32) {
      throw new Error("ed25519 seed must be 32 bytes");
    }
    sigBytes = ed25519.sign(signingBytes, args.privateKey);
  } else {
    sigBytes = new Uint8Array(
      await crypto.subtle.sign("Ed25519", args.privateKey, signingBytes as BufferSource)
    );
  }

  return {
    "x-dg-did": args.did,
    "x-dg-ts": ts,
    "x-dg-nonce": nonce,
    "x-dg-sig": bytesToHex(sigBytes),
  };
}

export type Dg1VerifyRejectReason =
  | "stale-timestamp"
  | "bad-nonce"
  | "bad-signature-format"
  | "bad-pubkey"
  | "signature-mismatch";

export type Dg1VerifyResult = { ok: true } | { ok: false; reason: Dg1VerifyRejectReason };

export interface VerifyDg1RequestArgs {
  did: string;
  /** 32-byte raw ed25519 public key. */
  publicKey: Uint8Array;
  /** Hex-encoded 64-byte Ed25519 signature (the `x-dg-sig` value). */
  sig: string;
  /** Header values verbatim. */
  ts: string;
  nonce: string;
  method: string;
  path: string;
  /** Raw request body bytes. */
  body: Uint8Array;
  nowSec?: number;
  windowSec?: number;
}

/**
 * Verify a dg1-signed request envelope — timestamp window, nonce shape,
 * signature format, and the Ed25519 signature itself. Agent existence,
 * ban status, and nonce-replay stores are the caller's responsibility
 * (delta-git keeps those in D1).
 */
export async function verifyDg1Request(
  args: VerifyDg1RequestArgs
): Promise<Dg1VerifyResult> {
  const windowSec = args.windowSec ?? DG1_SIG_WINDOW_SEC;
  const ts = Number(args.ts);
  const now = args.nowSec ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > windowSec) {
    return { ok: false, reason: "stale-timestamp" };
  }
  if (args.nonce.length < 8 || args.nonce.length > 128) {
    return { ok: false, reason: "bad-nonce" };
  }
  const sigBytes = hexToBytes(args.sig);
  if (!sigBytes || sigBytes.length !== 64) {
    return { ok: false, reason: "bad-signature-format" };
  }

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      args.publicKey as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
  } catch {
    return { ok: false, reason: "bad-pubkey" };
  }

  const payloadArgs: Dg1PayloadArgs = {
    did: args.did,
    ts: args.ts,
    nonce: args.nonce,
    method: args.method,
    path: args.path,
    bodySha256Hex: await dg1BodySha256Hex(args.body),
  };
  const ok = await crypto.subtle.verify(
    "Ed25519",
    key,
    sigBytes as BufferSource,
    (await dg1SigningBytes(payloadArgs)) as BufferSource
  );
  return ok ? { ok: true } : { ok: false, reason: "signature-mismatch" };
}
