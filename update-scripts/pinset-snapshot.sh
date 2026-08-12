#!/usr/bin/env bash
#
# pinset-snapshot.sh — signed pinset snapshots (Phase 1.5; early slice of the
# FM-3 mass-unpin backstop: a restore path exists BEFORE the chain registry).
#
# Dumps the cluster's AUTHORITATIVE desired-state pinset (`pin ls`, not
# runtime `status`) as JSON, signs it (ed25519 via openssl), prunes old
# snapshots. Restore = re-`pin add` every CID in a snapshot (see --restore).
#
# Usage:
#   pinset-snapshot.sh                 take + sign + prune
#   pinset-snapshot.sh --verify FILE   check signature
#   pinset-snapshot.sh --restore FILE  re-pin every CID in FILE (after verify)
#   pinset-snapshot.sh --install-cron  install /etc/cron.d entry (every 6h)
#
# Env: CLUSTER_CONTAINER (ipfs_cluster), OUT_DIR (/opt/fula-master/snapshots),
#      KEY (/opt/fula-master/snapshot-ed25519.pem), KEEP (28), CTL_HOST ('').
#
set -euo pipefail
CLUSTER_CONTAINER="${CLUSTER_CONTAINER:-ipfs_cluster}"
OUT_DIR="${OUT_DIR:-/opt/fula-master/snapshots}"
KEY="${KEY:-/opt/fula-master/snapshot-ed25519.pem}"
PUB="${KEY%.pem}.pub.pem"
KEEP="${KEEP:-28}"
CTL_HOST="${CTL_HOST:-}"   # e.g. /ip4/127.0.0.1/tcp/9094 (ctl default already)

die() { echo "ERROR: $*" >&2; exit 1; }
ctl() { # shellcheck disable=SC2086
  docker exec "$CLUSTER_CONTAINER" ipfs-cluster-ctl ${CTL_HOST:+--host "$CTL_HOST"} "$@"; }

ensure_key() {
  [ -f "$KEY" ] && return 0
  mkdir -p "$(dirname "$KEY")"
  openssl genpkey -algorithm ed25519 -out "$KEY" >/dev/null 2>&1 || die "openssl ed25519 keygen failed"
  openssl pkey -in "$KEY" -pubout -out "$PUB"
  chmod 600 "$KEY"
  echo "[pinset-snapshot] generated signing key $KEY (pub: $PUB)"
}

verify() {
  local f="$1"
  [ -f "$f" ] && [ -f "$f.sig" ] || die "missing $f or $f.sig"
  [ -f "$PUB" ] || die "missing public key $PUB"
  openssl pkeyutl -verify -pubin -inkey "$PUB" -rawin -in "$f" -sigfile "$f.sig" >/dev/null 2>&1 \
    && echo "[pinset-snapshot] signature OK: $f" || die "SIGNATURE INVALID: $f"
}

case "${1:-}" in
  --verify)  verify "${2:?usage: --verify FILE}"; exit 0 ;;
  --install-cron)
    cat > /etc/cron.d/fula-pinset-snapshot <<EOF
# Fula federated master — signed pinset snapshots every 6h (Phase 1.5)
0 */6 * * * root CLUSTER_CONTAINER=$CLUSTER_CONTAINER OUT_DIR=$OUT_DIR KEY=$KEY KEEP=$KEEP $(readlink -f "$0") >> /var/log/fula-pinset-snapshot.log 2>&1
EOF
    chmod 644 /etc/cron.d/fula-pinset-snapshot
    echo "[pinset-snapshot] cron installed: /etc/cron.d/fula-pinset-snapshot"
    exit 0 ;;
  --restore)
    f="${2:?usage: --restore FILE}"
    verify "$f"
    echo "[pinset-snapshot] restoring pins from $f ..."
    n=0
    # Each snapshot line is one pin object; re-pinning an existing pin is a
    # no-op at the cluster level, so restore is idempotent and mixed-state safe.
    while IFS= read -r cid; do
      [ -n "$cid" ] || continue
      ctl pin add "$cid" >/dev/null 2>&1 && n=$((n+1)) || echo "  WARN: pin add failed for $cid"
    done < <(jq -r 'if type=="array" then .[] else . end | .cid // .Cid // empty' "$f")
    echo "[pinset-snapshot] restore complete: $n pins re-added"
    exit 0 ;;
esac

# ---- take a snapshot ----
command -v jq >/dev/null || die "jq required"
mkdir -p "$OUT_DIR"
ensure_key
TS="$(date -u +%Y%m%dT%H%M%SZ)"
F="$OUT_DIR/pinset-$TS.json"
ctl --enc=json pin ls > "$F" || die "cluster pin ls failed"
COUNT="$(jq -r 'if type=="array" then length else 1 end' "$F" 2>/dev/null || echo '?')"
openssl pkeyutl -sign -inkey "$KEY" -rawin -in "$F" -out "$F.sig" || die "signing failed"
echo "[pinset-snapshot] $F ($COUNT pins) + signature"

# prune: keep newest $KEEP snapshot pairs
ls -1t "$OUT_DIR"/pinset-*.json 2>/dev/null | tail -n "+$((KEEP+1))" | while read -r old; do
  rm -f "$old" "$old.sig"
  echo "[pinset-snapshot] pruned $old"
done
