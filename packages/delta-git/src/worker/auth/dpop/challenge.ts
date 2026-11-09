/**
 * Challenge nonce issuance and consumption.
 *
 * Moved out of src/vendor/widespread — behavior unchanged; nonce
 * generation still uses oslo/crypto (MIT).
 */
import { generateRandomString, alphabet } from "oslo/crypto";
import { pepperedHash } from "./metrics.js";

const NONCE_TTL = 5 * 60; // 5 minutes

export interface ChallengeStore {
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

/**
 * Issue a challenge nonce.
 * Stores in the challenge store with 5-min TTL.
 * The stored VALUE is HMAC(did, pepper) — nonces never hold a raw identity
 * and the pepper prevents enumerating which DIDs requested challenges from
 * a KV dump.
 */
export async function issueChallenge(
  did: string,
  store: ChallengeStore,
  pepper: string
): Promise<string> {
  const nonce = generateRandomString(32, alphabet("a-z", "A-Z", "0-9"));
  await store.put(`nonce:${nonce}`, await pepperedHash(did, pepper), { expirationTtl: NONCE_TTL });
  return nonce;
}

/**
 * Consume a challenge nonce (single-use — deleted on read).
 * Returns the peppered DID hash bound to the nonce, or null if expired/consumed.
 * Callers must compare against HMAC(presented did, pepper), not the raw DID.
 */
export async function consumeChallenge(
  nonce: string,
  store: ChallengeStore
): Promise<string | null> {
  const didHash = await store.get(`nonce:${nonce}`);
  if (!didHash) return null;
  await store.delete(`nonce:${nonce}`);
  return didHash;
}

export { NONCE_TTL };
