#!/usr/bin/env node
/**
 * build-contract.mjs — compile a NEAR contract from source to wasm.
 *
 * Pipeline (two steps, both required):
 *   1. esbuild bundles `contract.src.js` → `contract.js`. The source uses
 *      near-sdk-js decorators, which esbuild only parses as TypeScript —
 *      same trick as test/harness.mjs: stage the source as `.ts` in a temp
 *      dir so the TS parser + experimentalDecorators apply.
 *   2. `near-sdk-js build` compiles `contract.js` → wasm. Its postinstall
 *      (allowed via the root pnpm-workspace.yaml `allowBuilds`) provides
 *      the QuickJS/wasi toolchain.
 *
 * Usage: node scripts/build-contract.mjs <contractDir> [wasmTarget]
 *   e.g. node scripts/build-contract.mjs contracts/market build/contract.wasm
 *
 * The wasm target must live under `build/` — near-sdk-js stages builder.c
 * next to it and its `#include "../node_modules/..."` paths only resolve
 * from that directory. Outputs are gitignored, never committed.
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

const [contractDir, wasmTarget = "build/contract.wasm"] = process.argv.slice(2);
if (!contractDir) {
  console.error("usage: build-contract.mjs <contractDir> [wasmTarget]");
  process.exit(1);
}

const dir = resolve(contractDir);
const srcPath = join(dir, "contract.src.js");
const outJs = join(dir, "contract.js");

// Stage as .ts inside the contract dir so esbuild's TS parser handles the
// decorators AND bare imports ("near-sdk-js") resolve through the package's
// node_modules — a /tmp entry point has no resolvable node_modules above it.
const tsPath = join(dir, ".contract.build.ts");
try {
  writeFileSync(tsPath, readFileSync(srcPath, "utf8"));
  await build({
    entryPoints: [tsPath],
    bundle: true,
    format: "esm",
    platform: "neutral",
    // near-sdk-js only declares "main" (no exports/module) — neutral
    // platform ignores main fields unless listed explicitly.
    mainFields: ["main"],
    target: "es2020",
    sourcemap: true,
    outfile: outJs,
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    logLevel: "info",
  });
} finally {
  rmSync(tsPath, { force: true });
}

// near-sdk-js writes intermediates into ./build/ relative to cwd and does
// not create it — make sure it exists first.
mkdirSync(join(dir, "build"), { recursive: true });

// near-sdk-js CLI — resolved relative to the package root (pnpm layout).
// Run with cwd = contract dir and the same relative args the old npm script
// used, so output lands in `<contractDir>/build/` as deploy.js expects.
const cli = join(
  dir,
  "..",
  "..",
  "node_modules",
  "near-sdk-js",
  "lib",
  "cli",
  "cli.js"
);
const res = spawnSync(
  process.execPath,
  [cli, "build", "contract.js", wasmTarget],
  { stdio: "inherit", cwd: dir }
);
process.exit(res.status ?? 1);
