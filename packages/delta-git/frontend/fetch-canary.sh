#!/usr/bin/env bash
# fetch-canary.sh — reproducibly materialize frontend/canary from upstream.
#
# frontend/canary is NOT committed to this repo. It is produced by:
#   1. shallow-cloning harness/canary at the pinned tag,
#   2. pruning the directories/files we deliberately exclude (see
#      frontend/UPSTREAM.md),
#   3. applying our modification patches from frontend/patches/,
#   4. overlaying whole-file replacements/additions from frontend/overlay/.
#
# Idempotent: if frontend/canary/.upstream-pin already records the pinned
# commit, this script exits 0 without touching the tree.
#
# Usage: frontend/fetch-canary.sh [--force]
#   --force  re-fetch even when the pin already matches.
set -euo pipefail

FRONTEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANARY_DIR="$FRONTEND_DIR/canary"
PATCHES_DIR="$FRONTEND_DIR/patches"
OVERLAY_DIR="$FRONTEND_DIR/overlay"

UPSTREAM_URL="https://github.com/harness/canary"
UPSTREAM_PIN_TAG="mfe.alpha.2819"
UPSTREAM_PIN_COMMIT="4aeb71467366f585b4f98270b872e8fdde13fd2b"

# Paths pruned after checkout — upstream surfaces we do not vendor.
# Keep in sync with frontend/UPSTREAM.md.
PRUNE_PATHS=(
  apps/portal
  apps/design-system
  apps/sidebar-app
  packages/tests
  packages/ai-chat-core
  docs
  charts
  eslint
  .github
  .claude
  .engops
  .husky
  .vscode
  .harness
  Dockerfile
  Dockerfile.mfe
  .dockerignore
  playwright.config.ts
  CODEOWNERS
  AGENTS.md
  CLAUDE.md
  CONTRIBUTOR_LICENSE_AGREEMENT.md
  DESIGN.md
  README.md
  figma.config.json
  .eslintignore
  .eslintrc.js
  .prettierignore
  .prettierrc.yml
)

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) echo "fetch-canary: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

PIN_FILE="$CANARY_DIR/.upstream-pin"
if [ "$FORCE" -eq 0 ] && [ -f "$PIN_FILE" ] \
  && [ "$(cat "$PIN_FILE")" = "$UPSTREAM_PIN_COMMIT" ]; then
  echo "fetch-canary: $CANARY_DIR already at pinned commit $UPSTREAM_PIN_COMMIT"
  exit 0
fi

echo "fetch-canary: fetching $UPSTREAM_URL @ $UPSTREAM_PIN_TAG ($UPSTREAM_PIN_COMMIT)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

git clone --quiet --depth 1 --branch "$UPSTREAM_PIN_TAG" "$UPSTREAM_URL" "$TMP_DIR/canary"

HEAD_COMMIT="$(git -C "$TMP_DIR/canary" rev-parse HEAD)"
if [ "$HEAD_COMMIT" != "$UPSTREAM_PIN_COMMIT" ]; then
  echo "fetch-canary: ERROR — tag $UPSTREAM_PIN_TAG resolved to $HEAD_COMMIT," \
    "expected $UPSTREAM_PIN_COMMIT. Update UPSTREAM_PIN_* if upstream moved." >&2
  exit 1
fi

for p in "${PRUNE_PATHS[@]}"; do
  rm -rf "$TMP_DIR/canary/$p"
done

# Apply modification patches. They were generated with `git diff` against the
# pruned tree, so paths are relative to the canary root and apply with
# `git apply -p1` semantics (a/ b/ prefixes stripped by default).
for patch in "$PATCHES_DIR"/*.patch; do
  [ -e "$patch" ] || continue
  name="$(basename "$patch")"
  if ! git -C "$TMP_DIR/canary" apply --check "$patch" 2>"$TMP_DIR/apply.err"; then
    echo "fetch-canary: ERROR — patch $name failed to apply cleanly:" >&2
    cat "$TMP_DIR/apply.err" >&2
    echo "fetch-canary: upstream may have moved; rebase frontend/patches/ onto" \
      "the new pin (see frontend/UPSTREAM.md)." >&2
    exit 1
  fi
  git -C "$TMP_DIR/canary" apply "$patch"
  echo "fetch-canary: applied $name"
done

# Overlay whole-file replacements and additions (lockfiles, package.json
# manifests, and every file that exists only in our tree).
if [ -d "$OVERLAY_DIR" ]; then
  (cd "$OVERLAY_DIR" && find . -type f | while read -r f; do
    mkdir -p "$TMP_DIR/canary/$(dirname "$f")"
    cp "$f" "$TMP_DIR/canary/$f"
  done)
  echo "fetch-canary: applied overlay from frontend/overlay/"
fi

echo "$UPSTREAM_PIN_COMMIT" > "$TMP_DIR/canary/.upstream-pin"

rm -rf "$CANARY_DIR"
mv "$TMP_DIR/canary" "$CANARY_DIR"
echo "fetch-canary: materialized $CANARY_DIR @ $UPSTREAM_PIN_COMMIT"
