# UPSTREAMS.md — upstream provenance and sync boundaries

This monorepo vendors or tracks four upstream projects. This file is the
single place that records where each one comes from, what we own, and how to
refresh it. The rule of thumb: **we maintain only our own code** — everything
else should be reproducible from upstream.

## 1. git-on-cloudflare → `packages/delta-git` (git subtree)

| | |
|---|---|
| Upstream | https://github.com/zllovesuki/git-on-cloudflare |
| License | MIT |
| Fork base commit | `007a96eae94c8f562d223f81eb7548c8f7c38673` (present in our history via `git subtree`) |
| Integration | `git subtree` — upstream history is merged, not squashed |
| Owned surface | `packages/delta-git/OURS.md` (generated list of every file we add/change vs the base commit, grouped by subsystem) |

**Sync procedure** — from the repo root:

```bash
packages/delta-git/scripts/sync-upstream.sh --dry-run   # preview conflicts
packages/delta-git/scripts/sync-upstream.sh             # git subtree pull
```

which runs:

```bash
git subtree pull --prefix=packages/delta-git \
  https://github.com/zllovesuki/git-on-cloudflare main
```

Post-sync checklist: resolve conflicts per `OURS.md`, regenerate drizzle
migrations from the repo-DO schema (`npm run db:generate`, squashed baseline
policy), keep the Worker name `delta-git`, run `npm run typecheck` + worker
tests. The script prints this checklist on failure.

Note: `packages/delta-git/frontend/canary` is gitignored and is **not** part
of the subtree — it is materialized separately (see §2).

## 2. harness/canary → `packages/delta-git/frontend/canary` (fetch + patch + overlay)

| | |
|---|---|
| Upstream | https://github.com/harness/canary |
| License | Apache-2.0 |
| Pinned ref | tag `mfe.alpha.2819` = commit `4aeb71467366f585b4f98270b872e8fdde13fd2b` |
| Integration | Not vendored as files. `frontend/fetch-canary.sh` shallow-clones the tag, prunes excluded apps/packages/infra, applies `frontend/patches/*.patch` (one per package + `root.patch`), then overlays `frontend/overlay/` (new files + `pnpm-lock.yaml` + `packages/ui/package.json`). Stamps `.upstream-pin`. |
| Owned surface | `frontend/patches/` + `frontend/overlay/`; mechanism docs in `frontend/UPSTREAM.md` |

`frontend/canary/` is gitignored and materialized on demand —
`scripts/ensure-spa-deps.mjs` runs `fetch-canary.sh` automatically when
`npm run build:spa` finds the tree missing or the pin stale. To refresh:
bump `UPSTREAM_PIN_*` in `fetch-canary.sh`, regenerate patches/overlay against
the new tag, rebuild.

## 3. NousResearch/hermes-agent → `packages/hermes/vendor/hermes-agent`

| | |
|---|---|
| Upstream | https://github.com/NousResearch/hermes-agent |
| License | MIT |
| Pinned ref | `HERMES_REF` in `packages/hermes/scripts/vendor.sh` |
| Integration | Fetched by `packages/hermes/scripts/vendor.sh` at vendor time; not committed |

## 4. slopdotcash → `upstream-patches/slopdotcash/` (not vendored)

| | |
|---|---|
| Upstream | SlopDotCash org (see `upstream-patches/slopdotcash/`) |
| Integration | Not vendored. Our one-commit fix lives as a patch under `upstream-patches/slopdotcash/` to be offered/applied upstream. |
