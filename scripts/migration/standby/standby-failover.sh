#!/usr/bin/env bash
# standby-failover.sh — promote this standby to primary.
#
# Single-command failover. Default behavior is conservative: does NOT fence
# the old primary, does NOT auto-update DNS — just brings this server up.
# Pass --with-fence to additionally try to stop the old primary's services,
# and --auto-dns + a configured DNS provider to update records.
#
# Order is critical. Any failure in steps 5-8 (postgres promote, kubo/cluster
# start) is fatal — we leave the half-promoted state and exit non-zero so the
# operator can investigate. Failures in step 9+ (systemd services) are
# warnings — those services can usually be retried with systemctl restart.

set -uo pipefail

CONFIG="/etc/fula-standby/standby-config.sh"
[ -r "$CONFIG" ] || { echo "FATAL: $CONFIG not found" >&2; exit 1; }
# shellcheck source=/dev/null
. "$CONFIG"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="/var/log/fula-standby-failover.log"

WITH_FENCE=false
AUTO_DNS=false
SKIP_REBUILD=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-fence)   WITH_FENCE=true;   shift ;;
    --auto-dns)     AUTO_DNS=true;     shift ;;
    --skip-rebuild) SKIP_REBUILD=true; shift ;;
    -h|--help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "Must run as root" >&2; exit 1; }

mkdir -p "$(dirname "$LOG_FILE")"
exec > >(tee -a "$LOG_FILE") 2>&1

log()   { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] failover: $*"; }
fatal() { log "FATAL: $*"; exit 1; }
warn()  { log "WARN:  $*"; }

# ----------------------------------------------------------------------------
# 1. Validate this is a valid standby that hasn't already been promoted.
# ----------------------------------------------------------------------------
log "===== failover start ====="
MODE=$(cat "$STANDBY_MODE_FILE" 2>/dev/null | head -n1 || echo missing)
case "$MODE" in
  sync-enabled|bootstrap-complete)
    log "current MODE: $MODE — proceeding"
    ;;
  promoted)
    fatal "MODE is 'promoted' — this server is already a primary; failover would be a no-op or worse"
    ;;
  *)
    fatal "MODE file unreadable or unknown ('$MODE'); refusing to promote a non-standby"
    ;;
esac

# ----------------------------------------------------------------------------
# 2. Acquire the sync lock so we don't race a concurrent cron run. -w 30
#    waits up to 30s; a sync run mid-promote would corrupt state.
# ----------------------------------------------------------------------------
exec 9>"$STANDBY_LOCK_FILE"
if ! flock -w 30 9; then
  fatal "could not acquire sync lock within 30s — a sync may be running; retry"
fi

# ----------------------------------------------------------------------------
# 3. Disable the sync cron so it can't run again during/after promotion.
#    chmod 0000 makes cron skip it (cron requires the file to be readable).
# ----------------------------------------------------------------------------
if [ -f /etc/cron.d/fula-standby-sync ]; then
  chmod 0000 /etc/cron.d/fula-standby-sync
  log "hourly sync cron disabled"
fi
if [ -f /etc/cron.d/fula-standby-wal-puller ]; then
  chmod 0000 /etc/cron.d/fula-standby-wal-puller
  log "WAL puller cron disabled"
fi

# ----------------------------------------------------------------------------
# 4. (optional) Fence primary in the background. The fence script is hard-
#    timed at 15s and ALWAYS exits 0, so this never blocks failover.
# ----------------------------------------------------------------------------
if $WITH_FENCE; then
  log "launching fence in background"
  bash "$SCRIPT_DIR/standby-fence-primary.sh" &
  FENCE_PID=$!
fi

# ----------------------------------------------------------------------------
# 5. Promote postgres from hot-standby to primary.
#
# `pg_ctl promote` writes a promote signal file inside the data dir; postgres
# detects it, finishes WAL replay, and exits recovery mode. We poll
# pg_is_in_recovery() until it returns false (or 60s timeout).
# ----------------------------------------------------------------------------
log "promoting postgres"
docker exec postgres-pinning pg_ctl promote -D /var/lib/postgresql/data 2>&1 \
  || fatal "pg_ctl promote failed"

for i in $(seq 1 60); do
  in_recovery=$(docker exec postgres-pinning psql -U postgres -tA -c 'SELECT pg_is_in_recovery();' 2>/dev/null | tr -d '[:space:]' || echo unknown)
  if [ "$in_recovery" = "f" ]; then
    log "postgres now accepting writes (pg_is_in_recovery=false)"
    break
  fi
  sleep 1
  if [ "$i" -eq 60 ]; then
    fatal "postgres still in recovery after 60s — promote did not complete"
  fi
done

# ----------------------------------------------------------------------------
# 6. Re-enable docker's restart policy on the identity-bearing containers.
#    Bootstrap set them to restart=no precisely to keep this passive; now we
#    want them to come back on host reboot.
# ----------------------------------------------------------------------------
log "re-enabling restart policy on docker containers"
for c in "${STANDBY_DOCKER_OFF[@]}"; do
  docker update --restart=unless-stopped "$c" >/dev/null 2>&1 || warn "could not update restart policy on $c"
done

# ----------------------------------------------------------------------------
# 7. Start kubo. Wait until `ipfs id` succeeds (60s max). Then assert the
#    running peer ID matches what the bundle recorded — anything else means
#    we somehow started a kubo with a different identity, which is corruption
#    and we must NOT proceed.
# ----------------------------------------------------------------------------
log "starting kubo"
docker start ipfs_host >/dev/null

for i in $(seq 1 60); do
  if docker exec ipfs_host ipfs id >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [ "$i" -eq 60 ]; then
    fatal "kubo didn't become ready within 60s"
  fi
done

EXPECTED_KUBO_PEER=""
if [ -f /var/lib/fula-recovery/bundle/kubo/id.json ]; then
  EXPECTED_KUBO_PEER=$(jq -r '.ID // empty' < /var/lib/fula-recovery/bundle/kubo/id.json 2>/dev/null || true)
fi
ACTUAL_KUBO_PEER=$(docker exec ipfs_host ipfs id --format='<id>' 2>/dev/null || true)
if [ -n "$EXPECTED_KUBO_PEER" ] && [ "$EXPECTED_KUBO_PEER" != "$ACTUAL_KUBO_PEER" ]; then
  fatal "kubo started with WRONG peer ID (got '$ACTUAL_KUBO_PEER', expected '$EXPECTED_KUBO_PEER'); aborting before more damage"
fi
log "kubo up, peer ID: $ACTUAL_KUBO_PEER"

# ----------------------------------------------------------------------------
# 8. Start cluster. Wait for `ipfs-cluster-ctl id`. Verify peer ID.
# ----------------------------------------------------------------------------
log "starting cluster"
docker start ipfs_cluster >/dev/null

for i in $(seq 1 60); do
  if docker exec ipfs_cluster ipfs-cluster-ctl id >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [ "$i" -eq 60 ]; then
    fatal "cluster didn't become ready within 60s"
  fi
done

EXPECTED_CLUSTER_PEER=""
if [ -f /var/lib/fula-recovery/bundle/cluster/identity.json ]; then
  EXPECTED_CLUSTER_PEER=$(jq -r '.id // empty' < /var/lib/fula-recovery/bundle/cluster/identity.json 2>/dev/null || true)
fi
ACTUAL_CLUSTER_PEER=$(docker exec ipfs_cluster ipfs-cluster-ctl --enc=json id 2>/dev/null | jq -r .id || true)
if [ -n "$EXPECTED_CLUSTER_PEER" ] && [ "$EXPECTED_CLUSTER_PEER" != "$ACTUAL_CLUSTER_PEER" ]; then
  fatal "cluster started with WRONG peer ID (got '$ACTUAL_CLUSTER_PEER', expected '$EXPECTED_CLUSTER_PEER')"
fi
log "cluster up, peer ID: $ACTUAL_CLUSTER_PEER"

# ----------------------------------------------------------------------------
# 9. Rebuild build artifacts (node_modules, Go binaries, fula-gateway image).
#    Code dirs were rsynced from primary but build outputs were excluded.
#    This typically takes 5-10 min and is the dominant component of RTO.
# ----------------------------------------------------------------------------
if $SKIP_REBUILD; then
  warn "skipping rebuild (--skip-rebuild); services may fail to start if build artifacts are stale"
else
  log "rebuilding build artifacts (this is the slow part — 5-10 min)"
  if ! bash "$SCRIPT_DIR/standby-rebuild-on-promote.sh"; then
    fatal "rebuild failed — services would not start cleanly. Investigate /var/log/fula-recovery.log"
  fi
fi

# ----------------------------------------------------------------------------
# 10. Start nginx, then systemd services in dependency order. Same order
#     recover.sh's phase_start uses. Service-level failures here are WARN,
#     not fatal — they're usually individually fixable post-failover.
# ----------------------------------------------------------------------------
log "starting nginx"
systemctl enable nginx >/dev/null 2>&1 || true
if ! systemctl restart nginx; then
  warn "nginx failed to restart — check 'nginx -t' and 'journalctl -u nginx'"
fi

log "starting systemd services"
SERVICES=(
  redis-server
  fula-pinning-service
  fula-upload-server
  fula-pinning-webui
  fula-gateway
  fula-ai-service
  x402-gateway
  libp2p-service
  mainnet-pool-server
  mainnet-rewards-server
)
for s in "${SERVICES[@]}"; do
  if ! systemctl list-unit-files 2>/dev/null | grep -q "^${s}\.service" && \
     [ ! -f "/etc/systemd/system/${s}.service" ]; then
    log "  $s: unit not present — skipping"
    continue
  fi
  systemctl enable "$s" >/dev/null 2>&1 || true
  if systemctl restart "$s"; then
    sleep 2
    if systemctl is-active --quiet "$s"; then
      log "  $s: active"
    else
      warn "$s: restart returned 0 but unit is not active (status: $(systemctl is-active "$s" 2>/dev/null))"
    fi
  else
    warn "$s: restart failed — see 'journalctl -u $s --since 1min'"
  fi
done

# ----------------------------------------------------------------------------
# 11. Activate deferred crons (fula-db-backup, fula-registry-ipns). These
#     publish to IPNS keys the primary owned; during standby they were staged
#     in /var/lib/fula-standby/deferred-cron/ so they wouldn't conflict.
# ----------------------------------------------------------------------------
DEFERRED_DIR="$STANDBY_STATE_DIR/deferred-cron"
if [ -d "$DEFERRED_DIR" ]; then
  log "activating deferred crons"
  shopt -s nullglob
  for f in "$DEFERRED_DIR"/*; do
    name=$(basename "$f")
    install -m 0644 -o root -g root "$f" "/etc/cron.d/$name"
    log "  installed /etc/cron.d/$name"
  done
  shopt -u nullglob
fi

# ----------------------------------------------------------------------------
# 12. DNS cutover instructions (or auto-update if implemented).
# ----------------------------------------------------------------------------
log ""
log "===== DNS CUTOVER ====="
THIS_IP=$(curl -s -4 https://ifconfig.io 2>/dev/null || hostname -I | awk '{print $1}')
log "Update your DNS A records to point at: $THIS_IP"
log "Affected hostnames (check /etc/nginx/sites-enabled/ for the canonical list):"
ls /etc/nginx/sites-enabled/ 2>/dev/null | sed 's/^/  /' || true
if $AUTO_DNS; then
  log "(--auto-dns set but no provider integration implemented; do this manually)"
fi
log "After DNS resolves to this server, run: bash /opt/pinning-service/scripts/migration/recover.sh --phase=certs"
log "  (to re-issue TLS certs via certbot for the new IP)"
log ""

# ----------------------------------------------------------------------------
# 13. Run the same post_verify health matrix recover.sh uses.
# ----------------------------------------------------------------------------
log "running post-failover health checks"
if bash /opt/pinning-service/scripts/migration/recover.sh --phase=post_verify 2>&1 | tail -100; then
  :
else
  warn "post_verify reported issues — review above"
fi

# ----------------------------------------------------------------------------
# 14. Mark this server as promoted. Any future sync run will see MODE=promoted
#     and refuse — which is correct (you can't sync from yourself).
# ----------------------------------------------------------------------------
{
  echo "promoted"
  date -u +%Y-%m-%dT%H:%M:%SZ
} > "$STANDBY_MODE_FILE"
log "MODE -> promoted"

# Wait briefly for the fence to finish so its log lands in our output.
if $WITH_FENCE && [ -n "${FENCE_PID:-}" ]; then
  wait "$FENCE_PID" 2>/dev/null || true
fi

log "===== failover complete ====="
log "Next steps:"
log "  1. Verify clients can reach this server (DNS, firewall, certs)"
log "  2. Confirm pinning-service traffic is being served (check /var/log/nginx/access.log)"
log "  3. If old primary comes back online, do NOT let it start fula services — set restart=no"
log "  4. To rebuild a new standby pointing at THIS server: run migrate-zip.sh here and bootstrap a fresh standby"
