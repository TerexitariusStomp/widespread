// claims.test.ts — LIVE tests. Forge-artifact validation hits the real
// GitHub API against the real sandbox repo; attestation tokens use the
// real HMAC path with the test ATTEST_SECRET binding. No mocks.

import { describe, expect, it } from "vitest";
import {
  parseForgeRef, validateForgeSubmission, attestationForMirror,
  verifyAttestation, handleClaimVerify,
} from "../src/claims";
import { realEnv, createIssue, createPr, SANDBOX } from "./helpers";

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

describe("validateForgeSubmission (live GitHub)", () => {
  it("rejects unparseable forgeRef", async () => {
    const { failures } = await validateForgeSubmission(realEnv(), { forgeRef: "bogus" });
    expect(failures[0]).toMatch(/forgeRef must be/);
  });

  it("rejects forgeUserId mismatch against the real issue author", async () => {
    const env = realEnv();
    const issue = await createIssue(env, `claims mismatch probe ${Date.now()}`);
    const { failures, evidence } = await validateForgeSubmission(env, {
      forgeRef: `${SANDBOX.owner}/${SANDBOX.repo}#${issue.number}`,
      forgeUserId: "999999999",
    });
    expect(failures.join()).toMatch(/forgeUserId mismatch/);
    // The real author id is reported back in the failure.
    expect(failures.join()).toContain(String(issue.user.id));
    expect(evidence.forgeUserId).toBe(String(issue.user.id));
  });

  it("enriches evidence with a real patch fingerprint for a real PR", async () => {
    const env = realEnv();
    const pr = await createPr(env, {
      title: `claims evidence PR ${Date.now()}`,
      body: "real diff for fingerprinting",
    });
    const { failures, evidence } = await validateForgeSubmission(env, {
      forgeRef: `https://github.com/${SANDBOX.owner}/${SANDBOX.repo}/pull/${pr.number}`,
    });
    expect(failures).toEqual([]);
    expect(evidence.patch_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evidence.forge).toBe("github");
    expect(evidence.head_sha).toBe(pr.headSha);
    expect(evidence.forgeUserId).toBeTruthy();
    expect(evidence.forgeLogin).toBeTruthy();
  });

  it("fails when the PR diff has no computable patch (binary-only)", async () => {
    const env = realEnv();
    const pr = await createPr(env, {
      title: `claims binary PR ${Date.now()}`,
      binary: true,
    });
    const { failures } = await validateForgeSubmission(env, {
      forgeRef: `https://github.com/${SANDBOX.owner}/${SANDBOX.repo}/pull/${pr.number}`,
    });
    expect(failures.join()).toMatch(/no computable patch/);
  });

  it("surfaces real GitHub errors for missing artifacts", async () => {
    const { failures } = await validateForgeSubmission(realEnv(), {
      forgeRef: `${SANDBOX.owner}/${SANDBOX.repo}#99999999`,
    });
    expect(failures.join()).toMatch(/github 404|not found/i);
  });
});

describe("attestation tokens", () => {
  it("mirror-scoped token round-trips through verifyAttestation", async () => {
    const env = realEnv();
    const token = await attestationForMirror(env, { mirror_id: "m1", claim_hash: "h" });
    expect(token).toBeTruthy();
    const v = await verifyAttestation(env, token!);
    expect(v.valid).toBe(true);
    expect(v.payload?.scope).toBe("mirror");
    expect(v.payload?.mirror_id).toBe("m1");
  });

  it("rejects tampered payload", async () => {
    const env = realEnv();
    const token = (await attestationForMirror(env, { mirror_id: "m1" }))!;
    const forgedBody = btoa(JSON.stringify({ mirror_id: "evil", exp: Date.now() + 1e6 }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const forged = `${forgedBody}.${token.split(".")[1]}`;
    const v = await verifyAttestation(env, forged);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe("bad signature");
  });

  it("rejects expired tokens", async () => {
    const env = realEnv();
    // Craft an expired-but-validly-signed token with the real HMAC path:
    // sign the payload with the same ATTEST_SECRET binding via WebCrypto.
    const payload = { mirror_id: "m1", exp: Date.now() - 1000 };
    const body = btoa(JSON.stringify(payload))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const secret = (env as unknown as Record<string, string>).ATTEST_SECRET;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const sig = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const v = await verifyAttestation(env, `${body}.${sig}`);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe("expired");
  });

  it("handleClaimVerify returns 400 without token", async () => {
    const res = await handleClaimVerify(new URL("https://x/api/claims/verify"), realEnv());
    expect(res.status).toBe(400);
  });
});
