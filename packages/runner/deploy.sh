#!/usr/bin/env bash
# deploy.sh — provision the widespread-runner on Vultr Cloud Compute.
#
# Two modes:
#   A) Provision the instance (needs VULTR_API_KEY, free: vultr.com/api)
#        ./deploy.sh provision
#   B) Install on a running host (run ON the VPS, or any Debian/Ubuntu)
#        ./deploy.sh install
#
# Recommended instance: Cloud Compute > High Performance > 1 vCPU / 1GB / 25GB
# ($6/mo billed hourly ≈ $0.009/hr — a full demo costs pennies).

set -euo pipefail

MODE="${1:-}"
REPO="${RUNNER_REPO:-https://github.com/terexitariusstomp/widespread-runner}"
APP_DIR="${APP_DIR:-/opt/widespread-runner}"

provision() {
  : "${VULTR_API_KEY:?set VULTR_API_KEY (free at vultr.com/api — no paid plan needed for the key)}"
  echo "Deploying 1vCPU/1GB High Performance instance…"
  # plan vc2-1c-1gb is $5; vhp-1c-1gb is $6 (recommended). region lax.
  curl -s -X POST "https://api.vultr.com/v2/instances" \
    -H "Authorization: Bearer ${VULTR_API_KEY}" \
    -H "Content-Type: application/json" \
    -d '{
      "region": "lax",
      "plan": "vhp-1c-1gb",
      "label": "widespread-runner",
      "os_id": 2284,
      "backups": "disabled",
      "enable_ipv6": false,
      "user_data": "'"$(base64 -w0 <<'UD'
#!/bin/bash
export DEBIAN_FRONTEND=noninteractive
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
UD
)"'"
    }' | python3 -c "import json,sys; d=json.load(sys.stdin); print('instance:', d['instance']['id'], d['instance'].get('main_ip','pending'))"
  echo "Wait ~60s for boot+docker, then: ssh root@<ip> 'bash -s' < deploy.sh install"
}

install() {
  echo "Installing widespread-runner on $(hostname)…"
  command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git; }
  command -v node >/dev/null || curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs

  [ -d "$APP_DIR" ] || git clone "$REPO" "$APP_DIR"
  cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund
  docker build -f Dockerfile.sandbox -t widespread-sandbox:latest .

  cat > /etc/systemd/system/widespread-runner.service <<'UNIT'
[Unit]
Description=widespread-runner — sandboxed bounty agent
After=docker.service
Requires=docker.service
[Service]
WorkingDirectory=/opt/widespread-runner
EnvironmentFile=-/opt/widespread-runner/.env
ExecStart=/usr/bin/node src/runner.js
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
UNIT

  cat > .env <<'ENV'
BRIDGE_BASE=https://widespread-bridge.widespread.workers.dev
FORGE_BASE=https://code.widespread.fyi
WORK_DIR=/var/lib/widespread-runs
SANDBOX_IMAGE=widespread-sandbox:latest
SANDBOX_CPUS=1
SANDBOX_MEM_MB=768
SANDBOX_TIMEOUT_SEC=600
POLL_MS=30000
# GIT_PUSH_URL=https://x-access-token:<token>@github.com/<you>/<repo>.git
ENV

  mkdir -p /var/lib/widespread-runs
  systemctl daemon-reload
  echo "Installed. Edit $APP_DIR/.env, then: systemctl start widespread-runner"
  echo "Watch: journalctl -u widespread-runner -f"
}

case "$MODE" in
  provision) provision ;;
  install) install ;;
  *) echo "usage: $0 {provision|install}"; exit 1 ;;
esac
