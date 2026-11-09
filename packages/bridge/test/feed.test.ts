// feed.test.ts — queryFeed/feedRss are pure functions over a FeedDoc;
// handleMcp runs against the worker's REAL KV binding with a doc seeded
// through the real feedstore. No stubs anywhere.

import { describe, expect, it } from "vitest";
import { queryFeed, feedRss, handleMcp } from "../src/feed";
import { seedFeedDoc, feedRecord, realEnv } from "./helpers";
import type { FeedDoc, FeedRecord } from "../src/types";

const rec = (over: Partial<FeedRecord>): FeedRecord => ({
  id: "t:1", source: "github", forge: "github", kind: "bounty",
  title: "fix the bug", url: "https://x/1",
  escrow: { state: "locked" },
  updated_at: 1000,
  ...over,
});

const doc = (records: FeedRecord[]): FeedDoc => ({
  generated_at: Date.now(), sources: {}, records,
});

describe("queryFeed", () => {
  const records = [
    rec({ id: "a", est_usd: 50, forge: "github", repo: "o/r1", competition: { pending_claims: 1 } }),
    rec({ id: "b", est_usd: 30, forge: "tangled", source: "tangled", escrow: { state: "external" }, competition: { pending_claims: 9 } }),
    rec({ id: "c", est_usd: 10, forge: "github", repo: "o/r2", escrow: { state: "none" }, updated_at: 2000 }),
  ];

  it("filters by forge", () => {
    expect(queryFeed(doc(records), { forge: "tangled" }).records.map((r) => r.id)).toEqual(["b"]);
  });
  it("filters by source prefix", () => {
    expect(queryFeed(doc(records), { source: "github-thirdparty" }).records).toEqual([]);
    const d2 = doc([rec({ id: "x", source: "github-thirdparty:algora" })]);
    expect(queryFeed(d2, { source: "github-thirdparty" }).records[0].id).toBe("x");
  });
  it("filters by repo, q, min_usd, escrow", () => {
    expect(queryFeed(doc(records), { repo: "o/r2" }).records[0].id).toBe("c");
    expect(queryFeed(doc(records), { q: "fix the" }).records.length).toBe(3);
    expect(queryFeed(doc(records), { q: "nonexistent" }).records.length).toBe(0);
    expect(queryFeed(doc(records), { min_usd: 20 }).records.map((r) => r.id)).toEqual(["a", "b"]);
    expect(queryFeed(doc(records), { escrow: "external" }).records[0].id).toBe("b");
  });
  it("max_competition filters crowded bounties", () => {
    expect(queryFeed(doc(records), { max_competition: 2 }).records.map((r) => r.id)).toEqual(["a", "c"]);
  });
  it("sorts by reward desc by default, newest, trust", () => {
    expect(queryFeed(doc(records), {}).records.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(queryFeed(doc(records), { sort: "newest" }).records[0].id).toBe("c");
    const trusted = doc([
      rec({ id: "low", est_usd: 100, escrow: { state: "none" }, trust: { repo_pass_rate: 0.1 } }),
      rec({ id: "high", est_usd: 10, escrow: { state: "locked" }, trust: { repo_pass_rate: 0.9 } }),
    ]);
    expect(queryFeed(trusted, { sort: "trust" }).records[0].id).toBe("high");
  });
  it("cursor paginates stably", () => {
    const page1 = queryFeed(doc(records), { limit: 2 });
    expect(page1.records.length).toBe(2);
    expect(page1.next_cursor).toBe("2");
    const page2 = queryFeed(doc(records), { limit: 2, cursor: page1.next_cursor! });
    expect(page2.records.length).toBe(1);
    expect(page2.next_cursor).toBeNull();
  });
});

describe("feedRss", () => {
  it("emits valid Atom with escaped content", () => {
    const xml = feedRss(doc([rec({ title: "a <b> & \"c\"", amount: "3", currency: "USD", competition: { pending_claims: 2 } })]), "https://x");
    expect(xml).toContain("<feed");
    expect(xml).toContain("<entry>");
    expect(xml).toContain("a &lt;b&gt; &amp; &quot;c&quot;");
    expect(xml).toContain("2 claims");
    expect(xml).not.toContain("<b>");
  });
});

describe("handleMcp (real KV feed doc)", () => {
  const env = () => realEnv();
  const call = (method: string, params?: unknown, id: unknown = 1) =>
    handleMcp(env(), { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

  it("initialize returns protocol + serverInfo", async () => {
    const res = await call("initialize");
    const body = await res!.json() as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe("widespread-feed");
  });
  it("notifications get no response", async () => {
    expect(await call("notifications/initialized", undefined, undefined)).toBeNull();
  });
  it("tools/list exposes feed + runners tools", async () => {
    const res = await call("tools/list");
    const body = await res!.json() as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["feed_search", "feed_get", "feed_stats", "runners_list"]));
  });
  it("unknown method returns JSON-RPC error", async () => {
    const res = await call("bogus/method");
    const body = await res!.json() as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });

  it("feed_get returns a record seeded through the real KV doc", async () => {
    const id = `mcp-test:${Date.now().toString(36)}`;
    await seedFeedDoc(env(), [feedRecord({
      id, title: `mcp seeded bounty ${id}`, url: "https://github.com/TerexitariusStomp/widespread-sandbox/issues/1",
    })]);
    const res = await call("tools/call", { name: "feed_get", arguments: { id } });
    const body = await res!.json() as {
      result: { structuredContent: { id?: string; title?: string } | { error?: string } };
    };
    const sc = body.result.structuredContent;
    expect(sc.id).toBe(id);
    expect(sc.title).toContain("mcp seeded bounty");
  });

  it("feed_stats reflects the seeded doc", async () => {
    const id = `mcp-stats:${Date.now().toString(36)}`;
    await seedFeedDoc(env(), [feedRecord({ id, title: `stats ${id}` })]);
    const res = await call("tools/call", { name: "feed_stats", arguments: {} });
    const body = await res!.json() as {
      result: { structuredContent: { total: number; generated_at: number } };
    };
    expect(body.result.structuredContent.total).toBe(1);
    expect(body.result.structuredContent.generated_at).toBeGreaterThan(0);
  });
});
