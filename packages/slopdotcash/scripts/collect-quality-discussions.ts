/** Capture public closure context privately; this file is not a site input. */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  type CapturedDiscussion,
  completeDiscussionConnections,
} from "./complete-quality-discussions";

const execFileAsync = promisify(execFile);

const [source, output] = process.argv.slice(2);
if (!output)
  throw new Error(
    "Usage: collect-quality-discussions.ts REPOSITORY_CENSUS OUTPUT",
  );
const census = JSON.parse(await readFile(source, "utf8"));
const rows: {
  id: string;
  closedAt: string;
  mergedAt: string | null;
  headRefOid: string;
}[] = census.nodes.filter((row: { mergedAt: string | null }) => !row.mergedAt);
const query = `query($ids:[ID!]!){nodes(ids:$ids){... on PullRequest{id closedAt mergedAt headRefOid comments(first:20){totalCount pageInfo{hasNextPage endCursor} nodes{id url body createdAt updatedAt authorAssociation author{login}}} reviews(first:10){totalCount pageInfo{hasNextPage endCursor} nodes{id url body state submittedAt author{login}}}}}}`;
const observations: unknown[] = [];
async function request(batch: typeof rows) {
  const pending = execFileAsync("gh", ["api", "graphql", "--input", "-"], {
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  pending.child.stdin?.end(
    JSON.stringify({ query, variables: { ids: batch.map((row) => row.id) } }),
  );
  const { stdout: text } = await pending;
  const response = JSON.parse(text);
  if (response.errors?.length || response.data?.nodes?.length !== batch.length)
    throw new Error("Incomplete discussion response");
  for (const row of response.data.nodes) {
    const original = batch.find((item) => item.id === row?.id);
    if (
      !original ||
      row.mergedAt ||
      original.closedAt !== row.closedAt ||
      original.headRefOid !== row.headRefOid
    )
      throw new Error(
        "Closure changed since census; refresh before assessing it",
      );
    observations.push(row);
  }
}
for (let at = 0; at < rows.length; at += 200) {
  await Promise.all(
    [rows.slice(at, at + 100), rows.slice(at + 100, at + 200)]
      .filter((batch) => batch.length)
      .map(request),
  );
  console.log(
    `Captured ${observations.length} of ${rows.length} closure discussions`,
  );
}
for (const row of observations)
  completeDiscussionConnections(row as CapturedDiscussion);
observations.sort((a, b) =>
  (a as { id: string }).id < (b as { id: string }).id ? -1 : 1,
);
await writeFile(
  output,
  `${JSON.stringify({ observedAt: new Date().toISOString(), observations })}\n`,
  { flag: "wx" },
);
