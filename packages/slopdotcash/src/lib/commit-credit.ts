/** SCR-04: credit GitHub-linked primary authors, never vendor agent accounts. */
const AGENT_COMMIT_ACCOUNT_IDS: ReadonlySet<string> = new Set([
  "MDQ6VXNlcjgxODQ3", // claude (Anthropic)
  "U_kgDOD-0LXg", // codex (OpenAI)
  "U_kgDOC972lw", // cursoragent (Cursor)
]);

export function isCreditEligibleCommitAuthor(
  actor: { id: string; kind: string } | null,
): boolean {
  return (
    actor !== null &&
    actor.kind !== "Bot" &&
    !AGENT_COMMIT_ACCOUNT_IDS.has(actor.id)
  );
}
