import type { Job } from "./contracts";
import type { D1Database, ReviewClaim } from "./persistence";

type ReviewJob = Extract<Job, { kind: "review" }>;

export async function recordBudgetBlock(
  db: D1Database,
  claim: ReviewClaim,
  job: ReviewJob,
  retryAt: string,
) {
  if (!Number.isFinite(Date.parse(retryAt)))
    throw new Error("Provider budget reset time is invalid");
  // Serialize only the queue contract, never provider bodies or source text.
  const identifiers: ReviewJob = {
    kind: "review",
    deliveryId: job.deliveryId,
    installationId: job.installationId,
    repositoryId: job.repositoryId,
    owner: job.owner,
    repo: job.repo,
    itemKind: job.itemKind,
    number: job.number,
  };
  await db
    .prepare(
      "INSERT INTO slopbot_budget_blocks(review_key,claim_token,job_json,blocked_at,retry_at) VALUES(?,?,?,?,?)",
    )
    .bind(
      claim.reviewKey,
      claim.token,
      JSON.stringify(identifiers),
      new Date().toISOString(),
      new Date(retryAt).toISOString(),
    )
    .run();
}

export async function activeBudgetBlock(db: D1Database, reviewKey: string) {
  return db
    .prepare(
      `SELECT b.retry_at FROM slopbot_budget_blocks b
     JOIN slopbot_reviews r ON r.review_key=b.review_key AND r.claim_token=b.claim_token
     WHERE r.review_key=? AND r.status='failed' AND b.retry_at>?`,
    )
    .bind(reviewKey, new Date().toISOString())
    .first<{ retry_at: string }>();
}

/** Queue first, then checkpoint. Unknown send outcomes can duplicate a job;
 * the existing review lease and completed-revision check prevent duplicate work.
 */
export async function resumeBudgetBlocks(
  db: D1Database,
  queue: { send(job: Job): Promise<void> },
) {
  const at = new Date().toISOString();
  const result = await db
    .prepare(
      `SELECT json_group_array(json_object('id',id,'job',json(job_json))) AS items FROM (
      SELECT b.id,b.job_json FROM slopbot_budget_blocks b
      JOIN slopbot_reviews r ON r.review_key=b.review_key AND r.claim_token=b.claim_token
      JOIN slopbot_installations i ON i.installation_id=r.installation_id
      WHERE r.status='failed' AND b.retry_at<=?
        AND i.removed_at IS NULL AND i.suspended_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM slopbot_budget_dispatches d WHERE d.block_id=b.id)
      ORDER BY b.retry_at,b.id LIMIT 100
    )`,
    )
    .bind(at)
    .first<{ items: string }>();
  const pending = JSON.parse(result?.items ?? "[]") as {
    id: number;
    job: ReviewJob;
  }[];
  for (const item of pending) {
    await queue.send(item.job);
    // Another scheduler may have sent the same durable job concurrently.
    await db
      .prepare(
        "INSERT INTO slopbot_budget_dispatches(block_id,queued_at) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM slopbot_budget_dispatches WHERE block_id=?)",
      )
      .bind(item.id, at, item.id)
      .run();
  }
  return pending.length;
}
