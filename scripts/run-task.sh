#!/bin/bash
set -euo pipefail
TASK_ID="${TASK_ID:-anon}"
export GIT_CONFIG_GLOBAL=/tmp/gitconfig
echo "[run-task] ${TASK_ID} starting in sealed sandbox"
git config --global --add safe.directory /work/repo
cd /work/repo 2>/dev/null || { echo "no repo"; exit 0; }
echo "[run-task] spec:"
cat /work/SPEC.md | head -30
echo "[run-task] repo files:"
git ls-files | head -20
date > .widespread-run
echo "task: ${TASK_ID}" >> .widespread-run
git add -A
git -c user.email=agent@widespread -c user.name=widespread-runner \
    commit -qm "widespread-runner: sealed execution of ${TASK_ID}" || true
git log --oneline -3
echo "[run-task] done"
