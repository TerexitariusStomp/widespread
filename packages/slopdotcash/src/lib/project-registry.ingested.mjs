/**
 * The committed registry snapshot that build-time ingestion collected from.
 * The browser build swaps only `projects.mjs`'s import of the generated
 * snapshot for the runtime D1 registry (vite.config.ts); this module keeps the
 * snapshot, so the published ledger validates against the registry it used.
 */

export { RAW_PROJECT_DEFINITIONS } from "./project-registry.generated.mjs";
