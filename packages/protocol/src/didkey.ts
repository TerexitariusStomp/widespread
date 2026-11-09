// did:key helpers for ed25519 keys — the only curve the dg1 agent
// envelope uses. did:key encodes `<multicodec-prefix> || <raw pubkey>`
// as base58btc with a "z" multibase marker:
//   0xed01 → Ed25519   (did:key:z6Mk…)
//
// Base58btc is the plain Bitcoin base58 alphabet (no checksum); the
// multibase "z" prefix is part of the DID string, not the payload.

import { base58 } from "@scure/base";

/** Two-byte multicodec varint prefix for ed25519 public keys. */
const ED25519_MULTICODEC_PREFIX = 0xed01;

const DID_KEY_RE = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)$/;

/**
 * Canonical `did:key` identifier for a 32-byte ed25519 public key.
 * @throws if `pub` is not exactly 32 bytes.
 */
export function didKeyFromPublicKey(pub: Uint8Array): string {
  if (pub.length !== 32) {
    throw new Error("ed25519 public key must be 32 bytes");
  }
  const payload = new Uint8Array(2 + pub.length);
  payload[0] = ED25519_MULTICODEC_PREFIX >> 8;
  payload[1] = ED25519_MULTICODEC_PREFIX & 0xff;
  payload.set(pub, 2);
  return `did:key:z${base58.encode(payload)}`;
}

/**
 * Decode a `did:key` ed25519 identifier back to its 32-byte public key.
 * Returns `undefined` for malformed DIDs, non-ed25519 multicodec
 * prefixes, or wrong key lengths.
 */
export function publicKeyFromDidKey(did: string): Uint8Array | undefined {
  const match = DID_KEY_RE.exec(did);
  if (!match) return undefined;
  let decoded: Uint8Array;
  try {
    decoded = base58.decode(match[1]);
  } catch {
    return undefined;
  }
  if (decoded.length !== 34) return undefined;
  if (((decoded[0] << 8) | decoded[1]) !== ED25519_MULTICODEC_PREFIX) return undefined;
  return decoded.slice(2);
}
