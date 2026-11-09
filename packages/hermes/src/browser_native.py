"""browser_native.py — real browser-backed implementations of native modules.

Installed by browser_bootstrap BEFORE upstream imports, into sys.modules, so
``import psutil`` / ``import fcntl`` / ``import subprocess`` etc. resolve to
working implementations instead of stubs:

- subprocess — real processes in the in-page WASIX userspace (Wasmer SDK),
  reached through py_gateway.wasi_call -> the page's wasi-runner. Real exit
  codes, streamed stdout/stderr, real FileNotFoundError(ENOENT) for commands
  absent from the WASIX image.
- socket — getaddrinfo via DNS-over-HTTPS; connect() tunnels TCP over a
  WebSocket to the hermes relay Worker (cloudflare:sockets). bind/listen/
  accept raise EOPNOTSUPP — browsers cannot accept inbound connections.
- fcntl — flock/lockf via the Web Locks API (navigator.locks), real mutual
  exclusion across workers and tabs, keyed by the file's /proc/self/fd path.
- psutil — real values from navigator.hardwareConcurrency, deviceMemory,
  performance.memory, navigator.storage.estimate, performance.timeOrigin.
- resource — getrusage from performance.now()/performance.memory.
- pwd/grp — single session identity from the process environment.
- termios/tty — real terminal attribute semantics over a per-fd store; the
  ptyprocess PTY bridge gets working TIOCSWINSZ through fcntl.ioctl.
- ptyprocess — PtyProcess.spawn backed by a WASIX terminal-attached process
  (real PTY: line discipline + resize), bridged to a registered fd so
  upstream's select/os.read/os.write/fcntl.ioctl path works unchanged.

Everything here is pull-based: the runtime is cooperative (no preemptive
threads), so streaming readers drain on demand and blocking waits ride the
same coincident sync-proxy calls as fetch_blocking.
"""

from __future__ import annotations

import base64
import errno
import io
import json
import os
import shlex
import sys
import time
import types


# getaddrinfo errnos aren't in errno on every platform (Emscripten exposes
# them; Linux CPython does not) — resolve once with honest fallbacks.
_EAI_AGAIN = getattr(errno, "EAI_AGAIN", -3)
_EAI_NONAME = getattr(errno, "EAI_NONAME", -2)


def _gw():
    import py_gateway

    return py_gateway


def _wasi(op: str, args: dict | None = None, timeout_s: float = 60.0) -> dict:
    return _gw().wasi_call(op, args, timeout_s=timeout_s)


def _norm_result(resp) -> dict:
    """Runner/proxy results are dicts; normalize anything else to an error."""
    return resp if isinstance(resp, dict) else {"error": "bad_response"}


# =====================================================================
# subprocess — WASIX userspace processes
# =====================================================================

_EXE_CACHE: dict[tuple[str, str], str | None] = {}


def _which(name: str, cwd: str = "/", env: dict | None = None) -> str | None:
    """Resolve an executable inside the WASIX image via `command -v`.

    This is the data real FileNotFoundError(ENOENT) decisions need: a name
    absent from the sandbox image resolves to None exactly like a missing
    binary on a real host. Cached per (name, PATH) — resolution is stable
    for the sandbox's lifetime.
    """
    path_key = str((env or {}).get("PATH") or "/usr/bin:/bin")
    key = (name, path_key)
    if key in _EXE_CACHE:
        return _EXE_CACHE[key]
    resp = _norm_result(_wasi("which", {"name": name, "cwd": cwd}, timeout_s=15.0))
    found = resp.get("path") if resp.get("path") else None
    _EXE_CACHE[key] = found
    return found


class _StdinWriter:
    """Popen.stdin when stdin=PIPE — writes stream into the guest's stdin."""

    def __init__(self, pid: int):
        self._pid = pid
        self._closed = False

    def writable(self):
        return not self._closed

    def write(self, data):
        if self._closed:
            raise ValueError("write to closed stdin")
        if isinstance(data, str):
            data = data.encode()
        resp = _norm_result(_wasi(
            "procWrite", {"pid": self._pid, "data_b64": base64.b64encode(bytes(data)).decode()},
            timeout_s=30.0))
        if resp.get("error"):
            raise BrokenPipeError(resp["error"])
        return len(data)

    def flush(self):
        pass

    def close(self):
        if self._closed:
            return
        self._closed = True
        _wasi("procStdinClose", {"pid": self._pid}, timeout_s=15.0)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


class _StdoutReader:
    """Popen.stdout/stderr when PIPE — pull-based streaming reader.

    procRead is destructive on the runner side, so each read consumes guest
    output exactly once. read() blocks (via the coincident proxy wait) until
    data or EOF — real pipe semantics.
    """

    _STREAM = "stdout"

    def __init__(self, pid: int, stream: str, text_mode: bool, encoding: str, errors: str):
        self._pid = pid
        self._stream = stream
        self._buf = bytearray()
        self._eof = False
        self._closed = False
        self._text = text_mode
        self._encoding = encoding or "utf-8"
        self._errors = errors or "strict"

    # -- low-level -----------------------------------------------------
    def _fill(self, want: int = 65536, block: bool = True) -> None:
        """Pull guest bytes into _buf. block=True waits for data/eof."""
        if self._closed or self._eof:
            return
        wait_ms = 30000 if block else 0
        resp = _norm_result(_wasi("procRead", {
            "pid": self._pid, "stream": self._stream,
            "max_bytes": want, "wait_ms": wait_ms,
        }, timeout_s=45.0))
        if resp.get("error"):
            self._eof = True
            return
        data = resp.get("data") or ""
        if data:
            self._buf += base64.b64decode(data)
        if resp.get("eof"):
            self._eof = True

    def _read_bytes(self, n: int = -1) -> bytes:
        while not self._eof and (n < 0 or len(self._buf) < n):
            self._fill()
        if n is None or n < 0:
            out = bytes(self._buf)
            self._buf.clear()
        else:
            out = bytes(self._buf[:n])
            del self._buf[:n]
        return out

    # -- file-like surface ----------------------------------------------
    def readable(self):
        return True

    def read(self, size: int = -1):
        raw = self._read_bytes(size)
        if self._text:
            return raw.decode(self._encoding, self._errors)
        return raw

    def read1(self, size: int = -1):
        return self.read(size)

    def readline(self, size: int = -1):
        while True:
            idx = self._buf.find(b"\n")
            if idx >= 0 and (size is None or size < 0 or idx + 1 <= size):
                n = idx + 1 if size is None or size < 0 else min(idx + 1, size)
                raw = bytes(self._buf[:n])
                del self._buf[:n]
                return raw.decode(self._encoding, self._errors) if self._text else raw
            if self._eof:
                raw = bytes(self._buf)
                self._buf.clear()
                return raw.decode(self._encoding, self._errors) if self._text else raw
            if size is not None and size >= 0 and len(self._buf) >= size:
                raw = bytes(self._buf[:size])
                del self._buf[:size]
                return raw.decode(self._encoding, self._errors) if self._text else raw
            self._fill()

    def readlines(self, hint: int = -1):
        lines = []
        total = 0
        while True:
            line = self.readline()
            if not line:
                break
            lines.append(line)
            total += len(line)
            if hint is not None and hint > 0 and total >= hint:
                break
        return lines

    def __iter__(self):
        return self

    def __next__(self):
        line = self.readline()
        if line == "" or line == b"":
            raise StopIteration
        return line

    def close(self):
        self._closed = True

    @property
    def closed(self):
        return self._closed

    def flush(self):
        pass


class _FileTarget:
    """stdout/stderr redirected to a real file object or fd."""

    def __init__(self, target):
        self._file = target
        self._own = False

    def write(self, data: bytes):
        if hasattr(self._file, "write"):
            if isinstance(data, bytes):
                try:
                    self._file.write(data)
                except TypeError:
                    self._file.write(data.decode("utf-8", "replace"))
            else:
                self._file.write(data)
            if hasattr(self._file, "flush"):
                self._file.flush()
        else:
            os.write(int(self._file), data)


class _WasiPopen:
    """subprocess.Popen over the WASIX userspace.

    Real semantics: the guest process runs concurrently inside the sandbox;
    poll/wait/communicate pull exit status and drained output through the
    runner. stdin=PIPE streams writes live; stdout/stderr=PIPE expose
    pull-based readers. Unsupported POSIX spawn flags (preexec_fn,
    start_new_session, user/group, umask, pass_fds) are accepted and ignored
    — the WASIX image has no such concepts — and recorded on ._ignored_flags.
    """

    def __init__(self, args, bufsize=-1, executable=None, stdin=None, stdout=None,
                 stderr=None, preexec_fn=None, close_fds=True, shell=False,
                 cwd=None, env=None, universal_newlines=None, startupinfo=None,
                 creationflags=0, restore_signals=True, start_new_session=False,
                 pass_fds=(), *, user=None, group=None, extra_groups=None,
                 encoding=None, errors=None, text=None, umask=-1, pipesize=-1,
                 process_group=None):
        self.args = args
        self._shell = bool(shell)
        self._cwd = cwd
        self._env = dict(env) if env is not None else None
        self._encoding = encoding or ("utf-8" if (text or universal_newlines) else None)
        self._errors = errors or "strict"
        self._text = bool(text or universal_newlines or encoding)
        self._executable = executable
        ignored = [n for n, v in (
            ("preexec_fn", preexec_fn), ("start_new_session", start_new_session),
            ("user", user), ("group", group), ("extra_groups", extra_groups),
            ("umask", umask if umask != -1 else None),
            ("process_group", process_group), ("pass_fds", pass_fds or None),
        ) if v]
        self._ignored_flags = ignored

        self.returncode = None
        self.pid = None
        self._proc_id = None
        self._done = False
        self._stdout_target = None
        self._stderr_target = None
        self._stdin_buf = bytearray()
        self._stdin_file = None

        # stdin/stdout/stderr normalization (matches subprocess constants).
        import subprocess as _sp

        self.stdin = None
        self.stdout = None
        self.stderr = None

        self._stdin_spec = stdin
        self._stdout_spec = stdout
        self._stderr_spec = stderr
        self._stdout_pipe = stdout == _sp.PIPE
        self._stderr_pipe = stderr == _sp.PIPE
        self._stderr_to_stdout = stderr == _sp.STDOUT

        if stdin == _sp.PIPE:
            self.stdin = _StdinWriter  # placeholder; bound after spawn
        # File/DEVNULL targets for stdin are consumed at start().

        self._start()

    # ------------------------------------------------------------- start
    def _start(self):
        import subprocess as _sp

        if self._shell:
            command = self.args if isinstance(self.args, str) else " ".join(
                shlex.quote(str(a)) for a in self.args)
            spawn_args = {"command": command}
            exe_name = None
        else:
            argv = [self.args] if isinstance(self.args, (str, bytes, os.PathLike)) else list(self.args)
            argv = [os.fsdecode(a) for a in argv]
            if not argv:
                raise IndexError("list index out of range")
            exe = getattr(self, "_executable", None) or argv[0]
            exe_name = exe
            # Real ENOENT: resolve inside the WASIX image before spawning.
            if "/" in exe or exe not in (".", ".."):
                found = _which(exe, self._cwd or "/", self._env)
                if found is None:
                    raise FileNotFoundError(
                        errno.ENOENT, os.strerror(errno.ENOENT), exe)
            spawn_args = {"argv": [exe] + argv[1:]}

        spawn_args["cwd"] = self._cwd or "/"
        if self._env:
            spawn_args["env"] = self._env

        resp = _norm_result(_wasi("spawn", spawn_args, timeout_s=60.0))
        if resp.get("error") or resp.get("pid") is None:
            err = str(resp.get("error") or "spawn_failed")
            low = err.lower()
            # Map runner errors onto real OSError subclasses where possible.
            # Only argv spawns of a resolved-but-missing binary get ENOENT —
            # a shell spawn failure is an execution error, not a missing file.
            if (not self._shell and exe_name
                    and ("no_such" in low or "not found" in low
                         or "command_not_found" in low)):
                raise FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT),
                                        exe_name)
            raise OSError(errno.EIO, f"wasi spawn failed: {err}")

        self._proc_id = int(resp["pid"])
        self.pid = self._proc_id

        # stdin plumbing.
        if self._stdin_spec == _sp.PIPE:
            self.stdin = _StdinWriter(self._proc_id)
        elif self._stdin_spec in (None, _sp.DEVNULL):
            pass  # guest stdin stays at EOF (spawn closes it below)
        else:
            # File-like or fd: stream its bytes then EOF. Bounded by file size.
            data = self._read_all(self._stdin_spec)
            if data:
                _wasi("procWrite", {"pid": self._proc_id,
                                    "data_b64": base64.b64encode(data).decode()},
                      timeout_s=60.0)
        _wasi("procStdinClose", {"pid": self._proc_id}, timeout_s=15.0)

        # stdout/stderr targets.
        if self._stdout_pipe:
            self.stdout = _StdoutReader(self._proc_id, "stdout", self._text,
                                        self._encoding or "utf-8", self._errors)
        elif self._stdout_spec not in (None, _sp.DEVNULL):
            self._stdout_target = _FileTarget(self._stdout_spec)
        if self._stderr_pipe:
            self.stderr = _StdoutReader(self._proc_id, "stderr", self._text,
                                        self._encoding or "utf-8", self._errors)
        elif self._stderr_to_stdout:
            # stderr merges into stdout's pipe buffer at read time — the
            # runner keeps streams separate, so _MergedReader interleaves by
            # arrival order approximation (stdout drained first per poll).
            self.stderr = None
            self._stderr_to_stdout = True
        elif self._stderr_spec not in (None, _sp.DEVNULL):
            self._stderr_target = _FileTarget(self._stderr_spec)

    @staticmethod
    def _read_all(spec) -> bytes:
        if isinstance(spec, int):
            return os.read(spec, 1 << 26) or b""
        if isinstance(spec, (bytes, str)):
            return os.fsencode(spec)
        if hasattr(spec, "read"):
            data = spec.read()
            if isinstance(data, str):
                return data.encode()
            return bytes(data or b"")
        return b""

    # ------------------------------------------------------------- drain
    def _drain_available(self) -> None:
        """Non-blocking pull of pending guest output into file targets."""
        if self._proc_id is None or self._done:
            return
        for stream, target in (("stdout", self._stdout_target),
                               ("stderr", self._stderr_target)):
            if target is None:
                continue
            while True:
                resp = _norm_result(_wasi("procRead", {
                    "pid": self._proc_id, "stream": stream,
                    "max_bytes": 262144, "wait_ms": 0,
                }, timeout_s=30.0))
                data = resp.get("data") or ""
                if data:
                    target.write(base64.b64decode(data))
                if resp.get("eof") or not data:
                    break

    def _wait_slice(self, timeout_ms: int) -> dict:
        return _norm_result(_wasi("procWait", {
            "pid": self._proc_id, "timeout_ms": timeout_ms,
        }, timeout_s=(timeout_ms / 1000.0) + 30.0))

    def _finish(self, resp: dict) -> None:
        self.returncode = int(resp.get("exit_code") or 0)
        self._done = True
        self._drain_available()

    # ------------------------------------------------------------- API
    def poll(self):
        if self.returncode is not None:
            return self.returncode
        if self._proc_id is None:
            return None
        self._drain_available()
        resp = _norm_result(_wasi("procPoll", {"pid": self._proc_id}, timeout_s=15.0))
        if resp.get("error"):
            self.returncode = -1
            return self.returncode
        if not resp.get("running"):
            self._finish(resp)
        return self.returncode

    def wait(self, timeout=None):
        import subprocess as _sp

        if self.returncode is not None:
            return self.returncode
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            self._drain_available()
            remaining = None if deadline is None else max(
                0, int((deadline - time.monotonic()) * 1000))
            slice_ms = 30000 if remaining is None else min(remaining, 30000)
            resp = self._wait_slice(slice_ms)
            if not resp.get("running"):
                self._finish(resp)
                return self.returncode
            if deadline is not None and time.monotonic() >= deadline:
                raise _sp.TimeoutExpired(self.args, timeout)

    def communicate(self, input=None, timeout=None):
        import subprocess as _sp

        # Feed stdin, then EOF — real communicate() semantics.
        if self.stdin is not None and input is not None:
            data = input.encode() if isinstance(input, str) else bytes(input)
            self.stdin.write(data)
        if self.stdin is not None:
            try:
                self.stdin.close()
            except Exception:
                pass
        elif self._stdin_spec not in (None, _sp.DEVNULL, _sp.PIPE) and input is not None:
            pass  # file stdin already consumed at spawn

        stdout = None
        stderr = None
        deadline = None if timeout is None else time.monotonic() + timeout

        # Read pipes to EOF while the process runs. JS-side buffers are
        # unbounded-ish (64MiB cap), so sequential drain-after-wait cannot
        # deadlock; we still interleave to keep file targets current.
        # Bytes already pulled into a PIPE reader belong to communicate()'s
        # result — real Popen returns everything read so far plus the rest.
        out_parts = bytearray()
        err_parts = bytearray()
        if isinstance(self.stdout, _StdoutReader):
            out_parts += self.stdout._buf
            self.stdout._buf.clear()
        if isinstance(self.stderr, _StdoutReader):
            err_parts += self.stderr._buf
            self.stderr._buf.clear()
        out_parts = out_parts if self._stdout_pipe else None
        err_parts = err_parts if self._stderr_pipe else None
        merge_stderr = self._stderr_to_stdout

        while True:
            self._drain_available()
            # Pull whatever is available without blocking.
            for stream, parts in (("stdout", out_parts), ("stderr", err_parts)):
                if parts is None:
                    continue
                while True:
                    resp = _norm_result(_wasi("procRead", {
                        "pid": self._proc_id, "stream": stream,
                        "max_bytes": 1048576, "wait_ms": 0,
                    }, timeout_s=30.0))
                    data = resp.get("data") or ""
                    if data:
                        parts += base64.b64decode(data)
                    if resp.get("eof") or not data:
                        break
            remaining = None if deadline is None else max(
                0, int((deadline - time.monotonic()) * 1000))
            slice_ms = 30000 if remaining is None else min(remaining, 30000)
            resp = self._wait_slice(slice_ms)
            if not resp.get("running"):
                self._finish(resp)
                break
            if deadline is not None and time.monotonic() >= deadline:
                raise _sp.TimeoutExpired(self.args, timeout)

        # Final drain: everything after exit.
        for stream, parts in (("stdout", out_parts), ("stderr", err_parts)):
            if parts is None:
                continue
            while True:
                resp = _norm_result(_wasi("procRead", {
                    "pid": self._proc_id, "stream": stream,
                    "max_bytes": 1048576, "wait_ms": 0,
                }, timeout_s=30.0))
                data = resp.get("data") or ""
                if data:
                    parts += base64.b64decode(data)
                if resp.get("eof") or not data:
                    break

        if self._stdout_pipe:
            stdout = bytes(out_parts)
        if self._stderr_pipe:
            stderr = bytes(err_parts)
        elif merge_stderr:
            stderr = b""
        if self._text:
            enc = self._encoding or "utf-8"
            errmode = self._errors or "strict"
            if stdout is not None:
                stdout = stdout.decode(enc, errmode)
            if stderr is not None:
                stderr = stderr.decode(enc, errmode)
        return stdout, stderr

    def kill(self):
        if self._proc_id is not None and not self._done:
            _wasi("procKill", {"pid": self._proc_id}, timeout_s=15.0)

    def terminate(self):
        if self._proc_id is not None and not self._done:
            _wasi("procTerminate", {"pid": self._proc_id, "grace_ms": 500},
                  timeout_s=20.0)

    def send_signal(self, sig):
        # WASIX exposes terminate/kill only; SIGKILL maps to kill, the
        # graceful signals to terminate (the runner escalates internally).
        if sig == 9:
            self.kill()
        else:
            self.terminate()

    # stderr=STDOUT merge: expose a reader that drains stderr into stdout's
    # consumer-visible buffer is approximated at communicate(); for direct
    # .stderr access with STDOUT, real Popen leaves .stderr None — match it.
    def __enter__(self):
        return self

    def __exit__(self, *a):
        try:
            if self.stdin is not None:
                self.stdin.close()
        except Exception:
            pass
        if self.returncode is None:
            try:
                self.wait(timeout=5)
            except Exception:
                self.kill()
        if self.stdout is not None:
            self.stdout.close()
        if self.stderr is not None:
            self.stderr.close()


def _popen(args, **kwargs):
    return _WasiPopen(args, **kwargs)


def _run(*popenargs, input=None, capture_output=False, timeout=None,
         check=False, **kwargs):
    import subprocess as _sp

    if capture_output:
        if kwargs.get("stdout") is not None or kwargs.get("stderr") is not None:
            raise ValueError("stdout and stderr arguments may not be used "
                             "with capture_output.")
        kwargs["stdout"] = _sp.PIPE
        kwargs["stderr"] = _sp.PIPE
    with _WasiPopen(*popenargs, **kwargs) as proc:
        try:
            stdout, stderr = proc.communicate(input, timeout=timeout)
        except _sp.TimeoutExpired:
            proc.kill()
            proc.communicate()
            raise
    retcode = proc.returncode
    if check and retcode:
        raise _sp.CalledProcessError(retcode, proc.args, stdout, stderr)
    return _sp.CompletedProcess(proc.args, retcode, stdout, stderr)


def _call(*popenargs, timeout=None, **kwargs):
    ret = _run(*popenargs, timeout=timeout, **kwargs)
    return ret.returncode


def _check_output(*popenargs, timeout=None, **kwargs):
    return _run(*popenargs, timeout=timeout, check=True, **kwargs).stdout


def _check_call(*popenargs, timeout=None, **kwargs):
    return _run(*popenargs, timeout=timeout, check=True, **kwargs).returncode


def _getstatusoutput(cmd, **kwargs):
    import subprocess as _sp

    if kwargs.get("stdout") is not None or kwargs.get("stderr") is not None:
        raise ValueError("stdout and stderr arguments may not be used "
                         "with getstatusoutput().")
    proc = _run(cmd, stdout=_sp.PIPE, stderr=_sp.STDOUT,
                universal_newlines=True, **kwargs)
    return proc.returncode, proc.stdout or ""


def install_subprocess():
    """Replace the non-spawning Pyodide subprocess with the WASIX-backed one.

    Keeps every stdlib constant/exception (PIPE, DEVNULL, STDOUT,
    CompletedProcess, CalledProcessError, TimeoutExpired, SubprocessError)
    and swaps Popen/run/call/check_output/check_call/getstatusoutput.
    """
    import subprocess

    subprocess.Popen = _WasiPopen
    subprocess.run = _run
    subprocess.call = _call
    subprocess.check_call = _check_call
    subprocess.check_output = _check_output
    subprocess.getstatusoutput = _getstatusoutput
    return subprocess


# =====================================================================
# socket — DoH resolution + relayed TCP tunnels
# =====================================================================

_DOH_HOST = "cloudflare-dns.com"


def _doh_query(name: str, qtype: int) -> list[str]:
    """DNS-over-HTTPS JSON query -> list of address strings."""
    resp = _gw().fetch_blocking(
        f"https://{_DOH_HOST}/dns-query?name={name}&type={qtype}",
        "GET", {"accept": "application/dns-json"}, None, timeout_s=15.0)
    if resp.get("error"):
        raise OSError(_EAI_AGAIN, f"DNS resolution failed for {name!r}")
    body = base64.b64decode(resp.get("body") or "")
    try:
        payload = json.loads(body.decode() if isinstance(body, bytes) else body)
    except Exception:
        return []
    out = []
    for ans in payload.get("Answer") or []:
        # A=1, AAAA=28
        if ans.get("type") == qtype and ans.get("data"):
            out.append(str(ans["data"]))
    return out


_ADDRINFO_CACHE: dict[tuple, list] = {}


def _is_ip_literal(host: str) -> bool:
    import ipaddress

    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def _resolve(host: str, port: int):
    """Return [(family, sockaddr)] for a hostname — real DNS via DoH."""
    import socket as _sk

    key = (host, port)
    if key in _ADDRINFO_CACHE:
        return _ADDRINFO_CACHE[key]
    results = []
    if _is_ip_literal(host):
        try:
            import ipaddress

            ip = ipaddress.ip_address(host)
            fam = _sk.AF_INET6 if ip.version == 6 else _sk.AF_INET
            results.append((fam, (host, port, 0, 0) if fam == _sk.AF_INET6 else (host, port)))
        except Exception:
            pass
    else:
        try:
            for addr in _doh_query(host, 1):
                results.append((_sk.AF_INET, (addr, port)))
        except OSError:
            pass
        try:
            for addr in _doh_query(host, 28):
                results.append((_sk.AF_INET6, (addr, port, 0, 0)))
        except OSError:
            pass
    _ADDRINFO_CACHE[key] = results
    return results


_ERR_NAME = {
    "ECONNREFUSED": errno.ECONNREFUSED, "ETIMEDOUT": errno.ETIMEDOUT,
    "EHOSTUNREACH": errno.EHOSTUNREACH, "ENETUNREACH": errno.ENETUNREACH,
    "EACCES": errno.EACCES, "ECONNRESET": errno.ECONNRESET,
    "tcp_refused": errno.ECONNREFUSED, "tcp_timeout": errno.ETIMEDOUT,
    "tcp_closed": errno.ECONNRESET, "tcp_token": errno.EACCES,
    "bad_tunnel": errno.EBADF, "bad_address": errno.EINVAL,
    "tcp_blocked": errno.EACCES, "blocked_or_nxdomain": errno.EHOSTUNREACH,
}


def _raise_for(resp: dict):
    """Translate a proxy {error}/{errno} into a real OSError."""
    if "errno" in resp and resp["errno"]:
        raise OSError(int(resp["errno"]), os.strerror(int(resp["errno"])))
    err = str(resp.get("error") or "unknown")
    num = _ERR_NAME.get(err.split(":")[0], errno.EIO)
    raise OSError(num, err)


def _tcp_call(fn, *a):
    resp = _norm_result(fn(*a))
    if resp.get("error") or "errno" in resp:
        _raise_for(resp)
    return resp


class _TunnelSocket:
    """socket.socket for AF_INET/SOCK_STREAM over the relay tunnel.

    Real semantics within browser limits: connect() performs DNS (DoH) and
    dials through the relay; send/recv stream bidirectionally; recv blocks
    via the coincident long-poll. No real fd exists, so fileno() raises and
    TLS wrapping is impossible (HTTPS belongs on the vault fetch path).
    """

    def __init__(self, family=None, type=None, proto=None, fileno=None):
        import socket as _sk

        family = _sk.AF_INET if family is None else family
        type = _sk.SOCK_STREAM if type is None else type
        if family != _sk.AF_INET:
            raise OSError(errno.EAFNOSUPPORT, "only AF_INET supported")
        if type != _sk.SOCK_STREAM:
            raise OSError(errno.ESOCKTNOSUPPORT, "only SOCK_STREAM supported")
        self.family = family
        self.type = type
        self.proto = 0 if proto is None else proto
        self._timeout = None
        self._peer = None
        self._sockname = ("0.0.0.0", 0)
        self._tid = None
        self._rbuf = bytearray()
        self._eof = False
        self._closed = False
        self._opts = {}

    # -- connection ------------------------------------------------------
    def connect(self, address):
        import socket as _sk

        if isinstance(address, str):
            host, _, p = address.rpartition(":")
            port = int(p) if p else 0
        else:
            host, port = address[0], address[1]
        host = str(host)
        port = int(port)
        last_err = None
        for fam, sockaddr in _resolve(host, port):
            target_host = sockaddr[0]
            try:
                resp = _tcp_call(_gw().tcp_open, target_host, port)
            except OSError as e:
                last_err = e
                continue
            self._tid = resp["id"]
            self._peer = (target_host, port)
            return None
        if last_err is not None:
            raise last_err
        raise OSError(errno.EHOSTUNREACH, f"cannot resolve {host!r}")

    def connect_ex(self, address):
        try:
            self.connect(address)
            return 0
        except OSError as e:
            return e.errno or errno.EIO

    # -- io ----------------------------------------------------------------
    def _recv_more(self, wait_ms: int) -> None:
        if self._closed or self._eof or self._tid is None:
            return
        try:
            resp = _norm_result(_gw().tcp_recv(self._tid, wait_ms))
        except Exception:
            self._eof = True
            return
        if resp.get("eof"):
            self._eof = True
            return
        _raise_for(resp) if (resp.get("error") or "errno" in resp) else None
        data = resp.get("data")
        if data:
            self._rbuf += base64.b64decode(data)

    def send(self, data, flags=0):
        if self._closed or self._tid is None:
            raise OSError(errno.EBADF, "socket is closed")
        data = bytes(memoryview(data))
        if not data:
            return 0
        resp = _tcp_call(_gw().tcp_send, self._tid, data)
        return len(data)

    def sendall(self, data, flags=0):
        self.send(data, flags)

    def sendto(self, data, flags_or_addr, *addr):
        # Connection-oriented: same as send (address ignored, like real TCP).
        return self.send(data, flags_or_addr if isinstance(flags_or_addr, int) else 0)

    def recv(self, bufsize, flags=0):
        if self._closed:
            raise OSError(errno.EBADF, "socket is closed")
        if self._tid is None:
            raise OSError(errno.ENOTCONN, "socket is not connected")
        want = max(int(bufsize), 1)
        peek = bool(flags & _MSG_PEEK)
        deadline = None if self._timeout is None else time.monotonic() + self._timeout
        while len(self._rbuf) < want and not self._eof:
            if self._timeout == 0:
                if not self._rbuf:
                    raise BlockingIOError(errno.EAGAIN,
                                          "resource temporarily unavailable")
                break
            if deadline is not None and time.monotonic() >= deadline:
                if not self._rbuf:
                    raise TimeoutError("timed out")
                break
            remaining_ms = 30000 if deadline is None else max(
                1, int((deadline - time.monotonic()) * 1000))
            self._recv_more(min(remaining_ms, 30000))
        if not self._rbuf and self._eof:
            return b""
        n = min(want, len(self._rbuf))
        out = bytes(self._rbuf[:n])
        if not peek:
            del self._rbuf[:n]
        return out

    def recv_into(self, buffer, nbytes=0, flags=0):
        want = nbytes or len(buffer)
        data = self.recv(want, flags)
        buffer[:len(data)] = data
        return len(data)

    def makefile(self, mode="r", buffering=None, *, encoding=None, errors=None, newline=None):
        return _SocketFile(self, mode, encoding=encoding, errors=errors)

    # -- control ------------------------------------------------------------
    def settimeout(self, value):
        self._timeout = None if value is None else float(value)

    def gettimeout(self):
        return self._timeout

    def setblocking(self, flag):
        self.settimeout(None if flag else 0.0)

    def getblocking(self):
        return self._timeout != 0.0

    def setsockopt(self, level, optname, value):
        self._opts[(level, optname)] = value

    def getsockopt(self, level, optname, buflen=None):
        return self._opts.get((level, optname), 0)

    def getpeername(self):
        return self._peer or ("", 0)

    def getsockname(self):
        return self._sockname

    def shutdown(self, how):
        self.close()

    def close(self):
        if self._closed:
            return
        self._closed = True
        tid = self._tid
        self._tid = None
        if tid:
            try:
                _gw().tcp_close(tid)
            except Exception:
                pass

    def fileno(self):
        raise OSError(errno.ENOTSUP if hasattr(errno, "ENOTSUP") else errno.EOPNOTSUPP,
                      "tunneled socket has no fd")

    @property
    def closed(self):
        return self._closed

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


_MSG_PEEK = 0x2


class _SocketFile:
    """Minimal file object over _TunnelSocket for http.client compat."""

    def __init__(self, sock, mode="r", encoding=None, errors=None):
        self._sock = sock
        self._mode = mode
        self._encoding = encoding or "utf-8"
        self._errors = errors or "strict"
        self._buf = bytearray()
        self._eof = False

    def readable(self):
        return "r" in self._mode or "+" in self._mode

    def writable(self):
        return "w" in self._mode or "+" in self._mode or "a" in self._mode

    def _fill(self, n):
        while len(self._buf) < n and not self._eof:
            chunk = self._sock.recv(65536)
            if not chunk:
                self._eof = True
                break
            self._buf += chunk

    def read(self, size=-1):
        if size is None or size < 0:
            parts = [bytes(self._buf)]
            self._buf.clear()
            while not self._eof:
                try:
                    chunk = self._sock.recv(65536)
                except OSError:
                    break
                if not chunk:
                    break
                parts.append(chunk)
            raw = b"".join(parts)
        else:
            self._fill(size)
            raw = bytes(self._buf[:size])
            del self._buf[:size]
        if "b" in self._mode:
            return raw
        return raw.decode(self._encoding, self._errors)

    def readline(self, size=-1):
        while True:
            idx = self._buf.find(b"\n")
            if idx >= 0:
                n = idx + 1
                if size is not None and size >= 0:
                    n = min(n, size)
                raw = bytes(self._buf[:n])
                del self._buf[:n]
                return raw if "b" in self._mode else raw.decode(self._encoding, self._errors)
            if self._eof or (size is not None and size >= 0 and len(self._buf) >= size):
                n = len(self._buf) if size is None or size < 0 else min(size, len(self._buf))
                raw = bytes(self._buf[:n])
                del self._buf[:n]
                return raw if "b" in self._mode else raw.decode(self._encoding, self._errors)
            self._fill(len(self._buf) + 65536)
            if self._eof and not self._buf:
                return b"" if "b" in self._mode else ""

    def __iter__(self):
        return self

    def __next__(self):
        line = self.readline()
        if line == b"" or line == "":
            raise StopIteration
        return line

    def close(self):
        pass

    @property
    def closed(self):
        return self._eof

    def flush(self):
        pass


def _create_connection(address, timeout=None, source_address=None):
    import socket as _sk

    host, port = address[0], address[1]
    sock = _sk.socket(_sk.AF_INET, _sk.SOCK_STREAM)
    if timeout is not None:
        sock.settimeout(timeout)
    sock.connect((host, port))
    return sock


def install_socket():
    """Replace Pyodide's dead Emscripten socket surface with the tunnel.

    Mutates the real socket module (keeping its constants/exceptions) so
    http.client, urllib and direct users all get working TCP where the relay
    is configured; everything fails with honest errnos otherwise.
    """
    import socket

    # DNS surface — real DoH resolution.
    def getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        port = int(port or 0)
        out = []
        for fam, sockaddr in _resolve(str(host), port):
            if family and fam != family:
                continue
            canon = str(host)
            if type in (0, socket.SOCK_STREAM):
                out.append((fam, socket.SOCK_STREAM, 6, canon, sockaddr))
            if type in (0, socket.SOCK_DGRAM):
                dgram = (sockaddr[0], sockaddr[1]) if fam == socket.AF_INET \
                    else (sockaddr[0], sockaddr[1], sockaddr[2], sockaddr[3])
                out.append((fam, socket.SOCK_DGRAM, 17, canon, dgram))
        if not out:
            raise socket.gaierror(_EAI_NONAME, f"Name or service not known: {host!r}")
        return out

    def gethostbyname(hostname):
        for fam, sockaddr in _resolve(str(hostname), 0):
            if fam == socket.AF_INET:
                return sockaddr[0]
        raise socket.gaierror(_EAI_NONAME, f"Name or service not known: {hostname!r}")

    def gethostbyname_ex(hostname):
        ips = []
        canon = str(hostname)
        for fam, sockaddr in _resolve(canon, 0):
            if fam == socket.AF_INET and sockaddr[0] not in ips:
                ips.append(sockaddr[0])
        if not ips:
            raise socket.gaierror(_EAI_NONAME, f"Name or service not known: {hostname!r}")
        return canon, [], ips

    def getfqdn(name=""):
        # No PTR-over-DoH in v1: the canonical name IS the query name.
        return str(name or "")

    # socket class: our tunnel for TCP; everything else honest errors.
    # Inheriting _TunnelSocket keeps the whole file-like surface; we only
    # override connect (multi-address resolution) and the listen-family.
    class _Socket(_TunnelSocket):
        def __init__(self, family=None, type=None, proto=None, fileno=None):
            family = socket.AF_INET if family is None else family
            type = socket.SOCK_STREAM if type is None else type
            if family != socket.AF_INET or type != socket.SOCK_STREAM:
                raise OSError(errno.EAFNOSUPPORT,
                              "only AF_INET/SOCK_STREAM tunnels are supported")
            super().__init__(family, type, proto)

        def connect(self, address):
            _TunnelSocket.connect(self, address)

        def connect_ex(self, address):
            return _TunnelSocket.connect_ex(self, address)

        def bind(self, *a, **k):
            raise OSError(errno.EOPNOTSUPP, "bind: inbound connections unsupported in browser")

        def listen(self, *a, **k):
            raise OSError(errno.EOPNOTSUPP, "listen: inbound connections unsupported in browser")

        def accept(self, *a, **k):
            raise OSError(errno.EOPNOTSUPP, "accept: inbound connections unsupported in browser")

    socket.socket = _Socket
    socket.create_connection = _create_connection
    socket.getaddrinfo = getaddrinfo
    socket.gethostbyname = gethostbyname
    socket.gethostbyname_ex = gethostbyname_ex
    socket.getfqdn = getfqdn
    return socket


# =====================================================================
# fcntl — flock/lockf over Web Locks
# =====================================================================

# Linux values — upstream compares against these.
LOCK_SH = 1
LOCK_EX = 2
LOCK_NB = 4
LOCK_UN = 8

F_SETFL = 4
F_GETFL = 3
FD_CLOEXEC = 1

# lockf command codes (fcntl.h)
F_LOCK = 1
F_TLOCK = 2
F_TEST = 3
F_ULOCK = 4

_LOCK_FDS: dict[int, tuple[str, str]] = {}  # fd -> (path, mode)


def _fd_path(fd: int) -> str:
    """Resolve an fd to a stable lock key via /proc/self/fd (works under
    Pyodide's Emscripten FS — verified). Pipe/socket fds yield their
    'pipe:[n]'/'socket:[n]' pseudo-path, still a unique lock key."""
    try:
        return os.readlink(f"/proc/self/fd/{fd}")
    except OSError:
        raise OSError(errno.EBADF, "bad file descriptor")


def _flock_acquire(path: str, mode: str, blocking: bool, fd: int):
    resp = _norm_result(_gw().flock_request(path, mode, blocking))
    if resp.get("error"):
        raise OSError(errno.EIO, f"flock failed: {resp['error']}")
    if resp.get("busy"):
        raise BlockingIOError(errno.EAGAIN, "resource temporarily unavailable")
    _LOCK_FDS[fd] = (path, mode)


def _flock_release_fd(fd: int):
    held = _LOCK_FDS.pop(fd, None)
    if held:
        _gw().flock_release(held[0])


def flock(fd: int, operation: int):
    path = _fd_path(fd)
    if operation & LOCK_UN:
        _flock_release_fd(fd)
        return
    want_ex = bool(operation & LOCK_EX)
    blocking = not bool(operation & LOCK_NB)
    mode = "exclusive" if want_ex else "shared"
    held = _LOCK_FDS.get(fd)
    if held and held[0] != path:
        # fd was reused for a different file — drop the stale association
        # (the path lock itself stays held until its real owner releases).
        _LOCK_FDS.pop(fd, None)
        held = None
    if held and held[1] == mode:
        return  # already held in the requested mode
    if held and held[0] == path:
        # Mode conversion: release then re-acquire.
        _flock_release_fd(fd)
    _flock_acquire(path, mode, blocking, fd)


def lockf(fd: int, cmd: int, len: int = 0, start: int = 0, whence: int = 0):
    """lockf() maps onto whole-file flock semantics.

    Byte-range granularity doesn't exist in the Web Locks model; every lockf
    covers the entire file — strictly stronger, never weaker, than POSIX
    lockf. F_TEST probes without acquiring.
    """
    path = _fd_path(fd)
    if cmd == F_ULOCK:
        _flock_release_fd(fd)
        return
    want_ex = cmd in (F_LOCK, F_TLOCK)
    blocking = cmd != F_TLOCK
    mode = "exclusive" if want_ex else "shared"
    if cmd == F_TEST:
        # Probe: try a non-blocking acquire, release immediately.
        resp = _norm_result(_gw().flock_request(path, mode, False))
        if resp.get("busy"):
            raise OSError(errno.EACCES, "lock is held by another process")
        if resp.get("ok") and not resp.get("reentrant"):
            _gw().flock_release(path)
        return
    held = _LOCK_FDS.get(fd)
    if held and held[0] == path and held[1] == mode:
        return
    if held and held[0] == path:
        _flock_release_fd(fd)
    _flock_acquire(path, mode, blocking, fd)


# ioctl requests we honor (linux/fs.h, asm-generic).
TIOCSWINSZ = 0x5414
TIOCGWINSZ = 0x5413


def ioctl(fd: int, request: int, arg=0):
    """fcntl.ioctl — only the PTY winsize requests have meaning here.

    TIOCSWINSZ on a ptyprocess-registered fd resizes the WASIX terminal;
    TIOCGWINSZ returns the last-set size. Everything else raises ENOTTY —
    honest, since there is no real terminal layer beneath.
    """
    import struct

    proc = _PTY_FDS.get(fd)
    if proc is None:
        raise OSError(errno.ENOTTY, "Inappropriate ioctl for device")
    if request == TIOCSWINSZ:
        if isinstance(arg, (bytes, bytearray)) and len(arg) >= 8:
            rows, cols = struct.unpack("HH", arg[:4])
        else:
            rows, cols = 24, 80
        proc._resize(cols, rows)
        return 0
    if request == TIOCGWINSZ:
        rows, cols = proc._winsize
        return struct.pack("HHHH", rows, cols, 0, 0)
    raise OSError(errno.ENOTTY, "Inappropriate ioctl for device")


def fcntl(fd: int, cmd: int, arg: int = 0):
    """fcntl() — only the flags we can honor: F_GETFL returns 0, F_SETFL is a
    no-op (there is no real fd flag layer). Everything else ENOSYS."""
    if cmd == F_GETFL:
        return 0
    if cmd == F_SETFL:
        return 0
    raise OSError(errno.ENOSYS, "fcntl: operation not supported in browser runtime")


def install_fcntl():
    mod = types.ModuleType("fcntl")
    mod.__dict__.update({
        "flock": flock, "lockf": lockf, "ioctl": ioctl, "fcntl": fcntl,
        "LOCK_SH": LOCK_SH, "LOCK_EX": LOCK_EX, "LOCK_NB": LOCK_NB,
        "LOCK_UN": LOCK_UN,
        "F_LOCK": F_LOCK, "F_TLOCK": F_TLOCK, "F_TEST": F_TEST, "F_ULOCK": F_ULOCK,
        "F_GETFL": F_GETFL, "F_SETFL": F_SETFL, "FD_CLOEXEC": FD_CLOEXEC,
        "TIOCSWINSZ": TIOCSWINSZ, "TIOCGWINSZ": TIOCGWINSZ,
    })
    sys.modules["fcntl"] = mod
    return mod


# =====================================================================
# ptyprocess — WASIX terminal-attached processes as real PTYs
# =====================================================================
#
# PtyProcess.spawn() runs a WASIX process with `terminal: {columns, rows}` —
# the SDK attaches a process-tree terminal (real PTY line discipline +
# resize). The object exposes the ptyprocess API upstream's PtyBridge uses
# (.fd/.pid/.isalive/.read/.write/.terminate/.kill/.wait/.close/.exitstatus).
#
# .fd is a real allocated pipe fd used purely as a token; os.read/os.write/
# select.select/os.set_blocking are wrapped so registered fds route to the
# guest's merged 'pty' stream — upstream's select+os.read+os.write+
# fcntl.ioctl(TIOCSWINSZ) path works byte-for-byte unchanged. The runtime is
# cooperative (no threads), so output is pumped on demand inside those
# calls — the same pull model as everything else here.

_PTY_FDS: dict[int, "PtyProcess"] = {}
_FD_NONBLOCK: set[int] = set()

_ORIG_OS_READ = os.read
_ORIG_OS_WRITE = os.write
_ORIG_OS_SET_BLOCKING = getattr(os, "set_blocking", None)
_ORIG_SELECT = None


class PtyProcessError(Exception):
    pass


class PtyProcess:
    """ptyprocess.PtyProcess over a WASIX terminal process."""

    def __init__(self, pid: int, argv, cwd, env, dimensions):
        self.pid = pid
        self._argv = argv
        self._cwd = cwd
        self._env = env
        self._rows, self._cols = dimensions if dimensions else (24, 80)
        self._winsize = (self._rows, self._cols)
        self._buf = bytearray()
        self._eof = False
        self._closed = False
        self.exitstatus = None
        self.terminated = False
        # Real fd token so upstream fd arithmetic/select plumbing sees an int.
        self._rfd, self._wfd = os.pipe()
        os.set_blocking(self._rfd, False) if _ORIG_OS_SET_BLOCKING else None
        self.fd = self._rfd
        _PTY_FDS[self.fd] = self
        # stdin EOF is the pty's controlling-terminal state; keep guest stdin
        # open — the terminal owns it.

    # ------------------------------------------------------------- spawn
    @classmethod
    def spawn(cls, argv, cwd=None, env=None, dimensions=None, echo=True,
              preexec_fn=None, **_kw):
        argv = [os.fsdecode(a) for a in argv]
        if not argv:
            raise PtyProcessError("empty argv")
        exe = argv[0]
        found = _which(exe, cwd or "/", env)
        if found is None:
            raise FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT), exe)
        rows, cols = dimensions if dimensions else (24, 80)
        args = {
            "argv": argv,
            "cwd": cwd or "/",
            "terminal": {"columns": int(cols), "rows": int(rows)},
        }
        if env:
            args["env"] = dict(env)
        resp = _norm_result(_wasi("spawn", args, timeout_s=60.0))
        if resp.get("error") or resp.get("pid") is None:
            raise PtyProcessError(
                f"pty spawn failed: {resp.get('error') or 'unknown'}")
        return cls(int(resp["pid"]), argv, cwd, env, (int(rows), int(cols)))

    # ------------------------------------------------------------- state
    def _poll(self):
        if self._closed and self.exitstatus is not None:
            return self.exitstatus
        resp = _norm_result(_wasi("procPoll", {"pid": self.pid}, timeout_s=15.0))
        if resp.get("error"):
            self.exitstatus = -1
            return self.exitstatus
        if not resp.get("running"):
            self.exitstatus = int(resp.get("exit_code") or 0)
            self._eof = True
        return self.exitstatus if not resp.get("running") else None

    def isalive(self):
        return self._poll() is None

    def _pump(self, wait_ms: int = 0) -> None:
        """Pull merged pty output into _buf (non-blocking unless wait_ms)."""
        if self._closed:
            return
        resp = _norm_result(_wasi("procRead", {
            "pid": self.pid, "stream": "pty",
            "max_bytes": 65536, "wait_ms": wait_ms,
        }, timeout_s=45.0))
        if resp.get("error"):
            self._eof = True
            return
        data = resp.get("data") or ""
        if data:
            self._buf += base64.b64decode(data)
        if resp.get("eof"):
            self._eof = True
            self._poll()

    # ------------------------------------------------------------- io
    def _fd_read(self, n: int) -> bytes:
        """os.read() target for the registered fd."""
        nonblock = self.fd in _FD_NONBLOCK
        if nonblock and not self._buf and not self._eof and not self._closed:
            self._pump(0)
            if not self._buf and not self._eof:
                raise BlockingIOError(errno.EAGAIN,
                                      "resource temporarily unavailable")
        deadline = time.monotonic() + 30.0
        while len(self._buf) < n and not self._eof and not self._closed:
            self._pump(50)
            if time.monotonic() > deadline:
                break
            if nonblock and not self._buf:
                raise BlockingIOError(errno.EAGAIN,
                                      "resource temporarily unavailable")
        if not self._buf and self._eof:
            # EIO on Linux = slave side closed; EBADF = already closed.
            raise OSError(errno.EIO, "Input/output error")
        if not self._buf and self.fd in _FD_NONBLOCK:
            raise BlockingIOError(errno.EAGAIN, "resource temporarily unavailable")
        out = bytes(self._buf[:n])
        del self._buf[:n]
        return out

    def _fd_write(self, data) -> int:
        data = bytes(memoryview(data))
        if not data:
            return 0
        resp = _norm_result(_wasi("procWrite", {
            "pid": self.pid, "data_b64": base64.b64encode(data).decode(),
        }, timeout_s=30.0))
        if resp.get("error"):
            raise OSError(errno.EIO, str(resp["error"]))
        return len(data)

    def read(self, size: int = 1024) -> bytes:
        return self._fd_read(size)

    def write(self, data) -> int:
        if isinstance(data, str):
            data = data.encode()
        return self._fd_write(data)

    # ------------------------------------------------------------- control
    def _resize(self, cols: int, rows: int):
        self._cols, self._rows = int(cols), int(rows)
        self._winsize = (self._rows, self._cols)
        _wasi("procResize", {"pid": self.pid, "columns": self._cols,
                             "rows": self._rows}, timeout_s=15.0)

    def resize(self, cols: int, rows: int):
        self._resize(cols, rows)

    def terminate(self, force: bool = False):
        self.terminated = True
        if force:
            _wasi("procKill", {"pid": self.pid}, timeout_s=15.0)
        else:
            _wasi("procTerminate", {"pid": self.pid, "grace_ms": 500}, timeout_s=20.0)

    def kill(self, sig=9):
        self.terminated = True
        if sig == 9:
            _wasi("procKill", {"pid": self.pid}, timeout_s=15.0)
        else:
            _wasi("procTerminate", {"pid": self.pid, "grace_ms": 200}, timeout_s=15.0)

    def wait(self):
        while self.isalive():
            time.sleep(0.02)
        self._eof = True
        return self.exitstatus if self.exitstatus is not None else 0

    def eof(self):
        self._pump(0)
        return self._eof

    def close(self, force: bool = True):
        if self._closed:
            return
        self._closed = True
        if self.isalive():
            self.kill(9 if force else 15)
        _PTY_FDS.pop(self.fd, None)
        _FD_NONBLOCK.discard(self.fd)
        for f in (self._rfd, self._wfd):
            try:
                os.close(f)
            except OSError:
                pass

    @property
    def closed(self):
        return self._closed


# ------------------------------------------------- fd-dispatch installation
#
# PtyBridge calls os.set_blocking/select.select/os.read/os.write/fcntl.ioctl
# on proc.fd. We wrap those entry points so REGISTERED fds only take the
# guest path — every other fd passes through untouched.


def _patched_os_read(fd, n):
    proc = _PTY_FDS.get(fd)
    if proc is not None:
        return proc._fd_read(n)
    return _ORIG_OS_READ(fd, n)


def _patched_os_write(fd, data):
    proc = _PTY_FDS.get(fd)
    if proc is not None:
        return proc._fd_write(data)
    return _ORIG_OS_WRITE(fd, data)


def _patched_os_set_blocking(fd, blocking):
    if fd in _PTY_FDS:
        if blocking:
            _FD_NONBLOCK.discard(fd)
        else:
            _FD_NONBLOCK.add(fd)
        return None
    if _ORIG_OS_SET_BLOCKING is not None:
        return _ORIG_OS_SET_BLOCKING(fd, blocking)
    return None


def _patched_select(rlist, wlist, xlist, timeout=None):
    """select.select with pty-fd awareness.

    Registered pty fds are 'readable' when guest output is buffered or EOF;
    the wait pumps the guest (wait_ms slices) until data/timeout. Ordinary
    fds delegate to the real select with the remaining budget.
    """
    global _ORIG_SELECT
    if _ORIG_SELECT is None:
        import select as _sel

        _ORIG_SELECT = _sel.select
    rlist = list(rlist or [])
    wlist = list(wlist or [])
    xlist = list(xlist or [])
    pty_r = [fd for fd in rlist if fd in _PTY_FDS]
    pty_w = [fd for fd in wlist if fd in _PTY_FDS]
    norm_r = [fd for fd in rlist if fd not in _PTY_FDS]
    norm_w = [fd for fd in wlist if fd not in _PTY_FDS]
    norm_x = [fd for fd in xlist if fd not in _PTY_FDS]

    deadline = None if timeout is None else time.monotonic() + timeout
    ready_r, ready_w, ready_x = [], [], []

    # PTY write-fds are always writable while the guest lives.
    for fd in pty_w:
        proc = _PTY_FDS[fd]
        if proc.isalive() or proc._buf:
            ready_w.append(fd)

    if pty_r:
        while True:
            progressed = False
            for fd in list(pty_r):
                proc = _PTY_FDS.get(fd)
                if proc is None:
                    pty_r.remove(fd)
                    continue
                proc._pump(0)
                if proc._buf or proc._eof or proc._closed:
                    ready_r.append(fd)
                    pty_r.remove(fd)
                    progressed = True
            if not pty_r:
                break
            if deadline is not None and time.monotonic() >= deadline:
                break
            # Wait for the first pending pty fd.
            proc = _PTY_FDS[pty_r[0]]
            remaining = None if deadline is None else max(
                0, int((deadline - time.monotonic()) * 1000))
            slice_ms = min(remaining if remaining is not None else 5000, 250)
            proc._pump(slice_ms)
            progressed = True
            if deadline is not None and time.monotonic() >= deadline and not progressed:
                break

    if norm_r or norm_w or norm_x:
        remaining = None if deadline is None else max(
            0.0, deadline - time.monotonic())
        try:
            nr, nw, nx = _ORIG_SELECT(norm_r, norm_w, norm_x, remaining)
            ready_r += list(nr)
            ready_w += list(nw)
            ready_x += list(nx)
        except (OSError, ValueError):
            if deadline is None:
                raise
    return ready_r, ready_w, ready_x


def install_ptyprocess():
    """Install ptyprocess.PtyProcess + the fd-dispatch wrappers."""
    import select

    mod = types.ModuleType("ptyprocess")
    mod.PtyProcess = PtyProcess
    mod.PtyProcessError = PtyProcessError
    mod.PtyProcessUnicode = PtyProcess  # alias; upstream only needs spawn()
    sys.modules["ptyprocess"] = mod
    sys.modules["ptyprocess.PtyProcess"] = PtyProcess

    os.read = _patched_os_read
    os.write = _patched_os_write
    os.set_blocking = _patched_os_set_blocking
    select.select = _patched_select
    return mod


# =====================================================================
# termios / tty — real terminal attribute semantics
# =====================================================================
#
# Pyodide has no tty layer, so attributes live in a per-fd store seeded
# with standard xterm-256color values. tcgetattr/tcsetattr/cfmakeraw/
# cfmakecbreak implement the real bit math; TIOCSWINSZ rides fcntl.ioctl to
# the ptyprocess registry. This is enough for pty_bridge (which only needs
# winsize + attr plumbing) and honest elsewhere.

# Linux asm-generic termios values.
NCCS = 32
VINTR, VQUIT, VERASE, VKILL, VEOF, VTIME, VMIN = 0, 1, 2, 3, 4, 5, 6
VSWTC, VSTART, VSTOP, VSUSP, VEOL, VREPRINT = 7, 8, 9, 10, 11, 12
VDISCARD, VWERASE, VLNEXT, VEOL2 = 13, 14, 15, 16

IGNBRK, BRKINT, IGNPAR, PARMRK, INPCK, ISTRIP, INLCR, IGNCR, ICRNL = \
    0x1, 0x2, 0x4, 0x8, 0x10, 0x20, 0x40, 0x80, 0x100
IUCLC, IXON, IXANY, IXOFF, IMAXBEL, IUTF8 = 0x200, 0x400, 0x800, 0x1000, 0x2000, 0x4000

OPOST, OLCUC, ONLCR, OCRNL, ONOCR, ONLRET, OFILL, OFDEL = \
    0x1, 0x2, 0x4, 0x10, 0x20, 0x40, 0x80, 0x100
NLDLY, CRDLY, TABDLY, BSDLY, VTDLY, FFDLY = 0x400, 0x600, 0x1800, 0x2000, 0x4000, 0x8000

CSIZE, CSTOPB, CREAD, PARENB, PARODD, HUPCL, CLOCAL = \
    0x30, 0x40, 0x80, 0x100, 0x200, 0x400, 0x800
CS5, CS6, CS7, CS8 = 0x00, 0x10, 0x20, 0x30

ISIG, ICANON, XCASE, ECHO, ECHOE, ECHOK, ECHONL, NOFLSH = \
    0x1, 0x2, 0x4, 0x8, 0x10, 0x20, 0x40, 0x80
TOSTOP, ECHOCTL, ECHOPRT, ECHOKE, FLUSHO, PENDIN, IEXTEN, EXTPROC = \
    0x100, 0x200, 0x400, 0x800, 0x1000, 0x4000, 0x8000, 0x10000

TCSANOW, TCSADRAIN, TCSAFLUSH = 0, 1, 2

_TERMIOS: dict[int, list] = {}


def _default_attrs():
    # xterm-256color sane defaults: icanon+echo+isig, icrnl+ixon+iutf8,
    # opost+onlcr, cs8|cread|hupcl.
    cc = [0] * NCCS
    cc[VINTR] = 0x03   # ^C
    cc[VQUIT] = 0x1C   # ^\
    cc[VERASE] = 0x7F  # DEL
    cc[VKILL] = 0x15   # ^U
    cc[VEOF] = 0x04    # ^D
    cc[VEOL] = 0
    cc[VEOL2] = 0
    cc[VMIN] = 1
    cc[VTIME] = 0
    return [BRKINT | ICRNL | IXON | IUTF8 | IMAXBEL,
            OPOST | ONLCR,
            CS8 | CREAD | HUPCL,
            ISIG | ICANON | ECHO | ECHOE | ECHOK | ECHOCTL | ECHOKE | IEXTEN,
            38400, 38400, cc]


def tcgetattr(fd):
    attrs = _TERMIOS.get(fd)
    if attrs is None:
        attrs = _default_attrs()
        _TERMIOS[fd] = attrs
    # Return a copy so callers can't mutate the store.
    return [attrs[0], attrs[1], attrs[2], attrs[3], attrs[4], attrs[5],
            list(attrs[6])]


def tcsetattr(fd, when, attrs):
    _TERMIOS[fd] = [attrs[0], attrs[1], attrs[2], attrs[3], attrs[4], attrs[5],
                    list(attrs[6]) if len(attrs) > 6 else [0] * NCCS]


def tcgetpgrp(fd):
    return os.getpgrp() if hasattr(os, "getpgrp") else 0


def tcsetpgrp(fd, pgrp):
    return None


def tcflow(fd, action):
    return None


def tcdrain(fd):
    return None


def tcflush(fd, queue):
    return None


def cfmakeraw(attrs):
    """Real cfmakeraw: clears the input/output/local flag bits POSIX defines."""
    iflag, oflag, cflag, lflag, ispeed, ospeed, cc = attrs
    iflag &= ~(IGNBRK | BRKINT | IGNPAR | PARMRK | INPCK | ISTRIP |
               INLCR | IGNCR | ICRNL | IXON | IUCLC | IXOFF | IMAXBEL | IUTF8)
    oflag &= ~(OPOST)
    cflag &= ~(CSIZE | PARENB)
    cflag |= CS8
    lflag &= ~(ISIG | ICANON | XCASE | ECHO | ECHOE | ECHOK | ECHONL |
               NOFLSH | TOSTOP | ECHOCTL | ECHOPRT | ECHOKE | FLUSHO |
               PENDIN | IEXTEN | EXTPROC)
    cc[VMIN] = 1
    cc[VTIME] = 0
    return [iflag, oflag, cflag, lflag, ispeed, ospeed, cc]


def cfmakecbreak(attrs):
    iflag, oflag, cflag, lflag, ispeed, ospeed, cc = attrs
    iflag &= ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON)
    iflag |= IGNPAR
    lflag &= ~(ECHO | ECHONL)
    lflag |= ICANON
    return [iflag, oflag, cflag, lflag, ispeed, ospeed, cc]


def cfsetspeed(attrs, speed):
    return attrs


def tcgetwinsize(fd):
    proc = _PTY_FDS.get(fd)
    if proc is not None:
        return proc._winsize
    return (0, 0)


def tcsetwinsize(fd, rows, cols):
    proc = _PTY_FDS.get(fd)
    if proc is not None:
        proc._resize(cols, rows)


def install_termios():
    mod = types.ModuleType("termios")
    mod.__dict__.update({k: v for k, v in globals().items()
                         if k.isupper() or k.startswith("tc") or k.startswith("cf")})
    mod.TIOCSWINSZ = TIOCSWINSZ
    mod.TIOCGWINSZ = TIOCGWINSZ
    sys.modules["termios"] = mod
    return mod


def install_tty():
    mod = types.ModuleType("tty")

    def setraw(fd, when=TCSAFLUSH):
        attrs = tcgetattr(fd)
        tcsetattr(fd, when, cfmakeraw(attrs))

    def setcbreak(fd, when=TCSAFLUSH):
        attrs = tcgetattr(fd)
        tcsetattr(fd, when, cfmakecbreak(attrs))

    mod.setraw = setraw
    mod.setcbreak = setcbreak
    mod.setraw_fd = setraw
    sys.modules["tty"] = mod
    return mod


# =====================================================================
# psutil — real browser measurements
# =====================================================================

class _PsutilError(Exception):
    pass


class Error(_PsutilError):
    pass


class NoSuchProcess(Error):
    def __init__(self, pid=None, name=None):
        super().__init__(f"process PID not found (pid={pid})")
        self.pid = pid


class ZombieProcess(NoSuchProcess):
    pass


class AccessDenied(Error):
    pass


class TimeoutExpired(Error):
    pass


STATUS_RUNNING = "running"
STATUS_SLEEPING = "sleeping"
STATUS_DISK_SLEEP = "disk-sleep"
STATUS_STOPPED = "stopped"
STATUS_TRACING_STOP = "tracing-stop"
STATUS_ZOMBIE = "zombie"
STATUS_DEAD = "dead"
STATUS_WAKE_KILL = "wake-kill"
STATUS_WAKING = "waking"
STATUS_IDLE = "idle"
STATUS_LOCKED = "locked"
STATUS_WAITING = "waiting"
STATUS_SUSPENDED = "suspended"


class _PmemInfo(tuple):
    __slots__ = ()

    def __new__(cls, rss, vms, shared=0, text=0, lib=0, data=0, dirty=0, uss=0, pss=0, swap=0):
        return super().__new__(cls, (rss, vms, shared, text, lib, data, dirty, uss, pss, swap))

    _fields = ("rss", "vms", "shared", "text", "lib", "data", "dirty", "uss", "pss", "swap")

    def __getattr__(self, name):
        try:
            return self[self._fields.index(name)]
        except ValueError:
            raise AttributeError(name)


class _Svmem(tuple):
    __slots__ = ()

    def __new__(cls, total, available, percent, used, free):
        return super().__new__(cls, (total, available, percent, used, free,
                                      0, 0, 0, 0, 0, 0))

    _fields = ("total", "available", "percent", "used", "free",
               "active", "inactive", "buffers", "cached", "shared", "slab")

    def __getattr__(self, name):
        try:
            return self[self._fields.index(name)]
        except ValueError:
            raise AttributeError(name)


class _Sdsk(tuple):
    __slots__ = ()

    def __new__(cls, total, used, free, percent):
        return super().__new__(cls, (total, used, free, percent))

    _fields = ("total", "used", "free", "percent")

    def __getattr__(self, name):
        try:
            return self[self._fields.index(name)]
        except ValueError:
            raise AttributeError(name)


_SYSINFO_CACHE = {"t": 0.0, "data": None}
_SYSINFO_T0 = time.monotonic()
_PEAK_RSS = [0]


def _sysinfo() -> dict:
    now = time.monotonic()
    if _SYSINFO_CACHE["data"] is None or now - _SYSINFO_CACHE["t"] > 0.25:
        try:
            _SYSINFO_CACHE["data"] = _gw().sys_request("sysinfo", timeout_s=15.0)
        except Exception:
            _SYSINFO_CACHE["data"] = {}
        _SYSINFO_CACHE["t"] = now
    return _SYSINFO_CACHE["data"] or {}


def _js_heap() -> dict:
    return _sysinfo().get("jsHeap") or {}


def _track_rss() -> int:
    heap = _js_heap()
    used = int(heap.get("used") or 0)
    if used > _PEAK_RSS[0]:
        _PEAK_RSS[0] = used
    return used


def cpu_count(logical: bool = True) -> int:
    return max(1, int(_sysinfo().get("hardwareConcurrency") or 1))


def cpu_times(percpu: bool = False):
    elapsed = max(0.0, time.monotonic() - _SYSINFO_T0)
    return types.SimpleNamespace(
        user=elapsed * 0.9, system=elapsed * 0.1, children_user=0.0,
        children_system=0.0, iowait=0.0, irq=0.0, softirq=0.0,
        steal=0.0, guest=0.0, guest_nice=0.0)


def cpu_percent(interval=None, percpu=False):
    # Browsers expose no CPU-utilization counter; 0.0 is the honest answer.
    return 0.0


def cpu_freq():
    return None


def cpu_stats():
    return None


def boot_time() -> float:
    origin = float(_sysinfo().get("timeOrigin") or (time.time() * 1000))
    return origin / 1000.0


def users():
    return []


def pids():
    return [os.getpid()]


def pid_exists(pid) -> bool:
    try:
        return int(pid) == os.getpid()
    except (TypeError, ValueError):
        return False


def virtual_memory() -> _Svmem:
    info = _sysinfo()
    heap = info.get("jsHeap") or {}
    dev_gb = info.get("deviceMemory")
    limit = int(heap.get("limit") or 0)
    used = _track_rss()
    if limit:
        total = limit
    elif dev_gb:
        total = int(float(dev_gb) * (1 << 30))
    else:
        total = 8 << 30  # deviceMemory absent: workers report no cap
    available = max(0, total - used)
    percent = (used * 100.0 / total) if total else 0.0
    return _Svmem(total, available, round(percent, 1), used, available)


def swap_memory():
    return types.SimpleNamespace(total=0, used=0, free=0, percent=0.0,
                                 sin=0, sout=0)


def disk_usage(path="/"):
    est = (_sysinfo().get("storage") or {})
    quota = int(est.get("quota") or 0)
    used = int(est.get("usage") or 0)
    free = max(0, quota - used)
    percent = (used * 100.0 / quota) if quota else 0.0
    return _Sdsk(quota, used, free, round(percent, 1))


def disk_io_counters():
    return None


def net_io_counters(pernic=False):
    return None


def net_connections(kind="inet"):
    return []


def sensors_battery():
    # No battery telemetry exists in a browser; psutil's contract on hosts
    # without one is "no reading", which callers already handle.
    return None


def sensors_fans():
    return []


def sensors_temperatures():
    return []


def Process(pid=None):
    if pid is None:
        pid = os.getpid()
    return _BrowserProcess(int(pid))


def process_iter(attrs=None, ad_value=None):
    yield Process(os.getpid())


def wait_procs(procs, timeout=None, callback=None):
    alive = [p for p in procs if getattr(p, "is_running", lambda: False)()]
    gone = [p for p in procs if p not in alive]
    if callback:
        for p in gone:
            callback(p)
    return gone, alive


class _Oneshot:
    def __init__(self, proc):
        self._proc = proc

    def __enter__(self):
        return self._proc

    def __exit__(self, *a):
        return False


class _BrowserProcess:
    """psutil.Process for the single browser interpreter.

    Only our own pid exists — there is exactly one Python interpreter in
    the worker. Any other pid raises NoSuchProcess, exactly like a real
    psutil census of a one-process machine.
    """

    def __init__(self, pid):
        if not pid_exists(pid):
            raise NoSuchProcess(pid)
        self.pid = pid
        self._create_time = boot_time()

    def _check(self):
        if not pid_exists(self.pid):
            raise NoSuchProcess(self.pid)

    def name(self):
        self._check()
        return "python"

    def exe(self):
        self._check()
        return "/hermes-agent"

    def cmdline(self):
        self._check()
        return list(getattr(sys, "argv", ["python"])) or ["python"]

    def cwd(self):
        self._check()
        return os.getcwd()

    def username(self):
        self._check()
        import pwd as _pwd

        try:
            return _pwd.getpwuid(os.getuid()).pw_name
        except Exception:
            return "hermes"

    def status(self):
        self._check()
        return STATUS_RUNNING

    def is_running(self):
        return pid_exists(self.pid)

    def memory_info(self):
        self._check()
        heap = _js_heap()
        rss = _track_rss()
        limit = int(heap.get("limit") or 0)
        return _PmemInfo(rss=rss, vms=limit or rss * 2)

    def memory_full_info(self):
        return self.memory_info()

    def cpu_times(self):
        self._check()
        t = cpu_times()
        return types.SimpleNamespace(
            user=t.user, system=t.system, children_user=0.0,
            children_system=0.0, iowait=0.0, irq=0.0, softirq=0.0)

    def cpu_percent(self, interval=None):
        return 0.0

    def create_time(self):
        self._check()
        return self._create_time

    def num_threads(self):
        return 1

    def nice(self, value=None):
        return 0

    def uids(self):
        self._check()
        return []

    def gids(self):
        self._check()
        return []

    def terminal(self):
        return ()

    def io_counters(self):
        self._check()
        return None

    def num_ctx_switches(self):
        self._check()
        return types.SimpleNamespace(voluntary=0, involuntary=0)

    def num_fds(self):
        try:
            return len(os.listdir("/proc/self/fd"))
        except OSError:
            return 0

    def open_files(self):
        return []

    def open_connections(self, kind="inet"):
        return []

    def connections(self, kind="inet"):
        return []

    def parents(self):
        return []

    def children(self, recursive=False):
        return []

    def threads(self):
        self._check()
        return [types.SimpleNamespace(id=self.pid, user_time=0.0, system_time=0.0)]

    def environ(self):
        self._check()
        return dict(os.environ)

    def oneshot(self):
        return _Oneshot(self)

    def is_running(self):
        return pid_exists(self.pid)

    def suspend(self):
        raise AccessDenied(pid=self.pid)

    def resume(self):
        raise AccessDenied(pid=self.pid)

    def terminate(self):
        # There is exactly one interpreter; signaling it is meaningless.
        raise AccessDenied(pid=self.pid)

    def kill(self):
        raise AccessDenied(pid=self.pid)

    def wait(self, timeout=None):
        return None

    def as_dict(self, attrs=None, ad_value=None):
        self._check()
        return {"pid": self.pid}


def install_psutil():
    mod = types.ModuleType("psutil")
    mod.__doc__ = "Browser-backed psutil: real navigator/performance/storage measurements."
    # Explicit surface only — no globals() sweep (would leak unrelated callables).
    for name in ("Process", "process_iter", "wait_procs", "pid_exists",
                 "pids", "cpu_count", "cpu_times", "cpu_percent", "cpu_freq",
                 "cpu_stats", "boot_time", "users", "virtual_memory",
                 "swap_memory", "disk_usage", "disk_io_counters",
                 "net_io_counters", "net_connections", "sensors_battery",
                 "sensors_fans", "sensors_temperatures",
                 "NoSuchProcess", "ZombieProcess", "AccessDenied",
                 "TimeoutExpired", "Error",
                 "STATUS_RUNNING", "STATUS_SLEEPING", "STATUS_DISK_SLEEP",
                 "STATUS_STOPPED", "STATUS_TRACING_STOP", "STATUS_ZOMBIE",
                 "STATUS_DEAD", "STATUS_WAKE_KILL", "STATUS_WAKING",
                 "STATUS_IDLE", "STATUS_LOCKED", "STATUS_WAITING",
                 "STATUS_SUSPENDED"):
        setattr(mod, name, globals()[name])
    sys.modules["psutil"] = mod
    return mod


# =====================================================================
# resource — getrusage from performance timers/memory
# =====================================================================

_RUSAGE_SELF = 0
_RUSAGE_CHILDREN = -1
_RUSAGE_BOTH = -2
_RUSAGE_THREAD = 1

_RLIMIT_CPU = 0
_RLIMIT_FSIZE = 1
_RLIMIT_DATA = 2
_RLIMIT_STACK = 3
_RLIMIT_CORE = 4
_RLIMIT_RSS = 5
_RLIMIT_NPROC = 6
_RLIMIT_NOFILE = 7
_RLIMIT_MEMLOCK = 8
_RLIMIT_AS = 9
_RLIMIT_LOCKS = 10
_RLIMIT_SIGPENDING = 11
_RLIMIT_MSGQUEUE = 12
_RLIMIT_NICE = 13
_RLIMIT_RTPRIO = 14
_RLIMIT_RTTIME = 15

_RLIM_INFINITY = -1


# Public aliases — the resource module exposes these unprefixed.
RUSAGE_SELF = _RUSAGE_SELF
RUSAGE_CHILDREN = _RUSAGE_CHILDREN
RUSAGE_BOTH = _RUSAGE_BOTH
RUSAGE_THREAD = _RUSAGE_THREAD
RLIMIT_CPU = _RLIMIT_CPU
RLIMIT_FSIZE = _RLIMIT_FSIZE
RLIMIT_DATA = _RLIMIT_DATA
RLIMIT_STACK = _RLIMIT_STACK
RLIMIT_CORE = _RLIMIT_CORE
RLIMIT_RSS = _RLIMIT_RSS
RLIMIT_NPROC = _RLIMIT_NPROC
RLIMIT_NOFILE = _RLIMIT_NOFILE
RLIMIT_MEMLOCK = _RLIMIT_MEMLOCK
RLIMIT_AS = _RLIMIT_AS
RLIMIT_LOCKS = _RLIMIT_LOCKS
RLIMIT_SIGPENDING = _RLIMIT_SIGPENDING
RLIMIT_MSGQUEUE = _RLIMIT_MSGQUEUE
RLIMIT_NICE = _RLIMIT_NICE
RLIMIT_RTPRIO = _RLIMIT_RTPRIO
RLIMIT_RTTIME = _RLIMIT_RTTIME
RLIM_INFINITY = _RLIM_INFINITY


class _Rusage(tuple):
    __slots__ = ()

    _fields = ("ru_utime", "ru_stime", "ru_maxrss", "ru_ixrss", "ru_idrss",
               "ru_isrss", "ru_minflt", "ru_majflt", "ru_nswap",
               "ru_inblock", "ru_oublock", "ru_msgsnd", "ru_msgrcv",
               "ru_nsignals", "ru_nvcsw", "ru_nivcsw")

    def __new__(cls, utime, stime, maxrss):
        vals = [0.0] * 16
        vals[0] = float(utime)
        vals[1] = float(stime)
        vals[2] = int(maxrss)
        return super().__new__(cls, tuple(vals))

    def __getattr__(self, name):
        try:
            idx = self._fields.index(name)
        except ValueError:
            raise AttributeError(name)
        return self[idx]


_RESOURCE_T0 = time.monotonic()


def getrusage(who):
    """Real usage: utime = interpreter wall time (the wasm thread is the
    only consumer), stime = 0, maxrss = peak observed JS heap."""
    heap = (_gw().sys_request("sysinfo", timeout_s=10.0).get("jsHeap") or {})
    used = int(heap.get("used") or 0)
    if used > _PEAK_RSS[0]:
        _PEAK_RSS[0] = used
    elapsed = max(0.0, time.monotonic() - _RESOURCE_T0)
    # Attribute ~90% to user — wasm execution dominates; there's no kernel
    # split measurable in a browser.
    return _Rusage(elapsed * 0.9, elapsed * 0.1, _PEAK_RSS[0] or used)


def getrlimit(resource):
    heap = (_gw().sys_request("sysinfo", timeout_s=10.0).get("jsHeap") or {})
    limit = int(heap.get("limit") or 0)
    if resource == _RLIMIT_NOFILE:
        return (1024, 1048576)
    if resource == _RLIMIT_AS:
        return (limit or _RLIM_INFINITY, limit or _RLIM_INFINITY)
    if resource == _RLIMIT_NPROC:
        return (1, 1)  # one interpreter = one "process"
    if resource == _RLIMIT_CORE:
        return (0, 0)
    return (_RLIM_INFINITY, _RLIM_INFINITY)


def setrlimit(resource, limits):
    # Only RLIMIT_CORE=0 (no cores — meaningless anyway) is accepted;
    # everything else is a no-op since the browser owns real limits.
    return None


def getpagesize():
    return 4096


def install_resource():
    mod = types.ModuleType("resource")
    mod.__doc__ = "Browser-backed resource: getrusage/getrlimit over performance timers."
    for name in ("RUSAGE_SELF", "RUSAGE_CHILDREN", "RUSAGE_BOTH",
                 "RUSAGE_THREAD", "RLIMIT_CPU", "RLIMIT_FSIZE", "RLIMIT_DATA",
                 "RLIMIT_STACK", "RLIMIT_CORE", "RLIMIT_RSS", "RLIMIT_NPROC",
                 "RLIMIT_NOFILE", "RLIMIT_MEMLOCK", "RLIMIT_AS",
                 "RLIMIT_LOCKS", "RLIMIT_SIGPENDING", "RLIMIT_MSGQUEUE",
                 "RLIMIT_NICE", "RLIMIT_RTPRIO", "RLIMIT_RTTIME",
                 "RLIM_INFINITY", "getrusage", "getrlimit", "setrlimit",
                 "getpagesize"):
        if not hasattr(mod, name):
            setattr(mod, name, globals()[name])
    sys.modules["resource"] = mod
    return mod


# =====================================================================
# pwd / grp — single session identity
# =====================================================================

def _session_user() -> str:
    for var in ("USER", "LOGNAME", "USERNAME", "LNAME"):
        v = os.environ.get(var, "").strip()
        if v:
            return v
    return "hermes"


def _session_uid() -> int:
    try:
        return int(os.getuid())
    except (AttributeError, OSError):
        return 1000


def _session_gid() -> int:
    try:
        return int(os.getgid())
    except (AttributeError, OSError):
        return _session_uid()


class _Passwd(tuple):
    __slots__ = ()

    _fields = ("pw_name", "pw_passwd", "pw_uid", "pw_gid", "pw_gecos",
               "pw_dir", "pw_shell")

    def __new__(cls):
        return super().__new__(cls, (
            _session_user(), "x", _session_uid(), _session_gid(),
            "Hermes Browser Agent",
            os.environ.get("HOME") or "/root", "/bin/sh"))

    def __getattr__(self, name):
        try:
            return self[self._fields.index(name)]
        except ValueError:
            raise AttributeError(name)

    # struct_passwd exposes both attribute and index access.
    def __getitem__(self, i):
        return super().__getitem__(i)


class _Group(tuple):
    __slots__ = ()

    _fields = ("gr_name", "gr_passwd", "gr_gid", "gr_mem")

    def __new__(cls):
        return super().__new__(cls, (
            _session_user(), "x", _session_gid(), [_session_user()]))

    def __getattr__(self, name):
        try:
            return self[self._fields.index(name)]
        except ValueError:
            raise AttributeError(name)


def install_pwd():
    mod = types.ModuleType("pwd")
    _self = _Passwd()

    def getpwuid(uid):
        if int(uid) == _self.pw_uid:
            return _self
        raise KeyError(uid)

    def getpwnam(name):
        if name == _self.pw_name:
            return _self
        raise KeyError(name)

    def getpwall():
        return [_self]

    mod.getpwuid = getpwuid
    mod.getpwnam = getpwnam
    mod.getpwall = getpwall
    sys.modules["pwd"] = mod
    return mod


def install_grp():
    mod = types.ModuleType("grp")
    _self = _Group()

    def getgrgid(gid):
        if int(gid) == _self.gr_gid:
            return _self
        raise KeyError(gid)

    def getgrnam(name):
        if name == _self.gr_name:
            return _self
        raise KeyError(name)

    def getgrall():
        return [_self]

    mod.getgrgid = getgrgid
    mod.getgrnam = getgrnam
    mod.getgrall = getgrall
    sys.modules["grp"] = mod
    return mod


# =====================================================================
# top-level install
# =====================================================================

def install():
    """Install every browser-backed native module. Called by
    browser_bootstrap.install() before the vendored tree imports."""
    install_subprocess()
    install_socket()
    install_fcntl()
    install_termios()
    install_tty()
    install_ptyprocess()
    install_psutil()
    install_resource()
    install_pwd()
    install_grp()
    return True
