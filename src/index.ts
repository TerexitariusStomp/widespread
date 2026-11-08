// Widespread ⇄ delta-git bridge worker.
//
//   GET  /                    dashboard (claim → evidence → verdict → payout)
//   GET  /api/state           all review records + bounties (dashboard feed)
//   POST /review              {repo, seq} one claim · {repo, all:true} outstanding
//   GET  /review?repo&seq     same, for linkable demo runs
//   GET  /api/bounties        funded-work registry
//   POST /api/bounties        open/overwrite a bounty (ADMIN_TOKEN if set)
//   DELETE /api/bounties/:r   close one
//   GET  /healthz
//   scheduled(*/5m)           scan WATCH_REPOS op-logs, review new ship claims

import { DASHBOARD_HTML } from "./dash";
import { handlePremiumExport } from "./premium";
import { reviewOutstanding, runReview } from "./review";
import { deleteBounty, listBounties, listRecords, putBounty } from "./store";
import type { Bounty, Env } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const bad = (msg: string, status = 400) => json({ error: msg }, status);

/** Where-the-money-goes trace for a claim: escrow → paid | refunded |
 * open | expired | slashed — the public answer to "where did it go". */
function payoutTrace(c: Record<string, unknown>) {
  const pay = (c.payout ?? {}) as {
    batch_id?: string; transaction_id?: string; receiver?: string;
    amount?: string; currency?: string;
  };
  const status = String(c.status ?? "open");
  return {
    escrowed: true,
    state: status === "accepted_paid" ? "paid" : status,
    to: pay.receiver ?? (status === "accepted_paid" ? "claimant" : "escrow"),
    tx: pay.transaction_id ?? pay.batch_id ?? null,
    amount: pay.amount ?? null,
    currency: pay.currency ?? null,
  };
}

function isAuthorized(req: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return true;
  return req.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`;
}

interface ReviewBody {
  repo?: string;
  seq?: number;
  all?: boolean;
  force?: boolean;
}

async function handleReview(req: Request, env: Env): Promise<Response> {
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

async function handleBountyPost(req: Request, env: Env): Promise<Response> {
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
async function scan(env: Env): Promise<number> {
  let reviewed = 0;
  for (const repo of watchRepos(env)) {
    reviewed += (await reviewOutstanding(env, repo)).length;
  }
  return reviewed;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/" || pathname === "/index.html") {
      return new Response(DASHBOARD_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (pathname === "/healthz") return json({ ok: true, service: "slopcash-bridge" });
    if (pathname === "/api/state" && req.method === "GET") {
      // Opportunistic pickup: an open dashboard polls this route, so new ship
      // claims get reviewed without needing a cron trigger slot.
      ctx.waitUntil(scan(env).catch((e) => console.error(`scan: ${String(e)}`)));
      const [claims, bounties] = await Promise.all([listRecords(env), listBounties(env)]);
      for (const c of claims as Record<string, unknown>[]) {
        c.payout_trace = payoutTrace(c);
      }
      return json({ claims, bounties });
    }
    // Public bounty board — funded, open markets + where the money goes.
    // Queryable by agents/auditors the way settled.tools scrapes rivals'.
    if (pathname === "/api/markets" && req.method === "GET") {
      const [claims, bounties] = await Promise.all([listRecords(env), listBounties(env)]);
      const byRepo = new Map<string, typeof claims>();
      for (const c of claims as { repo?: string }[]) {
        const k = String(c.repo ?? "");
        byRepo.set(k, [...(byRepo.get(k) ?? []), c]);
      }
      const markets = (bounties as Record<string, unknown>[]).map((b) => ({
        repo: b.repo, amount: b.amount, currency: b.currency,
        spec: b.spec, created_at: b.created_at,
        claims: (byRepo.get(String(b.repo)) ?? []).map((c) => ({
          id: (c as Record<string, unknown>).id,
          status: (c as Record<string, unknown>).status,
          payout_trace: payoutTrace(c as Record<string, unknown>),
        })),
      }));
      return json({ markets, total: markets.length });
    }
    if (pathname === "/api/scan" && req.method === "POST") {
      return json({ reviewed: await scan(env) });
    }
    if (pathname === "/api/premium/oplog-export" && req.method === "GET") {
      return handlePremiumExport(req, env);
    }
    if (pathname === "/review" && (req.method === "POST" || req.method === "GET")) {
      return handleReview(req, env);
    }
    if (pathname === "/api/bounties" && req.method === "GET") {
      return json({ bounties: await listBounties(env) });
    }
    if (pathname === "/api/bounties" && req.method === "POST") {
      return handleBountyPost(req, env);
    }
    const bountyDel = pathname.match(/^\/api\/bounties\/([a-z0-9-]+\/[a-z0-9-]+)$/i);
    if (bountyDel && req.method === "DELETE") {
      if (!isAuthorized(req, env)) return bad("unauthorized", 401);
      await deleteBounty(env, bountyDel[1]);
      return json({ ok: true });
    }
    return bad("not found", 404);
  },

  // The "picks up the claim" lane: poll each watched repo's op-log and run
  // the pipeline on ship entries we haven't seen before. Needs a cron slot —
  // when none is free the /api/state opportunistic scan covers pickup.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scan(env).catch((e) => console.error(`scan: ${String(e)}`)));
  },
} satisfies ExportedHandler<Env>;
