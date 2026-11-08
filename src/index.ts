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
import { handleBotVerdict, type BotVerdictBody } from "./botverdict";
import { attestClaim, ecosystem, openDispute } from "./ecosystem";
import { resolveLocator } from "./locator";
import { sponsorPage } from "./sponsor";
import { poidhInfo } from "./poidh";
import { hatsOrg, hatsHat, hatsStanceCheck, hatsOpportunities,
         hatsForeign, hatsPayoutQuote, intentsStatus, mechanismList, mechanismRun,
         earnedStance, delegatedStance, parseIdentityRef, stanceScore,
         ERC8004_REGISTRIES } from "./hats";
import { nearView } from "./near";
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
function payoutTrace(c: { status?: string; payout?: { transaction_id?: string; batch_id?: string; receiver?: string; amount?: string; currency?: string } | null }) {
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

/** Read open markets straight from the NEAR market contract — the chain is
 * the state; KV is only a dev fallback when no contract is configured. */
async function listOnchainMarkets(env: Env): Promise<unknown[] | null> {
  const acct = (env as { NEAR_CONTRACT?: string }).NEAR_CONTRACT;
  if (!acct) return null;
  const markets = await nearView(env, acct, "listOpen", {}) as
    { marketId: string; payer: string; spec: string; amount: string; locked: string; deadline: string; status: string }[] | null;
  if (!markets) return null;
  return markets.map((m) => ({
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
    // Sponsor-tool surface: AG Grid payout-trace viewer.
    if (pathname === "/sponsor") return sponsorPage(env);
    if (pathname === "/healthz") return json({ ok: true, service: "slopcash-bridge" });
    if (pathname === "/api/state" && req.method === "GET") {
      // Opportunistic pickup: an open dashboard polls this route, so new ship
      // claims get reviewed without needing a cron trigger slot.
      ctx.waitUntil(scan(env).catch((e) => console.error(`scan: ${String(e)}`)));
      const [claims, bounties] = await Promise.all([listRecords(env), listBounties(env)]);
      const claimsWithTrace = claims.map((c) => ({ ...c, payout_trace: payoutTrace(c) }));
      return json({ claims: claimsWithTrace, bounties });
    }
    // Public bounty board — funded, open markets + where the money goes.
    // Market truth is the CHAIN (widespread-near contract listOpen), not our
    // KV — the bridge is a thin renderer; participant infra holds the state.
    if (pathname === "/api/markets" && req.method === "GET") {
      const onchain = await listOnchainMarkets(env).catch(() => null);
      if (onchain) return json({ markets: onchain, total: onchain.length, source: "chain" });
      return json({ markets: [], total: 0, source: "chain",
        error: "no NEAR_CONTRACT configured — markets live on-chain, not in KV" });
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
    // PR-bot verdict oracle — widespread-bot posts a bot's public verdict on
    // a wide:funded PR; we sign it as a wide-verdict and settle if bound.
    if (pathname === "/api/bot-verdict" && req.method === "POST") {
      return handleBotVerdict(env, (await req.json().catch(() => ({}))) as BotVerdictBody);
    }
    // Public audit feed of PR-bot oracle verdicts (who verified, what score,
    // where the money went) — the "they're the verifier, we're the money" trail.
    if (pathname === "/api/bot-verdicts" && req.method === "GET") {
      const list = await env.CLAIMS.list({ prefix: "botverdict:" }).catch(() => null);
      const records = await Promise.all(
        (list?.keys ?? []).map((k) => env.CLAIMS.get(k.name, "json").catch(() => null))
      );
      return json({ verdicts: records.filter(Boolean), total: records.filter(Boolean).length });
    }
    // Collaborator ecosystem feed — rails, funding pools, security boards,
    // forges, workers, dispute/proof seams. All env-gated, all optional.
    if (pathname === "/api/ecosystem" && req.method === "GET") {
      return json(await ecosystem(env));
    }
    // Foreguild futarchy — live governance proposals on the NEAR contract.
    if (pathname === "/api/futarchy" && req.method === "GET") {
      const acct = (env as { FUTARCHY_CONTRACT?: string }).FUTARCHY_CONTRACT;
      if (!acct) return json({ proposals: [], total: 0,
        error: "no FUTARCHY_CONTRACT configured" });
      const proposals = await nearView(env, acct, "listProposals", {})
        .catch(() => null) as unknown[] | null;
      return json({ proposals: proposals ?? [], total: proposals?.length ?? 0,
        contract: acct, source: "chain" });
    }
    // Intentional Hats — org charts, stance checks, ranked opportunities.
    // All contract reads via nearView; writes happen on-chain by wearers.
    if (pathname === "/api/hats" && req.method === "GET") {
      const orgId = url.searchParams.get("org")
        ?? (env as { HATS_ORG?: string }).HATS_ORG ?? "2";
      return json(await hatsOrg(env, orgId));
    }
    if (pathname.startsWith("/api/hats/") && pathname.endsWith("/stance-check") && req.method === "POST") {
      const hatId = pathname.split("/")[3];
      const d = (await req.json().catch(() => ({}))) as
        { spec?: string; verdicts?: { spec?: string; outcome?: string }[]; delegate?: boolean };
      if (!d.spec) return bad("need {spec}", 400);
      const base = await hatsStanceCheck(env, hatId, d.spec) as Record<string, unknown>;
      if ("error" in base) return json(base);
      const hat = await hatsHat(env, hatId);
      const hatOk = hat && !("error" in hat) && hat ? hat : null;
      // earned stance: fold verified verdict history into effective prefs
      if (d.verdicts?.length && hatOk) {
        const es = earnedStance(hatOk, d.verdicts);
        const adj = { ...hatOk, stance: { ...hatOk.stance, prefs: es.prefs } };
        const rescored = stanceScore(adj, d.spec);
        base.earned = { ...es, rescored };
      }
      // delegated deliberation: constitutionRef as live endpoint (Simocracy)
      if (d.delegate !== false && hatOk)
        base.delegated = await delegatedStance(hatOk, d.spec);
      // identity ref parsing (ERC-8004 / ATProto / NEAR)
      if (hatOk) {
        const ref = parseIdentityRef(hatOk.identityRef ?? hatOk.constitutionRef);
        base.identity = ref?.kind === "erc8004"
          ? { ...ref, registries: ERC8004_REGISTRIES[ref.chainId] ?? null }
          : ref;
      }
      return json(base);
    }
    if (pathname.startsWith("/api/hats/") && pathname.endsWith("/foreign") && req.method === "GET") {
      const hatId = pathname.split("/")[3];
      return json(await hatsForeign(env, hatId));
    }
    if (pathname === "/api/hats/payout-quote" && req.method === "POST") {
      const d = (await req.json().catch(() => ({}))) as Record<string, string>;
      return json(await hatsPayoutQuote(env, d));
    }
    if (pathname === "/api/intents/status" && req.method === "GET") {
      const dep = url.searchParams.get("depositAddress") ?? "";
      return dep ? json(await intentsStatus(dep)) : bad("need ?depositAddress=", 400);
    }
    // Simocracy-compatible mechanism service (org.simocracy.mechanism).
    if (pathname === "/api/mechanisms" && req.method === "GET") {
      return json(mechanismList());
    }
    if (pathname.startsWith("/api/workflows/") && req.method === "POST") {
      const id = pathname.split("/")[3];
      const d = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      return json(await mechanismRun(env, id, d));
    }
    if (pathname.startsWith("/api/hats/") && pathname.endsWith("/opportunities") && req.method === "GET") {
      const hatId = pathname.split("/")[3];
      const markets = (await listOnchainMarkets(env).catch(() => null)) as
        { marketId: string; spec: string; locked: string }[] | null ?? [];
      return json(await hatsOpportunities(env, hatId, markets));
    }
    if (pathname.startsWith("/api/hats/") && req.method === "GET") {
      const hatId = pathname.split("/")[3];
      const hat = await hatsHat(env, hatId);
      if (!hat || ("error" in hat)) return bad("hat not found", 404);
      const acct = (env as { HATS_CONTRACT?: string }).HATS_CONTRACT;
      const scope = url.searchParams.get("scope");
      const has = scope
        ? await nearView(env, acct!, "hasScope", { hatId, scope }).catch(() => null)
        : null;
      return json({
        ...hat, contract: acct,
        foreign: hat.foreign
          ? { ...hat.foreign, address: "see /api/hats/:id/foreign (derived_public_key view)" }
          : null,
        scopeCheck: scope ? { scope, granted: has } : undefined,
      });
    }
    // Poidh rail — live sponsor-protocol state on Base (read-only).
    if (pathname === "/api/poidh" && req.method === "GET") {
      return json(await poidhInfo(env).catch((e) => ({ error: String(e) })));
    }
    // Sovereign repo layer — resolve any locator to its verification surface.
    if (pathname === "/api/locator" && req.method === "GET") {
      const u = url.searchParams.get("u") ?? "";
      return u ? json(resolveLocator(u)) : bad("need ?u=<locator>", 400);
    }
    // Kleros dispute seam — binds claimHash+reason as arbitration evidence.
    if (pathname === "/api/dispute" && req.method === "POST") {
      const d = (await req.json().catch(() => ({}))) as {
        repo?: string; market_id?: string; claim_hash?: string; reason?: string; responder?: string;
      };
      if (!d.repo || !d.claim_hash || !d.reason) return bad("need repo, claim_hash, reason", 400);
      return json(await openDispute(env, {
        repo: d.repo, marketId: d.market_id ?? "0", claimHash: d.claim_hash,
        reason: d.reason, responder: d.responder,
      }));
    }
    // Rekor attestation for a shipped commit — permanent public proof.
    if (pathname === "/api/attest" && req.method === "POST") {
      const a = (await req.json().catch(() => ({}))) as { repo?: string; sha?: string; note?: string };
      if (!a.repo || !a.sha) return bad("need repo, sha", 400);
      return json(await attestClaim(env, { repo: a.repo, sha: a.sha, note: a.note }));
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
