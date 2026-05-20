#!/usr/bin/env bash
# standby-fence-primary.sh — best-effort fence of the primary on failover.
#
# Called by standby-failover.sh when --with-fence is passed. Tries to stop
# the primary's identity-bearing services so a partial-failure primary doesn't
# fight the newly-promoted standby for the same peer IDs / IPNS records.
#
# This script:
#   - has a HARD timeout (15s); a hung SSH must not block failover
#   - ALWAYS exits 0; "primary unreachable" is a probable failover scenario
#     and should be reported, not treated as fatal
#   - logs success/failure to stderr (failover orchestrator captures it)
#
# Safe to call when primary is already off — it just times out faster.

set -u    # NOT -e: the whole point is to keep going on errors

CONFIG="/etc/fula-standby/standby-config.sh"
# shellcheck source=/dev/null
. "$CONFIG"

log() { echo "[$(date -u +%H:%M:%SZ)] fence: $*" >&2; }

log "attempting to fence primary ($PRIMARY_USER@$PRIMARY_HOST), 15s timeout"

# All of these run on the primary if it's reachable. The here-doc uses single
# quotes to prevent any local expansion — every $var here refers to the
# remote shell. The remote script ignores failures of individual stop calls
# (set +e) so an absent service doesn't short-circuit the rest.
timeout 15 ssh $SSH_OPTS -o ConnectTimeout=5 \
  "$PRIMARY_USER@$PRIMARY_HOST" bash -s <<'REMOTE' 2>&1
set +e
echo "fence: stopping systemd services"
systemctl stop \
  fula-pinning-service fula-upload-server fula-pinning-webui \
  fula-gateway fula-ai-service x402-gateway libp2p-service \
  mainnet-pool-server mainnet-rewards-server 2>/dev/null

echo "fence: stopping containers"
docker stop -t 10 ipfs_host ipfs_cluster fula-gateway-1 2>/dev/null

echo "fence: setting restart=no so a host reboot doesn't bring them back"
docker update --restart=no ipfs_host ipfs_cluster fula-gateway-1 2>/dev/null

echo "fence: done"
REMOTE
rc=$?
case "$rc" in
  0)   log "fence completed cleanly" ;;
  124) log "fence TIMED OUT after 15s — primary likely unreachable" ;;
  *)   log "fence returned rc=$rc — partial or failed; check failover log" ;;
esac

exit 0    # never propagate — failover must not block
