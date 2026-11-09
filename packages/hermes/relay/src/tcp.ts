import { b64urlDecode, b64urlEncode } from './encoding'
/**
 * tcp.ts — relayed TCP egress for the in-browser Hermes runtime.
 *
 * Browsers cannot open raw TCP sockets, so Python's `socket` module (running
 * under Pyodide in the page's backend worker) tunnels through this Worker:
 *
 *   POST /tcp-token                -> {token, base, expiresAt}   (origin-gated)
 *   GET  /tcp?token&host&port      -> JSON validation, or a WebSocket that
 *                                     pipes bytes to a cloudflare:sockets
 *                                     connect() upstream.
 *
 * Security model:
 * - Tokens are HMAC-signed (env TCP_TUNNEL_SECRET), short-lived (10 min),
 *   and minted only for SHARE_ORIGINS — same gate as session minting.
 * - The Worker resolves the target itself (DNS-over-HTTPS) and refuses
 *   private/loopback/link-local/reserved addresses and port 25 BEFORE
 *   dialing, so a token can't be turned into an SSRF primitive against
 *   the relay's own network or RFC1918 space.
 * - Payload bytes transit this isolate's memory only — never logged,
 *   never persisted (same privacy posture as the session DO).
 */
import { connect } from 'cloudflare:sockets'

export interface TcpEnv {
  TCP_TUNNEL_SECRET?: string
}

const te = new TextEncoder()
const TOKEN_TTL_MS = 10 * 60 * 1000

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, te.encode(data))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}


export async function mintTcpToken(env: TcpEnv): Promise<{ token: string; expiresAt: number } | null> {
  const secret = env.TCP_TUNNEL_SECRET
  if (!secret) return null
  const exp = Date.now() + TOKEN_TTL_MS
  const nonceBytes = new Uint8Array(16)
  crypto.getRandomValues(nonceBytes)
  const nonce = b64urlEncode(nonceBytes)
  const sig = await hmacHex(secret, `v1.${exp}.${nonce}`)
  return { token: `v1.${exp}.${nonce}.${sig}`, expiresAt: exp }
}

async function verifyTcpToken(env: TcpEnv, token: string): Promise<boolean> {
  const secret = env.TCP_TUNNEL_SECRET
  if (!secret || !token) return false
  const parts = token.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') return false
  const exp = Number(parts[1])
  const nonce = parts[2]!
  const sig = parts[3]!
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  const expect = await hmacHex(secret, `v1.${exp}.${nonce}`)
  // Constant-time-ish compare on equal-length hex strings.
  if (expect.length !== sig.length) return false
  let diff = 0
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i)
  return diff === 0
}

// ---------------------------------------------------------------- SSRF guard

function ipv4Parts(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  if (parts.some((p) => p! > 255)) return null
  return parts as number[]
}

/** True when the IPv4/IPv6 literal must never be dialed from the relay. */
function isBlockedAddress(ip: string): boolean {
  const v4 = ipv4Parts(ip)
  if (v4) {
    const [a, b] = v4 as [number, number, number, number]
    if (a === 0) return true                        // "this" network
    if (a === 10) return true                       // RFC1918
    if (a === 127) return true                      // loopback
    if (a === 169 && b === 254) return true         // link-local
    if (a === 172 && b! >= 16 && b! <= 31) return true // RFC1918
    if (a === 192 && b === 168) return true         // RFC1918
    if (a === 100 && b! >= 64 && b! <= 127) return true // CGNAT
    if (a === 192 && b === 0) return true           // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
    if (a === 224 || a! >= 240) return true         // multicast / reserved
    return false
  }
  const lower = ip.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  if (lower.startsWith('fe80:') || lower.startsWith('fe90:') ||
      lower.startsWith('fea0:') || lower.startsWith('feb0:')) return true // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true       // ULA fc00::/7
  // IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:hex) — check the v4 tail.
  const mapped = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip) ||
    /::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip)
  if (mapped) {
    if (mapped.length === 2) return isBlockedAddress(mapped[1]!)
    const hi = parseInt(mapped[1]!, 16)
    const lo = parseInt(mapped[2]!, 16)
    const v4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`
    return isBlockedAddress(v4)
  }
  return false
}

function isIpLiteral(host: string): boolean {
  return ipv4Parts(host) !== null || /^[0-9a-fA-F:]+$/.test(host) && host.includes(':')
}

interface DohAnswer { name: string; type: number; data: string }

async function dohResolve(host: string): Promise<string[]> {
  const out: string[] = []
  for (const type of ['A', 'AAAA']) {
    try {
      const res = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
        { headers: { accept: 'application/dns-json' } })
      if (!res.ok) continue
      const j = (await res.json()) as { Answer?: DohAnswer[] }
      for (const a of j.Answer || []) {
        if ((type === 'A' && a.type === 1) || (type === 'AAAA' && a.type === 28)) {
          out.push(a.data)
        }
      }
    } catch { /* try the other family */ }
  }
  return out
}

/** Resolve + filter to public addresses. Returns [] when nothing dialable. */
async function resolvePublic(host: string): Promise<string[]> {
  const literal = host.trim()
  if (isIpLiteral(literal)) {
    return isBlockedAddress(literal) ? [] : [literal]
  }
  const addrs = await dohResolve(literal)
  return addrs.filter((a) => !isBlockedAddress(a))
}

// ------------------------------------------------------------- WS <-> TCP

const BLOCKED_PORTS = new Set([25])

// errno numbers for the 4000+errno close-code channel back to the page.
const ERRNO = {
  ECONNREFUSED: 111, ETIMEDOUT: 110, EHOSTUNREACH: 113,
  ENETUNREACH: 101, ECONNRESET: 104, ECONNABORTED: 103,
  EACCES: 13, ENETDOWN: 100, EHOSTDOWN: 112,
}

function errnoOf(e: unknown): number {
  const msg = String((e as Error)?.message || e)
  for (const [name, num] of Object.entries(ERRNO)) {
    if (msg.toUpperCase().includes(name)) return num
  }
  if (/timed?\s*out/i.test(msg)) return ERRNO.ETIMEDOUT
  return 113 // EHOSTUNREACH — honest "couldn't reach" default
}

export interface TcpDialResult {
  ok: boolean
  addrs?: string[]
  error?: string
  errno?: number
}

/** Validate token/host/port and resolve public addresses (no dial). */
export async function validateTcpRequest(
  env: TcpEnv, url: URL): Promise<TcpDialResult> {
  const token = url.searchParams.get('token') || ''
  if (!(await verifyTcpToken(env, token))) return { ok: false, error: 'bad_token', errno: ERRNO.EACCES }
  const host = (url.searchParams.get('host') || '').trim()
  const port = Number(url.searchParams.get('port'))
  if (!host || host.length > 253 || !(port > 0 && port < 65536)) {
    return { ok: false, error: 'bad_address', errno: ERRNO.EACCES }
  }
  if (BLOCKED_PORTS.has(port)) {
    return { ok: false, error: 'port_blocked', errno: ERRNO.EACCES }
  }
  const addrs = await resolvePublic(host)
  if (!addrs.length) {
    return { ok: false, error: 'blocked_or_nxdomain', errno: ERRNO.EHOSTUNREACH }
  }
  return { ok: true, addrs }
}

/**
 * Handle a /tcp upgrade: validate, connect upstream, pipe WebSocket <->
 * socket. On connect failure the accepted socket is closed with
 * 4000+errno so the page learns the real errno.
 */
export async function handleTcpUpgrade(env: TcpEnv, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const check = await validateTcpRequest(env, url)
  if (!check.ok) {
    return new Response(JSON.stringify({ error: check.error }), {
      status: check.error === 'bad_token' ? 401 : 403,
      headers: { 'content-type': 'application/json' },
    })
  }

  const port = Number(url.searchParams.get('port'))
  let sock: Socket | null = null
  let lastErr: unknown = null
  for (const addr of check.addrs || []) {
    try {
      sock = connect({ hostname: addr, port })
      break
    } catch (e) {
      lastErr = e
    }
  }

  const pair = new WebSocketPair()
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
  server.accept()

  if (!sock) {
    server.close(4000 + errnoOf(lastErr), 'connect failed')
    return new Response(null, { status: 101, webSocket: client })
  }

  const socket = sock
  const writer = socket.writable.getWriter()

  // connect() returns before the handshake completes; a refused/unreachable
  // upstream surfaces as a `closed` rejection — translate it into the
  // 4000+errno close code the page maps back to a real OSError.
  socket.closed.catch((e) => {
    try { server.close(4000 + errnoOf(e), 'connect failed') } catch { /* gone */ }
  })

  // Upstream -> client.
  socket.readable
    .pipeTo(new WritableStream<Uint8Array>({
      write(chunk) {
        try { server.send(chunk) } catch { /* client gone */ }
      },
    }))
    .catch(() => { /* upstream closed */ })
    .finally(() => {
      try { server.close(1000, 'upstream closed') } catch { /* gone */ }
    })
  socket.closed
    .then(() => { try { server.close(1000, 'upstream closed') } catch { /* gone */ } })
    .catch(() => {})

  // Client -> upstream. Binary frames arrive as ArrayBuffer.
  server.addEventListener('message', (ev) => {
    const d = ev.data
    let bytes: Uint8Array
    if (typeof d === 'string') bytes = te.encode(d)
    else if (d instanceof ArrayBuffer) bytes = new Uint8Array(d)
    else bytes = new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
    writer.write(bytes).catch(() => { /* upstream gone */ })
  })
  server.addEventListener('close', () => {
    try { writer.close() } catch { /* gone */ }
    try { socket.close() } catch { /* gone */ }
  })
  server.addEventListener('error', () => {
    try { socket.close() } catch { /* gone */ }
  })

  return new Response(null, { status: 101, webSocket: client })
}
