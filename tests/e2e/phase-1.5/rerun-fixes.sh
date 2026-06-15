#!/usr/bin/env bash
# One-shot: pull fixes, apply migration 019, recreate gateway with its state
# volume, verify the pin-queue warning is gone, relaunch full drills detached.
set -uo pipefail
cd /root/pinning-service && git pull -q
. /opt/fula-master/.env

echo "== apply migration 019 directly (installer marker covers 001-018) =="
docker exec -i postgres-pinning psql -U "${POSTGRES_USER:-pinning_user}" -d "${POSTGRES_DB:-pinning_service}" -v ON_ERROR_STOP=1 < migrations/postgres/019_user_wallets_nullable_address.sql && echo "019 applied"

echo "== recreate gateway with state volume =="
COMPOSE_PROFILES=gateway docker compose --env-file /opt/fula-master/.env -f docker/master/docker-compose.master.yml up -d fula-gateway
sleep 8
docker logs fula-gateway-1 2>&1 | grep -ciE "falling back to fire-and-forget" | xargs -I{} echo "fire-and-forget warnings in fresh logs: {}"
docker logs fula-gateway-1 2>&1 | grep -iE "pin queue|registry persistence" | tail -3

echo "== relaunch full drill suite detached =="
nohup bash tests/e2e/phase-1.5/60-master-drills.sh > /tmp/drills15b.log 2>&1 &
echo "drills relaunched (pid $!)"
