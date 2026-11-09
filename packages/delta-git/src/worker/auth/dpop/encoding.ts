/**
 * Encoding helpers — base64, hex, UTF-8.
 *
 * Moved out of src/vendor/widespread/crypto — hex now delegates to
 * @noble/hashes/utils.js; base64/base64url/UTF-8 stay dependency-free
 * (atob/btoa/TextEncoder are universal in Workers + Node ≥16).
 */
import { bytesToHex as nobleBytesToHex, hexToBytes as nobleHexToBytes } from "@noble/hashes/utils.js";

/** Convert bytes to lowercase `0x`-prefixed hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  return `0x${nobleBytesToHex(bytes)}`;
}

/** Convert a `0x`-prefixed hex string to bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return nobleHexToBytes(clean);
}

/** Convert bytes to base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Convert base64 string to bytes. */
export function base64ToBytes(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** Convert bytes to base64url string (no padding, URL-safe). */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Convert base64url string to bytes. */
export function base64UrlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  return base64ToBytes(pad ? padded + "=".repeat(4 - pad) : padded);
}

/** Convert string to UTF-8 bytes. */
export function utf8ToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Convert UTF-8 bytes to string. */
export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
