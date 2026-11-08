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
  payout: PayoutReceipt | null;
  writeback: Writeback | null;
  reviewed_at: number;
}
