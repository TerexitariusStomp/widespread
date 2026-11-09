import type { D1TransactionalDatabase } from "../d1";

/** Reuse the payment engine with a physically separate private ledger. Wallet
 * possession and destination bindings stay canonical. SQL is application-owned;
 * request values are always bound parameters and never pass through this map. */
export function securityPaymentDatabase<T extends D1TransactionalDatabase>(
  db: T,
): T {
  const tables =
    /\b(payment_obligations|payment_events|payment_outbox|payment_attempts|payment_attempt_failures|payment_chain_cursors|payment_solana_scans|payment_solana_scan_pages|vault_snapshots)\b/gu;
  return {
    prepare: (sql: string) => db.prepare(sql.replace(tables, "security_$1")),
    batch: (statements: Parameters<T["batch"]>[0]) => db.batch(statements),
  } as T;
}
