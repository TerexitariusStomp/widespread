// hats.ts — Intentional Hats surfaces: org charts, stance checks, ranked
// opportunities, plus the Simocracy mechanism service and NEAR intents
// status. All contract reads via nearView; writes happen on-chain.
//
// The /api/hats/* sub-routes historically matched on prefix+suffix (any
// depth), so they share one wildcard dispatcher that reproduces the
// original check order exactly: stance-check → foreign → payout-quote →
// opportunities → generic hat lookup.

import { Hono } from "hono";
import {
  hatsOrg, hatsHat, hatsStanceCheck, hatsOpportunities,
  hatsForeign, hatsPayoutQuote, intentsStatus, mechanismList, mechanismRun,
  earnedStance, delegatedStance, parseIdentityRef, stanceScore,
  ERC8004_REGISTRIES,
} from "../hats";
import { nearView } from "../near";
import type { Env } from "../types";
import { bad, json, listOnchainMarkets } from "./shared";

export function hatRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/api/hats", async (c) => {
    const url = new URL(c.req.url);
    const orgId = url.searchParams.get("org")
      ?? (c.env as { HATS_ORG?: string }).HATS_ORG ?? "2";
    return json(await hatsOrg(c.env, orgId));
  });

  // Prefix+suffix dispatch — see header comment for the ordering contract.
  app.all("/api/hats/*", async (c, next) => {
    const url = new URL(c.req.url);
    const { pathname } = url;
    if (!pathname.startsWith("/api/hats/")) return next();
    const hatId = pathname.split("/")[3];

    if (pathname.endsWith("/stance-check") && c.req.method === "POST") {
      const d = (await c.req.json().catch(() => ({}))) as
        { spec?: string; verdicts?: { spec?: string; outcome?: string }[]; delegate?: boolean };
      if (!d.spec) return bad("need {spec}", 400);
      const base = await hatsStanceCheck(c.env, hatId, d.spec) as Record<string, unknown>;
      if ("error" in base) return json(base);
      const hat = await hatsHat(c.env, hatId);
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

    if (pathname.endsWith("/foreign") && c.req.method === "GET") {
      return json(await hatsForeign(c.env, hatId));
    }

    if (pathname === "/api/hats/payout-quote" && c.req.method === "POST") {
      const d = (await c.req.json().catch(() => ({}))) as Record<string, string>;
      return json(await hatsPayoutQuote(c.env, d));
    }

    if (pathname.endsWith("/opportunities") && c.req.method === "GET") {
      const markets = (await listOnchainMarkets(c.env)) as
        { marketId: string; spec: string; locked: string }[];
      return json(await hatsOpportunities(c.env, hatId, markets));
    }

    if (c.req.method === "GET") {
      const hat = await hatsHat(c.env, hatId);
      if (!hat || ("error" in hat)) return bad("hat not found", 404);
      const acct = (c.env as { HATS_CONTRACT?: string }).HATS_CONTRACT;
      const scope = url.searchParams.get("scope");
      const has = scope
        ? await nearView(c.env, acct!, "hasScope", { hatId, scope }).catch(() => null)
        : null;
      return json({
        ...hat, contract: acct,
        foreign: hat.foreign
          ? { ...hat.foreign, address: "see /api/hats/:id/foreign (derived_public_key view)" }
          : null,
        scopeCheck: scope ? { scope, granted: has } : undefined,
      });
    }

    return next();
  });

  app.get("/api/intents/status", async (c) => {
    const dep = new URL(c.req.url).searchParams.get("depositAddress") ?? "";
    return dep ? json(await intentsStatus(dep, c.env)) : bad("need ?depositAddress=", 400);
  });

  // Simocracy-compatible mechanism service (org.simocracy.mechanism).
  app.get("/api/mechanisms", (c) => json(mechanismList()));

  app.post("/api/workflows/*", async (c, next) => {
    const { pathname } = new URL(c.req.url);
    if (!pathname.startsWith("/api/workflows/")) return next();
    const id = pathname.split("/")[3];
    const d = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return json(await mechanismRun(c.env, id, d));
  });

  return app;
}
