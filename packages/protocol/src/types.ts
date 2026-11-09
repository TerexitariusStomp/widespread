// Shared wire types for the widespread protocol — the shapes that cross
// package boundaries (forge op-log, dg-ship-1 claims, HMAC attestation
// tokens). Canonical definitions live here so bridge, runner, solana,
// hermes, and delta-git all speak the same vocabulary.

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

/** What a dg-ship-1 claim asserts — the subset of the payload the payout
 * pipeline reads (commits, diff stats, payout hints). Producers may attach
 * additional fields (e.g. `env_attestation`); readers must tolerate them. */
export interface DgShip1Claim {
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
  [key: string]: unknown;
}

/** HMAC attestation token issued by the bridge claims API —
 * `<base64url(payload-json)>.<hex-hmac-sha256>`. The decoded payload
 * always carries `iat`/`exp` (epoch ms) plus scope-specific fields. */
export type AttestationToken = string;

export interface AttestationTokenPayload {
  iat?: number;
  exp?: number;
  scope?: string;
  [key: string]: unknown;
}
