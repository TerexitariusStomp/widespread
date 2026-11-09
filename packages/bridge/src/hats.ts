// hats.ts — Intentional Hats bridge surface: org charts, stance checks,
// opportunity ranking, foreign-chain identity. Reads contract state via
// nearView; all writes happen on-chain by hat wearers (the bridge never
// holds keys — same no-custody rule as the rest of the protocol).

import { nearView } from "./near";

export interface HatRecord {
  hatId: string; orgId: string; name: string;
  parentHatId: string | null; adminHatId: string | null;
  accountableTo: string | null; wearer: string;
  permissions: string[]; status: string;
  foreign: { chain: string; path: string; keyType: string } | null;
  identityRef: string | null; constitutionRef: string | null;
  stance: { prefs: Record<string, number>; vetoes: string[]; constitutionRef?: string | null };
  createdAt: string;
}

export interface OrgRecord {
  orgId: string; name: string; creator: string; createdAt: string;
}

export interface MarketLike {
  marketId: string; spec: string;
  payer?: string; amount?: string; locked?: string; deadline?: string; status?: string;
}

const DOMAIN_KEYWORDS: [RegExp, string][] = [
  [/oss|open.?source|infra|protocol|refactor|dependency/i, "oss-infra"],
  [/climate|carbon|regen|energy|environment/i, "climate"],
  [/secur|audit|vuln|crypto|key|auth/i, "security"],
  [/surveil|tracking|ads|dark.?pattern/i, "surveillance"],
  [/docs|readme|tutorial|guide/i, "docs"],
  [/ui|frontend|design|css|component/i, "frontend"],
];

function specDomains(spec: string): string[] {
  return DOMAIN_KEYWORDS.filter(([re]) => re.test(spec)).map(([, d]) => d);
}

// Deterministic stance eval: vetoes are absolute; otherwise alignment is the
// mean of matched-domain prefs (default 0 for unmatched domains).
export function stanceScore(
  hat: HatRecord, spec: string
): { support: boolean; score: number; reasons: string[] } {
  const reasons: string[] = [];
  const domains = specDomains(spec);
  for (const v of hat.stance.vetoes) {
    if (spec.toLowerCase().includes(v.toLowerCase().replace(/-adja.*$|s$/, ""))) {
      reasons.push(`veto: ${v}`);
      return { support: false, score: -1, reasons };
    }
  }
  let sum = 0, hits = 0;
  for (const d of domains) {
    const p = hat.stance.prefs[d];
    if (p !== undefined) { sum += p; hits++; reasons.push(`${d}:${p >= 0 ? "+" : ""}${p}`); }
  }
  const score = hits ? sum / hits : 0;
  return { support: score > 0 || hits === 0, score, reasons };
}

// Complexity estimate from spec signals — drives estCost in ranking.
export function estCost(spec: string): number {
  let c = 1;
  if (/smart.?contract|consensus|crypt|mpc|tee|zero.?knowledge/i.test(spec)) c += 3;
  if (/audit|security|vuln/i.test(spec)) c += 2;
  if (/refactor|migrat|architecture/i.test(spec)) c += 1.5;
  if (/docs|readme|typo|comment/i.test(spec)) c -= 0.5;
  return Math.max(0.5, c);
}

export async function hatsOrg(
  env: { HATS_CONTRACT?: string; NEAR_RPC_URL?: string }, orgId: string
): Promise<{ org: OrgRecord | null; hats: HatRecord[] } | { error: string }> {
  const acct = env.HATS_CONTRACT;
  if (!acct) return { error: "no HATS_CONTRACT configured" };
  const [org, hats] = await Promise.all([
    nearView(env, acct, "getOrg", { orgId }).catch(() => null),
    nearView(env, acct, "listHats", { orgId }).catch(() => null),
  ]);
  return { org: org as OrgRecord | null, hats: (hats as HatRecord[]) ?? [] };
}

export async function hatsHat(
  env: { HATS_CONTRACT?: string; NEAR_RPC_URL?: string }, hatId: string
): Promise<HatRecord | { error: string } | null> {
  const acct = env.HATS_CONTRACT;
  if (!acct) return { error: "no HATS_CONTRACT configured" };
  return (await nearView(env, acct, "getHat", { hatId }).catch(() => null)) as HatRecord | null;
}

export async function hatsStanceCheck(
  env: { HATS_CONTRACT?: string; NEAR_RPC_URL?: string },
  hatId: string, spec: string
) {
  const hat = await hatsHat(env, hatId);
  if (!hat || "error" in hat || !hat) return { error: "hat not found" };
  return { hatId, name: hat.name, wearer: hat.wearer, ...stanceScore(hat, spec) };
}

// rankOpportunities: funded on-chain markets scored by
// alignment × reward / estCost — vetoes excluded. Reward = locked NEAR.
export async function hatsOpportunities(
  env: { HATS_CONTRACT?: string; NEAR_CONTRACT?: string; NEAR_RPC_URL?: string },
  hatId: string,
  markets: MarketLike[]
) {
  const hat = await hatsHat(env, hatId);
  if (!hat || "error" in hat || !hat) return { error: "hat not found" };
  const ranked = markets
    .map((m) => {
      const s = stanceScore(hat, m.spec ?? "");
      const rewardRaw = parseFloat(m.locked ?? m.amount ?? "0") || 0;
      const reward = rewardRaw > 1e15 ? rewardRaw / 1e24 : rewardRaw; // yocto→NEAR
      const cost = estCost(m.spec ?? "");
      return {
        marketId: m.marketId, spec: m.spec, reward,
        estCost: cost,
        alignment: s.score,
        score: s.support ? (s.score || 0.1) * reward / cost : -1,
        reasons: s.reasons,
      };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  return { hatId, wearer: hat.wearer, ranked, evaluated: markets.length };
}

// ---- earned stance: declared prefs adjusted by verified work history ----
// verdicts: [{spec, outcome}] where outcome ∈ paid|refunded|derivative|rejected.
// Each paid verdict in a domain nudges that domain's effective pref up;
// refunds/rejections nudge down — personality is earned, not just declared.
export function earnedStance(
  hat: HatRecord,
  verdicts: { spec?: string; outcome?: string }[]
): { prefs: Record<string, number>; earned: Record<string, number>; verdictsUsed: number } {
  const prefs = { ...hat.stance.prefs };
  const earned: Record<string, number> = {};
  let used = 0;
  for (const v of verdicts ?? []) {
    const outcome = (v.outcome ?? "").toLowerCase();
    if (!["paid", "refunded", "derivative", "rejected"].includes(outcome)) continue;
    used++;
    const delta = outcome === "paid" ? 0.15 : outcome === "derivative" ? -0.1 : -0.2;
    for (const d of specDomains(v.spec ?? "")) {
      prefs[d] = (prefs[d] ?? 0) + delta;
      earned[d] = (earned[d] ?? 0) + delta;
    }
  }
  return { prefs, earned, verdictsUsed: used };
}

// ---- delegated deliberation: constitutionRef as a live endpoint ----
// If the hat's constitutionRef is an http(s) URL (e.g. a Simocracy sim's
// deliberation endpoint or an org.simocracy.mechanism service), the stance
// check delegates to it and returns its reasoned verdict alongside ours.
export async function delegatedStance(
  hat: HatRecord, spec: string
): Promise<{ delegated: boolean; endpoint?: string; verdict?: unknown; error?: string }> {
  const ref = hat.constitutionRef ?? hat.stance?.constitutionRef ?? hat.identityRef;
  if (!ref || !/^https?:\/\//.test(ref)) return { delegated: false };
  try {
    const res = await fetch(ref, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "org.simocracy.decision.request",
        proposal: { spec, hatId: hat.hatId, wearer: hat.wearer,
          stance: hat.stance },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { delegated: true, endpoint: ref, error: `http ${res.status}` };
    return { delegated: true, endpoint: ref, verdict: await res.json().catch(() => null) };
  } catch (e) {
    return { delegated: true, endpoint: ref, error: String(e) };
  }
}

// ---- identity refs: ERC-8004 / ATProto / bare NEAR ----
export type IdentityRef =
  | { kind: "erc8004"; chainId: number; agentId: string }
  | { kind: "atproto"; did: string; record?: string }
  | { kind: "near"; account: string }
  | { kind: "opaque"; raw: string };

export function parseIdentityRef(ref: string | null | undefined): IdentityRef | null {
  if (!ref) return null;
  let m = ref.match(/^erc8004:(\d+):([^:]+)$/i);
  if (m) return { kind: "erc8004", chainId: parseInt(m[1], 10), agentId: m[2] };
  m = ref.match(/^at:\/\/([^/]+)(\/(\S+))?$/);
  if (m) return { kind: "atproto", did: m[1], record: m[3] };
  if (/^[a-z0-9\-]+\.(near|testnet)$/.test(ref)) return { kind: "near", account: ref };
  return { kind: "opaque", raw: ref };
}

// ERC-8004 registries are CREATE2-deterministic — same addresses on every
// EVM mainnet (erc-8004/erc-8004-contracts, config/chains.yml).
export const ERC8004_REGISTRIES: Record<number, { identity: string; reputation: string }> = {
  1:    { identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
         reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" },
  8453: { identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
         reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" }, // Base
};

// ---- foreign-chain identity: derivation params for v1.signer MPC ----
// The bridge can't derive the foreign address itself (chainsig.js needs
// Node crypto; Workers can't bundle it) — agents/tooling derive client-side
// via chainsig.js deriveAddressAndPublicKey(predecessor, path). We expose
// the signer root key + full params so any client can verify/derive.
export async function hatsForeign(
  env: { HATS_CONTRACT?: string; NEAR_RPC_URL?: string }, hatId: string
) {
  const hat = await hatsHat(env, hatId);
  if (!hat || "error" in hat || !hat) return { error: "hat not found" };
  if (!hat.foreign) return { hatId, foreign: null };
  const isTestnet = (env.NEAR_RPC_URL ?? "").includes("testnet")
    || (env.HATS_CONTRACT ?? "").endsWith(".testnet");
  const signer = isTestnet ? "v1.signer-prod.testnet" : "v1.signer";
  // derived_public_key is a real view on the MPC contract (snake_case —
  // the camelCase derivedPublicKey does NOT exist).
  const domainId = hat.foreign.keyType === "secp256k1" ? 0 : 1;
  const derived = await nearView(env, signer, "derived_public_key", {
    path: hat.foreign.path,
    predecessor: env.HATS_CONTRACT,
    domain_id: domainId,
  }).catch(() => null) as string | null;
  // Solana addresses are base58(ed25519 pubkey) — the derived key IS the
  // foreign address for ed25519 chains. EVM needs keccak(uncompressed
  // secp256k1 pubkey) — returned raw for client-side derivation.
  const address = derived?.startsWith("ed25519:")
    ? derived.slice(8)
    : derived ?? null;
  return {
    hatId, hatName: hat.name, wearer: hat.wearer,
    foreign: {
      ...hat.foreign,
      predecessor: env.HATS_CONTRACT,
      signerContract: signer,
      derivedPublicKey: derived,
      address,
      addressNote: hat.foreign.keyType === "secp256k1"
        ? "EVM address = keccak(uncompressed secp256k1 pubkey)[12:] — derive client-side"
        : "ed25519 derived key is the foreign address (Solana-style base58)",
    },
  };
}

// ---- Simocracy-compatible mechanism service (org.simocracy.mechanism) ----
// GET /mechanisms advertises our governance primitives; POST
// /workflows/<id> executes them. Other sims/services can call these.
export function mechanismList() {
  return {
    mechanisms: [
      {
        id: "widespread.stake-check",
        title: "Hat stance check — would this identity support this spec?",
        endpoint: "/api/workflows/widespread.stake-check",
        input: { hatId: "string", spec: "string" },
        output: { support: "boolean", score: "number", reasons: "string[]" },
      },
      {
        id: "widespread.opportunity-ranking",
        title: "Rank funded work by alignment × reward / estCost",
        endpoint: "/api/workflows/widespread.opportunity-ranking",
        input: { hatId: "string", markets: "MarketLike[]" },
        output: { ranked: "scored markets, best first" },
      },
      {
        id: "widespread.futarchy-proposals",
        title: "Live futarchy governance proposals",
        endpoint: "/api/workflows/widespread.futarchy-proposals",
        input: {},
        output: { proposals: "proposal records" },
      },
    ],
  };
}

export async function mechanismRun(
  env: { HATS_CONTRACT?: string; FUTARCHY_CONTRACT?: string; NEAR_CONTRACT?: string; NEAR_RPC_URL?: string },
  id: string, input: Record<string, unknown>
) {
  switch (id) {
    case "widespread.stake-check": {
      const r = await hatsStanceCheck(env,
        String(input.hatId ?? ""), String(input.spec ?? ""));
      return { workflow: id, result: r };
    }
    case "widespread.opportunity-ranking": {
      const r = await hatsOpportunities(env,
        String(input.hatId ?? ""),
        (input.markets as MarketLike[]) ?? []);
      return { workflow: id, result: r };
    }
    case "widespread.futarchy-proposals": {
      const acct = env.FUTARCHY_CONTRACT;
      if (!acct) return { workflow: id, error: "no FUTARCHY_CONTRACT" };
      const proposals = await nearView(env, acct, "listProposals", {})
        .catch(() => null);
      return { workflow: id, result: { proposals: proposals ?? [] } };
    }
    default:
      return { workflow: id, error: "unknown mechanism", known: mechanismList().mechanisms.map(m => m.id) };
  }
}

// ---- NEAR Intents payout quote (1Click Swap API — dry, never credits) ----
// NEAR Intents' public swap API (chaindefuser/defuse infra — NOT the
// legacy intents-api.aurora.dev). No app key needed for quotes.
// Same discipline as intents.js: a quote is a preview; settlement only
// counts after confirmed status — never credit on deposit alone.
const INTENTS_API = "https://1click.chaindefuser.com/v0";

// Defuse asset ids (from /v0/tokens): NEAR-native USDC is unwrapped
// nep141:<contract>; foreign-chain assets are nep141:<chain>-<addr>.omft.near.
export const INTENTS_ASSETS = {
  NEAR_USDC: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  SOL_USDC: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  ETH_USDC: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
};

export async function hatsPayoutQuote(
  env: object,
  args: {
    hatId?: string; assetIn?: string; assetOut?: string;
    amount?: string; recipient?: string; destChain?: string; refundTo?: string;
  }
) {
  if (!args.amount || !args.recipient) {
    return { error: "need {amount, recipient} — assetIn/assetOut/destChain optional" };
  }
  const deadline = new Date(Date.now() + 2 * 3600e3)
    .toISOString().replace(/\.\d{3}Z$/, "Z");
  const origin = args.assetIn ?? INTENTS_ASSETS.NEAR_USDC;
  // refundTo must be a valid address ON THE ORIGIN CHAIN — NEAR account for
  // nep141-native assets, chain address for omft-wrapped origins.
  const isNearNative = origin.startsWith("nep141:") && !origin.includes(".omft.near");
  const refundTo = args.refundTo
    // widespread.near is a registered NEAR account — contract accounts like
    // wide-mkt-*.testnet get rejected upstream (observed HTTP 500).
    ?? (isNearNative ? "widespread.near" : null);
  if (!refundTo)
    return { error: "need refundTo — must be a valid address on the ORIGIN chain (NEAR account for nep141, chain address for omft assets)" };
  const body = {
    dry: true,
    swapType: "EXACT_INPUT",
    depositType: "ORIGIN_CHAIN",
    originAsset: origin,
    destinationAsset: args.assetOut ?? INTENTS_ASSETS.SOL_USDC,
    amount: String(args.amount),
    slippageTolerance: 100,
    refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: args.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline,
  };
  const res = await fetch(`${INTENTS_API}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  return {
    hatId: args.hatId ?? null,
    dry: true,
    rail: "near-intents-1click",
    status: res.ok ? "quoted" : `http ${res.status}`,
    quote: data?.quote ?? data,
    upstream: data?.message ? { message: data.message } : undefined,
    note: "indicative dry quote only — settlement requires confirmed status via /v0/status. NEAR-native origins currently 500 upstream (omft assets quote fine).",
  };
}

/** Settlement status for a 1Click deposit address — only credit on
 *  terminal success states (same discipline as waitSettled). */
export async function intentsStatus(depositAddress: string) {
  const res = await fetch(
    `${INTENTS_API}/status?depositAddress=${encodeURIComponent(depositAddress)}`,
    { signal: AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => null);
  return { depositAddress, http: res.status, status: data };
}
