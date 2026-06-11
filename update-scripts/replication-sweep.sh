#!/usr/bin/env bash
#
# replication-sweep.sh — below-threshold replication monitor + re-pin
# (Phase 1.5; early slice of the Phase-6 repair market; closes the S4 gap:
# "no automated server-side sweep" — see the plan's safeguards section).
#
# For every pin: count peers reporting "pinned". Anything under REPL_MIN gets
# logged + `recover`ed (cluster re-triggers pinning on error/missing peers).
# Exit 0 always in cron mode; --strict exits 1 if anything is still below
# threshold (used by the e2e drill).
#
# Usage: replication-sweep.sh [--strict]
# Env: CLUSTER_CONTAINER (ipfs_cluster), REPL_MIN (2),
#      ALERT_LOG (/opt/fula-master/replication-alerts.log), CTL_HOST (''),
#      --install-cron installs /etc/cron.d entry (every 30 min).
#
set -euo pipefail
CLUSTER_CONTAINER="${CLUSTER_CONTAINER:-ipfs_cluster}"
REPL_MIN="${REPL_MIN:-2}"
ALERT_LOG="${ALERT_LOG:-/opt/fula-master/replication-alerts.log}"
CTL_HOST="${CTL_HOST:-}"
STRICT=0
[ "${1:-}" = "--strict" ] && STRICT=1

die() { echo "ERROR: $*" >&2; exit 1; }
ctl() { # shellcheck disable=SC2086
  docker exec "$CLUSTER_CONTAINER" ipfs-cluster-ctl ${CTL_HOST:+--host "$CTL_HOST"} "$@"; }

if [ "${1:-}" = "--install-cron" ]; then
  cat > /etc/cron.d/fula-replication-sweep <<EOF
# Fula federated master — replication sweep every 30 min (Phase 1.5)
*/30 * * * * root CLUSTER_CONTAINER=$CLUSTER_CONTAINER REPL_MIN=$REPL_MIN ALERT_LOG=$ALERT_LOG $(readlink -f "$0") >> /var/log/fula-replication-sweep.log 2>&1
EOF
  chmod 644 /etc/cron.d/fula-replication-sweep
  echo "[replication-sweep] cron installed: /etc/cron.d/fula-replication-sweep"
  exit 0
fi

command -v jq >/dev/null || die "jq required"
mkdir -p "$(dirname "$ALERT_LOG")"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Stream pin statuses; normalize array vs ndjson across cluster versions.
# Output lines: "<cid> <pinned-count>"
mapfile -t UNDER < <(
  ctl --enc=json status 2>/dev/null \
  | jq -r 'if type=="array" then .[] else . end
           | [.cid // .Cid,
              ([.peer_map[]? | select(.status=="pinned")] | length)]
           | "\(.[0]) \(.[1])"' \
  | awk -v min="$REPL_MIN" '$2 < min { print }'
)

TOTAL="$(ctl --enc=json status 2>/dev/null | jq -r 'if type=="array" then length else 1 end' || echo '?')"

if [ "${#UNDER[@]}" -eq 0 ]; then
  echo "[replication-sweep] $TS OK — all $TOTAL pins at or above REPL_MIN=$REPL_MIN"
  exit 0
fi

echo "[replication-sweep] $TS ALERT — ${#UNDER[@]} pin(s) below REPL_MIN=$REPL_MIN (of $TOTAL):"
for line in "${UNDER[@]}"; do
  cid="${line%% *}"; n="${line##* }"
  echo "  $cid pinned on $n peer(s) — recovering"
  echo "$TS under-replicated cid=$cid pinned=$n min=$REPL_MIN" >> "$ALERT_LOG"
  ctl recover "$cid" >/dev/null 2>&1 || echo "  WARN: recover failed for $cid"
done

[ "$STRICT" = 1 ] && exit 1 || exit 0
