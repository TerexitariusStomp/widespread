/** Shared closure of captured filesystem entries; this grants no execution authority. */
import { assemblyRecord } from "./assembly-manifest";

export function assertFilesystemReferences(
  document: Record<string, unknown>,
  sizes: ReadonlyMap<string, number>,
) {
  if (
    !Array.isArray(document.phases) ||
    JSON.stringify(
      document.phases.map((phase) => assemblyRecord(phase).phase),
    ) !==
      JSON.stringify([
        "before-command",
        "after-traced-command",
        "after-post-collector-probe",
      ])
  )
    throw new Error("Missing filesystem phases");
  for (const value of document.phases) {
    const phase = assemblyRecord(value);
    if (!Array.isArray(phase.entries) || phase.entries.length > 256)
      throw new Error("Invalid filesystem entries");
    const names = new Set<string>();
    for (const value of phase.entries) {
      const entry = assemblyRecord(value);
      if (
        typeof entry.path !== "string" ||
        !entry.path ||
        new TextEncoder().encode(entry.path).length > 2048 ||
        Array.from(entry.path).some(
          (character) => character === "\\" || character.charCodeAt(0) < 32,
        ) ||
        entry.path
          .split("/")
          .some((part) => !part || part === "." || part === "..") ||
        names.has(entry.path)
      )
        throw new Error("Invalid filesystem entry path");
      names.add(entry.path);
      if (
        (entry.sha256 !== undefined ||
          entry.capturedBytes !== undefined ||
          entry.stable === true) &&
        (entry.kind !== "file" ||
          typeof entry.sha256 !== "string" ||
          !sizes.has(entry.sha256) ||
          sizes.get(entry.sha256) !== entry.capturedBytes)
      )
        throw new Error("Filesystem entry refers to missing content");
    }
  }
}
