/**
 * The browser build resolves `project-registry.generated.mjs` to this module
 * (vite.config.ts). `src/main.tsx` reads the current registry from the D1
 * project API and installs it before the app module loads, so every page
 * shows the registry as it is now, not as it was at build time.
 */

const installed = globalThis.__SLOP_PROJECT_REGISTRY__;
if (!Array.isArray(installed)) {
  throw new Error("[Slop] the project registry was not loaded");
}

export const RAW_PROJECT_DEFINITIONS = installed;
