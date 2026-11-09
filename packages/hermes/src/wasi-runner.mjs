// wasi-runner.mjs — WASIX userspace runner for the `wasi` terminal backend
// and the browser-backed native modules (subprocess/socket-adjacent exec,
// ptyprocess PTYs).
// Served verbatim at dist/wasi/wasi-runner.js; lazy-imported by bootstrap.js.
//
// The Wasmer SDK (dist/wasi/wasmer/) runs WASIX guests in web workers with
// real subprocess/pipe support — including `spawn()` with piped
// stdin/stdout/stderr and an optional process-tree terminal (real PTY:
// line discipline + resize). Vendored .webc packages (dist/wasi/webc/)
// provide bash + coreutils + grep/sed/findutils/tar; the sandbox filesystem
// persists across execs for the life of the page. Network is disabled.
//
// Ops:
//   status            — sandbox availability probe
//   exec              — one-shot shell command (queued; terminal tool path)
//   which             — `command -v` resolution inside the sandbox (ENOENT data)
//   spawn             — persistent process, piped or terminal-attached
//   procWrite         — bytes -> guest stdin
//   procStdinClose    — EOF on guest stdin
//   procRead          — destructive read of a stream ('stdout'|'stderr'|'pty')
//   procPoll          — {running, exitCode?}
//   procWait          — long-poll until exit or timeoutMs
//   procTerminate     — graceful terminate (SIGTERM-ish, escalates)
//   procKill          — immediate kill
//   procResize        — TIOCSWINSZ equivalent for terminal procs
//   reset             — drop the sandbox (kills in-flight execs)
const SDK_URL = new URL('./wasmer/index.js', import.meta.url).href
const webcUrl = (name) => new URL(`./webc/${name}.webc`, import.meta.url).href

const PACKAGES = ['bash', 'coreutils', 'grep', 'sed', 'findutils', 'tar']
const ENV = {
  TERM: 'xterm-256color',
  HOME: '/root',
  PATH: '/usr/bin:/bin',
}

// Per-stream buffer cap: a runaway guest can't grow page memory without
// bound. Chunks past the cap are dropped and the stream reports truncated.
const STREAM_CAP = 64 * 1024 * 1024
// procRead wait granularity — small enough for interactive PTY latency,
// large enough that a waiter isn't a busy spin against the coincident call.
const READ_POLL_MS = 25

let sandboxPromise = null
let queue = Promise.resolve()

async function getSandbox() {
  if (!sandboxPromise) {
    sandboxPromise = (async () => {
      const { Wasmer } = await import(SDK_URL)
      const wasmer = await new Wasmer({ cache: 'memory', parallelism: 2 }).ready()
      const sources = await Promise.all(PACKAGES.map(async (n) => {
        const res = await fetch(webcUrl(n))
        if (!res.ok) throw new Error(`webc ${n}: HTTP ${res.status}`)
        return new Uint8Array(await res.arrayBuffer())
      }))
      const pkgs = await wasmer.packages.loadMany(sources)
      const bash = pkgs.find((p) => p.commands.includes('bash')) || pkgs[0]
      return wasmer.sandboxes.create({
        packages: pkgs,
        shell: bash,
        env: ENV,
        network: { mode: 'disabled' },
      })
    })()
    sandboxPromise.catch(() => { sandboxPromise = null })
  }
  return sandboxPromise
}

function resetSandbox() {
  sandboxPromise = null
  for (const p of procs.values()) {
    try { p.waiters.splice(0).forEach((w) => w.resolve({ running: false, killed: true })) } catch {}
    p.streams.pty.eof = true
    p.streams.stdout.eof = true
    p.streams.stderr.eof = true
  }
  procs.clear()
}

// Serialize one-shot execs — keeps stdout/stderr and the shared sandbox
// filesystem ordering predictable for the agent. spawn/proc ops are NOT
// queued: background processes must run concurrently with execs.
function enqueue(fn) {
  const next = queue.then(fn, fn)
  queue = next.then(() => undefined, () => undefined)
  return next
}

async function exec(args) {
  const sandbox = await getSandbox()
  const timeoutMs = Math.min(Math.max(Number(args.timeout_s || 120) * 1000, 1000), 600000)
  const cwd = args.cwd || '/'
  const runCmd = (dir) => sandbox.shell(String(args.command || ''), {
    cwd: dir,
  }).run({
    stdin: args.stdin ? String(args.stdin) : undefined,
    timeoutMs,
    check: false,
  })
  let out
  try {
    out = await runCmd(cwd)
  } catch (e) {
    if (cwd === '/') throw e
    out = await runCmd('/')  // host cwd may not exist in the guest fs
  }
  const result = {
    stdout: out.stdout.text(),
    stderr: out.stderr.text(),
    exit_code: out.exitCode | 0,
  }
  if (out.reason === 'timeout') result.error = 'exec_timeout'
  return result
}

// Minimal shlex.quote for `which` probes — single-quote anything unsafe.
function shq(s) {
  const v = String(s)
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(v)) return v
  return "'" + v.replace(/'/g, "'\\''") + "'"
}

// `command -v` inside the sandbox resolves builtins, functions and PATH
// entries exactly like the guest shell will — the data subprocess needs to
// raise a real FileNotFoundError before spawn.
async function which(args) {
  const sandbox = await getSandbox()
  const name = String(args.name || '')
  if (!name) return { path: null }
  const cwd = args.cwd || '/'
  const runProbe = (dir) => sandbox.shell(`command -v -- ${shq(name)}`, {
    cwd: dir,
  }).run({ timeoutMs: 10000, check: false })
  let out
  try {
    out = await runProbe(cwd)
  } catch (e) {
    if (cwd === '/') throw e
    out = await runProbe('/')  // host cwd may not exist in the guest fs
  }
  const path = out.stdout.text().trim().split('\n').pop() || ''
  return { path: out.exitCode === 0 && path ? path : null }
}

// ------------------------------------------------------------- spawn procs
//
// Each spawned WASIX process gets three byte buffers ('stdout', 'stderr',
// 'pty'). Terminal-attached processes additionally merge both streams into
// 'pty' — a real PTY has no separate stderr. procRead is destructive
// (pipe semantics): bytes leave the buffer once read, so Python-side
// consumers can stream incrementally without losing data.

const procs = new Map()
let nextProcId = 1

function newStream() {
  return { chunks: [], size: 0, eof: false }
}

function pushBytes(stream, chunk) {
  if (!chunk || !chunk.length) return
  if (stream.size >= STREAM_CAP) { stream.truncated = true; return }
  stream.chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk))
  stream.size += chunk.length || chunk.byteLength || 0
}

function bytesAvailable(stream) {
  // Total un-consumed bytes: chunks[0] may be partially consumed.
  let n = 0
  for (const c of stream.chunks) n += c.length
  return n
}

// Read up to maxBytes from a stream, advancing a per-stream read cursor.
// Returns {data: Uint8Array, eof: bool, truncated: bool}.
function drain(stream, maxBytes) {
  const avail = bytesAvailable(stream)
  if (avail === 0) {
    return { data: new Uint8Array(0), eof: !!stream.eof, truncated: !!stream.truncated }
  }
  const want = Math.min(maxBytes > 0 ? maxBytes : avail, avail)
  const out = new Uint8Array(want)
  let off = 0
  while (off < want && stream.chunks.length) {
    const head = stream.chunks[0]
    const take = Math.min(head.length, want - off)
    out.set(head.subarray(0, take), off)
    off += take
    if (take === head.length) stream.chunks.shift()
    else stream.chunks[0] = head.subarray(take)
  }
  stream.size -= off
  return { data: out, eof: false, truncated: !!stream.truncated }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function pumpReadable(readable, stream, extra) {
  try {
    for await (const chunk of readable) {
      pushBytes(stream, chunk)
      if (extra) pushBytes(extra, chunk)
    }
  } catch { /* stream closed with the process */ }
  stream.eof = true
  if (extra) extra.eof = true
}

async function spawnProc(args) {
  const sandbox = await getSandbox()
  const a = args || {}
  const cwd = a.cwd || '/'
  const env = (a.env && typeof a.env === 'object') ? a.env : undefined
  const terminal = a.terminal && typeof a.terminal === 'object'
    ? {
        columns: Math.min(Math.max(Number(a.terminal.columns) || 80, 1), 0xffff),
        rows: Math.min(Math.max(Number(a.terminal.rows) || 24, 1), 0xffff),
      }
    : undefined
  const timeoutMs = a.timeout_ms
    ? Math.min(Math.max(Number(a.timeout_ms) * 1000, 1000), 3600000)
    : undefined

  let command
  const cmdOpts = { cwd, env }
  if (a.argv && Array.isArray(a.argv) && a.argv.length) {
    const [head, ...rest] = a.argv.map(String)
    command = sandbox.command(head, rest, cmdOpts)
  } else {
    command = sandbox.shell(String(a.command || ''), cmdOpts)
  }

  let proc
  try {
    proc = await command.spawn({
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      terminal,
      timeoutMs,
    })
  } catch (e) {
    // The guest fs is a fresh WASIX image: a host cwd like /home/pyodide
    // doesn't exist there and the SDK fails "could not create directory".
    // Fall back to '/' — the command still runs in the real userspace.
    if (cwd && cwd !== '/') {
      const fallback = a.argv && Array.isArray(a.argv) && a.argv.length
        ? sandbox.command(String(a.argv[0]), a.argv.slice(1).map(String), { cwd: '/', env })
        : sandbox.shell(String(a.command || ''), { cwd: '/', env })
      proc = await fallback.spawn({
        stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', terminal, timeoutMs,
      })
    } else {
      throw e
    }
  }

  const id = nextProcId++
  const entry = {
    proc,
    id,
    terminal: !!terminal,
    streams: { stdout: newStream(), stderr: newStream(), pty: newStream() },
    stdinClosed: false,
    done: false,
    exitCode: null,
    reason: null,
    waiters: [],
  }
  procs.set(id, entry)

  // Pump guest streams into the buffers. For terminal procs the 'pty'
  // stream gets BOTH stdout and stderr chunks — line discipline already
  // merged them guest-side; this mirrors a real terminal's single stream.
  const ptySink = terminal ? entry.streams.pty : null
  const pumps = []
  if (proc.stdout) pumps.push(pumpReadable(proc.stdout, entry.streams.stdout, ptySink))
  if (proc.stderr) pumps.push(pumpReadable(proc.stderr, entry.streams.stderr, ptySink))
  // Wait completion in the background so procWait/procPoll share one result.
  pumps.push((async () => {
    try {
      const out = await proc.wait({ check: false })
      entry.exitCode = out.exitCode | 0
      entry.reason = out.reason
    } catch (e) {
      entry.exitCode = -1
      entry.reason = 'error'
      entry.error = String(e && e.message || e)
    }
    entry.done = true
    // Do NOT mark streams eof here: pumpReadable owns that flag and sets it
    // only after the guest stream is fully drained — marking early would
    // let procRead report eof while bytes are still in flight.
    const ws = entry.waiters.splice(0)
    for (const w of ws) w.resolve({ running: false, exit_code: entry.exitCode, reason: entry.reason })
  })())
  entry.pumps = pumps
  return { pid: id }
}

function procEntry(args) {
  const id = Number(args && args.pid)
  const entry = procs.get(id)
  return entry || null
}

async function procWrite(args) {
  const entry = procEntry(args)
  if (!entry) return { error: 'no_such_process' }
  if (entry.stdinClosed || !entry.proc.stdin) return { error: 'stdin_closed' }
  const b64 = String(args.data_b64 || '')
  if (!b64) return { ok: true }
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  try {
    await entry.proc.stdin.write(bytes)
    return { ok: true }
  } catch (e) {
    return { error: String(e && e.message || e) }
  }
}

async function procStdinClose(args) {
  const entry = procEntry(args)
  if (!entry) return { error: 'no_such_process' }
  entry.stdinClosed = true
  try {
    if (entry.proc.stdin) await entry.proc.stdin.close()
  } catch { /* already closed */ }
  return { ok: true }
}

async function procRead(args) {
  const entry = procEntry(args)
  if (!entry) return { error: 'no_such_process' }
  const streamName = ['stdout', 'stderr', 'pty'].includes(args.stream) ? args.stream : 'stdout'
  const stream = entry.streams[streamName]
  const maxBytes = Math.min(Math.max(Number(args.max_bytes) || 65536, 1), 4 * 1024 * 1024)
  const waitMs = Math.min(Math.max(Number(args.wait_ms) || 0, 0), 30000)

  const deadline = Date.now() + waitMs
  for (;;) {
    const res = drain(stream, maxBytes)
    // Report eof only once the buffer is fully drained — pending bytes
    // after process exit must still be delivered first. entry.done alone
    // is NOT a stop condition: the stdout/stderr pumps can still be
    // draining guest bytes into the buffers.
    const eof = res.eof && bytesAvailable(stream) === 0
    if (res.data.length || eof) {
      let b64 = ''
      if (res.data.length) {
        let bin = ''
        const CH = 0x8000
        for (let i = 0; i < res.data.length; i += CH)
          bin += String.fromCharCode.apply(null, res.data.subarray(i, i + CH))
        b64 = btoa(bin)
      }
      return { data: b64, eof, truncated: !!stream.truncated }
    }
    if (Date.now() >= deadline) {
      return { data: '', eof: false, truncated: !!stream.truncated }
    }
    await sleep(READ_POLL_MS)
  }
}

function procPoll(args) {
  const entry = procEntry(args)
  if (!entry) return { error: 'no_such_process' }
  if (entry.done) return { running: false, exit_code: entry.exitCode, reason: entry.reason }
  return { running: true }
}

function procWait(args) {
  const entry = procEntry(args)
  if (!entry) return Promise.resolve({ error: 'no_such_process' })
  const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 0, 0), 3600000)
  if (entry.done) return Promise.resolve({ running: false, exit_code: entry.exitCode, reason: entry.reason })
  return new Promise((resolve) => {
    const waiter = { resolve }
    entry.waiters.push(waiter)
    if (timeoutMs > 0) {
      setTimeout(() => {
        const i = entry.waiters.indexOf(waiter)
        if (i >= 0) {
          entry.waiters.splice(i, 1)
          resolve({ running: true })
        }
      }, timeoutMs)
    }
  })
}

async function procTerminate(args) {
  const entry = procEntry(args)
  if (!entry) return { error: 'no_such_process' }
  if (entry.done) return { running: false, exit_code: entry.exitCode, reason: entry.reason }
  try {
    await entry.proc.terminate({ gracePeriodMs: Number(args.grace_ms) || 500 })
  } catch (e) {
    return { error: String(e && e.message || e) }
  }
  return { ok: true }
}

async function procKill(args) {
  const entry = procEntry(args)
  if (!entry) return { error: 'no_such_process' }
  if (!entry.done) {
    try { await entry.proc.kill() } catch { /* already gone */ }
  }
  return { ok: true }
}

function procResize(args) {
  const entry = procEntry(args)
  if (!entry) return { error: 'no_such_process' }
  if (!entry.terminal) return { error: 'not_a_terminal' }
  try {
    entry.proc.resizeTerminal(
      Math.min(Math.max(Number(args.columns) || 80, 1), 0xffff),
      Math.min(Math.max(Number(args.rows) || 24, 1), 0xffff))
    return { ok: true }
  } catch (e) {
    return { error: String(e && e.message || e) }
  }
}

async function status() {
  try {
    await getSandbox()
    return { available: true, detail: 'WASIX userspace (bash + coreutils via @wasmer/sdk)' }
  } catch (e) {
    return { available: false, reason: String(e && e.message || e) }
  }
}

const DIRECT_OPS = {
  spawn: spawnProc,
  procWrite,
  procStdinClose,
  procRead,
  procPoll,
  procWait,
  procTerminate,
  procKill,
  procResize,
}

export function call(op, args) {
  // spawn/proc ops run outside the exec queue: they are long-lived and must
  // interleave with one-shot execs. Errors still reset a dead sandbox.
  if (DIRECT_OPS[op]) {
    return Promise.resolve()
      .then(() => DIRECT_OPS[op](args || {}))
      .catch((e) => {
        resetSandbox()
        return { error: String(e && e.message || e) }
      })
  }
  return enqueue(async () => {
    try {
      if (op === 'status') return await status()
      if (op === 'exec') return await exec(args || {})
      if (op === 'which') return await which(args || {})
      if (op === 'reset') { resetSandbox(); return { ok: true } }
      return { error: 'unknown_op' }
    } catch (e) {
      if (e && (e.code === 'PROCESS_EXITED' || e.output)) {
        const o = e.output
        return {
          stdout: o.stdout.text(), stderr: o.stderr.text(),
          exit_code: o.exitCode | 0,
        }
      }
      // A dead sandbox (terminated kernel) shouldn't poison later execs.
      resetSandbox()
      return { error: String(e && e.message || e) }
    }
  })
}

// Bootstrap probes window.__HERMES_WASI__ for runner presence.
if (typeof window !== 'undefined') {
  window.__HERMES_WASI__ = { call }
}
