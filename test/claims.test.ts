import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  parseForgeRef, validateForgeSubmission, attestationForMirror,
  verifyAttestation, handleClaimVerify,
} from "../src/claims";
import { fakeEnv, fetchRouter, jsonRes } from "./mock";

const ghIssue = (over: Record<string, unknown> = {}) => ({
  number: 12, state: "open", title: "fix it",
  user: { id: 424242, login: "alice" },
  ...over,
});
const ghPr = (over: Record<string, unknown> = {}) => ({
  ...ghIssue(over),
  pull_request: {}, head: { sha: "a".repeat(40) },
  additions: 10, deletions: 2, changed_files: 1,
});
const ghFiles = [{ filename: "x.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }];

beforeEach(() => vi.unstubAllGlobals());

describe("parseForgeRef", () => {
  it("parses github.com URLs for issues and PRs", () => {
    expect(parseForgeRef("https://github.com/o/r/issues/3"))
      .toEqual({ owner: "o", repo: "r", kind: "issue", number: 3 });
    expect(parseForgeRef("https://github.com/o/r/pull/12"))
      .toEqual({ owner: "o", repo: "r", kind: "pr", number: 12 });
  });
  it("parses shorthand owner/repo#N as issue", () => {
    expect(parseForgeRef("o/r#7")).toEqual({ owner: "o", repo: "r", kind: "issue", number: 7 });
  });
  it("rejects non-github refs", () => {
    expect(parseForgeRef("gitlab.com/o/r/-/issues/1")).toBeNull();
    expect(parseForgeRef("not a ref")).toBeNull();
  });
});

describe("validateForgeSubmission", () => {
  it("rejects unparseable forgeRef", async () => {
    const { failures } = await validateForgeSubmission(fakeEnv(), { forgeRef: "bogus" });
    expect(failures[0]).toMatch(/forgeRef must be/);
  });

  it("rejects forgeUserId mismatch (anti-sybil)", async () => {
    vi.stubGlobal("fetch", fetchRouter([
      ["/issues/12", () => jsonRes(ghIssue())],
    ]));
    const { failures } = await validateForgeSubmission(fakeEnv(), {
      forgeRef: "o/r#12", forgeUserId: "999999",
    });
    expect(failures.join()).toMatch(/forgeUserId mismatch.*424242/);
  });

  it("enriches evidence with patch fingerprint for a real PR", async () => {
    vi.stubGlobal("fetch", fetchRouter([
      ["/issues/12", () => jsonRes(ghPr())],
      ["/pulls/12/files", () => jsonRes(ghFiles)],
    ]));
    const { failures, evidence } = await validateForgeSubmission(fakeEnv(), {
      forgeRef: "https://github.com/o/r/pull/12",
    });
    expect(failures).toEqual([]);
    expect(evidence.patch_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evidence.forgeUserId).toBe("424242");
    expect(evidence.head_sha).toBe("a".repeat(40));
  });

  it("fails when PR diff is empty", async () => {
    vi.stubGlobal("fetch", fetchRouter([
      ["/issues/12", () => jsonRes(ghPr())],
      ["/pulls/12/files", () => jsonRes([{ filename: "x.bin", status: "added" }])],
    ]));
    const { failures } = await validateForgeSubmission(fakeEnv(), {
      forgeRef: "https://github.com/o/r/pull/12",
    });
    expect(failures.join()).toMatch(/no computable patch/);
  });

  it("surfaces github rate-limit errors", async () => {
    vi.stubGlobal("fetch", fetchRouter([
      ["api.github.com", () => new Response("rate limited", { status: 403 })],
    ]));
    const { failures } = await validateForgeSubmission(fakeEnv(), { forgeRef: "o/r#1" });
    expect(failures.join()).toMatch(/rate limited/);
  });
});

describe("attestation tokens", () => {
  it("mirror-scoped token round-trips through verifyAttestation", async () => {
    const env = fakeEnv();
    const token = await attestationForMirror(env, { mirror_id: "m1", claim_hash: "h" });
    expect(token).toBeTruthy();
    const v = await verifyAttestation(env, token!);
    expect(v.valid).toBe(true);
    expect(v.payload?.scope).toBe("mirror");
    expect(v.payload?.mirror_id).toBe("m1");
  });

  it("rejects tampered payload", async () => {
    const env = fakeEnv();
    const token = (await attestationForMirror(env, { mirror_id: "m1" }))!;
    const [body] = token.split(".");
    const forged = `${btoa(JSON.stringify({ mirror_id: "evil", exp: Date.now() + 1e6 })).replace(/=+$/, "")}.${token.split(".")[1]}`;
    expect(forged.split(".")[0]).not.toBe(body);
    const v = await verifyAttestation(env, forged);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe("bad signature");
  });

  it("rejects expired tokens", async () => {
    const env = fakeEnv();
    // craft an expired-but-validly-signed token via the internal path:
    // sign manually with same scheme
    const { createHmac } = await import("node:crypto");
    const payload = { mirror_id: "m1", exp: Date.now() - 1000 };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", "test-attest-secret").update(body).digest("hex");
    const v = await verifyAttestation(env, `${body}.${sig}`);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe("expired");
  });

  it("handleClaimVerify returns 400 without token", async () => {
    const res = await handleClaimVerify(new URL("https://x/api/claims/verify"), fakeEnv());
    expect(res.status).toBe(400);
  });
});
