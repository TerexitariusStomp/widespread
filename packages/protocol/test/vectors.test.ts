// Round-trip tests against test-vectors.json — the same fixture the
// hermes Python plugin asserts against, so all implementations stay
// byte-compatible.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import {
  didKeyFromPublicKey,
  publicKeyFromDidKey,
  dg1Payload,
  dg1BodySha256Hex,
  signDg1Request,
  verifyDg1Request,
  opLogEntryHash,
  verifyOpLogChain,
  type OpLogEntry,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, "../test-vectors.json"), "utf8")) as {
  ed25519: { seedHex: string; publicKeyHex: string; did: string };
  dg1: {
    method: string;
    path: string;
    bodyUtf8: string;
    bodySha256Hex: string;
    ts: string;
    nonce: string;
    payload: string;
    signingDigestHex: string;
    signatureHex: string;
    headers: Record<string, string>;
  };
  oplog: { entries: OpLogEntry[]; tipHash: string; tipSeq: number };
};

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const unhex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const seed = hex(vectors.ed25519.seedHex);
const pub = hex(vectors.ed25519.publicKeyHex);
const did = vectors.ed25519.did;
const body = new TextEncoder().encode(vectors.dg1.bodyUtf8);

describe("did:key", () => {
  it("matches the fixed vector", () => {
    expect(unhex(ed25519.getPublicKey(seed))).toBe(vectors.ed25519.publicKeyHex);
    expect(didKeyFromPublicKey(pub)).toBe(did);
    expect(unhex(publicKeyFromDidKey(did)!)).toBe(vectors.ed25519.publicKeyHex);
  });

  it("rejects malformed / non-ed25519 dids", () => {
    expect(publicKeyFromDidKey("did:plc:abc")).toBeUndefined();
    expect(publicKeyFromDidKey("did:key:znotbase58!!!")).toBeUndefined();
    // secp256k1 multicodec (0xe701) must not decode as ed25519
    const other = new Uint8Array(34);
    other[0] = 0xe7; other[1] = 0x01;
    expect(publicKeyFromDidKey(`did:key:z${base58.encode(other)}`)).toBeUndefined();
  });
});

describe("dg1", () => {
  it("payload matches the fixed vector byte-for-byte", async () => {
    const v = vectors.dg1;
    expect(
      dg1Payload({
        did,
        ts: v.ts,
        nonce: v.nonce,
        method: v.method,
        path: v.path,
        bodySha256Hex: v.bodySha256Hex,
      })
    ).toBe(v.payload);
    expect(v.payload).toBe(
      `dg1\n${did}\n${v.ts}\n${v.nonce}\nPOST\n${v.path}\n${v.bodySha256Hex}`
    );
    expect(await dg1BodySha256Hex(body)).toBe(v.bodySha256Hex);
  });

  it("signDg1Request reproduces the vector signature (seed key)", async () => {
    const v = vectors.dg1;
    const headers = await signDg1Request({
      did,
      privateKey: seed,
      method: v.method,
      path: v.path,
      body,
      nowSec: Number(v.ts),
      nonce: v.nonce,
    });
    expect(headers).toEqual(v.headers);
  });

  it("verifyDg1Request accepts the vector signature", async () => {
    const v = vectors.dg1;
    const result = await verifyDg1Request({
      did,
      publicKey: pub,
      sig: v.signatureHex,
      ts: v.ts,
      nonce: v.nonce,
      method: "POST",
      path: v.path,
      body,
      nowSec: 1735689601,
    });
    expect(result).toEqual({ ok: true });
  });

  it("CryptoKey signing round-trips through verify", async () => {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const pk = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const d = didKeyFromPublicKey(pk);
    const b = new TextEncoder().encode("{}");
    const headers = await signDg1Request({
      did: d, privateKey: pair.privateKey, method: "post", path: "/api/x", body: b,
    });
    const result = await verifyDg1Request({
      did: d, publicKey: pk, sig: headers["x-dg-sig"],
      ts: headers["x-dg-ts"], nonce: headers["x-dg-nonce"],
      method: "POST", path: "/api/x", body: b,
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects stale timestamp, bad nonce, tampered body", async () => {
    const v = vectors.dg1;
    const base = {
      did, publicKey: pub, sig: v.signatureHex,
      ts: v.ts, nonce: v.nonce, method: "POST", path: v.path, body,
      nowSec: 1735689601,
    };
    expect(await verifyDg1Request({ ...base, ts: "1700000000" })).toEqual({
      ok: false, reason: "stale-timestamp",
    });
    expect(await verifyDg1Request({ ...base, nonce: "short" })).toEqual({
      ok: false, reason: "bad-nonce",
    });
    expect(await verifyDg1Request({ ...base, sig: "zz" })).toEqual({
      ok: false, reason: "bad-signature-format",
    });
    expect(
      await verifyDg1Request({ ...base, body: new TextEncoder().encode('{"tampered":true}') })
    ).toEqual({ ok: false, reason: "signature-mismatch" });
  });
});

describe("op-log chain", () => {
  it("recomputes every fixture hash", async () => {
    let prev = "genesis";
    for (const e of vectors.oplog.entries) {
      expect(e.prev_hash).toBe(prev);
      expect(await opLogEntryHash(e, prev)).toBe(e.hash);
      prev = e.hash;
    }
  });

  it("verifyOpLogChain accepts the fixture and detects tampering", async () => {
    const entries = vectors.oplog.entries;
    expect(await verifyOpLogChain(entries)).toMatchObject({
      valid: true, checked: 3, tip_seq: 2, tip_hash: vectors.oplog.tipHash,
    });
    const tampered = entries.map((e, i) =>
      i === 1 ? { ...e, payload: { ...e.payload, op: "forged" } } : e
    );
    const bad = await verifyOpLogChain(tampered);
    expect(bad.valid).toBe(false);
    expect(bad.broken_at_seq).toBe(1);
  });
});
