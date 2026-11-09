// Shared types for the Slop.cash ⇄ delta-git payout bridge.
//
// Protocol-shared shapes (OpLogEntry, ChainVerification, DgShip1Claim,
// AttestationToken) live in @widespread/protocol — import them from there
// directly; this module intentionally does not re-export them.

import type { ChainVerification, OpLogEntry } from "@widespread/protocol";

/** Runtime environment — bindings + vars + secrets (see wrangler.jsonc). */
export interface Env {
  CLAIMS: KVNamespace;
  /** D1 claim/settlement store — kv() prefers DB, falls back to CLAIMS
   *  so a deploy without the binding keeps working. */
  DB?: D1Database;
  AI: Ai;
  QUALITY: R2Bucket;
  EMBED: VectorizeIndex;
  FORGE_BASE: string;
  WATCH_REPOS: string;
  PAYPAL_API_BASE: string;
  LLM_MODEL: string;
  MIN_CONFIDENCE: string;
  PUBLIC_BASE: string;
  // secrets (wrangler secret put / .dev.vars)
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  ADMIN_TOKEN?: string;
  DG_AGENT_DID?: string;
  DG_AGENT_KEY_PKCS8_B64?: string;
  // NEAR on-chain market + oracle verdict signing
  NEAR_CONTRACT?: string;
  NEAR_RPC_URL?: string;
  ORACLE_ACCOUNT?: string;
  ORACLE_PUBKEY_HEX?: string;
  ORACLE_SEED_HEX?: string;
  ORACLE_SECRET_KEY?: string;
  // NEAR AI Cloud signed inference (provider_tee verdicts)
  NEAR_AI_API_KEY?: string;
  NEAR_AI_BASE?: string;
  NEAR_AI_MODEL?: string;
  // Unified bounty feed — source credentials + watchlists (all optional;
  // each source degrades independently when unset/unreachable)
  GITHUB_TOKEN?: string;
  /** Comma-separated forge watchlist: github:owner/repo, gl:host/o/r,
   *  forgejo:host/o/r, rad:<rid>, tangled:<repo-did> */
  FORGE_WATCH?: string;
  /** Per-source feed toggles: FEED_IMMUNEFI=1 etc. Default-on sources need no flag. */
  FEED_IMMUNEFI?: string;
  FEED_ALGORA?: string;
  FEED_POLAR?: string;
  /** HMAC secret for /api/claims attestation tokens (falls back to ADMIN_TOKEN). */
  ATTEST_SECRET?: string;
  /** Optional JWT for authenticated 1Click API routes (quotes/tokens work without it). */
  ONECLICK_JWT?: string;
  /** Markup (bps) applied when mirroring third-party bounties into our
   * markets — our spread, skimmed on-chain to platformTo at release. */
  CUT_BPS?: string;
  /** NEAR account that receives the platform cut (default: DAO sink). */
  CUT_SINK?: string;
  /** Ops account that auto-escrows fiat-funded mirrors into NEAR markets.
   * secretKey = ed25519:<base58> full-access key (NEAR_OPS_SECRET_KEY). */
  NEAR_OPS_ACCOUNT?: string;
  NEAR_OPS_SECRET_KEY?: string;
}

/** Normalized discovery record — one funded work item from any source.
 * Derived index only; canonical market truth stays on-chain / in KV. */
export interface FeedRecord {
  /** Stable dedupe key: `<source>:<sourceId>` e.g. "gh:owner/repo#12". */
  id: string;
  source: string;              // near-chain | kv-registry | github | github-thirdparty:<p> | tangled | radicle | forgejo | gitlab | external:<p>
  forge: string;               // github | gitlab | forgejo | codeberg | tangled | radicle | deltagit | generic | near
  kind: "bounty" | "task" | "gig";
  repo?: string;               // owner/repo shorthand when forge-native
  locator?: string;            // canonical repo locator/URL
  title: string;
  spec?: string;
  amount?: string;
  currency?: string;
  est_usd?: number;            // rough USD estimate for sorting; null when unknown
  escrow: {
    state: "locked" | "label-only" | "external" | "none";
    proof?: string;            // e.g. "near:wide-mkt-11561.testnet/7"
    locked?: string;
    deadline?: string;
  };
  payout?: { rails: string[]; note?: string };
  verification?: { required: string; spec_hash?: string; acceptance_hash?: string };
  url: string;                 // canonical source page
  claim?: { how: string; grammar?: string };
  execution?: { recommended: string; isolation: string; alternatives: string[]; note: string };
  trust?: { repo_claims?: number; repo_paid?: number; repo_pass_rate?: number };
  competition?: { pending_claims?: number; unique_claimants?: number; first_claim_age_h?: number };
  /** Repo health signals (CHAOSS-aligned) — score is 0–1, null when the
   * forge exposes too few signals to score honestly. */
  quality?: {
    score: number | null;
    stars?: number;
    merged_30d?: number;
    open_issues?: number;
    pushed_at?: string;
    maintainer_responsive?: boolean;
    computed_at?: number;
  };
  /** Primary repo language — key client-side matching dimension. */
  language?: string;
  /** Repo topics + issue labels + domain keywords — client-side matching
   * surface; consumers rank records against what their AI knows of them. */
  topics?: string[];
  /** Monetization path for non-Widespread funding — never implies our escrow.
   * String for simple hints; MirrorOffer when a concrete mirror
   * into a Widespread market is available. */
  widespread_offer?: string | MirrorOffer;
  created_at?: number;
  updated_at: number;
}

/** Concrete mirror offer: route an external bounty through a Widespread
 * market at face value. platformBps is our percent cut skimmed on-chain
 * at release to CUT_SINK — proportional, no FX oracle needed. */
export interface MirrorOffer {
  action: "mirror";
  endpoint: "createMarket";
  contract?: string;
  cut_bps: number;
  original?: { amount?: string; currency?: string };
  note: string;
}

/** Auto-generated mirror listing: an external bounty packaged as a
 * Widespread market opportunity at face value. Created for EVERY detected
 * third-party record each refresh — status flips to "funded" when a
 * market with the matching specHash appears on-chain. */
export interface MirrorListing {
  id: string;                    // mirror:<record_id>
  record_id: string;
  title: string;
  url: string;
  repo?: string;
  original?: { amount?: string; currency?: string; est_usd?: number };
  cut_bps: number;
  claimant_share?: { amount?: string; currency?: string; est_usd?: number };
  spec: string;
  spec_hash: string;
  createMarketArgs: Record<string, unknown>;
  status: "seeking-funder" | "fiat-funded" | "funded";
  funded_market_id?: string;
  /** Present when a fiat pay-in was captured (PayPal order). */
  fiat?: { amount: string; currency: string; payer_email?: string };
  created_at: number;
  updated_at: number;
}

/** Materialized feed document stored in KV — merged+normalized once per refresh. */
export interface FeedDoc {
  generated_at: number;
  sources: Record<string, { ok: boolean; count: number; error?: string; fetched_at: number }>;
  records: FeedRecord[];
  mirrors?: MirrorListing[];
}

type EvidenceSource = "forge-diff" | "upstream-patch" | "unavailable";

export interface CommitEvidence {
  sha: string;
  source: EvidenceSource;
  message: string | null;
  files: string[];
  lines_added: number;
  lines_removed: number;
  /** Truncated unified diff fed to the adjudicator (chars capped). */
  diff_excerpt: string | null;
  evidence_url: string | null;
  /** Context-insensitive diff fingerprint (patch-id) — proof for
   * derivative-work detection: a re-landed copy produces the same hash. */
  patch_fingerprint: string | null;
}

/** Claim-vs-recompute comparison shown on the dashboard + given to the LLM. */
export interface Crosscheck {
  claimed_files: number | null;
  recomputed_files: number;
  files_consistent: boolean | null;
  claimed_lines: number | null;
  recomputed_lines: number;
  lines_consistent: boolean | null;
  commits_verified: number;
  commits_total: number;
  partial: boolean;
}

/** A funded work item in the Slop.cash pool (our registry, keyed by repo). */
export interface Bounty {
  repo: string;
  amount: string;
  currency: string;
  receiver_email: string;
  /** actor/did → email overrides for pools paying distinct contributors. */
  recipients?: Record<string, string>;
  /** Acceptance spec the adjudicator scores the evidence against. */
  spec: string;
  /** Optional hint for remote-backed repos (e.g. a github.com repo URL). */
  upstream?: string;
  work_id?: string | null;
  note?: string | null;
  created_at: number;
}

export interface Adjudication {
  verdict: "accept" | "reject" | "cannot_assess";
  reasoning: string;
  confidence: number;
  model: string;
  /** Rubric-decomposed per-criterion verdicts (atomic, auditable). */
  criteria?: { criterion: string; pass: boolean | "cannot_assess";
    reason: string; confidence: number; signature_id?: string }[];
  /** First chars of raw model output, for transparency on the dashboard. */
  raw_excerpt?: string;
  error?: string;
  /** NEAR AI Cloud provider_tee signature id — fetchable proof the exact
   * request/response bytes ran inside the model's TEE. */
  signature_id?: string;
  /** The TEE signature payload returned by GET /v1/signature/<id>. */
  tee_signature?: unknown;
  /** Ed25519 oracle verdict envelope the market contract binds on-chain. */
  oracle_verdict_sig?: string;
}

export interface PayoutReceipt {
  attempted: boolean;
  skipped_reason?: string;
  sandbox: boolean;
  sender_batch_id?: string;
  batch_id?: string;
  batch_status?: string;
  transaction_id?: string;
  transaction_status?: string;
  receiver?: string;
  amount?: string;
  currency?: string;
  links?: { rel: string; href: string }[];
  error?: string;
}

/** Commit-status receipt written back to the forge (bidirectional audit). */
export interface Writeback {
  attempted: boolean;
  skipped_reason?: string;
  status_url?: string;
  error?: string;
}

type ReviewStatus = "accepted_paid" | "accepted_unpaid" | "rejected" | "error";

export interface ReviewRecord {
  /** `${owner}/${repo}:${seq}` — KV key + dashboard anchor. */
  id: string;
  repo: string;
  seq: number;
  status: ReviewStatus;
  claim: OpLogEntry;
  chain: ChainVerification;
  commits: CommitEvidence[];
  crosscheck: Crosscheck;
  bounty: Bounty | null;
  adjudication: Adjudication | null;
  /** Derivative-use proof: a later upstream commit landed the same patch
   * fingerprint — "used my code, never accepted" made checkable. */
  derivative?: { sha: string; matched: boolean } | null;
  /** Sigstore/Rekor hashedrekord attestation of the claimed commit —
   *  permanent public proof, env-gated (ATTEST_*). */
  attestation?: { uuid?: string; logIndex?: string; integratedTime?: number; skipped?: string } | null;
  payout: PayoutReceipt | null;
  writeback: Writeback | null;
  reviewed_at: number;
}
