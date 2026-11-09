// vitest.config.ts — bridge tests run inside real workerd via
// @cloudflare/vitest-pool-workers. Bindings (KV CLAIMS, vars) come from
// wrangler.jsonc; secrets are merged into a generated wrangler config's
// `vars` from .dev.vars + process.env so tests exercise the same
// credentials the deployed worker uses. The generated file is gitignored.
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

/** Parse KEY=value lines out of .dev.vars (gitignored local secrets). */
function devVars(): Record<string, string> {
  const file = path.join(import.meta.dirname, ".dev.vars");
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

// Secrets/env the tests need beyond wrangler.jsonc vars. Anything absent
// stays undefined and the dependent test legs skip with a clear message.
const testEnv: Record<string, string> = {
  ...devVars(),
  GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
  NEAR_OPS_ACCOUNT: process.env.NEAR_OPS_ACCOUNT ?? "",
  NEAR_OPS_SECRET_KEY: process.env.NEAR_OPS_SECRET_KEY ?? "",
  NEAR_AI_API_KEY: process.env.NEAR_AI_API_KEY ?? "",
  E2E_LIVE: process.env.E2E_LIVE ?? "",
  // Deterministic HMAC secret for attestation-token tests — self-contained
  // crypto, no external service involved.
  ATTEST_SECRET: process.env.ATTEST_SECRET ?? "test-attest-secret",
};

// NEAR ops credentials live in ~/.widespread-near-ops.json on dev machines
// ({accountId, secretKey, publicKey}). Fall back to it when the env vars
// aren't set so `pnpm test` picks them up without manual exports.
if (!testEnv.NEAR_OPS_SECRET_KEY) {
  try {
    const opsPath = path.join(process.env.HOME ?? "", ".widespread-near-ops.json");
    if (existsSync(opsPath)) {
      const ops = JSON.parse(readFileSync(opsPath, "utf8")) as {
        accountId?: string; secretKey?: string;
      };
      if (ops.accountId && ops.secretKey) {
        testEnv.NEAR_OPS_ACCOUNT ||= ops.accountId;
        testEnv.NEAR_OPS_SECRET_KEY = ops.secretKey;
      }
    }
  } catch { /* no creds file — escrow legs will skip */ }
}

// wrangler.jsonc is JSONC — strip comments/commas the naive way via the
// same trick delta-git uses: JSON.parse after comment stripping.
function stripJsonc(source: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLine) {
      if (ch === "\n") { inLine = false; out += ch; }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") { out += next ?? ""; i++; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === "/" && next === "/") { inLine = true; i++; continue; }
    if (ch === "/" && next === "*") { inBlock = true; i++; continue; }
    out += ch;
  }
  // Second pass: drop trailing commas. Comments are already gone, so a
  // `,` outside strings followed only by whitespace then } or ] is safe
  // to remove. Strings are tracked so commas inside values survive.
  let res = "";
  let inStr = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (inStr) {
      res += ch;
      if (ch === "\\") { res += out[i + 1] ?? ""; i++; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; res += ch; continue; }
    if (ch === ",") {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === "}" || out[j] === "]") continue;
    }
    res += ch;
  }
  return res;
}

function writeTestWranglerConfig(): string {
  const parsed = JSON.parse(stripJsonc(readFileSync("./wrangler.jsonc", "utf8")));
  parsed.vars = { ...(parsed.vars ?? {}), ...testEnv };
  const configPath = path.join(import.meta.dirname, ".vitest.wrangler.json");
  writeFileSync(configPath, JSON.stringify(parsed, null, 2));
  return configPath;
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      wrangler: { configPath: writeTestWranglerConfig() },
      // Single shared isolate: tests share the real local KV namespace, so
      // seeded feed:doc / escrowstate records are visible across files.
      // Tests must use unique ids — never assume a clean KV.
      singleWorker: true,
      isolatedStorage: false,
      // The `ai` binding is remote-only; tests never invoke adjudication.
      remoteBindings: false,
      miniflare: {
        kvPersist: false,
        compatibilityDate: "2025-10-01",
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
    // Files share one real KV namespace (singleWorker); serialize them so
    // feed:doc / escrowstate seeds can't race each other.
    fileParallelism: false,
  },
});
