#!/usr/bin/env bash
# standby-rebuild-on-promote.sh — regenerate build artifacts against the
# synced source tree before starting services on failover.
#
# Code dirs are rsynced from primary (so /opt/pinning-service, /opt/fula-api,
# etc. mirror primary's deployed state), but node_modules, Go binaries, and
# the fula-gateway docker image are deliberately excluded from the rsync
# (they're large, regenerable, and arch-sensitive). Running this script
# rebuilds them on the standby's hardware.
#
# Each invocation calls a single recover.sh phase. recover.sh's `--phase=NAME`
# clears the corresponding `.done` checkpoint before running, so this works
# whether or not the phase ran during bootstrap.
#
# This script is called by standby-failover.sh AFTER kubo + cluster start
# (so anything that needs the daemon's HTTP API works) but BEFORE the
# fula-* systemd services start. Roughly 5-10 min on a typical box.

set -euo pipefail

RECOVER="${RECOVER_SH:-/opt/pinning-service/scripts/migration/recover.sh}"
[ -x "$RECOVER" ] || { echo "FATAL: recover.sh not found at $RECOVER"; exit 1; }

log() { echo "[$(date -u +%H:%M:%SZ)] rebuild: $*"; }

PHASES=(
  build_pinning_core
  build_subservices
  build_mainnet_pool
  build_mainnet_rewards
  build_libp2p_service
  install_fula_api
)

for p in "${PHASES[@]}"; do
  log "running recover.sh --phase=$p"
  if bash "$RECOVER" --phase="$p"; then
    log "  $p: OK"
  else
    rc=$?
    log "  $p: FAILED (rc=$rc)"
    # Hard fail: an unbuilt service can't start cleanly. Bail loudly so the
    # failover orchestrator knows to abort.
    exit "$rc"
  fi
done

log "all build phases completed"
