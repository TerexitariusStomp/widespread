# OURS.md — delta-git owned surface

This file lists the files/areas **we own and modify** in the
`packages/delta-git` subtree of the `git-on-cloudflare` fork.
Everything not listed here is expected to track upstream
(`zllovesuki/git-on-cloudflare`) and should be refreshed via
`scripts/sync-upstream.sh` (see `UPSTREAMS.md` at the repo root).

Generated from `git diff --name-only 007a96eae94c8f562d223f81eb7548c8f7c38673..HEAD`
excludes `frontend/` (the vendored SPA has its own fetch+patch+overlay
mechanism — see `frontend/UPSTREAM.md`).

After a subtree sync, drizzle migrations under `drizzle/` are
**regenerated from `src/worker/do/repo/db/schema.ts`** (squashed
baseline policy — do not hand-merge migration files). The Worker
name remains `delta-git` regardless of upstream renames.

## delta workflows (1 files)

```
.delta/workflows/ci.yml
```

## root/config (23 files)

```
.dev.vars.example
.gitattributes
.gitignore
.gitleaksignore
.prettierignore
.prettierrc
.trivyignore
AGENTS.md
CLAUDE.md
LICENSE
NOTICE
PRODUCT.md
README.md
drizzle-d1.config.ts
drizzle-repo-do.config.ts
funding.json
package.json
playwright.config.ts
tsconfig.json
vite.config.ts
vitest.config.ts
vitest.unit.config.ts
wrangler.jsonc
```

## agent rules (7 files)

```
.windsurf/rules/dal.md
.windsurf/rules/decision-making.md
.windsurf/rules/environment.md
.windsurf/rules/typescript.md
.windsurf/rules/ui.md
.windsurf/rules/windows-npm.md
.windsurf/rules/wrangler.md
```

## cli (3 files)

```
cli/dgit.ts
cli/oauth.ts
cli/scan.ts
```

## containers (1 files)

```
containers/forge/Dockerfile
```

## docs (31 files)

```
docs/agent-integration.md
docs/agent-layer.md
docs/api-endpoints.md
docs/architecture.md
docs/archive/sidecar-backed-fetch-closure-proposal.md
docs/archive/streaming-push-closure-plan.md
docs/archive/streaming-push-cutover-plan.md
docs/archive/tessera-ownership-migration-plan.md
docs/arena.md
docs/better-fetch.md
docs/caching.md
docs/data-flows.md
docs/dgs/DGS-01-signed-requests.md
docs/dgs/DGS-02-error-codes.md
docs/dgs/DGS-03-rep-certs.md
docs/dgs/DGS-04-bundle-uri.md
docs/diff.md
docs/federation.md
docs/funding/budget-milestones.md
docs/funding/commercial-surface.md
docs/funding/one-pager.md
docs/funding/otf-concept-note.md
docs/funding/traction.md
docs/github-parity.md
docs/ops.md
docs/oss-licenses.md
docs/security.md
docs/site-smith.md
docs/slop-integration.md
docs/storage.md
docs/streaming-push.md
```

## drizzle (migrations) (7 files)

```
drizzle/d1/0000_rainy_tenebrous.sql
drizzle/d1/meta/0000_snapshot.json
drizzle/d1/meta/_journal.json
drizzle/repo-do/0000_youthful_ronan.sql
drizzle/repo-do/meta/0000_snapshot.json
drizzle/repo-do/meta/_journal.json
drizzle/repo-do/migrations.js
```

## e2e (3 files)

```
e2e/a11y.spec.ts
e2e/mobile.spec.ts
e2e/nav-crawl.spec.ts
```

## scripts (4 files)

```
scripts/copy-spa.mjs
scripts/dry-run.ts
scripts/ensure-spa-deps.mjs
scripts/smoke-git.ts
```

## client (SSR) (36 files)

```
src/client/components/AppLayout.tsx
src/client/components/footer.tsx
src/client/components/header.tsx
src/client/components/markdownHtmlSanitizer.ts
src/client/components/ui/badge.tsx
src/client/components/ui/button.tsx
src/client/components/ui/card.tsx
src/client/components/ui/empty-state.tsx
src/client/components/ui/error-banner.tsx
src/client/components/ui/index.ts
src/client/components/ui/input.tsx
src/client/components/ui/page-header.tsx
src/client/entries/did-signin.ts
src/client/entries/shell.ts
src/client/entries/styles.ts
src/client/entrypoints.ts
src/client/highlight-theme.ts
src/client/hydrate.tsx
src/client/islands/copy-button.tsx
src/client/islands/did-signin.tsx
src/client/islands/theme-toggle.tsx
src/client/json.ts
src/client/on-ready.ts
src/client/pages/AuthSignInPage.tsx
src/client/pages/ErrorPage.tsx
src/client/pages/NotFoundPage.tsx
src/client/server/IslandHost.tsx
src/client/server/assets.ts
src/client/server/document.tsx
src/client/server/error.ts
src/client/server/manifest.ts
src/client/server/registry.tsx
src/client/server/render.tsx
src/client/server/viewer.ts
src/client/styles.css
src/client/styles/app.css
```

## shared (11 files)

```
src/shared/arena.ts
src/shared/git/ref-display.ts
src/shared/git/types.ts
src/shared/slugs.ts
src/shared/web/format.ts
src/shared/web/http.ts
src/shared/web/index.ts
src/shared/web/json.ts
src/shared/web/mime.ts
src/shared/web/syntax.ts
src/shared/web/validation.ts
```

## src/other (2 files)

```
src/types/drizzle-migrations.d.ts
src/vite-env.d.ts
```

## vendor/widespread (14 files)

```
src/vendor/widespread/UPSTREAM.md
src/vendor/widespread/auth/challenge.ts
src/vendor/widespread/auth/didkey.ts
src/vendor/widespread/auth/dpop.ts
src/vendor/widespread/auth/headers.ts
src/vendor/widespread/auth/index.ts
src/vendor/widespread/auth/jwt.ts
src/vendor/widespread/auth/metrics.ts
src/vendor/widespread/auth/pds.ts
src/vendor/widespread/crypto/aes.ts
src/vendor/widespread/crypto/encoding.ts
src/vendor/widespread/crypto/index.ts
src/vendor/widespread/crypto/kdf.ts
src/vendor/widespread/crypto/signing.ts
```

## worker/agent (23 files)

```
src/worker/agent/abuse.ts
src/worker/agent/atpauth/challenge.ts
src/worker/agent/atpauth/didkey.ts
src/worker/agent/atpauth/jwt.ts
src/worker/agent/atpauth/oauth.ts
src/worker/agent/atpauth/pds.ts
src/worker/agent/atpauth/serviceAuth.ts
src/worker/agent/atpauth/verify.ts
src/worker/agent/attest.ts
src/worker/agent/auth.ts
src/worker/agent/clef.ts
src/worker/agent/dids.ts
src/worker/agent/importer.ts
src/worker/agent/manifest.ts
src/worker/agent/overnight.ts
src/worker/agent/patch.ts
src/worker/agent/prompts/siteSmith.ts
src/worker/agent/repCert.ts
src/worker/agent/runtime.ts
src/worker/agent/secrets.ts
src/worker/agent/secretscan.ts
src/worker/agent/siteSmith.ts
src/worker/agent/webhooks.ts
```

## worker/api (42 files)

```
src/worker/api/gitness/archival.ts
src/worker/api/gitness/certProbe.ts
src/worker/api/gitness/chaos.ts
src/worker/api/gitness/codeowners.ts
src/worker/api/gitness/codescan.ts
src/worker/api/gitness/commitFiles.ts
src/worker/api/gitness/commitmeta.ts
src/worker/api/gitness/delivery.ts
src/worker/api/gitness/depgraph.ts
src/worker/api/gitness/devx.ts
src/worker/api/gitness/discussions.ts
src/worker/api/gitness/dr.ts
src/worker/api/gitness/executions.ts
src/worker/api/gitness/funding.ts
src/worker/api/gitness/ghimport.ts
src/worker/api/gitness/gists.ts
src/worker/api/gitness/gitdata.ts
src/worker/api/gitness/index.ts
src/worker/api/gitness/insights.ts
src/worker/api/gitness/issues.ts
src/worker/api/gitness/knowledge.ts
src/worker/api/gitness/moderation.ts
src/worker/api/gitness/modules.ts
src/worker/api/gitness/pool.ts
src/worker/api/gitness/prmeta.ts
src/worker/api/gitness/projects.ts
src/worker/api/gitness/pullreq.ts
src/worker/api/gitness/pullreqs.ts
src/worker/api/gitness/rbac.ts
src/worker/api/gitness/releases.ts
src/worker/api/gitness/reliability.ts
src/worker/api/gitness/repokeys.ts
src/worker/api/gitness/repos.ts
src/worker/api/gitness/search.ts
src/worker/api/gitness/shared.ts
src/worker/api/gitness/social.ts
src/worker/api/gitness/spaces.ts
src/worker/api/gitness/stores.ts
src/worker/api/gitness/ticketSync.ts
src/worker/api/gitness/wiki.ts
src/worker/api/gitness/workflows.ts
src/worker/api/openapi.json
```

## worker/other (38 files)

```
src/worker/auth/cookies.ts
src/worker/auth/gitAuth.ts
src/worker/auth/httpSignature.ts
src/worker/auth/index.ts
src/worker/auth/oauth.ts
src/worker/auth/oidc.ts
src/worker/auth/origin.ts
src/worker/auth/pat.ts
src/worker/auth/session.ts
src/worker/auth/sessionMembership.ts
src/worker/cache/cache.ts
src/worker/cache/index.ts
src/worker/cache/policy.ts
src/worker/common/bytes.ts
src/worker/common/cloudflareApi.ts
src/worker/common/compression.ts
src/worker/common/heap.ts
src/worker/common/hex.ts
src/worker/common/ids.ts
src/worker/common/index.ts
src/worker/common/logger.ts
src/worker/common/origin.ts
src/worker/common/progress.ts
src/worker/common/response.ts
src/worker/common/stub.ts
src/worker/common/webtypes.ts
src/worker/index.ts
src/worker/keys.ts
src/worker/knowledge/index.ts
src/worker/notify/email.ts
src/worker/notify/notify.ts
src/worker/rbac/index.ts
src/worker/repositories/index.ts
src/worker/repositories/route.ts
src/worker/repositories/routeCache.ts
src/worker/scheduled.ts
src/worker/search/index.ts
src/worker/traffic.ts
```

## worker/compute (3 files)

```
src/worker/compute/egress.ts
src/worker/compute/pool.ts
src/worker/compute/sandbox.ts
```

## worker/db (39 files)

```
src/worker/db/d1/client.ts
src/worker/db/d1/dal/arena.ts
src/worker/db/d1/dal/evalCorpus.ts
src/worker/db/d1/dal/identities.ts
src/worker/db/d1/dal/index.ts
src/worker/db/d1/dal/modules.ts
src/worker/db/d1/dal/namespaces.ts
src/worker/db/d1/dal/passkeys.ts
src/worker/db/d1/dal/rbac.ts
src/worker/db/d1/dal/repositories.ts
src/worker/db/d1/dal/reputation.ts
src/worker/db/d1/dal/scanRuns.ts
src/worker/db/d1/dal/securityEvents.ts
src/worker/db/d1/dal/social.ts
src/worker/db/d1/dal/tokens.ts
src/worker/db/d1/dal/users.ts
src/worker/db/d1/index.ts
src/worker/db/d1/schema/agents.ts
src/worker/db/d1/schema/arenaMatches.ts
src/worker/db/d1/schema/delivery.ts
src/worker/db/d1/schema/devx.ts
src/worker/db/d1/schema/evalCorpus.ts
src/worker/db/d1/schema/identities.ts
src/worker/db/d1/schema/index.ts
src/worker/db/d1/schema/namespaceMemberships.ts
src/worker/db/d1/schema/namespaces.ts
src/worker/db/d1/schema/notifications.ts
src/worker/db/d1/schema/passkeys.ts
src/worker/db/d1/schema/patNamespaceGrants.ts
src/worker/db/d1/schema/patRepoGrants.ts
src/worker/db/d1/schema/personalAccessTokens.ts
src/worker/db/d1/schema/rbac.ts
src/worker/db/d1/schema/reliability.ts
src/worker/db/d1/schema/repositories.ts
src/worker/db/d1/schema/reputation.ts
src/worker/db/d1/schema/scanRuns.ts
src/worker/db/d1/schema/securityEvents.ts
src/worker/db/d1/schema/social.ts
src/worker/db/d1/schema/users.ts
```

## worker/do (49 files)

```
src/worker/do/index.ts
src/worker/do/repo/catalog/activity.ts
src/worker/do/repo/catalog/agentApi.ts
src/worker/do/repo/catalog/arena.ts
src/worker/do/repo/catalog/compaction/index.ts
src/worker/do/repo/catalog/compaction/lease.ts
src/worker/do/repo/catalog/compaction/plan.ts
src/worker/do/repo/catalog/compaction/requests.ts
src/worker/do/repo/catalog/discussions.ts
src/worker/do/repo/catalog/diverge.ts
src/worker/do/repo/catalog/index.ts
src/worker/do/repo/catalog/issueQuery.ts
src/worker/do/repo/catalog/issues.ts
src/worker/do/repo/catalog/leases.ts
src/worker/do/repo/catalog/merge.ts
src/worker/do/repo/catalog/oplog.ts
src/worker/do/repo/catalog/projects.ts
src/worker/do/repo/catalog/receive.ts
src/worker/do/repo/catalog/releases.ts
src/worker/do/repo/catalog/shared.ts
src/worker/do/repo/catalog/state.ts
src/worker/do/repo/db/client.ts
src/worker/do/repo/db/dal/agent.ts
src/worker/do/repo/db/dal/arena.ts
src/worker/do/repo/db/dal/discussions.ts
src/worker/do/repo/db/dal/index.ts
src/worker/do/repo/db/dal/issues.ts
src/worker/do/repo/db/dal/packCatalog.ts
src/worker/do/repo/db/dal/projects.ts
src/worker/do/repo/db/dal/releases.ts
src/worker/do/repo/db/dal/shared.ts
src/worker/do/repo/db/index.ts
src/worker/do/repo/db/schema.ts
src/worker/do/repo/debug/checks.ts
src/worker/do/repo/debug/index.ts
src/worker/do/repo/debug/packed.ts
src/worker/do/repo/debug/state.ts
src/worker/do/repo/debug/types.ts
src/worker/do/repo/maintenance.ts
src/worker/do/repo/packOperations.ts
src/worker/do/repo/refs.ts
src/worker/do/repo/repoConfig.ts
src/worker/do/repo/repoDO.ts
src/worker/do/repo/repoDO/access.ts
src/worker/do/repo/repoDO/seeding.ts
src/worker/do/repo/repoState.ts
src/worker/do/repo/scheduler.ts
src/worker/do/repo/storage.ts
src/worker/do/sandbox/forgeSandbox.ts
```

## worker/git (90 files)

```
src/worker/git/compaction/plan.ts
src/worker/git/core/commitParse.ts
src/worker/git/core/index.ts
src/worker/git/core/object-parse.ts
src/worker/git/core/objects.ts
src/worker/git/core/pgpsig.ts
src/worker/git/core/pktline.ts
src/worker/git/core/protocol.ts
src/worker/git/core/sshsig.ts
src/worker/git/core/tree.ts
src/worker/git/index.ts
src/worker/git/object-store/candidates.ts
src/worker/git/object-store/catalog.ts
src/worker/git/object-store/delta.ts
src/worker/git/object-store/idxView.ts
src/worker/git/object-store/index.ts
src/worker/git/object-store/lookup.ts
src/worker/git/object-store/materialize.ts
src/worker/git/object-store/peel.ts
src/worker/git/object-store/store.ts
src/worker/git/object-store/support.ts
src/worker/git/object-store/types.ts
src/worker/git/operations/args.ts
src/worker/git/operations/bundle.ts
src/worker/git/operations/closure.ts
src/worker/git/operations/fetch/execute.ts
src/worker/git/operations/fetch/filter.ts
src/worker/git/operations/fetch/neededFast.ts
src/worker/git/operations/fetch/plan.ts
src/worker/git/operations/fetch/protocol.ts
src/worker/git/operations/fetch/refClosure.ts
src/worker/git/operations/fetch/responses.ts
src/worker/git/operations/fetch/shallow.ts
src/worker/git/operations/fetch/sideband.ts
src/worker/git/operations/fetch/types.ts
src/worker/git/operations/index.ts
src/worker/git/operations/limits.ts
src/worker/git/operations/objectInfo.ts
src/worker/git/operations/read/commits.ts
src/worker/git/operations/read/diff.ts
src/worker/git/operations/read/index.ts
src/worker/git/operations/read/lastchange.ts
src/worker/git/operations/read/license.ts
src/worker/git/operations/read/objects.ts
src/worker/git/operations/read/refs.ts
src/worker/git/operations/read/tree.ts
src/worker/git/operations/read/types.ts
src/worker/git/operations/types.ts
src/worker/git/operations/uploadStream/index.ts
src/worker/git/operations/validation.ts
src/worker/git/pack/build.ts
src/worker/git/pack/index.ts
src/worker/git/pack/indexer/connectivity.ts
src/worker/git/pack/indexer/index.ts
src/worker/git/pack/indexer/inflateCursor.ts
src/worker/git/pack/indexer/resolve/deferred.ts
src/worker/git/pack/indexer/resolve/dependencies.ts
src/worker/git/pack/indexer/resolve/errors.ts
src/worker/git/pack/indexer/resolve/externalBase.ts
src/worker/git/pack/indexer/resolve/helpers.ts
src/worker/git/pack/indexer/resolve/index.ts
src/worker/git/pack/indexer/resolve/materialize.ts
src/worker/git/pack/indexer/resolve/payloadCache.ts
src/worker/git/pack/indexer/resolve/reader.ts
src/worker/git/pack/indexer/resolve/refLookup.ts
src/worker/git/pack/indexer/scan.ts
src/worker/git/pack/indexer/types.ts
src/worker/git/pack/indexer/writeIdx.ts
src/worker/git/pack/packMeta.ts
src/worker/git/pack/refIndex.ts
src/worker/git/pack/rewrite.ts
src/worker/git/pack/rewrite/layout.ts
src/worker/git/pack/rewrite/ownership.ts
src/worker/git/pack/rewrite/plan.ts
src/worker/git/pack/rewrite/selection.ts
src/worker/git/pack/rewrite/selectionCompact.ts
src/worker/git/pack/rewrite/selectionResolve.ts
src/worker/git/pack/rewrite/selectionRetained.ts
src/worker/git/pack/rewrite/shared.ts
src/worker/git/pack/rewrite/stream.ts
src/worker/git/pack/snapshot.ts
src/worker/git/receive/bytes.ts
src/worker/git/receive/pipeline.ts
src/worker/git/receive/pktSectionStream.ts
src/worker/git/receive/r2Upload.ts
src/worker/git/receive/request.ts
src/worker/git/receive/response.ts
src/worker/git/receive/streamReceivePack.ts
src/worker/git/receive/support.ts
src/worker/git/remote/push.ts
```

## worker/merge (4 files)

```
src/worker/merge/engine.ts
src/worker/merge/file.ts
src/worker/merge/packWriter.ts
src/worker/merge/resolution.ts
```

## worker/routes (38 files)

```
src/worker/routes/admin.ts
src/worker/routes/agent.ts
src/worker/routes/agentSurface.ts
src/worker/routes/apiv3.ts
src/worker/routes/archive.ts
src/worker/routes/atpauth.ts
src/worker/routes/auth.ts
src/worker/routes/authOidc.ts
src/worker/routes/authPasskeys.ts
src/worker/routes/authRepositories.ts
src/worker/routes/authShared.ts
src/worker/routes/authTokens.ts
src/worker/routes/badge.ts
src/worker/routes/cors.ts
src/worker/routes/d1Bookmark.ts
src/worker/routes/did.ts
src/worker/routes/docs.ts
src/worker/routes/feed.ts
src/worker/routes/git.ts
src/worker/routes/graphql.ts
src/worker/routes/hermes.ts
src/worker/routes/hono.ts
src/worker/routes/mcp.ts
src/worker/routes/npmRegistry.ts
src/worker/routes/oauthProvider.ts
src/worker/routes/pages.ts
src/worker/routes/poppy.ts
src/worker/routes/reputation.ts
src/worker/routes/requestSchemas.ts
src/worker/routes/spa.ts
src/worker/routes/ui.ts
src/worker/routes/ui/agents.ts
src/worker/routes/ui/helpers.ts
src/worker/routes/ui/llms.ts
src/worker/routes/ui/raw.ts
src/worker/routes/ui/refsApi.ts
src/worker/routes/uiResponse.ts
src/worker/routes/xrpc.ts
```

## worker/runner (2 files)

```
src/worker/runner/platform.ts
src/worker/runner/spec.ts
```

## worker/tasks (19 files)

```
src/worker/tasks/adjudicate.ts
src/worker/tasks/arena.ts
src/worker/tasks/artifactsEvents.ts
src/worker/tasks/artifactsSubscriptions.ts
src/worker/tasks/compaction.ts
src/worker/tasks/context.ts
src/worker/tasks/cronmatch.ts
src/worker/tasks/deploy.ts
src/worker/tasks/federate.ts
src/worker/tasks/knowledge.ts
src/worker/tasks/pipeline.ts
src/worker/tasks/queue.ts
src/worker/tasks/refBackfill.ts
src/worker/tasks/repositoryDelete.ts
src/worker/tasks/routeCacheSync.ts
src/worker/tasks/runner.ts
src/worker/tasks/securityScan.ts
src/worker/tasks/types.ts
src/worker/tasks/webhook.ts
```

## test (152 files)

```
test/admin-csrf.worker.test.ts
test/admin-disclosure.worker.test.ts
test/agent-adjudication.worker.test.ts
test/agent-parity.worker.test.ts
test/agent-surface.worker.test.ts
test/alarm-cleanup.worker.test.ts
test/arena.worker.test.ts
test/artifacts-subscriptions.test.ts
test/atp-verify.worker.test.ts
test/auth-account-merged.worker.test.ts
test/auth-session.worker.test.ts
test/auth-tessera-callback.worker.test.ts
test/auth-tessera-start.worker.test.ts
test/auth.worker.test.ts
test/badge.worker.test.ts
test/bundle-uri.worker.test.ts
test/cache-policy.worker.test.ts
test/clef-poppy.test.ts
test/codeowners.worker.test.ts
test/commit-diff.worker.test.ts
test/compute-needed-fast.worker.test.ts
test/compute-pool.worker.test.ts
test/concurrent-receive.worker.test.ts
test/cronmatch.test.ts
test/d1-schema.worker.test.ts
test/d1-session.worker.test.ts
test/delivery.worker.test.ts
test/devx.worker.test.ts
test/dg-status.worker.test.ts
test/did-identity.worker.test.ts
test/discussions.worker.test.ts
test/docs.worker.test.ts
test/e2e-repos.worker.test.ts
test/egress.test.ts
test/env.d.ts
test/federate.worker.test.ts
test/fetch-acks.worker.test.ts
test/fetch-streaming.worker.test.ts
test/find-common-haves-batch.worker.test.ts
test/funding.test.ts
test/gate-quarantine.worker.test.ts
test/git-acl.worker.test.ts
test/gitness-api.worker.test.ts
test/gitness/pullreq.test.ts
test/graphql.worker.test.ts
test/hono-routing.worker.test.ts
test/http-signature.worker.test.ts
test/importer.worker.test.ts
test/info-refs.worker.test.ts
test/insights.worker.test.ts
test/issues.worker.test.ts
test/knowledge.worker.test.ts
test/last-change.worker.test.ts
test/leaderboard.worker.test.ts
test/lfs.worker.test.ts
test/load-50-agents.worker.test.ts
test/ls-refs-filters.worker.test.ts
test/ls-refs.worker.test.ts
test/manifest.test.ts
test/mcp.worker.test.ts
test/modules.worker.test.ts
test/multipack-union.worker.test.ts
test/notify-email.worker.test.ts
test/oauth-provider.worker.test.ts
test/object-info.worker.test.ts
test/object-parse.test.ts
test/ofs-delta-converge.worker.test.ts
test/ofs-delta-encode.test.ts
test/ofs-delta-known-encodings.test.ts
test/oidc-config.test.ts
test/oidc-transaction.test.ts
test/pack-first-fetch-and-ui.worker.test.ts
test/pack-first-read-path.closure.worker.test.ts
test/pack-first-read-path.routes.worker.test.ts
test/pack-first-read-regressions.worker.test.ts
test/pack-indexer-fixture.worker.test.ts
test/pack-indexer.connectivity.commits.worker.test.ts
test/pack-indexer.connectivity.tags.worker.test.ts
test/pack-indexer.resolve.ofs.worker.test.ts
test/pack-indexer.resolve.ref.worker.test.ts
test/pack-indexer.scan.worker.test.ts
test/pack-ref-index.test.ts
test/pack-rewrite-cycle.worker.test.ts
test/pack-rewrite-plan.test.ts
test/packed-object-candidates.worker.test.ts
test/packed-object-store.catalog.worker.test.ts
test/packed-object-store.delta.worker.test.ts
test/packed-object-store.reads.worker.test.ts
test/parse-fetch-args.test.ts
test/parse-helpers.worker.test.ts
test/passkeys.worker.test.ts
test/pat-format.test.ts
test/pat-last-used.worker.test.ts
test/pat-management.worker.test.ts
test/pat-verify.worker.test.ts
test/pipelines.worker.test.ts
test/platform-runner.worker.test.ts
test/pool-award-live.test.ts
test/pool-sanitize.test.ts
test/projects.worker.test.ts
test/queue-malformed.worker.test.ts
test/rbac.worker.test.ts
test/readpath-tag-peel.worker.test.ts
test/receive-adv.worker.test.ts
test/receive-connectivity.worker.test.ts
test/receive-invalid-ref.worker.test.ts
test/receive-missing-parent.worker.test.ts
test/releases.worker.test.ts
test/reliability.worker.test.ts
test/rep-cert.worker.test.ts
test/repo-create.worker.test.ts
test/repository-delete.worker.test.ts
test/repository-resolver.worker.test.ts
test/route-cache-sync.worker.test.ts
test/runner-spec.test.ts
test/scan-attest.worker.test.ts
test/scan-cli.test.ts
test/scripts/validate-fixture-indexer.ts
test/search.worker.test.ts
test/shallow-fetch.worker.test.ts
test/sidebar-surfaces.worker.test.ts
test/slugs.test.ts
test/social.worker.test.ts
test/streaming-compaction.worker.test.ts
test/streaming-receive.worker.test.ts
test/stubs/cloudflare-workers.ts
test/tsconfig.json
test/upload-pack-acks.test.ts
test/upload-pack-content-encoding.worker.test.ts
test/util/authCookies.ts
test/util/compaction-helpers.ts
test/util/d1Bookmark.ts
test/util/d1Migrations.ts
test/util/d1Setup.ts
test/util/do-retry.ts
test/util/fetch-protocol.ts
test/util/git-pack.ts
test/util/git-push.ts
test/util/oidcFake.ts
test/util/pack-first.ts
test/util/pack-indexer.helpers.ts
test/util/packed-repo.ts
test/util/queue.ts
test/util/repoSeed.ts
test/util/streaming-helpers.ts
test/util/test-helpers.ts
test/util/test-indexer.ts
test/vitest.bindings.ts
test/web-format.test.ts
test/widespread-auth.test.ts
test/wiki.worker.test.ts
test/xrpc.worker.test.ts
```

## tools (2 files)

```
tools/did-sign.ts
tools/loadsim.ts
```
