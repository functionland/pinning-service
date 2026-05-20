#!/usr/bin/env bash
# standby-sync-kubo.sh — pull kubo blocks + datastore from primary.
#
# Live rsync; primary's kubo daemon keeps running. Safe because flatfs writes
# individual immutable files per CID — a partial rsync sees either a complete
# file or no file at all, never a half-written CID.
#
# Identity files (config, keystore, etc.) are NEVER synced after bootstrap.
# Their on-disk values were established once during recover.sh --standby-bootstrap
# and must remain frozen; preflight refuses to sync if peer IDs ever diverge.
#
# --delete is critical: kubo GC removes pinned-out blocks on primary, and
# without --delete the standby's disk grows monotonically.

set -euo pipefail

CONFIG="/etc/fula-standby/standby-config.sh"
# shellcheck source=/dev/null
. "$CONFIG"

log() { echo "[$(date -u +%H:%M:%SZ)] sync-kubo: $*"; }

STANDBY_KUBO_VOL=$(docker volume inspect ipfs_host_data --format '{{.Mountpoint}}')
mkdir -p "$STANDBY_KUBO_VOL/blocks" "$STANDBY_KUBO_VOL/datastore"

# Exclusions: every file kubo treats as identity, plus runtime sockets and
# transient lock files. Listed verbosely because rsync exclusions are
# load-bearing for correctness here — a missed exclude would overwrite a
# divergent file silently.
EXCLUDES=(
  --exclude=config
  --exclude=keystore
  --exclude=keystore/**
  --exclude=datastore_spec
  --exclude=version
  --exclude=api
  --exclude=gateway
  --exclude=repo.lock
  --exclude=.rsync-partial/
  --exclude='*.swap'
  --exclude='.tmp*'
)

RSYNC_OPTS=(
  -aH
  --delete
  --partial
  --partial-dir=.rsync-partial
  --info=stats1
  --bwlimit="${RSYNC_BWLIMIT:-50M}"
  --timeout=300
  -e "ssh $SSH_OPTS"
  "${EXCLUDES[@]}"
)

log "rsync blocks: $PRIMARY_KUBO_BLOCKS -> $STANDBY_KUBO_VOL/blocks/"
rsync "${RSYNC_OPTS[@]}" \
  "$PRIMARY_USER@$PRIMARY_HOST:$PRIMARY_KUBO_BLOCKS/" \
  "$STANDBY_KUBO_VOL/blocks/"

log "rsync datastore: $PRIMARY_KUBO_DATASTORE -> $STANDBY_KUBO_VOL/datastore/"
rsync "${RSYNC_OPTS[@]}" \
  "$PRIMARY_USER@$PRIMARY_HOST:$PRIMARY_KUBO_DATASTORE/" \
  "$STANDBY_KUBO_VOL/datastore/"

# Kubo runs as uid 1000:1000 inside the official ipfs/kubo image. Ownership on
# the host filesystem must match or the container can't write to its repo.
chown -R 1000:1000 "$STANDBY_KUBO_VOL/blocks" "$STANDBY_KUBO_VOL/datastore"

log "done"
