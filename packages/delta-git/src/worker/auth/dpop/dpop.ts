/**
 * DPoP (Demonstrating Proof-of-Possession, RFC 9449) helpers.
 *
 * Moved out of src/vendor/widespread — internals now run on `jose`
 * (importJWK / jwtVerify / calculateJwkThumbprint) instead of hand-rolled
 * base64url + WebCrypto ECDSA. Exported signatures are unchanged.
 *
 * Validates: signature, htm, htu, iat (within 60s), jti (single-use via KV).
 */
import {
  calculateJwkThumbprint,
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
} from "jose";

export interface DpopStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

type DpopJwk = { kty: string; x: string; y: string; crv?: string };

interface DpopClaims {
  htm?: unknown;
  htu?: unknown;
  iat?: unknown;
  jti?: unknown;
}

/**
 * Compute the JWK thumbprint (RFC 7638) of a DPoP public key.
 * Delegates to jose's calculateJwkThumbprint — the canonical member set
 * per kty (EC keys include `crv`), which is what RFC 9449 `jkt` means.
 */
export async function computeJwkThumbprint(jwk: DpopJwk): Promise<string> {
  // RFC 7638 thumbprints use only the required members per kty — for EC
  // that includes `crv`. Callers that already gated on P-256 (the atp
  // verify route strips crv before storing) get the identical thumbprint
  // by defaulting it here.
  const normalized =
    jwk.kty === "EC" && !jwk.crv ? { ...jwk, crv: "P-256" } : jwk;
  return calculateJwkThumbprint(normalized);
}

/**
 * Verify a DPoP proof (RFC 9449).
 * The proof is a JWT signed with the client's DPoP private key.
 * Validates: signature, htm, htu, iat (within 60s), jti (single-use via KV).
 */
export async function verifyDpopProof(
  dpopProof: string,
  expectedHtm: string,
  expectedHtu: string,
  expectedJkt: string,
  store: DpopStore
): Promise<boolean> {
  try {
    const header = decodeProtectedHeader(dpopProof);
    if (header.typ !== "dpop+jwt") return false;
    if (header.alg !== "ES256") return false;
    const jwk = header.jwk as DpopJwk | undefined;
    if (!jwk || jwk.kty !== "EC") return false;

    // Claim checks run on the unverified payload first so a malformed or
    // replayed proof is rejected before the signature work — same order
    // the hand-rolled verifier used.
    const claims = decodeJwt(dpopProof) as DpopClaims;
    if (claims.htm !== expectedHtm) return false;
    if (claims.htu !== expectedHtu) return false;
    if (typeof claims.iat !== "number") return false;

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - claims.iat) > 60) return false;
    if (typeof claims.jti !== "string" || claims.jti.length === 0) return false;

    // Single-use jti check
    const jtiKey = `dpop:${claims.jti}`;
    if (await store.get(jtiKey)) return false;
    await store.put(jtiKey, "1", { expirationTtl: 120 });

    const jkt = await computeJwkThumbprint(jwk);
    if (jkt !== expectedJkt) return false;

    const key = await importJWK(jwk, "ES256");
    await jwtVerify(dpopProof, key, { algorithms: ["ES256"] });
    return true;
  } catch {
    return false;
  }
}
