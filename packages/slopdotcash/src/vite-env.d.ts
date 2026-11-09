/**
 * Supplies Vite's asset and stylesheet module declarations to TypeScript.
 */

/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Overrides the project registry source; only the browser-test fixture sets it. */
  readonly VITE_SLOP_PROJECT_REGISTRY_URL?: string;
}
