export interface RepoActivity {
  state: "receiving" | "compacting";
  startedAt?: number;
  expiresAt?: number;
}
