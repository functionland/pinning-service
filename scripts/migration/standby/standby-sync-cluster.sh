#!/usr/bin/env bash
# standby-sync-cluster.sh — pull ipfs-cluster CRDT state from primary.
#
# Pause-window strategy (the load-bearing decision):
#
#   The naive pattern (pause -> tar | gzip | ssh | gunzip | tar -x -> unpause)
#   keeps the cluster paused for the ENTIRE network transfer. On a hundreds-
#   of-MB CRDT over a non-LAN link, that's tens of seconds — every sync run.
#   The primary's pinning-service traffic stalls the whole time.
#
#   Instead: pause cluster, tar to a LOCAL tmpfile on primary, unpause
#   IMMEDIATELY, then stream the tmpfile back outside the pause window. The
#   pause is bounded to local-disk tar duration only (~1-5s for typical CRDT
#   sizes), regardless of the standby's network speed.
#
# Identity files (identity.json, service.json) are excluded from BOTH the tar
# and the rsync-into-volume — they were set once at bootstrap and must stay
# frozen; the preflight check refuses to sync if they ever diverge.

set -euo pipefail

CONFIG="/etc/fula-standby/standby-config.sh"
# shellcheck source=/dev/null
. "$CONFIG"

log() { echo "[$(date -u +%H:%M:%SZ)] sync-cluster: $*"; }

STANDBY_CLUSTER_VOL=$(docker volume inspect ipfs_cluster_data --format '{{.Mountpoint}}')
STAGING="$STANDBY_STAGING_DIR/cluster.$$"
mkdir -p "$STAGING"

# Cleanup local staging + remote tmpfile on any exit, including kill. The
# remote-tmpfile cleanup is best-effort; if SSH is broken we obviously can't
# reach it, and primary's /tmp gets cleaned by the OS on reboot anyway.
REMOTE_TARBALL=""
cleanup() {
  rm -rf "$STAGING" 2>/dev/null || true
  if [ -n "$REMOTE_TARBALL" ]; then
    ssh $SSH_OPTS "$PRIMARY_USER@$PRIMARY_HOST" "rm -f '$REMOTE_TARBALL'" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# ----------------------------------------------------------------------------
# Phase A — pause briefly on primary, tar to local tmpfile, unpause.
#
# The remote heredoc:
#   - Sets its OWN trap to unpause on EXIT/INT/TERM/HUP (HUP catches SSH
#     session death). This is set BEFORE `docker pause`, so even if the
#     heredoc crashes mid-execution the cluster gets unpaused.
#   - Resolves the in-container cluster path to its host path via the same
#     mount-prefix python helper migrate-zip.sh uses. Don't hardcode; on
#     Fula Box this is /uniondrive/ipfs-cluster, on stock it's the named
#     volume's mountpoint.
#   - Prints the tarball path as the last line of stdout for us to capture.
#
# Quoting: <<'REMOTE' (single-quoted heredoc) prevents local-side expansion,
# so $$ etc. evaluate on the primary as intended.
# ----------------------------------------------------------------------------
log "issuing pause+tar on primary"
REMOTE_OUTPUT=$(ssh $SSH_OPTS "$PRIMARY_USER@$PRIMARY_HOST" bash -s <<'REMOTE'
set -euo pipefail

TARBALL="/tmp/fula-cluster-snap-$$-$(date -u +%s).tgz"

CLUSTER_PATH_IN=$(docker exec ipfs_cluster sh -c 'printf "%s" "${IPFS_CLUSTER_PATH:-/data/ipfs-cluster}"' 2>/dev/null)
[ -n "$CLUSTER_PATH_IN" ] || { echo "ERROR: cannot read IPFS_CLUSTER_PATH inside container" >&2; exit 1; }

# Resolve in-container path -> host path via longest mount-prefix match.
HOST_PATH=$(docker inspect ipfs_cluster --format '{{json .Mounts}}' 2>/dev/null \
  | python3 -c '
import json, sys
mounts = json.load(sys.stdin)
p = sys.argv[1].rstrip("/")
matches = [m for m in mounts if p == m["Destination"].rstrip("/") or p.startswith(m["Destination"].rstrip("/") + "/")]
if not matches:
    sys.exit(1)
best = max(matches, key=lambda m: len(m["Destination"].rstrip("/")))
suffix = p[len(best["Destination"].rstrip("/")):].lstrip("/")
src = best["Source"].rstrip("/")
print(src + ("/" + suffix if suffix else ""), end="")
' "$CLUSTER_PATH_IN")

[ -n "$HOST_PATH" ] && [ -d "$HOST_PATH" ] || {
  echo "ERROR: cannot resolve cluster host path (in-container: $CLUSTER_PATH_IN)" >&2
  exit 1
}

# Trap MUST be installed before the pause. If a fault between install and
# pause leaves the cluster un-paused, that's a no-op; the trap is harmless.
# But the reverse — pause without a trap — risks leaving the cluster frozen.
trap 'docker unpause ipfs_cluster >/dev/null 2>&1 || true' EXIT INT TERM HUP

docker pause ipfs_cluster >/dev/null

# nice+ionice minimize CPU/IO impact on the primary during tar.
# gzip -1 because CRDT state is small enough that level-6 doesn't pay back.
nice -n 19 ionice -c 3 tar \
  --warning=no-file-changed \
  --exclude=identity.json \
  --exclude=service.json \
  -c -C "$(dirname "$HOST_PATH")" "$(basename "$HOST_PATH")" 2>/dev/null \
  | gzip -1 > "$TARBALL"

docker unpause ipfs_cluster >/dev/null
trap - EXIT INT TERM HUP

# Final line of stdout = tarball path. Caller captures.
echo "$TARBALL"
REMOTE
)

REMOTE_TARBALL=$(echo "$REMOTE_OUTPUT" | tail -n1)
case "$REMOTE_TARBALL" in
  /tmp/fula-cluster-snap-*.tgz) : ;;
  *)
    log "FATAL: unexpected remote output (no tarball path):"
    echo "$REMOTE_OUTPUT" | sed 's/^/  /'
    exit 1
    ;;
esac
log "remote tarball: $REMOTE_TARBALL"

# ----------------------------------------------------------------------------
# Phase B — stream the tarball back. Cluster is RUNNING again at this point;
# this transfer doesn't impact primary's pinning-service traffic.
# ----------------------------------------------------------------------------
log "scp tarball back to standby"
scp $SSH_OPTS -q "$PRIMARY_USER@$PRIMARY_HOST:$REMOTE_TARBALL" "$STAGING/snap.tgz"

# ----------------------------------------------------------------------------
# Phase C — unpack on standby and atomic-swap into cluster volume.
#
# We unpack into staging, then rsync (--delete) into the live cluster volume.
# rsync, not mv, because the volume has identity.json + service.json that we
# must NOT touch. The --delete makes the standby's CRDT match primary's
# exactly (modulo identity files), which is the whole point of the sync.
# ----------------------------------------------------------------------------
log "unpacking + applying"
tar -xzf "$STAGING/snap.tgz" -C "$STAGING"
TAR_TOPLEVEL=$(find "$STAGING" -mindepth 1 -maxdepth 1 -type d ! -name '.*' | head -n1)
[ -d "$TAR_TOPLEVEL" ] || { log "FATAL: tarball had no top-level dir"; exit 1; }

rsync -aH --delete \
  --exclude=identity.json \
  --exclude=service.json \
  "$TAR_TOPLEVEL/" "$STANDBY_CLUSTER_VOL/"

# ipfs-cluster runs as uid 1000:1000 in the official image (same as kubo).
chown -R 1000:1000 "$STANDBY_CLUSTER_VOL"
chmod 0600 "$STANDBY_CLUSTER_VOL/identity.json" "$STANDBY_CLUSTER_VOL/service.json" 2>/dev/null || true

log "done"
