"""browser_bootstrap.py — runs inside Pyodide BEFORE importing tui_gateway.

Our code, living outside the vendored tree (per the minimal-diff constraint):
stubs native-only modules so upstream files import unmodified, points
HERMES_HOME at the browser FS, and installs the vault-mediated httpx
transport so model calls leave via fetch — keys never enter this heap.
"""
import os
import sys

# --- 1. HERMES_HOME → in-browser FS --------------------------------------
# MEMFS for the spike; swapped for an OPFS-backed mount once we persist.
os.environ.setdefault("HERMES_HOME", "/hermes-home")
os.environ["HERMES_BROWSER"] = "1"            # our own signal for the plugin layer
os.environ.setdefault("HERMES_SKIP_UPDATE_CHECKS", "1")
os.makedirs(os.environ["HERMES_HOME"], exist_ok=True)

# stdin: no TTY in a browser worker. EOF immediately so interactive prompts
# (input()/sys.stdin.read) raise EOFError instead of spinning on EAGAIN.
import io  # noqa: E402


class _EOFStdin(io.StringIO):
    def isatty(self):
        return False

    def readable(self):
        return True

    def read(self, *a):
        return ""

    def readline(self, *a):
        return ""


sys.stdin = _EOFStdin("")

# --- 2. Native-module implementations -------------------------------------
def _install_native_stubs():
    """Install real browser-backed native modules (see browser_native.py).

    Dispositions, verified against the pinned Pyodide 0.28.3 lock and the
    vendored upstream tree:

    IMPLEMENTED (real): subprocess (WASIX userspace), socket (DoH + relay
    TCP tunnel), fcntl (Web Locks), psutil (navigator/performance/storage),
    resource (performance timers), pwd/grp (session identity),
    termios/tty (attr store + winsize plumbing), ptyprocess (WASIX terminal
    spawn behind a registered fd).

    DELETED — Pyodide ships them (rule a): mmap, PIL/Pillow (env wheel).

    DELETED — upstream only touches them behind guards or on platforms we
    are not (rule b): pty (evals/tests only), pexpect (tests only),
    nemo_relay (lazy optional import), pillow_heif (guarded optional),
    winpty/pywinpty (Windows-only ConPTY path), readline (no production
    imports — prompt_toolkit is self-contained).
    """
    import browser_native

    browser_native.install()


# --- 3. Vault-mediated httpx transport ------------------------------------
def _install_http_transport():
    """Model calls route through the page: the Python side hands the request
    to the worker bridge, which Atomics-waits while the page resolves
    vault: grant handles into real credentials and performs fetch().

    Response bodies are buffered (no incremental SSE streaming in v1 — the
    bytes are complete and the model SDK still parses them; incremental
    streaming needs the chunked ring extension)."""
    try:
        import httpx  # noqa: F401
    except ImportError:
        return

    class _BufferedStream(httpx.SyncByteStream):
        def __init__(self, data: bytes):
            self._data = data

        def __iter__(self):
            if self._data:
                yield self._data
            self._data = b""

    def _vault_request(request):
        import base64

        import py_gateway

        body_b64 = base64.b64encode(request.content).decode() if request.content else None
        resp = py_gateway.fetch_blocking(
            str(request.url), request.method,
            {k: v for k, v in request.headers.items()}, body_b64)
        status = int(resp.get("status") or 599)
        raw = base64.b64decode(resp.get("body") or "")
        if resp.get("error"):
            raise httpx.TransportError(str(resp["error"]), request=request)
        return httpx.Response(status, headers=resp.get("headers") or {},
                              stream=_BufferedStream(raw), request=request)

    class BrowserFetchTransport(httpx.BaseTransport):
        def handle_request(self, request):  # sync httpx; worker blocks on SAB
            return _vault_request(request)

    # The real choke point is the default transport class itself: upstream
    # build_keepalive_http_client passes an explicit shared
    # httpx.HTTPTransport into httpx.Client and the openai SDK, so a
    # Client-subclass setdefault("transport") is bypassed. Patch
    # HTTPTransport.handle_request (and the async twin) so every transport —
    # shared, per-client, or default — routes through vault.
    async def _vault_async(self, request):
        # Atomics.wait inside a coroutine serializes the wasm loop, but the
        # fetch resolves on the page thread — same blocking shape as sync.
        return _vault_request(request)

    # Patch through httpx._transports' re-exported names, not a submodule:
    # on Emscripten HTTPTransport aliases jsfetch.JavascriptFetchTransport
    # (the default.py module is never imported), on every other platform it
    # is HTTPCoreTransport — patching the alias covers both.
    try:
        import httpx._transports as _httpx_transports
    except ImportError:
        _httpx_transports = None
    if _httpx_transports is not None:
        _httpx_transports.HTTPTransport.handle_request = (
            lambda self, request: _vault_request(request))
        _httpx_transports.AsyncHTTPTransport.handle_async_request = _vault_async

    _orig = httpx.Client

    class VaultClient(_orig):
        def __init__(self, *a, **k):
            k.setdefault("transport", BrowserFetchTransport())
            super().__init__(*a, **k)

    httpx.Client = VaultClient

    # urllib3 is patched at urlopen, the single choke point requests'
    # HTTPAdapter.send and direct PoolManager users both funnel through.
    # On Emscripten urllib3's contrib backend falls back to a synchronous
    # XMLHttpRequest — a JS-level block no Python interrupt can reach —
    # and either way it bypasses vault mediation. Route it through the
    # same page-side fetch as httpx.
    try:
        import urllib3.connectionpool as _ucp
        import urllib3.response as _ures
        from urllib3._collections import HTTPHeaderDict as _HHD
    except ImportError:
        return

    def _timeout_s(timeout, default=120.0):
        if timeout is None:
            return default
        for attr in ("read_timeout", "total"):
            v = getattr(timeout, attr, None)
            if isinstance(v, (int, float)) and v:
                return float(v)
        if isinstance(timeout, (int, float)):
            return float(timeout)
        return default

    def _vault_urlopen(self, method, url, body=None, headers=None,
                       retries=None, redirect=True, assert_same_host=True,
                       timeout=None, pool_timeout=None, release_conn=None,
                       chunked=False, body_pos=None, preload_content=True,
                       decode_content=True, **response_kw):
        import base64
        import urllib.parse

        import py_gateway

        if not urllib.parse.urlsplit(str(url)).scheme:
            host = self.host if self.port in (None, 80, 443) else f"{self.host}:{self.port}"
            url = f"{self.scheme}://{host}{url}"
        if isinstance(body, str):
            body = body.encode()
        body_b64 = base64.b64encode(body).decode() if body else None
        resp = py_gateway.fetch_blocking(
            str(url), str(method).upper(), dict(headers or {}), body_b64,
            timeout_s=_timeout_s(timeout))
        raw = base64.b64decode(resp.get("body") or "")
        if resp.get("error"):
            raise OSError(f"vault fetch failed: {resp['error']}")
        return _ures.HTTPResponse(
            body=raw, status=int(resp.get("status") or 599),
            headers=_HHD(resp.get("headers") or {}), reason=None,
            preload_content=False, decode_content=False,
            original_response=None, request_method=str(method),
            request_url=str(url), version=11,
            enforce_content_length=False)

    _ucp.HTTPConnectionPool.urlopen = _vault_urlopen

    # Third stdlib transport: urllib.request.urlopen / OpenerDirector.open go
    # through http.client -> raw socket. Route them through the same vault
    # fetch; HTTP semantics (error raise, addinfourl shape) are preserved.
    try:
        import email.message
        import urllib.error
        import urllib.request as _urq
        import urllib.response
    except ImportError:
        return

    def _vault_urllib_open(url, data=None, timeout=None):
        import base64
        import io

        import py_gateway

        is_req = hasattr(url, "full_url")
        full = url.full_url if is_req else str(url)
        method = (url.get_method() if is_req else None) or ("POST" if data else "GET")
        headers = dict(getattr(url, "headers", {}) or {})
        if data is None and is_req:
            data = getattr(url, "data", None)
        if isinstance(data, str):
            data = data.encode()
        body_b64 = base64.b64encode(data).decode() if data else None
        resp = py_gateway.fetch_blocking(
            full, method, headers, body_b64,
            timeout_s=float(timeout) if isinstance(timeout, (int, float)) else 120.0)
        if resp.get("error"):
            raise urllib.error.URLError(resp["error"])
        status = int(resp.get("status") or 599)
        msg = email.message.Message()
        for hk, hv in (resp.get("headers") or {}).items():
            msg[hk] = hv
        fp = urllib.response.addinfourl(io.BytesIO(base64.b64decode(resp.get("body") or "")),
                                      msg, full, code=status)
        fp.status = status
        if status >= 400:
            raise urllib.error.HTTPError(full, status, "", msg, fp)
        return fp

    _urq.urlopen = _vault_urllib_open
    _urq.OpenerDirector.open = lambda self, url, data=None, timeout=None: _vault_urllib_open(url, data, timeout)


def _install_exit_guards():
    """os._exit -> proc_exit under wasm = silent process death. Raise instead
    so exit paths surface as catchable errors during bring-up."""
    def _no_exit(code=0):
        raise SystemExit(f"os._exit({code}) intercepted in browser runtime")
    os._exit = _no_exit
    os.abort = lambda: (_ for _ in ()).throw(RuntimeError("os.abort intercepted"))


def install():
    _install_exit_guards()
    _install_native_stubs()
    _install_http_transport()
    sys.path.insert(0, "/hermes-py")  # unpacked vendored tree
    return True
