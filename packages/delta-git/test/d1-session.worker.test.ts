import { env, exports as workerExports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  D1_BOOKMARK_COOKIE_MAX_AGE_SECONDS,
  D1_BOOKMARK_COOKIE_HEADER_NAME,
  D1_BOOKMARK_HEADER,
  parseBookmarkCookie,
} from "./util/d1Bookmark";
import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests } from "./util/repoSeed";

// The D1 Sessions middleware decision is observed through a pass-through
// wrapper installed directly on `env.DB.withSession`. The wrapper records
// the chosen anchor and delegates EVERY call to the real D1 session —
// no query is intercepted, no result is fabricated, and bookmarks are the
// real Lamport tokens workerd's local D1 issues. This is observability
// ("which anchor did the middleware pick?"), not a service fake: deleting
// the wrapper changes nothing about what D1 serves.
//
// `D1SessionBookmark` and `D1SessionConstraint` are global ambient types
// from `worker-configuration.d.ts`. `undefined` is included to match the
// original signature shape even though the middleware always passes a
// concrete value.
type D1SessionAnchor = D1SessionBookmark | D1SessionConstraint | undefined;

type Instrumentation = {
  readonly anchors: ReadonlyArray<D1SessionAnchor>;
  readonly sessionPrepareCalls: number;
  readonly getBookmarkCalls: number;
  reset(): void;
  restore(): void;
};

function instrumentSessions(): Instrumentation {
  const anchors: D1SessionAnchor[] = [];
  let sessionPrepareCalls = 0;
  let getBookmarkCalls = 0;
  const db = env.DB;
  const originalWithSession = db.withSession;

  db.withSession = function wrappedWithSession(anchor?: D1SessionBookmark | D1SessionConstraint) {
    anchors.push(anchor);
    const session = originalWithSession.call(db, anchor);
    const wrapped: D1DatabaseSession = {
      prepare(query) {
        sessionPrepareCalls += 1;
        return session.prepare(query);
      },
      batch<T = unknown>(statements: D1PreparedStatement[]) {
        return session.batch<T>(statements);
      },
      getBookmark() {
        getBookmarkCalls += 1;
        return session.getBookmark();
      },
    };
    return wrapped;
  };

  return {
    get anchors() {
      return anchors;
    },
    get sessionPrepareCalls() {
      return sessionPrepareCalls;
    },
    get getBookmarkCalls() {
      return getBookmarkCalls;
    },
    reset() {
      anchors.length = 0;
      sessionPrepareCalls = 0;
      getBookmarkCalls = 0;
    },
    restore() {
      db.withSession = originalWithSession;
    },
  };
}

beforeAll(async () => {
  await ensureD1Migrations(env);
});

let activeInstrumentation: Instrumentation | null = null;

afterEach(() => {
  activeInstrumentation?.restore();
  activeInstrumentation = null;
});

function instrument(): Instrumentation {
  const handle = instrumentSessions();
  activeInstrumentation = handle;
  return handle;
}

const ALWAYS_PRIMARY = "first-primary";
const ALWAYS_REPLICA = "first-unconstrained";
// D1 bookmarks are 59-char Lamport tokens (`8-8-8-32` hex groups).
const BOOKMARK_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}$/;

describe("D1 Sessions middleware", () => {
  it("opens exactly one session per request and routes c.var.db through it", async () => {
    const owner = `sess-owner-${Math.random().toString(36).slice(2, 8)}`;
    await setupRepoForTests(env, owner, "repo");
    const probe = instrument();

    // Post-cutover `/${owner}` is a static SPA route that never touches D1,
    // so the probe goes through the gitness facade repo lookup instead —
    // it runs `findNamespaceBySlug` + repository queries through `c.var.db`.
    const res = await workerExports.default.fetch(
      `https://example.com/api/v1/repos/${owner}/repo/+`
    );
    expect(res.status).toBe(200);
    expect(probe.anchors).toHaveLength(1);
    // The wrapped session sees prepares. If the middleware had used `env.DB`
    // directly, the counter would still be zero.
    expect(probe.sessionPrepareCalls).toBeGreaterThan(0);
    expect(probe.getBookmarkCalls).toBe(1);
  });

  it("anchors anonymous GET on first-unconstrained when no bookmark is present", async () => {
    const owner = `sess-anon-${Math.random().toString(36).slice(2, 8)}`;
    await setupRepoForTests(env, owner, "repo");
    const probe = instrument();

    await workerExports.default.fetch(`https://example.com/${owner}`);
    expect(probe.anchors[0]).toBe(ALWAYS_REPLICA);
  });

  it("anchors generic POST on first-primary", async () => {
    const probe = instrument();
    // No session cookie; the route returns 401 inside the handler. The
    // middleware decision is captured before the handler runs.
    const res = await workerExports.default.fetch("https://example.com/auth/api/repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://example.com" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(probe.anchors[0]).toBe(ALWAYS_PRIMARY);
  });

  it("anchors POST /:owner/:repo/git-upload-pack on first-unconstrained (read-shaped POST)", async () => {
    const owner = `sess-up-${Math.random().toString(36).slice(2, 8)}`;
    const repo = "repo";
    await setupRepoForTests(env, owner, repo);
    const probe = instrument();

    const res = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/git-upload-pack`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-git-upload-pack-request",
          "Git-Protocol": "version=2",
        },
        body: new Uint8Array([]),
      }
    );
    // 400 because the body has no command; we only care that the
    // middleware classified this route correctly.
    expect(res.status).toBe(400);
    expect(probe.anchors[0]).toBe(ALWAYS_REPLICA);
  });

  it("anchors POST /:owner/:repo/git-receive-pack on first-primary (write-shaped POST)", async () => {
    const owner = `sess-rcv-${Math.random().toString(36).slice(2, 8)}`;
    const repo = "repo";
    await setupRepoForTests(env, owner, repo);
    const probe = instrument();

    const res = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/git-receive-pack`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-git-receive-pack-request" },
        body: new Uint8Array([]),
      }
    );
    // Without push credentials the route 401-challenges; that still
    // means the middleware classified the path first.
    expect(res.status).toBe(401);
    expect(probe.anchors[0]).toBe(ALWAYS_PRIMARY);
  });

  it("anchors GET /auth/callback on first-primary (write-shaped GET)", async () => {
    const probe = instrument();
    const res = await workerExports.default.fetch(
      "https://example.com/auth/callback?code=&state=",
      { redirect: "manual" }
    );
    // Missing transaction cookie -> redirect to /auth with error. The
    // middleware decision still fired.
    expect(res.status).toBe(302);
    expect(probe.anchors[0]).toBe(ALWAYS_PRIMARY);
  });

  it("anchors GET /auth/callback/ (trailing slash) on first-primary", async () => {
    // Hono's `strict: false` normalizes the trailing slash before our
    // middleware sees `c.req.path`. The defensive normalize in the
    // selector backs that up so the classification still holds if the
    // option is ever flipped.
    const probe = instrument();
    const res = await workerExports.default.fetch(
      "https://example.com/auth/callback/?code=&state=",
      { redirect: "manual" }
    );
    expect(res.status).toBe(302);
    expect(probe.anchors[0]).toBe(ALWAYS_PRIMARY);
  });

  it("honors inbound header bookmark on a read-like request", async () => {
    const owner = `sess-hdr-${Math.random().toString(36).slice(2, 8)}`;
    await setupRepoForTests(env, owner, "repo");
    const probe = instrument();

    await workerExports.default.fetch(`https://example.com/${owner}`, {
      headers: { [D1_BOOKMARK_HEADER]: "probe-bookmark-aaa" },
    });
    expect(probe.anchors[0]).toBe("probe-bookmark-aaa");
  });

  it("honors inbound cookie bookmark on a read-like request", async () => {
    const owner = `sess-ckie-${Math.random().toString(36).slice(2, 8)}`;
    await setupRepoForTests(env, owner, "repo");
    const probe = instrument();

    await workerExports.default.fetch(`https://example.com/${owner}`, {
      headers: {
        Cookie: `${D1_BOOKMARK_COOKIE_HEADER_NAME}=${encodeURIComponent("probe-bookmark-bbb")}`,
      },
    });
    expect(probe.anchors[0]).toBe("probe-bookmark-bbb");
  });

  it("prefers the inbound header over the inbound cookie", async () => {
    const owner = `sess-pref-${Math.random().toString(36).slice(2, 8)}`;
    await setupRepoForTests(env, owner, "repo");
    const probe = instrument();

    await workerExports.default.fetch(`https://example.com/${owner}`, {
      headers: {
        [D1_BOOKMARK_HEADER]: "header-wins",
        Cookie: `${D1_BOOKMARK_COOKIE_HEADER_NAME}=${encodeURIComponent("cookie-loses")}`,
      },
    });
    expect(probe.anchors[0]).toBe("header-wins");
  });

  it("ignores inbound bookmark on a mutating request", async () => {
    const probe = instrument();
    const res = await workerExports.default.fetch("https://example.com/auth/api/repositories", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://example.com",
        [D1_BOOKMARK_HEADER]: "should-be-ignored",
        Cookie: `${D1_BOOKMARK_COOKIE_HEADER_NAME}=${encodeURIComponent("also-ignored")}`,
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(probe.anchors[0]).toBe(ALWAYS_PRIMARY);
  });

  it("emits header + cookie carrying the real advanced bookmark", async () => {
    const owner = `sess-emit-${Math.random().toString(36).slice(2, 8)}`;
    await setupRepoForTests(env, owner, "repo");
    const probe = instrument();

    const res = await workerExports.default.fetch(
      `https://example.com/api/v1/repos/${owner}/repo/+`
    );
    expect(res.status).toBe(200);
    expect(probe.anchors[0]).toBe(ALWAYS_REPLICA);
    // The emitted bookmark is the real Lamport token the session's
    // getBookmark() returned — local D1 issues genuine bookmarks.
    const emitted = res.headers.get(D1_BOOKMARK_HEADER);
    expect(emitted).toMatch(BOOKMARK_PATTERN);
    const cookie = parseBookmarkCookie(res.headers.get("set-cookie"));
    expect(cookie?.value).toBe(emitted);
    expect(cookie?.attributes.Path).toBe("/");
    expect(cookie?.attributes.HttpOnly).toBe(true);
    expect(cookie?.attributes.Secure).toBe(true);
    expect(cookie?.attributes.SameSite).toBe("Lax");
    expect(cookie?.attributes["Max-Age"]).toBe(String(D1_BOOKMARK_COOKIE_MAX_AGE_SECONDS));
  });

  it("does not emit when the route never touches D1", async () => {
    // Anonymous `GET /` calls `loadViewer` which short-circuits before
    // hitting D1 because there is no session cookie. The session opens
    // but no queries run and `getBookmark()` returns null.
    const probe = instrument();
    const res = await workerExports.default.fetch("https://example.com/");
    expect(res.status).toBe(200);
    expect(probe.anchors).toHaveLength(1);
    expect(probe.sessionPrepareCalls).toBe(0);
    expect(res.headers.get(D1_BOOKMARK_HEADER)).toBeNull();
    expect(parseBookmarkCookie(res.headers.get("set-cookie"))).toBeNull();
  });

  it("does not emit when the outbound bookmark equals the inbound bookmark", async () => {
    // A session anchored at a bookmark D1 cannot resolve echoes that
    // bookmark back from getBookmark(), so inbound === outbound and the
    // emitter correctly suppresses header/cookie churn.
    const probe = instrument();
    const res = await workerExports.default.fetch("https://example.com/", {
      headers: { [D1_BOOKMARK_HEADER]: "unresolvable-bookmark-zzz" },
    });
    expect(res.status).toBe(200);
    expect(probe.anchors[0]).toBe("unresolvable-bookmark-zzz");
    expect(res.headers.get(D1_BOOKMARK_HEADER)).toBeNull();
    expect(parseBookmarkCookie(res.headers.get("set-cookie"))).toBeNull();
  });

  it("rejects malformed inbound bookmark values and falls back to the default anchor", async () => {
    const probe = instrument();
    // Control character in the header -> rejected; cookie is honored
    // because it survives the sanitizer.
    await workerExports.default.fetch("https://example.com/", {
      headers: {
        [D1_BOOKMARK_HEADER]: "bad\x01value",
        Cookie: `${D1_BOOKMARK_COOKIE_HEADER_NAME}=${encodeURIComponent("fallback-cookie")}`,
      },
    });
    expect(probe.anchors[0]).toBe("fallback-cookie");
  });

  it("rejects oversize inbound bookmark and falls back to first-unconstrained", async () => {
    const probe = instrument();
    // D1 bookmarks are 59-char Lamport tokens (`8-8-8-32` hex). The cap is
    // 256 chars to leave headroom for format evolution; anything past
    // that is rejected as transport-malformed.
    const oversized = "a".repeat(257);
    await workerExports.default.fetch("https://example.com/", {
      headers: { [D1_BOOKMARK_HEADER]: oversized },
    });
    expect(probe.anchors[0]).toBe(ALWAYS_REPLICA);
  });

  it("round-trips a real bookmark from a write to a follow-up read", async () => {
    // The write half: POST /api/agents performs a real D1 insert, so the
    // primary-anchored session's getBookmark() returns a genuine advanced
    // bookmark that the middleware emits as header + cookie.
    const pubkey = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const writeRes = await workerExports.default.fetch("https://example.com/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pubkey, label: `sess-rt-${Date.now().toString(36)}` }),
    });
    expect(writeRes.status).toBe(200);
    const issuedBookmark = writeRes.headers.get(D1_BOOKMARK_HEADER);
    expect(issuedBookmark).toMatch(BOOKMARK_PATTERN);
    const cookie = parseBookmarkCookie(writeRes.headers.get("set-cookie"));
    expect(cookie?.value).toBe(issuedBookmark);

    // The read half: the browser would echo the cookie on the next
    // navigation. A read-like request consumes it as the session anchor.
    const owner = `sess-rt-${Math.random().toString(36).slice(2, 8)}`;
    await setupRepoForTests(env, owner, "repo");
    const readProbe = instrument();
    await workerExports.default.fetch(`https://example.com/${owner}`, {
      headers: {
        Cookie: `${D1_BOOKMARK_COOKIE_HEADER_NAME}=${encodeURIComponent(issuedBookmark!)}`,
      },
    });
    expect(readProbe.anchors[0]).toBe(issuedBookmark);
  });
});
