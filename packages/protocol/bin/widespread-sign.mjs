#!/usr/bin/env node
// widespread-sign — dg1 request signer + did:key keygen.
//
// Replaces delta-git/tools/did-sign.ts for agent-envelope signing:
// produces the x-dg-* headers delta-git verifies on mutating agent
// endpoints (POST /dg/ship, /dg/status, …).
//
//   widespread-sign keygen [--out key.json]
//       → fresh ed25519 did:key identity. Prints {did, privateKeyPkcs8Hex,
//         privateKeySeedHex}; --out also writes the JSON to a file.
//         The private key IS the credential — keep it safe.
//
//   widespread-sign sign --key <file> --method POST --path /api/o/r/dg/ship \
//       [--body '<json>' | --body-file <f> | stdin] [--did did:key:z…]
//       → prints the four x-dg-* headers as JSON.
//
//   --key accepts:
//     • the JSON written by `keygen` ({did, privateKeyPkcs8Hex, …})
//     • a bare hex string: 64-char = pkcs8, 32-char = raw ed25519 seed
//   --did defaults to the key file's did (or is derived for seed keys).

import { readFileSync, writeFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  didKeyFromPublicKey,
  publicKeyFromDidKey,
  signDg1Request,
} from "../dist/index.js";

const te = new TextEncoder();

const toHex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

function arg(name, args = process.argv) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

async function readBody() {
  if (has("body")) return te.encode(String(arg("body")));
  const file = arg("body-file");
  if (file) return new Uint8Array(readFileSync(file));
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const s = Buffer.concat(chunks).toString("utf8").trim();
    if (s) return te.encode(s);
  }
  return te.encode("{}");
}

async function keygen() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  // JWK export gives us the raw 32-byte seed for seed-based signers.
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const out = {
    did: didKeyFromPublicKey(pub),
    publicKeyHex: toHex(pub),
    privateKeyPkcs8Hex: toHex(pkcs8),
    privateKeySeedHex: jwk.d ? Buffer.from(jwk.d, "base64url").toString("hex") : undefined,
  };
  const file = arg("out");
  if (file) writeFileSync(file, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(out, null, 2));
}

async function loadKey(keyArg) {
  // Returns { did?, privateKey: CryptoKey|Uint8Array, seedPub? }
  const raw = readFileSync(keyArg, "utf8").trim();
  if (raw.startsWith("{")) {
    const j = JSON.parse(raw);
    const hex = j.privateKeyPkcs8Hex ?? j.privateKeyHex;
    if (!hex) throw new Error("key file JSON lacks privateKeyPkcs8Hex");
    const key = await crypto.subtle.importKey(
      "pkcs8", fromHex(hex), { name: "Ed25519" }, false, ["sign"]);
    return { did: j.did, privateKey: key };
  }
  const hex = raw.replace(/^0x/, "");
  if (hex.length === 64) {
    // 64 hex chars = 32-byte raw seed
    const seed = fromHex(hex);
    return { did: undefined, privateKey: seed, seedPub: ed25519.getPublicKey(seed) };
  }
  if (hex.length === 128) {
    const key = await crypto.subtle.importKey(
      "pkcs8", fromHex(hex), { name: "Ed25519" }, false, ["sign"]);
    return { did: undefined, privateKey: key };
  }
  throw new Error("unrecognized key file — expected keygen JSON or 64/128-char hex");
}

async function sign() {
  const keyArg = arg("key");
  const method = arg("method") ?? "POST";
  const path = arg("path");
  if (!keyArg || !path) {
    console.error("usage: widespread-sign sign --key <file> --method POST --path </api/...> [--body <json>|--body-file <f>] [--did did:key:z…]");
    process.exit(1);
  }
  const { did: keyDid, privateKey, seedPub } = await loadKey(keyArg);
  const did = arg("did") ?? keyDid ??
    (seedPub ? didKeyFromPublicKey(seedPub) : undefined);
  if (!did || !publicKeyFromDidKey(did)) {
    console.error("could not determine did:key — pass --did or use a keygen JSON / seed key");
    process.exit(1);
  }
  const body = await readBody();
  const headers = await signDg1Request({ did, privateKey, method, path, body });
  console.log(JSON.stringify(headers, null, 2));
}

const cmd = process.argv[2];
if (cmd === "keygen") await keygen();
else if (cmd === "sign") await sign();
else {
  console.error("usage:\n  widespread-sign keygen [--out key.json]\n  widespread-sign sign --key <file> --method POST --path </api/...> [--body <json>|--body-file <f>] [--did did:key:z…]");
  process.exit(1);
}
