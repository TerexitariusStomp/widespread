#!/usr/bin/env node
/**
 * ensure-spa-deps.mjs — `frontend/canary` is the vendored upstream Gitness
 * SPA: a standalone pnpm project with its own pnpm-workspace.yaml, lockfile,
 * and catalog. It is intentionally NOT a member of the root pnpm workspace,
 * and it is NOT committed to git — it is materialized on demand by
 * `frontend/fetch-canary.sh` (upstream clone + patches + overlay; see
 * frontend/UPSTREAM.md).
 *
 * This guard runs before the canary build steps:
 *   1. If `frontend/canary` is missing or its `.upstream-pin` does not match
 *      the pinned upstream commit, run `frontend/fetch-canary.sh`.
 *   2. If `frontend/canary/node_modules` is absent (fresh checkout / clean),
 *      install the canary workspace.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const frontendDir = join(dirname(fileURLToPath(import.meta.url)), "..", "frontend");
const canaryDir = join(frontendDir, "canary");
const pinFile = join(canaryDir, ".upstream-pin");

// Keep in sync with UPSTREAM_PIN_COMMIT in frontend/fetch-canary.sh.
const EXPECTED_PIN = "4aeb71467366f585b4f98270b872e8fdde13fd2b";

let pin = null;
try {
  pin = readFileSync(pinFile, "utf8").trim();
} catch {
  // missing canary tree or pin file — fetch below
}

if (pin !== EXPECTED_PIN) {
  console.log("[build:spa] frontend/canary missing or stale — running frontend/fetch-canary.sh");
  const res = spawnSync(join(frontendDir, "fetch-canary.sh"), ["--force"], {
    stdio: "inherit",
    shell: false,
  });
  if (res.status !== 0) {
    console.error("[build:spa] fetch-canary.sh failed");
    process.exit(res.status ?? 1);
  }
}

const canaryModules = join(canaryDir, "node_modules");
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
