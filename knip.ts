import type { KnipConfig } from "knip";

// Knip workspaces mirror pnpm-workspace.yaml (packages/*). Per-package
// entry points are spelled out because several runtimes hide their real
// entries from static analysis:
//   - Cloudflare Workers: the fetch/scheduled handler module (wrangler
//     `main`), Durable Object classes bound by name in wrangler.jsonc.
//   - Vite browser entrypoints referenced as path strings
//     (src/client/entrypoints.ts -> vite.config.ts `input`).
//   - near-sdk-js contract sources use decorators knip can't see; the
//     built contract.js under contracts/*/build is generated.
//   - hermes vendor/* is the vendored hermes-agent subtree (own release
//     cadence) — excluded entirely, like delta-git/frontend/canary.
const config: KnipConfig = {
  workspaces: {
    "packages/protocol": {
      entry: ["src/index.ts", "bin/widespread-sign.mjs", "test/**/*.test.ts"],
      project: ["src/**/*.ts", "bin/**/*.mjs", "test/**/*.ts"],
    },
    "packages/bridge": {
      entry: ["src/index.ts", "test/**/*.test.ts", "scripts/*.mjs"],
      project: ["src/**/*.ts", "test/**/*.ts", "scripts/*.mjs"],
    },
    "packages/near": {
      entry: [
        "contracts/*/contract.src.js",
        "contracts/*/deploy.js",
        "contracts/market/release.js",
        "scripts/*.mjs",
        "test/*.test.mjs",
        "test/harness.mjs",
        "test/near-sdk-js-stub.mjs",
      ],
      project: ["contracts/**/*.js", "scripts/**/*.mjs", "test/**/*.mjs"],
    },
    "packages/hermes": {
      entry: [
        "src/**/*.js",
        "src/**/*.mjs",
        "relay/src/index.ts",
        "proxy-worker/worker.js",
        "public/_worker.js",
        "scripts/*.mjs",
        "tests/*.test.mjs",
      ],
      project: [
        "src/**/*.{js,mjs}",
        "relay/src/**/*.ts",
        "proxy-worker/**/*.js",
        "public/_worker.js",
        "scripts/*.mjs",
        "tests/*.mjs",
      ],
      // vendor/hermes-agent is a vendored upstream tree; dist/ and
      // assets/ are build outputs. host-agent/plugin-catalog are data.
      ignore: ["vendor/**", "dist/**", "assets/**", "host-agent/**", "plugin-catalog/**"],
      // hermes/relay is a nested npm package (own package-lock, not a pnpm
      // workspace member) — partyserver resolves from its own
      // node_modules, invisible to this workspace's dep analysis.
      // coincident/penpal/partysocket/@wllama/wllama are consumed by
      // scripts/assemble.mjs via node_modules/<pkg>/dist path copies into
      // dist/vendor — no import specifier exists for knip to see.
      ignoreDependencies: [
        "partyserver",
        "coincident",
        "penpal",
        "partysocket",
        "@wllama/wllama",
      ],
      // ./vendor/*.js and ./pyodide/*.mjs imports are generated/copied into
      // src/vendor at build time (scripts/vendor.sh + pack scripts) — the
      // sources live outside the analyzed tree.
      // Values containing regex metacharacters are compiled as RegExp by
      // knip (see knip's isRegexLike) — use real patterns, not globs.
      ignoreUnresolved: [
        ".*/vendor/.*",
        ".*/pyodide/.*",
        ".*vendor-wllama\\.js",
        ".*/wasi/.*",
        "/local-llm.js",
      ],
    },
    "packages/runner": {
      entry: ["src/runner.js", "src/claim.js", "test/*.test.mjs"],
      project: ["src/**/*.js", "test/**/*.mjs"],
      // tpm2_pcrread/tpm2_quote are host binaries exec'd on self-hosted
      // machines — not npm packages.
      ignoreBinaries: ["tpm2_pcrread", "tpm2_quote"],
    },
    "packages/solana": {
      entry: ["src/**/*.js", "test/*.test.mjs"],
      project: ["src/**/*.js", "test/**/*.mjs"],
    },
    "packages/bot": {
      entry: ["index.js", "verdict.js", "test/*.test.mjs"],
      project: ["*.js", "test/**/*.mjs"],
      // probot is the app runtime that loads index.js's default export —
      // provided by the probot host/GitHub Action, not imported directly.
      ignoreDependencies: ["probot"],
    },
    "packages/delta-git": {
      entry: [
        "src/worker/index.ts",
        "cli/*.ts",
        "tools/*.ts",
        "scripts/*.ts",
        "scripts/*.mjs",
        // Vite browser entrypoints — referenced as path strings in
        // src/client/entrypoints.ts consumed by vite.config.ts `input`.
        "src/client/entries/*.ts",
        "test/**/*.ts",
        "e2e/**/*.ts",
        // drizzle-kit --config targets (npm run db:generate[:repo|:d1]).
        "drizzle-*.config.ts",
        // vite.config.ts is the SPA build config — knip's vite plugin is
        // disabled above (it cannot load under this wrangler version), so
        // declare the config file itself as an entry.
        "vite.config.ts",
      ],
      project: [
        "src/**/*.{ts,tsx}",
        "cli/**/*.ts",
        "tools/**/*.ts",
        "scripts/**/*.{ts,mjs}",
        "test/**/*.ts",
        "e2e/**/*.ts",
        "*.config.ts",
      ],
      // frontend/canary is the vendored SPA (separate upstream project with
      // its own lockfile) — never analyze it here.
      // The files below src/worker/auth/dpop/ are upstream-owned (absent
      // from OURS.md): upstream sync would restore them, so knip must not
      // flag them even if they look dead.
      ignore: [
        "frontend/**",
        "src/worker/auth/dpop/challenge.ts",
        "src/worker/auth/dpop/dpop.ts",
        "src/worker/auth/dpop/encoding.ts",
        "src/worker/auth/dpop/metrics.ts",
      ],
      // vite.config.ts imports @cloudflare/vite-plugin, whose peer range
      // (^4.156.1) exceeds this workspace's installed wrangler (4.140.0),
      // and vitest.config.ts resolves './wrangler.jsonc' relative to the
      // repo root. Both configs fail to load under knip — disable those
      // plugins; the browser entrypoints are already declared above.
      vite: false,
      vitest: false,
      // Deps knip cannot see:
      //   @primer/primitives — CSS-only @import in src/client/styles/app.css.
      //   tailwindcss — peer of @tailwindcss/vite; vite.config.ts fails to
      //     load under knip in this environment (wrangler peer mismatch).
      //   @cloudflare/vite-plugin / @tailwindcss/vite / @vitejs/plugin-react
      //     — imported only by vite.config.ts, which the disabled vite
      //     plugin cannot analyze; all three ARE used by the SPA build.
      ignoreDependencies: [
        "@primer/primitives",
        "tailwindcss",
        "@cloudflare/vite-plugin",
        "@tailwindcss/vite",
        "@vitejs/plugin-react",
      ],
      // tpm2_pcrread/tpm2_quote are host binaries exec'd by the runner
      // claim flow on self-hosted machines — not npm packages.
      ignoreBinaries: ["tpm2_pcrread", "tpm2_quote"],
    },
  },
};

export default config;
