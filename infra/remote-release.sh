#!/usr/bin/env bash
# Runs ON the VPS after rsync. Installs deps, rebuilds the UI, restarts systemd,
# and waits for /health. Does not touch .env, geoqa.config.json, var/, or any
# watch.yaml — those stay on the machine.
set -euo pipefail

ROOT=/opt/geoqa
export PATH=/usr/local/bin:/usr/bin:/bin

cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "refusing: $ROOT/.env is missing — credentials are not in git" >&2
  exit 1
fi
if grep -q '^SSH_' .env; then
  echo "refusing: SSH_ keys must not live on the server .env" >&2
  exit 1
fi
if [[ ! -f geoqa.config.json ]]; then
  echo "refusing: $ROOT/geoqa.config.json is missing — copy the example and set network.provider" >&2
  exit 1
fi

pnpm install --frozen-lockfile
pnpm ui:build
test -f "$ROOT/apps/ui/dist/index.html"

install -m 644 "$ROOT/infra/geoqa.service" /etc/systemd/system/geoqa.service
install -m 644 "$ROOT/infra/geoqa-bridge.service" /etc/systemd/system/geoqa-bridge.service
install -m 644 "$ROOT/infra/geoqa-digest.service" /etc/systemd/system/geoqa-digest.service
install -m 644 "$ROOT/infra/geoqa-digest.timer" /etc/systemd/system/geoqa-digest.timer
systemctl daemon-reload
systemctl enable --now geoqa-bridge.service
systemctl enable --now geoqa-digest.timer
systemctl restart geoqa.service

for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:4180/health | grep -q '"ok"'; then
    echo "geoqa /health ok"
    exit 0
  fi
  sleep 1
done

echo "geoqa did not become healthy on 127.0.0.1:4180" >&2
systemctl --no-pager --full status geoqa.service || true
exit 1
