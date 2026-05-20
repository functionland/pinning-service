#!/usr/bin/env bash
# standby-sync.sh — hourly cron entrypoint for warm-standby data sync.
#
# Orchestrates per-category sync scripts. Single-instance via flock; refuses
# to start if a previous run is still in progress. Each sub-script is best-
# effort: a failure in one (e.g. transient SSH blip during kubo rsync) does
# NOT abort the others, but is recorded in the final summary.
#
# Layout:
#   /var/log/fula-standby-sync.log   — append-only run log
#   /var/lock/fula-standby-sync.lock — flock target
#
# Exit codes:
#   0 — all sections passed or warned (cron-safe; no email spam)
#   1 — preflight refused (no sync was attempted)
#   2 — one or more sections hard-failed (operator should investigate)

set -uo pipefail

CONFIG="/etc/fula-standby/standby-config.sh"
[ -r "$CONFIG" ] || { echo "FATAL: $CONFIG not found" >&2; exit 1; }
# shellcheck source=/dev/null
. "$CONFIG"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_START=$(date -u +%s)

# All output is tee'd to the sync log AND stdout (cron will mail stdout if
# cron is configured to do so; otherwise the log file is the record).
mkdir -p "$(dirname "$STANDBY_LOG_FILE")"
exec > >(tee -a "$STANDBY_LOG_FILE") 2>&1

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] sync: $*"; }

# ----------------------------------------------------------------------------
# Single-instance guard.
#
# `flock -n` returns immediately if the lock is held. We exit 0 (not failure)
# because "previous run still going" is normal — long kubo rsync can outrun
# the hourly tick on the first sync after a busy primary day. Logging it makes
# operator-visible without spamming.
# ----------------------------------------------------------------------------
exec 9>"$STANDBY_LOCK_FILE"
if ! flock -n 9; then
  log "previous sync still running (lock held); exiting"
  exit 0
fi

log "===== sync run start ====="

# ----------------------------------------------------------------------------
# Preflight — refuses if peer IDs diverge or any fula service is running on
# standby. A preflight failure is loud (exit 1) because it indicates an
# operational problem that needs human attention.
# ----------------------------------------------------------------------------
if ! bash "$SCRIPT_DIR/standby-preflight.sh"; then
  log "===== preflight refused; sync aborted ====="
  exit 1
fi

# ----------------------------------------------------------------------------
# Dispatch.
#
# We track per-section pass/fail without using -e (so one failure doesn't
# kill the whole run). Each section's stdout/stderr already lands in the log
# via the exec-redirect above.
# ----------------------------------------------------------------------------
declare -A RESULTS
run_section() {
  local name="$1" script="$2" start now rc
  start=$(date -u +%s)
  log "--- $name: start"
  if bash "$script"; then
    rc=0
    RESULTS[$name]=ok
  else
    rc=$?
    RESULTS[$name]="FAIL(rc=$rc)"
  fi
  now=$(date -u +%s)
  log "--- $name: done in $((now - start))s [${RESULTS[$name]}]"
  return 0   # never propagate — orchestrator decides final exit
}

# Order: data-heavy first (so a transient SSH issue doesn't waste the
# pause-window on cluster), then small/cheap. PostgreSQL is NOT here — it
# streams continuously via the restore_command, independent of this cron.
run_section "files"   "$SCRIPT_DIR/standby-sync-files.sh"
run_section "kubo"    "$SCRIPT_DIR/standby-sync-kubo.sh"
run_section "cluster" "$SCRIPT_DIR/standby-sync-cluster.sh"
run_section "redis"   "$SCRIPT_DIR/standby-sync-redis.sh"

# ----------------------------------------------------------------------------
# Summary.
# ----------------------------------------------------------------------------
elapsed=$(( $(date -u +%s) - RUN_START ))
log "===== sync run end (${elapsed}s elapsed) ====="
fail=0
for k in "${!RESULTS[@]}"; do
  log "  $k: ${RESULTS[$k]}"
  [[ "${RESULTS[$k]}" == FAIL* ]] && fail=1
done

if [ "$fail" -ne 0 ]; then
  log "one or more sections failed — see above. Recent log: $STANDBY_LOG_FILE"
  exit 2
fi
exit 0
