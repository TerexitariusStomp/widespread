// ingest.test.ts — LIVE scanMirrorSubmissions against real GitHub + real KV.
// Each run creates a REAL issue and a REAL PR (whose body references the
// issue, producing a real cross-referenced timeline event) in the sandbox
// repo, seeds the real feed doc + fiatfund record in real KV, then lets
// the scanner do its real GitHub timeline → forge-validation → claim-file
// pass. Nothing is stubbed; GitHub's timeline propagation is awaited with
// a bounded poll.

import { describe, expect, it } from "vitest";
import { scanMirrorSubmissions } from "../src/ingest";
import {
  realEnv, createIssue, createPr, seedFeedDoc, sandboxMirror, SANDBOX,
} from "./helpers";
import { ghHeaders, GH_API } from "../src/forge";
import type { Env } from "../src/types";
import type { MirrorListing } from "../src/types";

const env = () => realEnv();

interface TimelineEvent {
  event?: string;
  source?: { issue?: { number?: number; pull_request?: unknown; state?: string } };
}

async function ghGet<T>(path: string): Promise<T> {
  const res = await fetch(`${GH_API}${path}`, { headers: ghHeaders(env()) });
  if (!res.ok) throw new Error(`github GET ${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** Wait until GitHub materializes the cross-referenced timeline event for
 * the issue — propagation is usually instant but can lag a few seconds. */
async function waitForCrossRef(issueNumber: number, prNumber: number): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const events = await ghGet<TimelineEvent[]>(
      `/repos/${SANDBOX.owner}/${SANDBOX.repo}/issues/${issueNumber}/timeline?per_page=100`);
    const hit = events.some((e) =>
      e.event === "cross-referenced" && e.source?.issue?.number === prNumber
      && e.source.issue.pull_request && e.source.issue.state === "open");
    if (hit) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`cross-referenced event for PR #${prNumber} never appeared on issue #${issueNumber}`);
}

/** Build the full live fixture: real issue + real referencing PR + real
 * feed-doc mirror + real fiatfund KV record. Returns the mirror + claim
 * prefix parts for assertions. */
async function liveFixture(opts: { fund?: boolean } = {}): Promise<{
  mirror: MirrorListing; mirrorId: string; issueNumber: number; prNumber: number;
}> {
  const e = env();
  const stamp = Date.now().toString(36);
  const issue = await createIssue(e, `ingest fixture issue ${stamp}`,
    "Sandbox issue that a PR will reference — used by ingest.test.ts.");
  const pr = await createPr(e, {
    title: `ingest fixture PR ${stamp}`,
    body: `Refs ${SANDBOX.owner}/${SANDBOX.repo}#${issue.number}`,
  });
  await waitForCrossRef(issue.number, pr.number);

  const recordId = `github-thirdparty:generic:${SANDBOX.owner}/${SANDBOX.repo}#${issue.number}`;
  const mirror = sandboxMirror({
    recordId,
    title: `ingest fixture bounty ${stamp}`,
    estUsd: 10,
  });
  mirror.id = `mirror:ingest-test:${stamp}`; // unique KV namespace per run
  await seedFeedDoc(e, [], [mirror]);
  if (opts.fund !== false) {
    await e.CLAIMS.put(`fiatfund:${mirror.id}`, JSON.stringify({
      mirror_id: mirror.id, order_id: `O-${stamp}`, amount: "10",
      currency: "USD", status: "captured", created_at: Date.now(),
    }));
  }
  return { mirror, mirrorId: mirror.id, issueNumber: issue.number, prNumber: pr.number };
}

async function filedClaims(mirrorId: string) {
  const e = env();
  const out: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  do {
    const page = await e.CLAIMS.list({ prefix: `mclaim:${mirrorId}:`, cursor, limit: 100 });
    for (const k of page.keys) {
      const v = await e.CLAIMS.get(k.name);
      if (v) out.push(JSON.parse(v) as Record<string, unknown>);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

describe("scanMirrorSubmissions (live GitHub + live KV)", () => {
  it("files an attested auto-ingested claim for a real cross-referenced PR", async () => {
    const { mirrorId, prNumber } = await liveFixture();
    const r = await scanMirrorSubmissions(env());
    expect(r.errors).toEqual([]);
    expect(r.claims_filed).toBeGreaterThanOrEqual(1);

    const claims = await filedClaims(mirrorId);
    expect(claims).toHaveLength(1);
    const claim = claims[0] as {
      auto_ingested?: boolean; attested?: boolean; payout?: unknown;
      forgeRef?: string; status?: string;
    };
    expect(claim.auto_ingested).toBe(true);
    expect(claim.attested).toBe(true);
    expect(claim.payout).toBeNull(); // winner supplies address at verdict
    expect(claim.forgeRef).toContain(`/pull/${prNumber}`);
    expect(claim.status).toBe("pending");
  }, 120000);

  it("dedupes: a second scan files nothing new", async () => {
    const { mirrorId } = await liveFixture();
    const e = env();
    const r1 = await scanMirrorSubmissions(e);
    expect(r1.claims_filed).toBeGreaterThanOrEqual(1);
    const r2 = await scanMirrorSubmissions(e);
    expect(r2.claims_filed).toBe(0);
    expect(await filedClaims(mirrorId)).toHaveLength(1);
  }, 120000);

  it("skips unfunded mirrors entirely (no fiatfund record)", async () => {
    const { mirrorId } = await liveFixture({ fund: false });
    const r = await scanMirrorSubmissions(env());
    expect(r.scanned).toBe(0);
    expect(r.claims_filed).toBe(0);
    expect(await filedClaims(mirrorId)).toHaveLength(0);
  }, 120000);
});
