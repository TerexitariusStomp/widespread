/** Parses one bounded, unquoted single-line JSON record in a Markdown fence. */
export function parseFencedRecord(
  body: string,
  name: "slop-score" | "slop-score-approval" | "slop-review",
  malformedMessage = `${name} record JSON is malformed`,
): unknown | null {
  const pattern = new RegExp(
    "^ {0,3}```" +
      name +
      "[\\t ]*\\r?\\n([^\\r\\n]{1,32768})\\r?\\n {0,3}```[\\t ]*$",
    "gmu",
  );
  const matches = [...body.matchAll(pattern)];
  if (matches.length > 1)
    throw new TypeError(`source must contain at most one ${name} record`);
  if (matches.length === 0) return null;
  try {
    return JSON.parse(matches[0][1]);
  } catch {
    throw new TypeError(malformedMessage);
  }
}
