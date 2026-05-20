#!/usr/bin/env bash
# standby-preflight.sh — pre-flight checks for warm-standby sync.
#
# Called by standby-sync.sh before EVERY sync run, and by standby-failover.sh
# before any state-changing step. Refuses to proceed (non-zero exit) if any
# invariant is violated.
#
# Exit codes:
#   0 — OK to sync/promote
#   1 — primary SSH unreachable
#   2 — standby identity files missing or unreadable
#   3 — peer-ID divergence between standby and primary (standby was likely
#       promoted previously; sync would corrupt the cluster)
#   4 — identity-bearing service unexpectedly running on standby (sync would
#       race; a sync that overwrote a running daemon's state is corruption)

set -euo pipefail

CONFIG="/etc/fula-standby/standby-config.sh"
[ -r "$CONFIG" ] || { echo "FATAL: $CONFIG not found — was bootstrap run?" >&2; exit 1; }
# shellcheck source=/dev/null
. "$CONFIG"

log() { echo "[$(date -u +%H:%M:%SZ)] preflight: $*"; }

# ----------------------------------------------------------------------------
# 1. SSH reachable?
# ----------------------------------------------------------------------------
if ! timeout 15 ssh $SSH_OPTS "$PRIMARY_USER@$PRIMARY_HOST" true 2>/dev/null; then
  log "FATAL: cannot SSH to primary ($PRIMARY_USER@$PRIMARY_HOST)"
  exit 1
fi
log "SSH to primary OK"

# ----------------------------------------------------------------------------
# 2. Resolve standby's kubo + cluster volume mountpoints (host paths) so we
#    can read identity files directly without starting any container.
# ----------------------------------------------------------------------------
STANDBY_KUBO_VOL=$(docker volume inspect ipfs_host_data --format '{{.Mountpoint}}' 2>/dev/null || true)
[ -n "$STANDBY_KUBO_VOL" ] && [ -d "$STANDBY_KUBO_VOL" ] || {
  log "FATAL: standby kubo volume 'ipfs_host_data' not found or not mounted"
  exit 2
}

STANDBY_CLUSTER_VOL=$(docker volume inspect ipfs_cluster_data --format '{{.Mountpoint}}' 2>/dev/null || true)
[ -n "$STANDBY_CLUSTER_VOL" ] && [ -d "$STANDBY_CLUSTER_VOL" ] || {
  log "FATAL: standby cluster volume 'ipfs_cluster_data' not found or not mounted"
  exit 2
}

# ----------------------------------------------------------------------------
# 3. Read standby's kubo + cluster peer IDs from on-disk files.
#    Kubo's daemon is stopped; reading config directly is the only way to know
#    what peer ID it WOULD use if it started. The config file is a JSON object
#    with .Identity.PeerID at the top level.
# ----------------------------------------------------------------------------
[ -r "$STANDBY_KUBO_VOL/config" ] || { log "FATAL: $STANDBY_KUBO_VOL/config not readable"; exit 2; }
STANDBY_KUBO_PEER=$(jq -r '.Identity.PeerID // empty' < "$STANDBY_KUBO_VOL/config" 2>/dev/null)
[ -n "$STANDBY_KUBO_PEER" ] || { log "FATAL: cannot extract Identity.PeerID from standby kubo config"; exit 2; }

[ -r "$STANDBY_CLUSTER_VOL/identity.json" ] || { log "FATAL: $STANDBY_CLUSTER_VOL/identity.json not readable"; exit 2; }
STANDBY_CLUSTER_PEER=$(jq -r '.id // empty' < "$STANDBY_CLUSTER_VOL/identity.json" 2>/dev/null)
[ -n "$STANDBY_CLUSTER_PEER" ] || { log "FATAL: cannot extract id from standby cluster identity.json"; exit 2; }

# ----------------------------------------------------------------------------
# 4. Read primary's live peer IDs via SSH.
# ----------------------------------------------------------------------------
PRIMARY_KUBO_PEER=$(timeout 20 ssh $SSH_OPTS "$PRIMARY_USER@$PRIMARY_HOST" \
  "docker exec ipfs_host ipfs config show 2>/dev/null | jq -r '.Identity.PeerID // empty'" 2>/dev/null || true)
[ -n "$PRIMARY_KUBO_PEER" ] || { log "FATAL: cannot read primary kubo peer ID via SSH"; exit 1; }

PRIMARY_CLUSTER_PEER=$(timeout 20 ssh $SSH_OPTS "$PRIMARY_USER@$PRIMARY_HOST" \
  "docker exec ipfs_cluster cat /data/ipfs-cluster/identity.json 2>/dev/null | jq -r '.id // empty'" 2>/dev/null || true)
[ -n "$PRIMARY_CLUSTER_PEER" ] || { log "FATAL: cannot read primary cluster peer ID via SSH"; exit 1; }

# ----------------------------------------------------------------------------
# 5. Compare. Divergence here means the standby was previously promoted and
#    forgot to re-bootstrap. Sync would push primary's state on top of a
#    different peer-ID-owning standby, which is irrecoverable corruption.
# ----------------------------------------------------------------------------
if [ "$STANDBY_KUBO_PEER" != "$PRIMARY_KUBO_PEER" ]; then
  log "FATAL: kubo peer ID divergence"
  log "  standby: $STANDBY_KUBO_PEER"
  log "  primary: $PRIMARY_KUBO_PEER"
  log "  This standby is not a valid replica of this primary. Was it previously"
  log "  promoted? To recover: stop, wipe, re-bootstrap from a fresh bundle."
  exit 3
fi
if [ "$STANDBY_CLUSTER_PEER" != "$PRIMARY_CLUSTER_PEER" ]; then
  log "FATAL: cluster peer ID divergence"
  log "  standby: $STANDBY_CLUSTER_PEER"
  log "  primary: $PRIMARY_CLUSTER_PEER"
  exit 3
fi
log "peer-ID match: kubo=$STANDBY_KUBO_PEER cluster=$STANDBY_CLUSTER_PEER"

# ----------------------------------------------------------------------------
# 6. Standby's identity-bearing containers must NOT be running. If they are,
#    we'd be writing into a live datastore and the daemon would either crash
#    or corrupt its own state.
# ----------------------------------------------------------------------------
for c in "${STANDBY_DOCKER_OFF[@]}"; do
  state=$(docker inspect "$c" --format '{{.State.Status}}' 2>/dev/null || echo absent)
  if [ "$state" = "running" ] || [ "$state" = "restarting" ]; then
    log "FATAL: container '$c' on standby is $state — sync would corrupt its state"
    log "  Run: docker stop $c && docker update --restart=no $c"
    exit 4
  fi
done

# ----------------------------------------------------------------------------
# 7. Standby's identity-bearing systemd units must NOT be active.
# ----------------------------------------------------------------------------
for u in "${STANDBY_SYSTEMD_OFF[@]}"; do
  if systemctl is-active --quiet "$u" 2>/dev/null; then
    log "FATAL: systemd unit '$u' on standby is active — sync would race"
    log "  Run: systemctl stop $u && systemctl disable $u"
    exit 4
  fi
done

# ----------------------------------------------------------------------------
# 8. MODE must be sync-enabled (or, for failover, anything not 'promoted').
#    A standby that has never been "armed" by the operator shouldn't sync —
#    bootstrap-complete is the unarmed state.
# ----------------------------------------------------------------------------
MODE=$(cat "$STANDBY_MODE_FILE" 2>/dev/null | head -n1 || echo missing)
case "$MODE" in
  sync-enabled)
    : # OK
    ;;
  bootstrap-complete)
    log "FATAL: MODE is '$MODE' — standby has been bootstrapped but sync is not armed."
    log "  After installing the SSH pubkey on primary and verifying connectivity, run:"
    log "    echo sync-enabled > $STANDBY_MODE_FILE"
    exit 4
    ;;
  promoted)
    log "FATAL: MODE is 'promoted' — this standby is now a primary; sync would be backwards."
    exit 4
    ;;
  *)
    log "FATAL: MODE file unreadable or unknown value: '$MODE'"
    exit 4
    ;;
esac

log "all preflight checks passed"
exit 0
