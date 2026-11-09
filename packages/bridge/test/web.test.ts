// web.test.ts — page renderers run against the worker's REAL KV feed doc
// (seeded via feedstore) — no module mocks. Each test seeds the doc it
// needs, so assertions reflect real stored state.

import { describe, expect, it } from "vitest";
import type { FeedRecord, MirrorListing } from "../src/types";
import { homePage, bountiesPage, bountyPage, fundPage, docsPage, bountyMarkdown } from "../src/web/pages";
import { seedFeedDoc, feedRecord, realEnv } from "./helpers";

const stamp = Date.now().toString(36);

const record = (over: Partial<FeedRecord>): FeedRecord => feedRecord({
  id: `web-test:rec:${stamp}`,
  title: "Fix the parser bug <script>alert(1)</script>",
  spec: "Fix the parser. <img onerror=x>",
  url: "https://github.com/TerexitariusStomp/widespread-sandbox/issues/1",
  updated_at: Date.now() - 3600_000,
  ...over,
});

const mirror = (over: Partial<MirrorListing>): MirrorListing => ({
  id: `mirror:web-test:${stamp}`,
  record_id: `web-test:rec:${stamp}`,
  title: "Fix the parser bug",
  url: "https://github.com/TerexitariusStomp/widespread-sandbox/issues/1",
  repo: "TerexitariusStomp/widespread-sandbox",
  original: { amount: "100", currency: "USD", est_usd: 100 },
  cut_bps: 1000, claimant_share: { est_usd: 90 },
  spec: "Fix the parser.", spec_hash: `sha256:web-${stamp}`,
  createMarketArgs: {}, status: "seeking-funder",
  created_at: Date.now(), updated_at: Date.now(),
  ...over,
});

const MIRROR_ID = `mirror:web-test:${stamp}`;
const REC_ID = `web-test:rec:${stamp}`;

async function seed(records: FeedRecord[], mirrors: MirrorListing[]) {
  await seedFeedDoc(realEnv(), records, mirrors);
}

describe("web pages (real KV feed doc)", () => {
  it("home renders stats + top bounties + how-it-works", async () => {
    await seed([record({})], [mirror({})]);
    const res = await homePage(realEnv());
    const t = await res.text();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(t).toContain("every forge");
    expect(t).toContain("How it works");
    expect(t).toContain("mirror-only");
  });

  it("bounties page lists records + mirrors with filter toolbar", async () => {
    await seed([record({})], [mirror({})]);
    const t = await (await bountiesPage(realEnv())).text();
    expect(t).toContain("Bounties");
    expect(t).toContain("filter title");
    expect(t).toContain("Fix the parser bug");
  });

  it("bounty detail shows mirror fund CTA + spec", async () => {
    await seed([record({})], [mirror({})]);
    const t = await (await bountyPage(realEnv(), undefined, MIRROR_ID)).text();
    expect(t).toContain("Fund this bounty");
    expect(t).toContain("Fund with PayPal");
    expect(t).toContain("face value");
    expect(t).toContain("platform cut");
    expect(t).toContain("Fix the parser.");
  });

  it("bounty detail 404s cleanly on unknown id", async () => {
    await seed([], []);
    const t = await (await bountyPage(realEnv(), undefined, "mirror:nope")).text();
    expect(t).toContain("No bounty with that id");
  });

  it("fund page renders timeline even without funding", async () => {
    await seed([record({})], [mirror({})]);
    const t = await (await fundPage(realEnv(), undefined, MIRROR_ID)).text();
    expect(t).toContain("Funding status");
    expect(t).toContain("NEAR escrow");
  });

  it("bounty markdown twin renders agent-readable fields", async () => {
    await seed([record({})], [mirror({})]);
    const res = await bountyMarkdown(realEnv(), undefined, MIRROR_ID);
    const t = await res.text();
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(t).toContain("# ");
    expect(t).toContain("mirror_id");
    expect(t).toContain("POST /api/mirrors/claims");
    expect(t).toContain("platform cut");
  });

  it("escapes HTML in titles/specs (XSS)", async () => {
    await seed([
      record({ title: "<script>alert(1)</script>", spec: "<img onerror=x>" }),
    ], []);
    const t = await (await bountiesPage(realEnv())).text();
    expect(t).not.toContain("<script>alert(1)</script>");
    expect(t).toContain("&lt;script&gt;");
    const d = await (await bountyPage(realEnv(), undefined, REC_ID)).text();
    expect(d).not.toContain("<img onerror=x>");
    expect(d).toContain("&lt;img");
  });

  it("docs page covers feed surfaces + standards status", async () => {
    const t = await docsPage().text();
    expect(t).toContain("/api/feed");
    expect(t).toContain("ERC-8004");
    expect(t).toContain("x402");
    expect(t).toContain("mirror-only");
  });
});
