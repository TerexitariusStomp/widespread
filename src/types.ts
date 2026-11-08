// Shared types for the Slop.cash ⇄ delta-git payout bridge.

/** Runtime environment — bindings + vars + secrets (see wrangler.jsonc). */
export interface Env {
  CLAIMS: KVNamespace;
  AI: Ai;
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
  /** Markup (bps) applied when mirroring third-party bounties into our
   * markets — our spread, skimmed on-chain to platformTo at release. */
  MARKUP_BPS?: string;
  /** NEAR account that receives mirror-market markup (default: DAO sink). */
  MARKUP_SINK?: string;
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
  /** Monetization path for non-Widespread funding — never implies our escrow.
   * String for simple hints; MirrorOffer when a concrete marked-up mirror
   * into a Widespread market is available. */
  widespread_offer?: string | MirrorOffer;
  created_at?: number;
  updated_at: number;
}

/** Concrete mirror offer: route an external bounty through a Widespread
 * market at a marked-up price. platformBps is skimmed on-chain at release
 * to MARKUP_SINK — proportional markup needs no FX oracle. */
export interface MirrorOffer {
  action: "mirror";
  endpoint: "createMarket";
  contract?: string;
  markup_bps: number;
  original?: { amount?: string; currency?: string };
  note: string;
}

/** Auto-generated mirror listing: an external bounty packaged as a
 * marked-up Widespread market opportunity. Created for EVERY detected
 * third-party record each refresh — status flips to "funded" when a
 * market with the matching specHash appears on-chain. */
export interface MirrorListing {
  id: string;                    // mirror:<record_id>
  record_id: string;
  title: string;
  url: string;
  repo?: string;
  original?: { amount?: string; currency?: string; est_usd?: number };
  markup_bps: number;
  marked_up?: { amount?: string; currency?: string; est_usd?: number };
  spec: string;
  spec_hash: string;
  createMarketArgs: Record<string, unknown>;
  status: "seeking-funder" | "funded";
  funded_market_id?: string;
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

/** One row of GET /api/:owner/:repo/dg/oplog (snake_case over the wire). */
export interface OpLogEntry {
  seq: number;
  hash: string;
  prev_hash: string;
  kind: string;
  actor: string;
  payload: Record<string, unknown>;
  created_at: number;
}

export interface OpLogResponse {
  entries: OpLogEntry[];
}

/** Result of replaying the op-log hash chain locally. */
export interface ChainVerification {
  valid: boolean;
  checked: number;
  tip_hash: string | null;
  tip_seq: number;
  broken_at_seq: number | null;
}

/** What the ship claim asserts (subset of the dg-ship-1 payload we use). */
export interface ShipClaim {
  session_id?: string;
  tool?: string;
  commits?: string[];
  files?: number;
  ship?: boolean;
  lines_added?: number;
  lines_removed?: number;
  claimed?: {
    lines_added?: number;
    lines_removed?: number;
    files_touched?: number;
  };
  paypal_email?: string;
  work_id?: string;
}

export type EvidenceSource = "forge-diff" | "upstream-patch" | "unavailable";

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
  verdict: "accept" | "reject";
  reasoning: string;
  confidence: number;
  model: string;
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

export type ReviewStatus = "accepted_paid" | "accepted_unpaid" | "rejected" | "error";

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
