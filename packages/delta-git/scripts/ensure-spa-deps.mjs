#!/usr/bin/env node
/**
 * ensure-spa-deps.mjs — `frontend/canary` is the vendored upstream Gitness
 * SPA: a standalone pnpm project with its own pnpm-workspace.yaml, lockfile,
 * and catalog. It is intentionally NOT a member of the root pnpm workspace,
 * so its dependencies are not installed by the root `pnpm install`.
 *
 * This guard runs before the canary build steps: if
 * `frontend/canary/node_modules` is absent (fresh checkout / clean), it
 * installs the canary workspace first. No-op when deps are already present.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const canaryModules = new URL("../frontend/canary/node_modules/", import.meta.url);
if (existsSync(canaryModules)) {
  process.exit(0);
}

console.log("[build:spa] frontend/canary/node_modules missing — installing canary workspace deps");
// canary's own pnpm-workspace.yaml makes it a separate workspace root, so a
// plain `pnpm -C frontend/canary install` resolves its catalog/lockfile
// correctly without involving the root workspace.
const res = spawnSync("pnpm -C frontend/canary install", {
  stdio: "inherit",
  shell: true,
});
process.exit(res.status ?? 1);
