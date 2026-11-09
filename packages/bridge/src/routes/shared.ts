// shared.ts — helpers used across bridge route modules: JSON responses,
// the anonymous-page memo cache, admin auth, and the shared scan/review
// pipeline that several endpoints trigger opportunistically.

import type { Context } from "hono";
import { reviewOutstanding, runReview } from "../review";
import { nearView } from "../near";
import type { Bounty, Env } from "../types";
import { putBounty } from "../store";

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export const bad = (msg: string, status = 400) => json({ error: msg }, status);

/** Hono types `c.executionCtx` as its own minimal ExecutionContext
 * interface; on Workers it is the real thing at runtime. This is the
 * single cast site bridging the two declarations. */
export function execCtx(c: Context): ExecutionContext {
  return c.executionCtx as ExecutionContext;
}

/** Anonymous HTML GET memoization — feed pages render from the KV feed
 * doc and cost real CPU; free-tier isolates get ~10ms. Authenticated or
 * cookie-bearing requests always bypass. */
const pageCache = new Map<string, { body: string; expires: number }>();
const PAGE_TTL_MS = 45_000;

/** Decode a path segment that may contain %2F-encoded id characters.
 * Malformed escapes fall back to the raw segment rather than throwing. */
export function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function cacheable(req: Request): boolean {
  return req.method === "GET"
    && !req.headers.get("authorization")
    && !req.headers.get("cookie");
}

export async function cachedPage(url: URL, req: Request, render: () => Promise<Response>): Promise<Response> {
  if (!cacheable(req)) return render();
  const key = url.pathname + url.search;
  const hit = pageCache.get(key);
  if (hit && hit.expires > Date.now()) {
    return new Response(hit.body, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const res = await render();
  if (res.headers.get("content-type")?.includes("text/html")) {
    const body = await res.clone().text();
    if (pageCache.size > 200) pageCache.clear();
    pageCache.set(key, { body, expires: Date.now() + PAGE_TTL_MS });
  }
  return res;
}

/** Where-the-money-goes trace for a claim: escrow → paid | refunded |
 * open | expired | slashed — the public answer to "where did it go". */
export function payoutTrace(c: { status?: string; payout?: { transaction_id?: string; batch_id?: string; receiver?: string; amount?: string; currency?: string } | null }) {
  const pay = c.payout ?? {};
  const status = c.status ?? "open";
  return {
    escrowed: true,
    state: status === "accepted_paid" ? "paid" : status,
    to: pay.receiver ?? (status === "accepted_paid" ? "claimant" : "escrow"),
    tx: pay.transaction_id ?? pay.batch_id ?? null,
    amount: pay.amount ?? null,
    currency: pay.currency ?? null,
  };
}

export function isAuthorized(req: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return true;
  return req.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`;
}

interface ReviewBody {
  repo?: string;
  seq?: number;
  all?: boolean;
  force?: boolean;
}

export async function handleReview(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  let body: ReviewBody = {};
  if (req.method === "POST") {
    body = (await req.json().catch(() => ({}))) as ReviewBody;
  }
  const repo = body.repo ?? url.searchParams.get("repo") ?? "";
  const seqRaw = body.seq ?? url.searchParams.get("seq") ?? undefined;
  const all = body.all || url.searchParams.get("all") === "1";
  const force = body.force || url.searchParams.get("force") === "1";
  const seq = seqRaw === undefined || seqRaw === null ? undefined : Number(seqRaw);
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/i.test(repo)) return bad("repo must look like owner/repo");
  try {
    if (all || seq === undefined || !Number.isFinite(seq)) {
      const records = await reviewOutstanding(env, repo);
      return json({ reviewed: records.length, status: "ok", records });
    }
    const record = await runReview(env, repo, seq, { force: !!force });
    return json({ reviewed: 1, status: record.status, records: [record] });
  } catch (e) {
    return bad(String(e), e instanceof Error && e.message.includes("not") ? 404 : 422);
  }
}

/** Read open markets straight from the NEAR market contract — the chain is
 * the source of truth. NEAR_CONTRACT is required config: a missing account
 * throws immediately rather than silently serving an empty board. Transient
 * RPC failures degrade to an empty list (the feed treats chain as one
 * optional source). */
interface OnchainMarket {
  marketId: string; payer: string; spec: string;
  amount: string; locked: string; deadline: string; status: string;
}

export async function listOnchainMarkets(env: Env): Promise<Record<string, unknown>[]> {
  const acct = env.NEAR_CONTRACT;
  if (!acct) {
    throw new Error("NEAR_CONTRACT is not configured — on-chain markets are required");
  }
  const markets = await nearView(env, acct, "listOpen", {}).catch(() => null) as
    OnchainMarket[] | null;
  return (markets ?? []).map((m) => ({
    marketId: m.marketId, payer: m.payer, spec: m.spec,
    amount: m.amount, locked: m.locked, deadline: m.deadline,
    status: m.status, payout_trace: {
      escrowed: true, state: m.status,
      to: m.status === "paid" ? "claimant" : "escrow", tx: null,
    },
  }));
}

interface BountyBody {
  repo?: string;
  amount?: string;
  currency?: string;
  receiver_email?: string;
  recipients?: Record<string, string>;
  spec?: string;
  upstream?: string;
  work_id?: string;
  note?: string;
}

export async function handleBountyPost(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env)) return bad("unauthorized", 401);
  const body = (await req.json().catch(() => null)) as BountyBody | null;
  if (!body?.repo || !/^[a-z0-9-]+\/[a-z0-9-]+$/i.test(body.repo)) {
    return bad("repo must look like owner/repo");
  }
  if (!body.receiver_email && !body.recipients) {
    return bad("receiver_email (or recipients map) required — a PayPal-linked email");
  }
  const bounty: Bounty = {
    repo: body.repo,
    amount: body.amount ?? "1.00",
    currency: (body.currency ?? "USD").toUpperCase(),
    receiver_email: body.receiver_email ?? "",
    ...(body.recipients ? { recipients: body.recipients } : {}),
    spec: body.spec ?? "",
    ...(body.upstream ? { upstream: body.upstream } : {}),
    ...(body.work_id ? { work_id: body.work_id } : {}),
    ...(body.note ? { note: body.note } : {}),
    created_at: Date.now(),
  };
  await putBounty(env, bounty);
  return json({ ok: true, bounty }, 201);
}

function watchRepos(env: Env): string[] {
  return (env.WATCH_REPOS ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
}

/** Scan watched repos' op-logs; review ship claims we haven't seen. */
export async function scan(env: Env): Promise<number> {
  let reviewed = 0;
  for (const repo of watchRepos(env)) {
    reviewed += (await reviewOutstanding(env, repo)).length;
  }
  return reviewed;
}
