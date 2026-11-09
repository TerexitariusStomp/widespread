#!/usr/bin/env bash
# sync-upstream.sh — pull upstream changes into packages/delta-git.
#
# packages/delta-git is a `git subtree` of zllovesuki/git-on-cloudflare.
# This script wraps `git subtree pull` with a dry-run mode and clear
# conflict guidance. See UPSTREAMS.md (repo root) for the full picture.
#
# Usage:
#   packages/delta-git/scripts/sync-upstream.sh [--dry-run] [--branch NAME]
#
#   --dry-run   Fetch and merge upstream into a temporary ref, report what
#               would change, then abort. Never touches your worktree.
#   --branch    Upstream branch to pull (default: main).
set -euo pipefail

UPSTREAM_URL="https://github.com/zllovesuki/git-on-cloudflare"
UPSTREAM_BRANCH="main"
SUBTREE_PREFIX="packages/delta-git"
# The commit our subtree history is based on (see UPSTREAMS.md).
BASE_COMMIT="007a96eae94c8f562d223f81eb7548c8f7c38673"

DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --branch) UPSTREAM_BRANCH="$2"; shift ;;
    *) echo "sync-upstream: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

echo "sync-upstream: fetching $UPSTREAM_URL ($UPSTREAM_BRANCH)"
git fetch "$UPSTREAM_URL" "$UPSTREAM_BRANCH"
UPSTREAM_REF="FETCH_HEAD"

echo "sync-upstream: upstream HEAD = $(git rev-parse --short "$UPSTREAM_REF")"
echo "sync-upstream: subtree base = $BASE_COMMIT"

if [ "$DRY_RUN" -eq 1 ]; then
  # Merge upstream into a scratch branch to preview conflicts without
  # touching the worktree.
  SCRATCH="sync-upstream-dry-run-$$"
  trap 'git branch -D "$SCRATCH" >/dev/null 2>&1 || true' EXIT
  git branch "$SCRATCH" HEAD
  if git merge-tree --write-tree "$SCRATCH" "$UPSTREAM_REF" >/dev/null 2>&1; then
    echo "sync-upstream: dry-run — merge appears CLEAN."
    echo "sync-upstream: files that would change under $SUBTREE_PREFIX:"
    git diff --name-only HEAD "$UPSTREAM_REF" -- "$SUBTREE_PREFIX" | head -50
  else
    echo "sync-upstream: dry-run — merge has CONFLICTS." >&2
    echo "sync-upstream: run without --dry-run to attempt the real merge;" >&2
    echo "conflicts must be resolved by hand (subtree merges do not auto-resolve)." >&2
  fi
  exit 0
fi

# Real pull. -–squash is intentionally NOT used: we keep upstream history so
# future pulls remain incremental.
echo "sync-upstream: running: git subtree pull --prefix=$SUBTREE_PREFIX $UPSTREAM_URL $UPSTREAM_BRANCH"
if ! git subtree pull --prefix="$SUBTREE_PREFIX" "$UPSTREAM_URL" "$UPSTREAM_BRANCH"; then
  cat >&2 <<'EOF'

sync-upstream: subtree pull FAILED — likely merge conflicts.

Guidance:
  1. `git status` to see conflicted files. Conflicts are almost always in
     files listed in packages/delta-git/OURS.md (our owned surface).
  2. Resolve each conflict keeping OUR changes where OURS.md says we own
     the file; take upstream hunks elsewhere.
  3. After resolving: `git add` the resolved files and
     `git commit` to finish the merge.
  4. Afterwards regenerate drizzle migrations from
     src/worker/do/repo/db/schema.ts (`npm run db:generate`) — the squashed
     baseline policy means migration files are regenerated, not merged.
  5. `npm run typecheck` and the relevant test/*.worker.test.ts suites.
  6. frontend/canary is NOT part of the subtree — refresh it separately via
     packages/delta-git/frontend/fetch-canary.sh (see frontend/UPSTREAM.md).
EOF
  exit 1
fi

echo "sync-upstream: done. Review the merge commit, then:"
echo "  cd packages/delta-git && npm run db:generate && npm run typecheck"
