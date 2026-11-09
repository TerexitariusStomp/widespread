# Vendored upstream: harness/canary

- **Repo**: https://github.com/harness/canary
- **Pinned ref**: tag `mfe.alpha.2819` (commit `4aeb71467366f585b4f98270b872e8fdde13fd2b`)
- **License**: Apache-2.0 (see `canary/LICENSE` after fetch)

## Mechanism: fetch + patch + overlay

`frontend/canary/` is **not committed** to this repository (it is gitignored).
It is materialized on demand by `frontend/fetch-canary.sh`, which:

1. Shallow-clones `harness/canary` at tag `mfe.alpha.2819` and verifies HEAD
   equals the pinned commit (fails loudly if the tag moved).
2. Prunes upstream surfaces we do not vendor (see below).
3. Applies every `frontend/patches/*.patch` with `git apply` — one patch per
   top-level package (`gitness`, `ui`, `views`, `filters`, `forms`,
   `pipeline-graph`, `yaml-editor`) plus `root.patch` for root dotfiles.
   Patches only contain *modifications* to upstream files.
4. Copies every file under `frontend/overlay/` over the tree — files that
   exist only in our tree (e.g. `apps/gitness/src/pages-delta/`,
   `src/delta/`, new `pages-v2/` routes) plus whole-file replacements that
   do not patch well (`pnpm-lock.yaml`, `packages/ui/package.json`,
   `canary/UPSTREAM.md` — the historical provenance note kept inside the
   vendored tree).
5. Stamps `canary/.upstream-pin` with the pinned commit.

`frontend/fetch-canary.sh` is idempotent: it exits early when `.upstream-pin`
already matches. `scripts/ensure-spa-deps.mjs` invokes it automatically when
`build:spa` runs and the tree is missing or stale.

## What was imported (kept after pruning)

- `apps/gitness` — the Gitness SPA (React 17, Vite build)
- `packages/{ui,views,forms,filters,yaml-editor,pipeline-graph,core-design-system}` —
  its full `@harnessio/*` workspace dependency closure

## What is deliberately excluded (pruned by fetch-canary.sh)

- `apps/portal`, `apps/design-system`, `apps/sidebar-app` — docs/preview/MFE apps
- `packages/tests`, `packages/ai-chat-core` — test harness + unused chat package
- Root Dockerfiles, playwright config, CODEOWNERS, CI/docs/charts/eslint/husky
  dirs and dotfiles — upstream infra

## Local modifications

The authoritative list is the patch/overlay content itself; it is verified
byte-for-byte against the pinned upstream by re-running the fetch. Known
deltas (generated, not hand-maintained):

- `package.json` (canary root) — unchanged from upstream at this pin.
- `pnpm-lock.yaml` — overlay: regenerated/trimmed for our dependency set.
- `apps/gitness/package.json` — `@harnessio/react-ng-manager-*` deps removed
  (Harness-platform MFE clients, unused standalone).
- `packages/*/tsconfig.json` — `ignoreDeprecations: "5.0"` added.
- `packages/ui/package.json` + `ui/src` — markdown-viewer/search/nav tweaks
  for the delta-git reskin.
- `apps/gitness/src/delta/github-theme.css` — `github` theme for the
  delta-git reskin (the GitHub reskin is token-driven via this file).
- `apps/gitness/src/routes.tsx` + new `src/pages-v2/` + `src/delta/` —
  delta-git views (arena, ideas, agents, merge intents, secrets vault) wired
  into the SPA router; `window.apiUrl` points at the same-origin `/api/v1`
  facade served by the delta-git worker.
- `.gitignore` — adjusted for the vendored layout.

## Refreshing to a newer upstream

1. Bump `UPSTREAM_PIN_TAG` / `UPSTREAM_PIN_COMMIT` in `fetch-canary.sh`.
2. Run `frontend/fetch-canary.sh --force` in a scratch checkout of the new pin,
   diff against the old overlay target, and regenerate `patches/` + `overlay/`
   (the same git-diff workflow used to create them).
3. Re-run `npm run build:spa` from `packages/delta-git`.
