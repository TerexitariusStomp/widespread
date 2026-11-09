import { type D1Migration } from "cloudflare:test";

// Load every SQL migration file at import time (`eager: true`) so workerd
// doesn't need filesystem access — same trick delta-git uses, minus the
// drizzle journal (we glob + sort filenames instead).
const sqlFiles = import.meta.glob("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function splitStatements(sql: string): string[] {
  // Strip -- comments BEFORE splitting on ";" — a semicolon inside a
  // comment would otherwise leak comment text in as a "statement".
  return sql
    .split("\n")
    .map((line) => line.replace(/\s*--.*$/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function readAppD1Migrations(): D1Migration[] {
  return Object.entries(sqlFiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fileName, sql]) => ({
      name: fileName.split("/").pop() ?? fileName,
      queries: splitStatements(sql),
    }));
}
