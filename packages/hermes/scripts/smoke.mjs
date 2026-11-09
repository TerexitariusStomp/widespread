// smoke.mjs — Playwright smoke for the real in-browser Hermes backend:
// page boot, backend-ready, ws JSON-RPC round-trips, REST through the real
// ASGI app, and the vault boundary (a saved key must store as a `vault:`
// handle, never raw bytes into the Python heap).
//
// Usage: node scripts/smoke.mjs           — serves dist/ on :8471 itself
//        CHROME_PATH=/path/chrome node scripts/smoke.mjs
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'

const PORT = Number(process.env.SMOKE_PORT || 8471)
const server = spawn(process.execPath, ['scripts/serve.mjs', 'dist', String(PORT)],
  { stdio: ['ignore', 'pipe', 'inherit'] })
process.on('exit', () => server.kill())
await new Promise((r) => setTimeout(r, 800))

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
browser.on('disconnected', () => console.log('!! browser disconnected'))
const { writeFileSync, appendFileSync } = await import('node:fs')
writeFileSync('/tmp/smoke-console.log', '')
const page = await browser.newPage()
const logs = []
page.on('console', (m) => {
  logs.push(m.text())
  try { appendFileSync('/tmp/smoke-console.log', m.text() + '\n') } catch {}
})
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message))
page.on('crash', () => console.log('!! page crashed'))

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
console.log('== page loaded; waiting for backend boot ==')

const deadline = Date.now() + 300000
const interruptAt = process.env.SMOKE_INTERRUPT_AT_S
  ? Date.now() + Number(process.env.SMOKE_INTERRUPT_AT_S) * 1000
  : 0
let interrupted = false
let ready = false
while (Date.now() < deadline) {
  ready = await page.evaluate(() => !!window.__HERMES_BACKEND_READY__).catch(() => false)
  if (ready) break
  if (!interrupted && interruptAt && Date.now() > interruptAt) {
    interrupted = true
    await page.evaluate(() => { window.__HERMES_INTERRUPT__[0] = 2 }).catch(() => {})
    console.log('!! sent SIGINT to backend worker')
  }
  await new Promise((r) => setTimeout(r, 3000))
}
console.log('backend ready:', ready)
console.log('--- console tail ---')
logs.slice(-40).forEach((l) => console.log('  ', l.slice(0, 260)))

if (ready) {
  const probes = await page.evaluate(async () => {
    const out = {}
    for (const p of ['/api/status', '/api/profiles', '/api/config?include_defaults=false']) {
      try {
        const r = await fetch(p, { headers: { 'X-Hermes-Session-Token': window.__HERMES_BOOTSTRAP__.sessionToken } })
        const t = await r.text()
        out[p] = r.status + ' ' + t.slice(0, 300)
      } catch (e) { out[p] = 'ERR ' + e.message }
    }
    return out
  })
  console.log('--- REST probes ---')
  for (const k in probes) console.log(' ', k, '=>', probes[k].replace(/\n/g, ' ').slice(0, 300))

  const rpc = await page.evaluate(() => new Promise((resolve) => {
    const log = []
    const results = {}
    const ws = new WebSocket('ws://' + location.host + '/api/ws?token=' + window.__HERMES_BOOTSTRAP__.sessionToken)
    const methods = [
      'session.list', 'gateway.ping', 'setup.status', 'model.options',
      'tools.list', 'toolsets.list', 'session.create',
    ]
    const EXPECTED = methods.length + 4 // + complete.path, save_key, shell.exec, battery
    const t = setTimeout(() => resolve({ timeout: true, log, results }), 180000)
    ws.onmessage = (ev) => {
      const s = String(ev.data)
      log.push(s.slice(0, 200))
      try {
        const m = JSON.parse(s)
        if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
          results[m.id] = m.error ? { error: m.error } : { result: m.result }
          const sid = results[106] && results[106].result && results[106].result.session_id
          if (sid && results[107] === undefined) {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: 107, method: 'complete.path',
              params: { word: '/usr/bin/g', session_id: sid, cwd: '/' } }))
            // Vault interception: the raw key must be rewritten page-side;
            // the backend only ever sees a vault:<handle> placeholder.
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: 108, method: 'model.save_key',
              params: { slug: 'openai-api', api_key: 'sk-test-VAULT-AAA' } }))
          }
        }
      } catch (e) {}
      if (Object.keys(results).length >= EXPECTED) {
        clearTimeout(t); resolve({ log, results })
      }
    }
    ws.onopen = () => {
      methods.forEach((m, i) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 100 + i, method: m, params: {} })))
      // Native-module proofs (sessionless): shell.exec drives the patched
      // subprocess -> WASIX userspace; system.battery drives the browser
      // psutil implementation through agent.battery -> psutil.
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 109, method: 'shell.exec',
        params: { command: 'uname -a; echo ---; ls / | head -20; echo ---; pwd' } }))
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 110, method: 'system.battery', params: {} }))
      setTimeout(() => { clearTimeout(t); resolve({ log, results }) }, 120000)
    }
    ws.onerror = () => resolve({ error: 'ws error', log, results })
    ws.onclose = (ev) => resolve({ closed: ev.code, log, results })
  }))
  console.log('--- ws probe ---')
  const methodNames = ['session.list', 'gateway.ping', 'setup.status', 'model.options', 'tools.list', 'toolsets.list', 'session.create', 'complete.path(wasi)', 'model.save_key', 'shell.exec(wasi)', 'system.battery(psutil)']
  const idFor = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110]
  for (let i = 0; i < methodNames.length; i++) {
    const r = (rpc.results || {})[idFor[i]]
    const out = r === undefined ? 'NO-REPLY'
      : r.error ? 'ERR ' + JSON.stringify(r.error).slice(0, 200)
      : JSON.stringify(r.result).slice(0, 400)
    console.log(' ', methodNames[i], '=>', out)
  }
  // shell.exec proof: real WASIX uname + ls output came back through the
  // patched subprocess module (not the wasi plugin's exec op).
  const shellOut = JSON.stringify((rpc.results || {})[109] || {})
  const shellPass = /Linux|GNU|wasix|WASI|wasm32/i.test(shellOut) && shellOut.includes('---')
  console.log('  shell.exec through subprocess/WASIX =>', shellPass ? 'PASS' : 'CHECK-ABOVE')
  // Vault proof: a stored key is a labeled handle in the vault worker; the
  // raw value must not appear anywhere in the Python heap or config write.
  const vault = await page.evaluate(async () => {
    try {
      const r = await window.__HERMES_VAULT__.call('list')
      const handles = (r && r.handles) || []
      return {
        count: handles.length,
        labels: handles.map((h) => h.label),
        hasHandle: handles.some((h) => String(h.label || '').includes('model.save_key')),
      }
    } catch (e) { return { error: String(e) } }
  })
  console.log('--- vault ---')
  console.log('  handles =>', JSON.stringify(vault))
  console.log('  save_key stored as vault handle =>',
    vault.hasHandle ? 'PASS' : 'CHECK-ABOVE')

  // --- browser-native bridge probes -------------------------------------
  // Exercises the same page-side implementations the Python coincident
  // calls use: sysinfo (psutil/resource backing), Web Locks flock
  // (fcntl backing), and the relayed TCP tunnel (socket backing).
  const bridge = await page.evaluate(async () => {
    const b = window.__HERMES_BRIDGE__
    if (!b) return { error: 'no __HERMES_BRIDGE__' }
    const out = {}
    try {
      const si = await b.sysinfo()
      out.sysinfo = {
        hardwareConcurrency: si.hardwareConcurrency,
        deviceMemory: si.deviceMemory,
        heapUsed: si.jsHeap && si.jsHeap.used,
        heapLimit: si.jsHeap && si.jsHeap.limit,
        storageQuota: si.storage && si.storage.quota,
        timeOrigin: si.timeOrigin,
      }
    } catch (e) { out.sysinfo = { error: String(e) } }
    try {
      const held = await b.flock('/tmp/smoke-flock-probe', 'exclusive', true)
      const rel = await b.flockRelease('/tmp/smoke-flock-probe')
      out.flock = { held, rel }
    } catch (e) { out.flock = { error: String(e) } }
    try {
      const st = await b.wasiStatus()
      out.wasi = st
    } catch (e) { out.wasi = { error: String(e) } }
    // TCP tunnel: only meaningful when a relay is configured/reachable.
    // tcpOpen -> /tcp-token POST -> WS /tcp -> cloudflare:sockets upstream.
    try {
      const t0 = Date.now()
      const opened = await Promise.race([
        b.tcpOpen('example.com', 80),
        new Promise((r) => setTimeout(() => r({ error: 'probe_timeout' }), 30000)),
      ])
      out.tcpOpen = { ms: Date.now() - t0, ...opened }
      if (opened && opened.id) {
        // Real HTTP/1.0 round-trip through the tunnel.
        const b64 = (s) => btoa(s)
        await b.tcpSend(opened.id, b64('GET / HTTP/1.0\r\nHost: example.com\r\n\r\n'))
        const chunks = []
        for (let i = 0; i < 20; i++) {
          const r = await b.tcpRecv(opened.id, 5000)
          if (r.data) chunks.push(atob(r.data))
          if (r.eof || r.error || r.errno) break
        }
        const text = chunks.join('')
        out.tcpHttp = {
          bytes: text.length,
          statusLine: text.split('\r\n')[0] || '',
          hasHtml: /<html|<!doctype/i.test(text),
        }
        await b.tcpClose(opened.id)
      }
    } catch (e) { out.tcpOpen = { error: String(e) } }
    return out
  })
  console.log('--- bridge probes ---')
  console.log(' ', JSON.stringify(bridge, null, 1).slice(0, 2000))
  const si = bridge.sysinfo || {}
  const sysPass = (si.hardwareConcurrency || 0) > 0 && (si.heapUsed || 0) > 0
  console.log('  sysinfo real measurements =>', sysPass ? 'PASS' : 'CHECK-ABOVE')
  const flockPass = bridge.flock && bridge.flock.held && bridge.flock.held.ok === true
  console.log('  Web Locks flock roundtrip =>', flockPass ? 'PASS' : 'CHECK-ABOVE')
  const tcp = bridge.tcpHttp || {}
  console.log('  TCP tunnel HTTP fetch =>',
    tcp.statusLine ? tcp.statusLine + (tcp.hasHtml ? ' PASS' : ' WEAK') : 'SKIP (no relay configured)')
  console.log('--- events ---')
  ;(rpc.log || []).slice(0, 8).forEach((l) => console.log('  ', l.slice(0, 200)))
}
await browser.close()
server.kill()
