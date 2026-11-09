"""Unit tests for src/browser_native.py — the browser-backed native modules.

These run under CPython (not Pyodide): a fake `py_gateway` module is injected
into sys.modules so the coincident-proxy calls resolve to scripted responses.
That exercises the REAL Python logic — argv resolution, ENOENT mapping,
pipe draining, DoH parsing, Web Locks flock state, termios bit math — without
a browser. Browser-side behavior (WASIX spawn, relay tunnel, Web Locks) is
covered by the Playwright smoke path.
"""
import base64
import importlib.util
import json
import os
import sys
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "src")


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------- fake gw
class FakeGateway(types.ModuleType):
    """Scripted stand-in for py_gateway's coincident-proxy functions."""

    def __init__(self):
        super().__init__("py_gateway")
        self.calls = []
        self.which_map = {}          # name -> path|None
        self.proc_read_state = {}    # pid -> {'calls': n}
        self.sysinfo = {
            "hardwareConcurrency": 8,
            "deviceMemory": 8,
            "timeOrigin": 1_700_000_000_000.0,
            "jsHeap": {"used": 4 * 1024 * 1024, "total": 0,
                       "limit": 2 * 1024**3},
            "storage": {"quota": 10 * 1024**3, "usage": 1024**3},
        }
        self.doh = {
            ("example.com", 1): [{"name": "example.com", "type": 1,
                                  "data": "93.184.216.34"}],
            ("example.com", 28): [],
            ("v6.example.com", 28): [{"name": "v6.example.com", "type": 28,
                                      "data": "2606:2800:220:1:248:1893:25c8:1946"}],
        }
        self.tcp = {"next": 0, "open_error": None}
        self.flock_state = {}

    # -- wasi ---------------------------------------------------------
    def wasi_call(self, op, args=None, timeout_s=60.0):
        self.calls.append(("wasi", op, args))
        args = args or {}
        if op == "which":
            name = args.get("name", "")
            if name in self.which_map:
                return {"path": self.which_map[name]}
            return {"path": None}
        if op == "spawn":
            self.tcp["next"] += 1
            return {"pid": 1000 + self.tcp["next"]}
        if op == "procWrite":
            return {"ok": True}
        if op == "procStdinClose":
            return {"ok": True}
        if op == "procRead":
            pid = args.get("pid")
            st = self.proc_read_state.setdefault(pid, {"n": 0})
            st["n"] += 1
            if st["n"] == 1:
                return {"data": base64.b64encode(b"hello\n").decode(),
                        "eof": True}
            return {"data": "", "eof": True}
        if op in ("procWait",):
            return {"running": False, "exit_code": 0}
        if op == "procPoll":
            return {"running": False, "exit_code": 0}
        if op in ("procKill", "procTerminate", "procResize"):
            return {"ok": True}
        return {"error": f"unexpected op {op}"}

    # -- fetch ----------------------------------------------------------
    def fetch_blocking(self, url, method, headers, body_b64, timeout_s=30.0):
        self.calls.append(("fetch", url))
        if "dns-query" in url:
            from urllib.parse import urlparse, parse_qs
            q = parse_qs(urlparse(url).query)
            name, qtype = q["name"][0], int(q["type"][0])
            answers = self.doh.get((name, qtype), [])
            payload = {"Status": 0, "Answer": answers}
            return {"status": 200, "headers": {},
                    "body": base64.b64encode(json.dumps(payload).encode()).decode()}
        return {"error": "unexpected fetch " + url}

    # -- sys ------------------------------------------------------------
    def sys_request(self, op, args=None, timeout_s=30.0):
        self.calls.append(("sys", op))
        return dict(self.sysinfo)

    # -- flock ------------------------------------------------------------
    def flock_request(self, path, mode, blocking=True):
        self.calls.append(("flock_req", path, mode, blocking))
        if path in self.flock_state:
            return {"ok": False, "busy": True}
        self.flock_state[path] = mode
        return {"ok": True}

    def flock_release(self, path):
        self.calls.append(("flock_rel", path))
        self.flock_state.pop(path, None)
        return {"ok": True}

    # -- tcp ---------------------------------------------------------------
    def tcp_open(self, host, port):
        self.calls.append(("tcp_open", host, port))
        if self.tcp["open_error"]:
            return self.tcp["open_error"]
        self.tcp["next"] += 1
        return {"id": f"t{self.tcp['next']}"}

    def tcp_send(self, tid, data):
        self.calls.append(("tcp_send", tid, data))
        return {"ok": True}

    def tcp_recv(self, tid, timeout_ms=30000):
        self.calls.append(("tcp_recv", tid, timeout_ms))
        return {"eof": True}

    def tcp_close(self, tid):
        self.calls.append(("tcp_close", tid))
        return {"ok": True}


GW = FakeGateway()
sys.modules["py_gateway"] = GW
BN = _load("browser_native", os.path.join(SRC, "browser_native.py"))


class SubprocessTests(unittest.TestCase):
    def setUp(self):
        import subprocess
        BN.install_subprocess()
        self.sp = subprocess

    def test_run_captures_stdout_and_exit_code(self):
        GW.which_map["ls"] = "/usr/bin/ls"
        r = self.sp.run(["ls"], capture_output=True)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout, b"hello\n")
        # which was consulted before spawn — real ENOENT data path.
        self.assertTrue(any(c[0] == "wasi" and c[1] == "which" for c in GW.calls))

    def test_missing_command_raises_enoent(self):
        with self.assertRaises(FileNotFoundError) as cm:
            self.sp.run(["definitely-not-a-real-binary-xyz"])
        self.assertEqual(cm.exception.errno, 2)

    def test_shell_uses_shell_spawn(self):
        GW.which_map.clear()
        r = self.sp.run("echo hi", shell=True, capture_output=True)
        self.assertEqual(r.returncode, 0)
        spawn = [c for c in GW.calls if c[0] == "wasi" and c[1] == "spawn"]
        self.assertEqual(spawn[-1][2]["command"], "echo hi")

    def test_stdin_pipe_and_text_mode(self):
        GW.which_map["cat"] = "/bin/cat"
        r = self.sp.run(["cat"], input="ping", capture_output=True, text=True)
        self.assertEqual(r.stdout, "hello\n")  # fake ignores stdin content
        self.assertIsInstance(r.stdout, str)


class SocketTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        BN.install_socket()

    def test_getaddrinfo_resolves_a_record(self):
        import socket
        infos = socket.getaddrinfo("example.com", 80, socket.AF_INET,
                                   socket.SOCK_STREAM)
        self.assertTrue(infos)
        fam, _, _, _, sa = infos[0]
        self.assertEqual(fam, socket.AF_INET)
        self.assertEqual(sa[0], "93.184.216.34")
        self.assertEqual(sa[1], 80)

    def test_connect_tunnels_and_recv_eof(self):
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.connect(("example.com", 80))
        self.assertEqual(s.getpeername(), ("93.184.216.34", 80))
        s.sendall(b"GET / HTTP/1.0\r\n\r\n")
        self.assertEqual(s.recv(1024), b"")  # fake tunnel reports eof
        s.close()
        self.assertTrue(s.closed)

    def test_connect_ex_returns_errno(self):
        import socket
        GW.tcp["open_error"] = {"error": "tcp_refused"}
        s = socket.socket()
        self.assertNotEqual(s.connect_ex(("example.com", 80)), 0)
        GW.tcp["open_error"] = None

    def test_bind_listen_accept_eopnotsupp(self):
        import socket
        s = socket.socket()
        for fn in (s.bind, s.listen, s.accept):
            with self.assertRaises(OSError):
                fn(("0.0.0.0", 0)) if fn is s.bind else fn(1) if fn is s.listen else fn()

    def test_unknown_host_gaierror(self):
        import socket
        with self.assertRaises(socket.gaierror):
            socket.getaddrinfo("no-such-host.invalid", 80)


class FcntlTests(unittest.TestCase):
    def setUp(self):
        BN.install_fcntl()
        self.fcntl = sys.modules["fcntl"]

    def test_flock_exclusive_and_release(self):
        r, w = os.pipe()
        try:
            self.fcntl.flock(r, self.fcntl.LOCK_EX | self.fcntl.LOCK_NB)
            self.fcntl.flock(r, self.fcntl.LOCK_UN)
            self.assertIn(("flock_rel",), [c[:1] for c in GW.calls])
        finally:
            os.close(r)
            os.close(w)

    def test_lockf_test_and_ulock(self):
        r, w = os.pipe()
        try:
            self.fcntl.lockf(r, self.fcntl.F_LOCK)
            self.fcntl.lockf(r, self.fcntl.F_ULOCK)
        finally:
            os.close(r)
            os.close(w)

    def test_ioctl_rejects_non_pty_fd(self):
        r, w = os.pipe()
        try:
            with self.assertRaises(OSError):
                self.fcntl.ioctl(r, self.fcntl.TIOCSWINSZ, b"\x18\x00\x50\x00\x00\x00\x00\x00")
        finally:
            os.close(r)
            os.close(w)


class PsutilTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        BN.install_psutil()
        cls.psutil = sys.modules["psutil"]

    def test_cpu_count_real(self):
        self.assertEqual(self.psutil.cpu_count(), 8)

    def test_virtual_memory_real_values(self):
        vm = self.psutil.virtual_memory()
        self.assertGreater(vm.total, 0)
        self.assertGreater(vm.used, 0)
        self.assertGreaterEqual(vm.percent, 0.0)

    def test_disk_usage_and_boot_time(self):
        du = self.psutil.disk_usage("/")
        self.assertEqual(du.total, 10 * 1024**3)
        self.assertGreaterEqual(self.psutil.boot_time(), 1_700_000_000)

    def test_pid_exists_only_self(self):
        self.assertTrue(self.psutil.pid_exists(os.getpid()))
        self.assertFalse(self.psutil.pid_exists(999999))
        p = self.psutil.Process()
        self.assertEqual(p.pid, os.getpid())
        self.assertGreater(p.memory_info().rss, 0)
        with self.assertRaises(self.psutil.NoSuchProcess):
            self.psutil.Process(424242)


class MiscModuleTests(unittest.TestCase):
    def test_termios_cfmakeraw_and_attrs(self):
        BN.install_termios()
        t = sys.modules["termios"]
        attrs = t.tcgetattr(0)
        raw = t.cfmakeraw(attrs)
        self.assertFalse(raw[3] & t.ECHO)
        self.assertFalse(raw[3] & t.ICANON)
        self.assertEqual(raw[2] & t.CSIZE, t.CS8)
        t.tcsetattr(0, t.TCSANOW, raw)
        self.assertEqual(t.tcgetattr(0)[3] & t.ECHO, 0)

    def test_tty_setraw(self):
        BN.install_tty()
        tty = sys.modules["tty"]
        tty.setraw(0)
        import termios
        self.assertFalse(termios.tcgetattr(0)[3] & termios.ECHO)

    def test_resource_getrusage(self):
        BN.install_resource()
        r = sys.modules["resource"]
        ru = r.getrusage(r.RUSAGE_SELF)
        self.assertGreaterEqual(ru.ru_utime, 0.0)
        self.assertGreater(ru.ru_maxrss, 0)

    def test_pwd_grp_session_identity(self):
        BN.install_pwd()
        BN.install_grp()
        import pwd, grp
        me = pwd.getpwuid(os.getuid() if hasattr(os, "getuid") else 0)
        self.assertTrue(me.pw_name)
        self.assertEqual(pwd.getpwnam(me.pw_name).pw_uid, me.pw_uid)
        g = grp.getgrgid(me.pw_gid)
        self.assertEqual(g.gr_name, me.pw_name)


if __name__ == "__main__":
    unittest.main()
