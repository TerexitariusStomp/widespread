#!/usr/bin/env node
/**
 * build-contract.mjs — compile NEAR contracts from source to wasm.
 *
 * Each `contracts/<name>/contract.src.js` is handed DIRECTLY to
 * `near-sdk-js build`, which runs its own rollup + babel pipeline
 * (legacy decorators) and then QuickJS → wasm. Its postinstall (allowed
 * via the root pnpm-workspace.yaml `allowBuilds`) provides the QuickJS/wasi
 * toolchain.
 *
 * Footgun: do NOT pre-bundle the source with esbuild/TS decorators. That
 * lowers `@call`/`@view` into `__decorateClass(...)` calls before
 * near-sdk-js sees them, so its babel plugin generates no per-method
 * wrappers and the wasm exports ONLY the class (methods.h lists one entry)
 * — it deploys fine but every method call fails with MethodNotFound.
 * After each build we assert that `build/methods.h` exports at least one
 * method beyond the class name to catch that regression.
 *
 * Usage: node scripts/build-contract.mjs [name ...]
 *   no args → builds every contract in CONTRACTS (market, hats, futarchy)
 *   e.g. node scripts/build-contract.mjs futarchy
 *
 * Output: contracts/<name>/build/contract.wasm (+ intermediates). The wasm
 * target must live under `build/` — near-sdk-js stages builder.c next to it
 * and its `#include "../node_modules/..."` paths only resolve from that
 * directory (each contract dir has a node_modules → ../../node_modules
 * symlink). Outputs are gitignored, never committed.
 */
import { mkdirSync, readFileSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS = ["market", "hats", "futarchy"];
const WASM_TARGET = "build/contract.wasm";

const cli = join(pkgRoot, "node_modules", "near-sdk-js", "lib", "cli", "cli.js");

/** Parse near-sdk-js's generated methods.h into exported names. */
function exportedMethods(dir) {
  return readFileSync(join(dir, "build", "methods.h"), "utf8")
    .split("\n")
    .map((l) => /^DEFINE_NEAR_METHOD\((\w+)\)/.exec(l)?.[1])
    .filter(Boolean);
}

function buildOne(name) {
  const dir = join(pkgRoot, "contracts", name);
  // near-sdk-js writes intermediates into ./build/ relative to cwd and does
  // not create it — make sure it exists first.
  mkdirSync(join(dir, "build"), { recursive: true });
  const res = spawnSync(
    process.execPath,
    [cli, "build", "contract.src.js", WASM_TARGET],
    { stdio: "inherit", cwd: dir }
  );
  if (res.status !== 0) {
    console.error(`[build] ${name}: near-sdk-js build failed (${res.status})`);
    return false;
  }
  // The first entry is the contract class itself; anything less than one
  // more means decorators were lost (see footgun above).
  const methods = exportedMethods(dir);
  if (methods.length < 2) {
    console.error(`[build] ${name}: wasm exports no methods (${methods.join(",")})`);
    return false;
  }
  const size = statSync(join(dir, WASM_TARGET)).size;
  console.log(
    `[build] ${name}: ${WASM_TARGET} ${size} bytes, ${methods.length - 1} methods`
  );
  return true;
}

const names = process.argv.slice(2);
const targets = names.length ? names : CONTRACTS;
const unknown = targets.filter((n) => !CONTRACTS.includes(n));
if (unknown.length) {
  console.error(`unknown contract(s): ${unknown.join(", ")} — expected ${CONTRACTS.join("|")}`);
  process.exit(1);
}
let ok = true;
for (const name of targets) ok = buildOne(name) && ok;
process.exit(ok ? 0 : 1);
