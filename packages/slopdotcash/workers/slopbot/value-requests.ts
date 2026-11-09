import type { D1Database } from "./persistence";
import { requireRegisteredRepository } from "./registry";

export type ValueRequest = {
  deliveryId: string;
  installationId: number;
  repositoryId: number;
  owner: string;
  repo: string;
  number: number;
};

/** A durable source-change request, not a score or permission to call a model.
 * Delivery retries must retain exactly the same identifiers.
 */
export async function recordValueRequest(db: D1Database, job: ValueRequest) {
  if (
    !job.deliveryId ||
    ![job.installationId, job.repositoryId, job.number].every(
      (id) => Number.isSafeInteger(id) && id > 0,
    ) ||
    !/^[A-Za-z0-9-]+$/.test(job.owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(job.repo)
  )
    throw new Error("Invalid value request identifiers");
  await requireRegisteredRepository(db, job);
  await db
    .prepare(
      `INSERT INTO slopbot_value_requests
       (delivery_id,installation_id,repository_id,owner,repo,pull_request_number,received_at)
       SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS
       (SELECT 1 FROM slopbot_value_requests WHERE delivery_id=?)`,
    )
    .bind(
      job.deliveryId,
      job.installationId,
      job.repositoryId,
      job.owner,
      job.repo,
      job.number,
      new Date().toISOString(),
      job.deliveryId,
    )
    .run();
  const stored = await db
    .prepare(
      `SELECT 1 AS ok FROM slopbot_value_requests WHERE delivery_id=?
       AND installation_id=? AND repository_id=? AND owner=? AND repo=?
       AND pull_request_number=?`,
    )
    .bind(
      job.deliveryId,
      job.installationId,
      job.repositoryId,
      job.owner,
      job.repo,
      job.number,
    )
    .first<{ ok: number }>();
  if (!stored) throw new Error("Value delivery identity changed");
}
