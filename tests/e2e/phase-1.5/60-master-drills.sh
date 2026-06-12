#!/usr/bin/env bash
#
# Phase 1.5 e2e drills — federated master Stage A (TEST SERVER ONLY).
# Requires: join-as-master.sh completed; the fxe2e Phase-1 cluster running
# (adopted writer `ipfs_cluster` + sim master + followers from fula-ota
# tests/e2e/phase-1). Run from the pinning-service checkout root.
#
#   D1 stack health        : postgres/api/webui containers healthy
#   D2 migration applied   : 018 partial UNIQUE index exists
#   D3 lease arbitration   : two webui instances -> ONE leader, ONE standby,
#                            exactly one hourly_deduction row per (user, hour)
#   D4 leader kill -9      : standby takes over; STILL one row for the hour
#   D5 live-PG integration : vitest fm2-billing-integration (2 tests) green
#   D6 snapshot            : take + verify; tampered file FAILS verify;
#                            unpin + --restore re-pins
#   D7 sweep               : healthy -> exit 0; force under-replication ->
#                            --strict exit 1 + alert logged; restore -> exit 0
#
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
ENVF=/opt/fula-master/.env
# shellcheck disable=SC1090
. "$ENVF" 2>/dev/null || { echo "FATAL: $ENVF missing (run join-as-master.sh)"; exit 1; }

PASS=0; FAIL=0
ok()  { echo "ok   - $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL - $1"; FAIL=$((FAIL+1)); }
psqlc() { docker exec -i postgres-pinning psql -U "${POSTGRES_USER:-pinning_user}" -d "${POSTGRES_DB:-pinning_service}" -tA -c "$1"; }

U="e2e-drill-user"
HOURREF="hour:$(date -u +%Y-%m-%dT%H)"

echo "== D1 stack health =="
for c in postgres-pinning fula-pinning-api fula-pinning-webui; do
  st="$(docker inspect "$c" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || echo missing)"
  { [ "$st" = healthy ] || [ "$st" = running ]; } && ok "D1 $c $st" || bad "D1 $c is '$st'"
done

echo "== D2 migration 018 applied =="
n="$(psqlc "SELECT COUNT(*) FROM pg_indexes WHERE indexname='idx_credit_history_hourly_dedup'")"
[ "$n" = 1 ] && ok "D2 idx_credit_history_hourly_dedup exists" || bad "D2 index missing"

echo "== D3 two masters, one leader, one deduction per (user,hour) =="
# Seed a billable user (10 GiB > free tier) — idempotent.
psqlc "INSERT INTO users (username, password_hash) VALUES ('$U','x') ON CONFLICT (username) DO NOTHING" >/dev/null
psqlc "INSERT INTO user_credits (user_id, balance_fula, total_deposited_fula) VALUES ('$U', 50, 50) ON CONFLICT (user_id) DO UPDATE SET balance_fula=50, is_suspended=0" >/dev/null
psqlc "INSERT INTO pins (requestid, username, cid, status, size, user_id) VALUES ('e2e-drill-pin-1','$U','bafy-e2e-drill','pinned', 10737418240, '$U') ON CONFLICT (requestid) DO UPDATE SET size=10737418240, status='pinned'" >/dev/null
psqlc "DELETE FROM credit_history WHERE user_id='$U'" >/dev/null

run_webui() { # $1=name $2=port
  docker rm -f "$1" >/dev/null 2>&1 || true
  docker run -d --name "$1" --network host \
    -e NODE_ENV=production -e WEBUI_PORT="$2" -e BIND_HOST=127.0.0.1 \
    -e POSTGRES_HOST=127.0.0.1 -e POSTGRES_PORT=5432 \
    -e POSTGRES_DB="${POSTGRES_DB:-pinning_service}" -e POSTGRES_USER="${POSTGRES_USER:-pinning_user}" \
    -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
    -e JWT_SECRET="$JWT_SECRET" -e SESSION_SECRET="$SESSION_SECRET" \
    -e BILLING_IDEMPOTENCY=true -e CRON_LEADER_LEASE=true \
    -e VAULT_ADDRESS=0x000000000000000000000000000000000000bEEF \
    -e DEDUCTION_INTERVAL_MS=15000 -e SCANNER_INTERVAL_MS=600000 \
    fula-pinning-webui:master >/dev/null
}
run_webui drill-master-a 3101
run_webui drill-master-b 3102
echo "  (waiting 50s for ticks...)"
sleep 50

LA="$(docker logs drill-master-a 2>&1 | grep -c 'acquired cron lease' || true)"
LB="$(docker logs drill-master-b 2>&1 | grep -c 'acquired cron lease' || true)"
SA="$(docker logs drill-master-a 2>&1 | grep -c 'standby (lease held' || true)"
SB="$(docker logs drill-master-b 2>&1 | grep -c 'standby (lease held' || true)"
[ $((LA>0?1:0))$((LB>0?1:0)) != 11 ] && [ $(((LA>0?1:0)+(LB>0?1:0))) -eq 1 ] \
  && ok "D3 exactly one leader (a=$LA b=$LB)" || bad "D3 leader split wrong (a=$LA b=$LB)"
[ $(((SA>0?1:0)+(SB>0?1:0))) -ge 1 ] && ok "D3 standby observed lease held elsewhere" || bad "D3 no standby log"
n="$(psqlc "SELECT COUNT(*) FROM credit_history WHERE user_id='$U' AND tx_type='hourly_deduction' AND reference_id='$HOURREF'")"
[ "$n" = 1 ] && ok "D3 exactly ONE deduction row for $HOURREF" || bad "D3 deduction rows for hour = $n (want 1)"

echo "== D4 kill -9 the leader; standby takes over; still one row =="
LEADER=drill-master-a; STANDBY=drill-master-b
[ "$LB" -gt 0 ] && { LEADER=drill-master-b; STANDBY=drill-master-a; }
docker kill -s KILL "$LEADER" >/dev/null
echo "  (killed $LEADER; waiting 45s for $STANDBY to take over...)"
sleep 45
TOOK="$(docker logs "$STANDBY" 2>&1 | grep -c 'acquired cron lease' || true)"
[ "$TOOK" -gt 0 ] && ok "D4 $STANDBY acquired the lease after leader death" || bad "D4 standby never took over"
n="$(psqlc "SELECT COUNT(*) FROM credit_history WHERE user_id='$U' AND tx_type='hourly_deduction' AND reference_id='$HOURREF'")"
[ "$n" = 1 ] && ok "D4 STILL exactly one deduction row after failover (idempotency held)" || bad "D4 rows for hour = $n (want 1)"
docker rm -f drill-master-a drill-master-b >/dev/null 2>&1

echo "== D5 live-Postgres integration tests (vitest) =="
if docker run --rm --network host -v "$REPO/pinning-webui":/app -w /app \
     -e POSTGRES_HOST=127.0.0.1 -e POSTGRES_PORT=5432 \
     -e POSTGRES_DB="${POSTGRES_DB:-pinning_service}" -e POSTGRES_USER="${POSTGRES_USER:-pinning_user}" \
     -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
     node:22 bash -lc "npm ci --no-audit --no-fund >/dev/null 2>&1 && npx vitest run tests/fm2-billing-integration.test.ts 2>&1 | tail -6"; then
  ok "D5 integration tests green on live Postgres"
else
  bad "D5 integration tests failed"
fi

echo "== D6 signed pinset snapshot: take, verify, tamper, restore =="
SNAP_OUT="$(OUT_DIR=/opt/fula-master/snapshots bash "$REPO/update-scripts/pinset-snapshot.sh" 2>&1)" && ok "D6 snapshot taken" || bad "D6 snapshot failed: $SNAP_OUT"
F="$(ls -1t /opt/fula-master/snapshots/pinset-*.json | head -1)"
bash "$REPO/update-scripts/pinset-snapshot.sh" --verify "$F" >/dev/null 2>&1 && ok "D6 signature verifies" || bad "D6 signature verify failed"
cp "$F" /tmp/tampered.json; cp "$F.sig" /tmp/tampered.json.sig; echo " " >> /tmp/tampered.json
bash "$REPO/update-scripts/pinset-snapshot.sh" --verify /tmp/tampered.json >/dev/null 2>&1 && bad "D6 tampered file passed verify(!)" || ok "D6 tampered file REJECTED"
CID_RESTORE="$(jq -r 'if type=="array" then .[0] else . end | .cid // .Cid' "$F")"
if [ -n "$CID_RESTORE" ] && [ "$CID_RESTORE" != null ]; then
  docker exec ipfs_cluster ipfs-cluster-ctl pin rm "$CID_RESTORE" >/dev/null 2>&1
  sleep 5
  bash "$REPO/update-scripts/pinset-snapshot.sh" --restore "$F" >/dev/null 2>&1
  sleep 10
  docker exec ipfs_cluster ipfs-cluster-ctl --enc=json status "$CID_RESTORE" 2>/dev/null | grep -qi '"pinned"' \
    && ok "D6 unpinned CID restored from snapshot" || bad "D6 restore did not re-pin $CID_RESTORE"
else
  bad "D6 no CID available in snapshot to drill restore"
fi

echo "== D7 replication sweep: healthy=0, forced-low=strict-fail+alert, recovered=0 =="
bash "$REPO/update-scripts/replication-sweep.sh" --strict >/dev/null 2>&1 \
  && ok "D7 sweep clean on healthy cluster" || bad "D7 sweep flagged a healthy cluster"
docker stop fxe2e_fA_cluster fxe2e_fB_cluster >/dev/null 2>&1
systemctl stop fxe2e-master-ipfscluster.service
echo "  (3 of 4 peers down; waiting 30s for status to notice...)"
sleep 30
if bash "$REPO/update-scripts/replication-sweep.sh" --strict >/dev/null 2>&1; then
  bad "D7 sweep MISSED forced under-replication"
else
  ok "D7 sweep detected under-replication (strict exit 1)"
fi
grep -q under-replicated /opt/fula-master/replication-alerts.log 2>/dev/null \
  && ok "D7 alert logged" || bad "D7 no alert in log"
docker start fxe2e_fA_cluster fxe2e_fB_cluster >/dev/null 2>&1
systemctl start fxe2e-master-ipfscluster.service
echo "  (peers back; waiting 45s to reconverge...)"
sleep 45
bash "$REPO/update-scripts/replication-sweep.sh" --strict >/dev/null 2>&1 \
  && ok "D7 sweep clean again after recovery" || bad "D7 cluster did not reconverge for sweep"

echo
echo "RESULT: pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ] || exit 1
