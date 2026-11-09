/** Private isolated-analysis report. Exact bytes do not establish release authority. */
import { assemblyRecord as record } from "./assembly-manifest";

const HEX = /^[a-f0-9]{64}$/u;
function sha(value: unknown): string {
  if (typeof value !== "string" || !HEX.test(value))
    throw new Error("Invalid provenance digest");
  return value;
}
function size(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error("Invalid provenance size");
  return Number(value);
}
function gaps(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 1024 ||
    value.some((item) => typeof item !== "string" || item.length > 256)
  )
    throw new Error("Invalid provenance coverage");
  return value as string[];
}
function file(value: unknown) {
  if (value === null) return null;
  const row = record(value);
  if (row.executable !== null && typeof row.executable !== "boolean")
    throw new Error("Invalid provenance mode");
  return {
    sha256: sha(row.sha256),
    bytes: size(row.bytes),
    executable: row.executable as boolean | null,
  };
}

export function parseProvenanceReport(value: unknown) {
  const report = record(value);
  const source = record(report.source);
  if (
    report.schema !== "slop-provenance-comparison-v1" ||
    report.state !== "quarantined" ||
    report.executionAuthorized !== false ||
    report.publicationAuthorized !== false ||
    typeof source.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(source.repository) ||
    typeof source.commitSha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(source.commitSha) ||
    typeof source.treeSha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(source.treeSha) ||
    !Array.isArray(report.inputs) ||
    report.inputs.length !== 3 ||
    !Array.isArray(report.changes) ||
    report.changes.length > 2048
  )
    throw new Error("Unsupported provenance report");
  const roles = ["source-inventory", "source-archive", "release-archive"];
  const inputs = report.inputs.map((value, index) => {
    const input = record(value);
    if (input.role !== roles[index])
      throw new Error("Invalid provenance input role");
    const bytes = size(input.bytes);
    if (bytes > (index === 0 ? 2 : 32) * 1024 * 1024)
      throw new Error("Provenance input exceeds bound");
    return { role: roles[index], sha256: sha(input.sha256), bytes };
  });
  const paths = new Set<string>();
  const changes = report.changes.map((value) => {
    const change = record(value);
    const path = change.path;
    if (
      typeof path !== "string" ||
      !path ||
      path.length > 1024 ||
      Array.from(path).some(
        (character) =>
          character === "\\" ||
          character === ":" ||
          character.charCodeAt(0) < 32,
      ) ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      paths.has(path)
    )
      throw new Error("Invalid provenance path");
    paths.add(path);
    const before = file(change.source);
    const after = file(change.release);
    if ((!before && !after) || (before && before.executable === null))
      throw new Error("Invalid provenance comparison");
    const disposition = !before
      ? "added"
      : !after
        ? "removed"
        : before.sha256 !== after.sha256
          ? "changed"
          : after.executable === null
            ? "metadata-unavailable"
            : before.executable !== after.executable
              ? "mode-changed"
              : "identical-bytes-and-executable-bit";
    if (
      change.disposition !== disposition ||
      (before &&
        after &&
        before.sha256 === after.sha256 &&
        before.bytes !== after.bytes)
    )
      throw new Error("Provenance disposition mismatch");
    return { path, disposition, source: before, release: after };
  });
  return {
    source: {
      repository: source.repository,
      commitSha: source.commitSha,
      treeSha: source.treeSha,
    },
    inputs,
    changes,
    visibilityGaps: gaps(report.visibilityGaps),
    sourceVisibilityGaps: gaps(report.sourceVisibilityGaps),
  };
}

/** Check the comparison's source side against the acquired inventory, not a label. */
export function bindProvenanceSource(
  report: ReturnType<typeof parseProvenanceReport>,
  sourceValue: unknown,
  inventorySha256: string,
) {
  const source = record(sourceValue);
  if (
    source.schema !== "slop-source-inventory-v1" ||
    source.state !== "quarantined" ||
    source.repository !== report.source.repository ||
    source.commitSha !== report.source.commitSha ||
    source.treeSha !== report.source.treeSha ||
    report.inputs[0]?.sha256 !== inventorySha256 ||
    !Array.isArray(source.records) ||
    JSON.stringify(gaps(source.visibilityGaps)) !==
      JSON.stringify(report.sourceVisibilityGaps)
  )
    throw new Error("Provenance source identity mismatch");
  const compared = new Map(
    report.changes
      .filter((change) => change.source)
      .map((change) => [change.path, change.source]),
  );
  if (source.records.length !== compared.size)
    throw new Error("Provenance source inventory mismatch");
  for (const value of source.records) {
    const entry = record(value);
    const observed = compared.get(String(entry.path));
    if (
      !observed ||
      entry.type !== "blob" ||
      entry.state !== "quarantined" ||
      (entry.mode !== "100644" && entry.mode !== "100755") ||
      entry.sha256 !== observed.sha256 ||
      entry.bytes !== observed.bytes ||
      (entry.mode === "100755") !== observed.executable
    )
      throw new Error("Provenance source bytes or mode mismatch");
    compared.delete(String(entry.path));
  }
  if (compared.size) throw new Error("Provenance source inventory mismatch");
}
