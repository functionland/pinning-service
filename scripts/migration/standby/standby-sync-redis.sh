#!/usr/bin/env bash
# standby-sync-redis.sh — pull redis persistence from primary.
#
# Stops standby's redis first so the RDB file isn't open-for-write during
# rsync; uses .new + atomic rename so an interrupted transfer leaves the
# previous good RDB in place; restarts redis at the end.

set -euo pipefail

CONFIG="/etc/fula-standby/standby-config.sh"
# shellcheck source=/dev/null
. "$CONFIG"

log() { echo "[$(date -u +%H:%M:%SZ)] sync-redis: $*"; }

DATA_DIR="/var/lib/redis"
[ -d "$DATA_DIR" ] || { log "$DATA_DIR not present — skipping (redis may not be installed yet)"; exit 0; }

WAS_ACTIVE=false
if systemctl is-active --quiet redis-server 2>/dev/null; then
  WAS_ACTIVE=true
  log "stopping redis-server"
  systemctl stop redis-server
fi

# RDB (snapshot) — should always be present.
rsync -t --timeout=120 -e "ssh $SSH_OPTS" \
  "$PRIMARY_USER@$PRIMARY_HOST:$DATA_DIR/dump.rdb" \
  "$DATA_DIR/dump.rdb.new"
mv "$DATA_DIR/dump.rdb.new" "$DATA_DIR/dump.rdb"

# AOF (append-only file) — may not exist if AOF persistence is disabled.
# Treat absence as non-fatal.
if rsync -t --timeout=120 -e "ssh $SSH_OPTS" \
     "$PRIMARY_USER@$PRIMARY_HOST:$DATA_DIR/appendonly.aof" \
     "$DATA_DIR/appendonly.aof.new" 2>/dev/null; then
  mv "$DATA_DIR/appendonly.aof.new" "$DATA_DIR/appendonly.aof"
fi

chown redis:redis "$DATA_DIR/dump.rdb" 2>/dev/null || true
[ -f "$DATA_DIR/appendonly.aof" ] && chown redis:redis "$DATA_DIR/appendonly.aof" 2>/dev/null || true

if $WAS_ACTIVE; then
  log "restarting redis-server"
  systemctl start redis-server
fi

log "done"
