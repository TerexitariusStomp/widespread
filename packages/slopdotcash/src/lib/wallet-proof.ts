import type { WalletChain } from "./wallets";

/** Immutable wallet evidence shared by allocation records and their cycle index. */
export interface ProfileReadmeWalletProof {
  address: string;
  chain: WalletChain;
  observedAt: string;
  sourceCommit: string;
  sourceUrl: string;
}

export interface GithubIssueWalletProof {
  address: string;
  chain: WalletChain;
  observedAt: string;
  sourceActorId: string;
  sourceBodySha256: string;
  sourceIssueId: string;
  sourceIssueNumber: number;
  sourceUpdatedAt: string;
  sourceUrl: string;
}

export interface SlopDatabaseWalletProof {
  address: string;
  chain: WalletChain;
  observedAt: string;
  sourceActorId: string;
  sourceClaimId: string;
  sourceRecordSha256: string;
  sourceUrl: string;
}

export type WalletProof =
  | ProfileReadmeWalletProof
  | GithubIssueWalletProof
  | SlopDatabaseWalletProof;
