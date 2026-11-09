// encoding.ts — base64/base64url + sha256 helpers shared by the relay
// worker, the session Durable Object, and the TCP tunnel token path.
// Chunked String.fromCharCode loops avoid call-stack limits on large
// payloads (REST bodies can exceed the argument limit).

const te = new TextEncoder()

export async function sha256Hex(data: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', te.encode(data))
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function chunkedB64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return btoa(s)
}

export function b64encode(buf: ArrayBuffer): string {
  return chunkedB64(new Uint8Array(buf))
}

export function b64decode(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return chunkedB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return b64decode(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
}
