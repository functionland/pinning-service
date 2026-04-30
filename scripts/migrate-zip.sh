#!/usr/bin/env bash
# migrate-zip.sh — Snapshot every artifact needed to reconstruct the Fula Cloud
# stack (pinning-service + fula-api + mainnet-pool-server + mainnet-rewards +
# x402-gateway + fula-ai-service + libp2p-service) on a brand new Ubuntu host.
#
# Run on the OLD server as root:
#   sudo bash migrate-zip.sh                         # default: include kubo blocks + cluster CRDT
#   sudo bash migrate-zip.sh --no-blocks             # skip kubo blocks (transfer separately via rsync)
#   sudo bash migrate-zip.sh --out /tmp2             # custom output directory
#
# Output:
#   <out>/fula-migration-<UTC-timestamp>.tgz
#   <out>/fula-migration-<UTC-timestamp>.tgz.sha256
#
# Read-only against host filesystem and database. Briefly (~3s) pauses ipfs-cluster
# for a consistent CRDT snapshot.

set -euo pipefail

OUT_DIR="/tmp2"
INCLUDE_BLOCKS=true
INCLUDE_CLUSTER_DATA=true
WITH_PIN_LIST=false
DOCKER_CTL_TIMEOUT=30
DOCKER_CP_TIMEOUT=60
TIMESTAMP=$(date -u +%Y%m%d-%H%M%SZ)
NAME="fula-migration-${TIMESTAMP}"

# Used in the printed-at-end rsync hint as the SSH source hostname.
# Defaults to this server's hostname; override by exporting MIGRATE_HOSTNAME
# before running (e.g. if the new server reaches you via a different DNS name).
MIGRATE_HOSTNAME="${MIGRATE_HOSTNAME:-$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo "<old-server>")}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)               OUT_DIR="$2"; shift 2 ;;
    --no-blocks)         INCLUDE_BLOCKS=false; shift ;;
    --no-cluster-data)   INCLUDE_CLUSTER_DATA=false; shift ;;
    --with-pin-list)     WITH_PIN_LIST=true; shift ;;
    --ctl-timeout)       DOCKER_CTL_TIMEOUT="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "Must run as root"; exit 1; }
mkdir -p "$OUT_DIR"
W="$OUT_DIR/$NAME"
mkdir -p "$W"/{systemd,docker,kubo,cluster,cron,nginx,letsencrypt,ufw,sysctl,fula-gateway,redis,env,apple,services,postgres,images}

# Open FD 3 as a dedicated log channel pointing at whatever the original stderr
# was (a terminal when run interactively). log() writes to FD 3, so callers
# can redirect FD 1 (stdout) AND FD 2 (stderr) freely — common pattern in this
# script:  `_dexec ... > capture.txt 2>/dev/null`  — without losing log lines.
exec 3>&2
log() { echo "[$(date -u +%H:%M:%SZ)] $*" >&3; }
log "Bundle: $W"

# ============================================================================
# Resource-pressure controls
# ----------------------------------------------------------------------------
# The single most expensive operation in this script is the kubo blocks tar:
# it reads millions of small files (flatfs) and gzip-compresses them, all
# while the production stack is still serving traffic. On servers with large
# pinned datasets (>50 GB) this can saturate one CPU core for tens of minutes
# AND saturate disk I/O, making the host feel unresponsive even though it's
# making progress.
#
# Mitigations applied throughout this script:
#   1. nice + ionice — heavy commands run at the lowest CPU + I/O priority,
#      so production services keep their fair share of resources.
#   2. pigz when available — multi-threaded gzip; same compression format as
#      gzip but uses all CPU cores and runs ~N times faster on N-core hosts.
#   3. compression level 1 — much faster than the default level 6, with
#      negligible size penalty for kubo block data (most blocks are already
#      content-compressed by their producers).
#   4. no double-compression on outer bundle — the outer tarball runs
#      gzip -1 around contents that are already gzipped, which would be
#      pure CPU waste. We skip recompression of already-compressed members.
# ============================================================================

# Auto-install pigz on Debian/Ubuntu if running as root and apt is available.
# Tiny package; one-time install; benefits every subsequent run.
if ! command -v pigz >/dev/null 2>&1; then
  if [[ $EUID -eq 0 ]] && command -v apt-get >/dev/null 2>&1; then
    log "installing pigz for parallel compression (one-time, takes <30s)..."
    DEBIAN_FRONTEND=noninteractive apt-get install -y pigz >/dev/null 2>&1 \
      || log "  pigz install failed; falling back to single-threaded gzip"
  else
    log "NOTE: pigz not installed — single-threaded gzip will be used (slower)."
    log "      To speed up future runs: apt install pigz"
  fi
fi

# Compression helper. Reads stdin, writes stdout. Defaults to level 1 (fast)
# for the kubo block stream because IPFS blocks are largely uncompressible
# already; level 6+ burns CPU for sub-1% size reduction.
NPROC=$(nproc 2>/dev/null || echo 2)
_compress() {
  local level="${1:-1}"
  if command -v pigz >/dev/null 2>&1; then
    pigz "-${level}" "-p${NPROC}"
  else
    gzip "-${level}"
  fi
}

# Run a command at the lowest CPU + I/O priority to keep production responsive.
# Falls through transparently if nice/ionice aren't installed.
_low_impact() {
  local NICE=""  IONICE=""
  command -v nice   >/dev/null 2>&1 && NICE="nice -n 19"
  command -v ionice >/dev/null 2>&1 && IONICE="ionice -c 3"
  $NICE $IONICE "$@"
}

# Timeout-wrapped docker exec / docker cp. On a production server, individual
# control-plane commands (e.g., `ipfs-cluster-ctl pin ls --enc=json`) can hang
# for many minutes when the cluster has a large pin set. Without a timeout,
# such a hang silently stalls the whole bundle. Default 30s for CTL queries,
# 60s for file copies (kubo keystore, identity files).
#
# All wrappers PRINT what they're about to run (truncated) before executing,
# so if the script hangs, the user sees exactly which line is the culprit.
_dexec() {
  local desc="$1"; shift
  log "    [exec ${DOCKER_CTL_TIMEOUT}s] $desc"
  # Run the command; capture its real exit code BEFORE testing it, otherwise
  # `if ! cmd` flips the exit status and we lose the actual rc.
  timeout "${DOCKER_CTL_TIMEOUT}" docker exec "$@"
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
      log "    [TIMEOUT after ${DOCKER_CTL_TIMEOUT}s] $desc — skipping (cluster/daemon busy?)"
    else
      log "    [exec rc=$rc] $desc — skipping"
    fi
  fi
  return $rc
}

_dcp() {
  local desc="$1" src="$2" dst="$3"
  log "    [cp ${DOCKER_CP_TIMEOUT}s] $desc ($src -> $dst)"
  timeout "${DOCKER_CP_TIMEOUT}" docker cp "$src" "$dst"
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
      log "    [TIMEOUT after ${DOCKER_CP_TIMEOUT}s] $desc — skipping"
    else
      log "    [cp rc=$rc] $desc — file not present at that path (path mismatch?)"
    fi
  fi
  return $rc
}

# Detect docker availability up front
HAVE_DOCKER=true
command -v docker >/dev/null 2>&1 || HAVE_DOCKER=false
$HAVE_DOCKER || log "WARN: docker not available — container-related sections will be skipped"

# ----------------------------------------------------------------------------
# Detect the IPFS data directory inside the kubo container. Stock kubo image
# uses /data/ipfs but custom-installed setups can use /root/.ipfs or others.
# Returns the in-container path on stdout, or empty if not found.
# ----------------------------------------------------------------------------
_detect_kubo_data_path() {
  local container="$1" candidate
  # Method 1: read IPFS_PATH from the daemon's environment
  candidate=$(timeout 5 docker exec "$container" sh -c 'printf "%s" "$IPFS_PATH"' 2>/dev/null)
  if [ -n "$candidate" ] && timeout 5 docker exec "$container" test -f "$candidate/config" 2>/dev/null; then
    echo "$candidate"; return 0
  fi
  # Method 2: probe common paths
  for candidate in /data/ipfs /root/.ipfs /home/ipfs/.ipfs; do
    if timeout 5 docker exec "$container" test -f "$candidate/config" 2>/dev/null; then
      echo "$candidate"; return 0
    fi
  done
  return 1
}

_detect_cluster_data_path() {
  local container="$1" candidate
  candidate=$(timeout 5 docker exec "$container" sh -c 'printf "%s" "$IPFS_CLUSTER_PATH"' 2>/dev/null)
  if [ -n "$candidate" ] && timeout 5 docker exec "$container" test -f "$candidate/identity.json" 2>/dev/null; then
    echo "$candidate"; return 0
  fi
  for candidate in /data/ipfs-cluster /root/.ipfs-cluster; do
    if timeout 5 docker exec "$container" test -f "$candidate/identity.json" 2>/dev/null; then
      echo "$candidate"; return 0
    fi
  done
  return 1
}

# ----------------------------------------------------------------------------
# Resolve an in-container path to its corresponding host path by finding the
# longest matching mount destination prefix. Handles arbitrary mount layering
# (Fula Box, vanilla, multi-bind, etc.).
#
# Example: container has these mounts:
#     /uniondrive       (host) → /uniondrive       (container)
#     /home/root/.fula  (host) → /internal         (container)
#     /var/lib/docker/volumes/.../_data → /data/ipfs-cluster
#
# _resolve_container_path ipfs_cluster /uniondrive/ipfs-cluster
#   → /uniondrive/ipfs-cluster   (matches /uniondrive prefix, suffix=/ipfs-cluster)
#
# _resolve_container_path ipfs_host /internal/ipfs_data
#   → /home/root/.fula/ipfs_data (matches /internal prefix, suffix=/ipfs_data)
# ----------------------------------------------------------------------------
_resolve_container_path() {
  local container="$1" in_path="$2"
  docker inspect "$container" --format '{{json .Mounts}}' 2>/dev/null \
    | python3 -c '
import json, sys
mounts = json.load(sys.stdin)
p = sys.argv[1].rstrip("/")
matches = [
    m for m in mounts
    if p == m["Destination"].rstrip("/")
       or p.startswith(m["Destination"].rstrip("/") + "/")
]
if not matches:
    sys.exit(1)
best = max(matches, key=lambda m: len(m["Destination"].rstrip("/")))
suffix = p[len(best["Destination"].rstrip("/")):].lstrip("/")
src = best["Source"].rstrip("/")
print(src + ("/" + suffix if suffix else ""))
' "$in_path"
}

# Always unpause ipfs_cluster on exit, even on Ctrl-C or mid-snapshot crash.
# Without this, a failure between `docker pause` and `docker unpause` leaves the
# cluster frozen indefinitely, blocking pinning-service traffic on the OLD server.
# Safe to call even if cluster wasn't paused or doesn't exist.
trap 'docker unpause ipfs_cluster >/dev/null 2>&1 || true' EXIT INT TERM

# ============================================================================
# 1. systemd unit files (use these verbatim on the new server)
# ============================================================================
log "systemd units"
for s in fula-pinning-service fula-pinning-webui fula-upload-server fula-gateway \
         fula-ai-service x402-gateway hub-server mainnet-pool-server \
         mainnet-rewards-server libp2p-service go-fula redis ipfs ipfscluster \
         ipfs-cluster-web ipfs-pinning; do
  for ext in service service.bak; do
    src="/etc/systemd/system/${s}.${ext}"
    [ -f "$src" ] && cp "$src" "$W/systemd/" 2>/dev/null || true
  done
done
# Override fragments
cp -r /etc/systemd/system/*.service.d "$W/systemd/" 2>/dev/null || true

# ============================================================================
# 2. Cron jobs
# ============================================================================
log "cron"
[ -d /etc/cron.d ] && cp -r /etc/cron.d "$W/cron/cron.d" 2>/dev/null || true
crontab -l > "$W/cron/root.crontab" 2>/dev/null || true

# ============================================================================
# 3. Docker container definitions (env, ports, volumes, restart policy)
# ============================================================================
if $HAVE_DOCKER; then
  log "docker inspect"
  for c in postgres-pinning ipfs_host ipfs_cluster fula-gateway-1; do
    docker inspect "$c" > "$W/docker/${c}.json" 2>/dev/null \
      || echo "missing: $c" >> "$W/docker/missing.log"
  done
  docker volume ls -q > "$W/docker/volumes-list.txt" 2>/dev/null || true
  if [ -s "$W/docker/volumes-list.txt" ]; then
    docker volume inspect $(cat "$W/docker/volumes-list.txt") > "$W/docker/volumes.json" 2>/dev/null || true
  fi
  docker network ls > "$W/docker/networks-list.txt" 2>/dev/null || true
fi

# ============================================================================
# 4. Kubo: peer ID, full config, IPNS keystore, every IPNS key exported
# ============================================================================
if $HAVE_DOCKER && docker inspect ipfs_host >/dev/null 2>&1; then
  log "kubo identity + keys"
  _dexec "ipfs config show" ipfs_host ipfs config show > "$W/kubo/config.json"  2>/dev/null || true
  _dexec "ipfs id"          ipfs_host ipfs id          > "$W/kubo/id.json"      2>/dev/null || true
  _dexec "ipfs key list -l" ipfs_host ipfs key list -l > "$W/kubo/key-list.txt" 2>/dev/null || true

  # Auto-detect kubo data path (stock = /data/ipfs, but custom installs vary).
  # Falls back to /data/ipfs and lets _dcp warn if files aren't there.
  KUBO_PATH_IN_CONTAINER=$(_detect_kubo_data_path ipfs_host || echo "/data/ipfs")
  if [ "$KUBO_PATH_IN_CONTAINER" = "/data/ipfs" ]; then
    log "  kubo data path inside container: $KUBO_PATH_IN_CONTAINER (default)"
  else
    log "  kubo data path inside container: $KUBO_PATH_IN_CONTAINER (custom — auto-detected)"
  fi

  # Raw config = peer ID + private key for the kubo node itself
  _dcp "kubo raw config" "ipfs_host:${KUBO_PATH_IN_CONTAINER}/config" "$W/kubo/raw-config.json" || true

  # datastore_spec describes WHERE blocks + pebbleds live (relative or absolute
  # paths). Critical for restoring on a new server: without this, the new kubo
  # creates a default spec and won't find migrated data at custom paths.
  _dcp "kubo datastore_spec" "ipfs_host:${KUBO_PATH_IN_CONTAINER}/datastore_spec" "$W/kubo/datastore_spec" || true

  # Export every IPNS key in the keystore (covers fula-db-backup AND fula-registry)
  mkdir -p "$W/kubo/exported-keys"
  KEY_NAMES=$(timeout "${DOCKER_CTL_TIMEOUT}" docker exec ipfs_host ipfs key list 2>/dev/null || echo "")
  if [ -n "$KEY_NAMES" ]; then
    while read -r keyname; do
      [ -z "$keyname" ] && continue
      if timeout "${DOCKER_CTL_TIMEOUT}" docker exec ipfs_host sh -c "cd /tmp && ipfs key export '$keyname'" >/dev/null 2>&1; then
        _dcp "key $keyname" "ipfs_host:/tmp/${keyname}.key" "$W/kubo/exported-keys/${keyname}.key" || true
        timeout "${DOCKER_CTL_TIMEOUT}" docker exec ipfs_host rm -f "/tmp/${keyname}.key" 2>/dev/null || true
      fi
    done <<< "$KEY_NAMES"
  fi

  # Defense in depth — grab the raw keystore directory too (alternate restore path)
  _dcp "kubo keystore dir" "ipfs_host:${KUBO_PATH_IN_CONTAINER}/keystore" "$W/kubo/keystore" || true
fi

# ============================================================================
# 5. ipfs-cluster: identity, service config, pin list, CRDT state
# ============================================================================
if $HAVE_DOCKER && docker inspect ipfs_cluster >/dev/null 2>&1; then
  log "ipfs-cluster identity + state"

  # Auto-detect cluster data path (stock = /data/ipfs-cluster).
  CLUSTER_PATH_IN_CONTAINER=$(_detect_cluster_data_path ipfs_cluster || echo "/data/ipfs-cluster")
  if [ "$CLUSTER_PATH_IN_CONTAINER" = "/data/ipfs-cluster" ]; then
    log "  cluster data path inside container: $CLUSTER_PATH_IN_CONTAINER (default)"
  else
    log "  cluster data path inside container: $CLUSTER_PATH_IN_CONTAINER (custom — auto-detected)"
  fi

  # Identity files are tiny — fast even on busy clusters. Fall back gracefully
  # if missing here; they're also inside cluster/data.tgz from the host-side tar.
  _dcp "identity.json" "ipfs_cluster:${CLUSTER_PATH_IN_CONTAINER}/identity.json" "$W/cluster/" || true
  _dcp "service.json"  "ipfs_cluster:${CLUSTER_PATH_IN_CONTAINER}/service.json"  "$W/cluster/" || true

  # peers ls is small (1 entry per cluster member). Quick.
  _dexec "ipfs-cluster-ctl peers ls" ipfs_cluster ipfs-cluster-ctl peers ls \
    > "$W/cluster/peers.txt" 2>/dev/null || true

  # pin ls --enc=json walks the ENTIRE cluster pin set. On a production cluster
  # with hundreds of thousands of pins this can take many minutes, lock the
  # cluster API while it runs, AND produce a multi-GB JSON file. Skipped by
  # default — the canonical pin set is in cluster/data.tgz (CRDT state) which
  # we capture below. Re-enable with --with-pin-list if you specifically want
  # the JSON dump as a diagnostic artifact.
  if $WITH_PIN_LIST; then
    log "  --with-pin-list: capturing pin list JSON (may take several minutes)"
    _dexec "ipfs-cluster-ctl pin ls --enc=json" ipfs_cluster ipfs-cluster-ctl pin ls --enc=json \
      > "$W/cluster/pins.json" 2>/dev/null || true
    # status command similarly walks every pin's allocation state — heavy
    _dexec "ipfs-cluster-ctl status" ipfs_cluster ipfs-cluster-ctl status \
      > "$W/cluster/status.txt" 2>/dev/null || true
  else
    log "  skipping pin ls + status (canonical pin set is in cluster/data.tgz; pass --with-pin-list to override)"
  fi

  if $INCLUDE_CLUSTER_DATA; then
    # Resolve the in-container data path to a host path via mount-prefix match.
    # On Fula Box this is /uniondrive/ipfs-cluster (the bulky one) rather than
    # the docker volume mounted at /data/ipfs-cluster (which is empty).
    CLUSTER_SRC=$(_resolve_container_path ipfs_cluster "$CLUSTER_PATH_IN_CONTAINER" 2>/dev/null || echo "")

    log "  pausing ipfs_cluster ~3s for consistent CRDT snapshot"
    docker pause ipfs_cluster >/dev/null

    if [ -n "$CLUSTER_SRC" ] && [ -d "$CLUSTER_SRC" ]; then
      log "  cluster data source on host: $CLUSTER_SRC (resolved from $CLUSTER_PATH_IN_CONTAINER)"
      ls -la "$CLUSTER_SRC" 2>/dev/null | tail -n +2 | head -20 | sed 's/^/    /' >&3 || true
      # Note: not using `local` here — we're at the script's top level, not in
      # a function. (`local` is a syntax error outside function scope.)
      TOTAL_SRC_BYTES=$(du -sb "$CLUSTER_SRC" 2>/dev/null | cut -f1 || echo "0")
      TOTAL_SRC_HUMAN=$(du -sh "$CLUSTER_SRC" 2>/dev/null | cut -f1 || echo "?")
      log "  cluster data total size on host: ${TOTAL_SRC_HUMAN} (${TOTAL_SRC_BYTES} bytes)"

      # If the source is large (>100 MB), warn that this is now the heavy step
      if [ "${TOTAL_SRC_BYTES:-0}" -gt 104857600 ]; then
        log "  NOTE: cluster CRDT is ${TOTAL_SRC_HUMAN}; tar+compress may take several minutes"
      fi

      if _low_impact tar -c -C "$(dirname "$CLUSTER_SRC")" "$(basename "$CLUSTER_SRC")" 2>/dev/null \
           | _compress 1 > "$W/cluster/data.tgz"; then
        TAR_SIZE_BYTES=$(stat -c%s "$W/cluster/data.tgz" 2>/dev/null || echo 0)
        TAR_SIZE_HUMAN=$(du -sh "$W/cluster/data.tgz" 2>/dev/null | cut -f1)
        log "  cluster CRDT snapshot saved: $TAR_SIZE_HUMAN ($TAR_SIZE_BYTES bytes compressed)"
        # Sanity check: tarball should be at least 5% of source size for typical
        # CRDT data (compresses ~3-5x). If much smaller, something's wrong.
        if [ "${TOTAL_SRC_BYTES:-0}" -gt 1048576 ] && \
           [ "${TAR_SIZE_BYTES:-0}" -lt $((TOTAL_SRC_BYTES / 20)) ]; then
          log "  WARN: tarball is suspiciously small relative to source"
          log "        (source ${TOTAL_SRC_HUMAN}, tarball ${TAR_SIZE_HUMAN})"
          log "        This may indicate a mount-resolution mismatch. Investigate before transferring."
        fi
      else
        log "  WARN: cluster data tar produced errors"
      fi
    else
      log "  WARN: could not resolve cluster data path '$CLUSTER_PATH_IN_CONTAINER' to a host path"
      log "        Container mounts:"
      docker inspect ipfs_cluster --format '{{range .Mounts}}{{printf "    %s -> %s\n" .Source .Destination}}{{end}}' >&3 2>/dev/null
    fi
    docker unpause ipfs_cluster >/dev/null
    log "  resumed ipfs_cluster"
  fi
fi

# ============================================================================
# 6. Nginx full tree
# ============================================================================
log "nginx"
[ -f /etc/nginx/nginx.conf ] && cp /etc/nginx/nginx.conf "$W/nginx/"
for d in conf.d snippets sites-available sites-enabled; do
  [ -d "/etc/nginx/$d" ] && cp -r "/etc/nginx/$d" "$W/nginx/" 2>/dev/null || true
done
ls -la /etc/nginx/sites-enabled/ > "$W/nginx/sites-enabled-listing.txt" 2>/dev/null || true

# ============================================================================
# 7. UFW
# ============================================================================
log "ufw"
ufw status numbered > "$W/ufw/status.txt" 2>/dev/null || true
[ -f /etc/ufw/user.rules ]   && cp /etc/ufw/user.rules   "$W/ufw/" 2>/dev/null || true
[ -f /etc/ufw/before.rules ] && cp /etc/ufw/before.rules "$W/ufw/" 2>/dev/null || true

# ============================================================================
# 8. Let's Encrypt — preserves certs so cutover doesn't need re-issuance
# ============================================================================
log "letsencrypt"
[ -d /etc/letsencrypt ] && tar -czf "$W/letsencrypt.tgz" /etc/letsencrypt/ 2>/dev/null || true

# ============================================================================
# 9. sysctl + ulimits (IPFS file-descriptor / TCP tuning)
# ============================================================================
log "sysctl + limits"
[ -d /etc/sysctl.d ]            && cp -r /etc/sysctl.d            "$W/sysctl/sysctl.d"     2>/dev/null || true
[ -d /etc/security/limits.d ]   && cp -r /etc/security/limits.d   "$W/sysctl/limits.d"     2>/dev/null || true
sysctl -a 2>/dev/null | grep -E "^(fs\.|net\.core|net\.ipv4\.tcp)" > "$W/sysctl/runtime.txt" || true

# ============================================================================
# 10. fula-gateway state (registry.cid, db-backup.cid, history) — small
# ============================================================================
log "fula-gateway state"
if [ -d /var/lib/fula-gateway ]; then
  _low_impact tar -c /var/lib/fula-gateway/ 2>/dev/null \
    | _compress 1 > "$W/fula-gateway/state.tgz" || true
fi

# ============================================================================
# 11. Redis
# ============================================================================
log "redis"
for f in /var/lib/redis/dump.rdb /var/lib/redis/appendonly.aof /etc/redis/redis.conf; do
  [ -f "$f" ] && cp "$f" "$W/redis/" 2>/dev/null || true
done

# ============================================================================
# 12. Application .env files (8 services)
# ============================================================================
log "env files"
declare -A ENV_PATHS=(
  [pinning-service]=/home/root/pinning-service/.env
  [ipfs-server]=/home/root/pinning-service/ipfs-server/.env
  [pinning-webui]=/home/root/pinning-service/pinning-webui/.env
  [x402-skale]=/home/root/pinning-service/x402-skale/.env
  [fula-ai-service]=/opt/fula-ai-service/.env
  [mainnet-pool-server]=/opt/mainnet/.env
  [mainnet-rewards-server]=/opt/mainnet-rewards/.env
  [fula-api]=/etc/fula/.env
)
for name in "${!ENV_PATHS[@]}"; do
  src="${ENV_PATHS[$name]}"
  # Use `install -m 0600` instead of `cp` to make secret-file mode explicit and
  # immune to source-file mode drift. The bundle tarball can sit at rest on the
  # transfer host; bundled .env files must always be 0600.
  [ -f "$src" ] && install -m 0600 "$src" "$W/env/${name}.env" 2>/dev/null || true
done

# ============================================================================
# 13. Apple Sign-In key file (chmod 600 — Apple .p8 is signing-key sensitive)
# ============================================================================
log "apple key"
if [ -d /etc/apple ]; then
  cp -rL /etc/apple/. "$W/apple/" 2>/dev/null || true
  find "$W/apple" -type f -exec chmod 600 {} \; 2>/dev/null || true
fi

# ============================================================================
# 14. /home/root/password.txt (just in case)
# ============================================================================
[ -f /home/root/password.txt ] && cp /home/root/password.txt "$W/password.txt" 2>/dev/null || true

# ============================================================================
# 15. Service repo identification + per-service artifacts
# ============================================================================
log "service repos"
for svc_dir in /opt/mainnet /opt/mainnet-rewards /opt/fula-ai-service /opt/fula-api \
               /home/root/pinning-service /home/root/sugarfunge-api /home/root/sugarfunge-node \
               /home/root/temporary-reward-server /home/root/go-fula; do
  [ -d "$svc_dir" ] || continue
  name=$(basename "$svc_dir")
  if [ -d "$svc_dir/.git" ]; then
    ( cd "$svc_dir" && git remote -v ) > "$W/services/${name}-remote.txt" 2>/dev/null || true
    ( cd "$svc_dir" && git log -1 --format='%H %s %ai' ) > "$W/services/${name}-head.txt" 2>/dev/null || true
  fi
done
ls -la /opt          > "$W/services/opt-layout.txt"          2>/dev/null || true
ls -la /home/root    > "$W/services/home-root-layout.txt"    2>/dev/null || true

# mainnet-pool-server: snapshot /opt/mainnet (sans bulk dirs) + pm2 state + ecosystem
if [ -d /opt/mainnet ]; then
  log "mainnet-pool-server snapshot"
  mkdir -p "$W/services/mainnet-pool-server"
  [ -f /opt/mainnet/.pm2/dump.pm2 ]      && cp /opt/mainnet/.pm2/dump.pm2      "$W/services/mainnet-pool-server/" 2>/dev/null || true
  [ -f /opt/mainnet/ecosystem.config.js ] && cp /opt/mainnet/ecosystem.config.js "$W/services/mainnet-pool-server/" 2>/dev/null || true
  _low_impact tar \
      --exclude='/opt/mainnet/node_modules' \
      --exclude='/opt/mainnet/.pm2/logs' \
      --exclude='/opt/mainnet/.pm2/pids' \
      --exclude='/opt/mainnet/logs' \
      --exclude='/opt/mainnet/tmp' \
      -c /opt/mainnet/ 2>/dev/null \
      | _compress 1 > "$W/services/mainnet-pool-server/opt-mainnet.tgz" || true
fi

# libp2p-service: pre-built binary + source for rebuild fallback (NO identity key)
if [ -d /opt/mainnet/libp2p-service ]; then
  log "libp2p-service binary + source"
  mkdir -p "$W/services/libp2p-service"
  [ -x /opt/mainnet/libp2p-service/libp2p-service ] && \
    cp -p /opt/mainnet/libp2p-service/libp2p-service "$W/services/libp2p-service/binary" 2>/dev/null || true
  for src in main.go go.mod go.sum; do
    [ -f "/opt/mainnet/libp2p-service/$src" ] && \
      cp "/opt/mainnet/libp2p-service/$src" "$W/services/libp2p-service/" 2>/dev/null || true
  done
fi

# ============================================================================
# 16. PostgreSQL: fresh dump (canonical), schema, row counts
# ============================================================================
if $HAVE_DOCKER && docker inspect postgres-pinning >/dev/null 2>&1; then
  log "postgres fresh dump"
  PG_USER=$(docker inspect postgres-pinning --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^POSTGRES_USER=' | cut -d= -f2-)
  PG_USER="${PG_USER:-pinning_user}"
  # Use -Z1 (instead of default -Z6 inside pg_dump) — much faster for the same
  # ratio on already-textual SQL data. Don't redirect stderr to /dev/null so
  # genuine pg_dump errors surface in the script log.
  if ! docker exec postgres-pinning pg_dump -U "$PG_USER" -d pinning_service -Fc -Z1 \
       > "$W/postgres/pinning-fresh.dump" 2>>"${OUT_DIR}/pg_dump.err"; then
    log "  WARN: pg_dump failed — see ${OUT_DIR}/pg_dump.err"
    rm -f "$W/postgres/pinning-fresh.dump"  # don't ship a truncated dump
  fi
  docker exec postgres-pinning pg_dump -U "$PG_USER" -d pinning_service --schema-only \
    > "$W/postgres/schema.sql" 2>/dev/null || true
  docker exec postgres-pinning psql -U "$PG_USER" -d pinning_service -tAc \
    "SELECT relname||' '||n_live_tup FROM pg_stat_user_tables ORDER BY relname" \
    > "$W/postgres/row-counts.txt" 2>/dev/null || true
  docker exec postgres-pinning psql -U "$PG_USER" -d pinning_service -tAc "SELECT version()" \
    > "$W/postgres/version.txt" 2>/dev/null || true
  PG_SRC=$(docker inspect postgres-pinning --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}')
  echo "$PG_SRC" > "$W/postgres/data-host-path.txt"
fi

# ============================================================================
# 17. fula-gateway docker image (avoids 10-15min Rust rebuild on new server)
# ============================================================================
if $HAVE_DOCKER; then
  log "saving fula-gateway docker image"
  IMG=$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '^fula-gateway' | head -1)
  if [ -n "$IMG" ]; then
    # docker save streams uncompressed tar; we then compress at level 1.
    # nice+ionice keep this from starving the running gateway container.
    _low_impact docker save "$IMG" 2>/dev/null \
      | _compress 1 > "$W/images/fula-gateway.tar.gz" \
      || log "  WARN: docker save failed for $IMG"
  fi
fi

# ============================================================================
# 18. Kubo block data — follows datastore_spec to find every storage path.
#
# The previous implementation tarred only IPFS_PATH on host. That works for
# default kubo (where blocks live under IPFS_PATH/blocks) but BREAKS for
# custom datastore_spec layouts that put data on a different drive (e.g.,
# Fula Box's /uniondrive/ipfs_datastore/{blocks,datastore}). The kubo daemon
# reads each "path" from datastore_spec when it starts; we must capture each
# of those paths to make the bundle self-sufficient.
#
# For each mount entry in datastore_spec.mounts:
#   - if path is absolute: capture that exact host path
#   - if path is relative: capture IPFS_PATH/<path>
# Result: kubo/data-<basename>.tgz per storage path, e.g.:
#   kubo/data-blocks.tgz       ← from /uniondrive/ipfs_datastore/blocks (or relative "blocks")
#   kubo/data-datastore.tgz    ← from /uniondrive/ipfs_datastore/datastore
# ============================================================================
if $HAVE_DOCKER && $INCLUDE_BLOCKS; then
  SPEC_FILE="$W/kubo/datastore_spec"
  if [ ! -f "$SPEC_FILE" ]; then
    log "  WARN: no datastore_spec captured (older bundle?); falling back to single-tar of $KUBO_PATH_IN_CONTAINER"
    KUBO_PATHS_TO_TAR="$KUBO_PATH_IN_CONTAINER:data"
  else
    # Parse datastore_spec, emit "in_container_path:tarball_name" lines.
    # tarball_name = last component of path; if path is relative, prefix with
    # IPFS_PATH inside the container before resolving.
    KUBO_PATHS_TO_TAR=$(python3 - "$SPEC_FILE" "$KUBO_PATH_IN_CONTAINER" <<'PY'
import json, sys
spec = json.load(open(sys.argv[1]))
ipfs_path = sys.argv[2].rstrip("/")
seen = []
def walk(node):
    if isinstance(node, dict):
        if "path" in node and isinstance(node["path"], str):
            p = node["path"]
            tarball = p.rstrip("/").split("/")[-1] or "root"
            in_path = p if p.startswith("/") else (ipfs_path + "/" + p.lstrip("/"))
            entry = (in_path, tarball)
            if entry not in seen:
                seen.append(entry)
        for v in node.values():
            walk(v)
    elif isinstance(node, list):
        for v in node:
            walk(v)
walk(spec)
for in_path, tarball in seen:
    print(f"{in_path}:{tarball}")
PY
)
  fi

  if [ -z "$KUBO_PATHS_TO_TAR" ]; then
    log "  WARN: could not derive any kubo data paths to tar — bundle will lack block data"
  fi

  # Compute total byte estimate up front for visibility
  TOTAL_KUBO_BYTES=0
  declare -A KUBO_RESOLVED=()  # in_path -> host_path
  while IFS=: read -r in_path tarball; do
    [ -z "$in_path" ] && continue
    host_path=$(_resolve_container_path ipfs_host "$in_path" 2>/dev/null || echo "")
    if [ -z "$host_path" ] || [ ! -d "$host_path" ]; then
      log "  WARN: cannot resolve $in_path → host path; skipping (will be missing from bundle)"
      continue
    fi
    KUBO_RESOLVED["$in_path"]="$host_path"
    bytes=$(du -sb "$host_path" 2>/dev/null | cut -f1 || echo 0)
    TOTAL_KUBO_BYTES=$((TOTAL_KUBO_BYTES + bytes))
  done <<< "$KUBO_PATHS_TO_TAR"

  TOTAL_KUBO_HUMAN=$(numfmt --to=iec-i --suffix=B "$TOTAL_KUBO_BYTES" 2>/dev/null || echo "${TOTAL_KUBO_BYTES} bytes")
  log ""
  log "==[ KUBO DATA — heaviest step ]========================================"
  log "  derived from datastore_spec; tarring each storage path separately so"
  log "  recover.sh can place data at the right relative subdirectory in IPFS_PATH"
  log "  total to tar:    $TOTAL_KUBO_HUMAN"
  if command -v pigz >/dev/null 2>&1; then
    log "  compressor:      pigz -1 -p${NPROC}  (multi-threaded)"
  else
    log "  compressor:      gzip -1  (install 'pigz' for ${NPROC}x speed-up)"
  fi
  log "  priority:        nice=19 + ionice=idle"
  log "  expected total:  roughly $((TOTAL_KUBO_BYTES / 200000000)) sec at 200 MB/s pigz"
  log "                   roughly $((TOTAL_KUBO_BYTES / 50000000))  sec at  50 MB/s gzip"
  log "  monitor:         du -h $W/kubo/data-*.tgz   # tarball sizes grow"
  log "                   iotop -ao                  # I/O usage"
  log "  abort:           Ctrl-C is safe — EXIT trap unpauses cluster + cleans"
  log "======================================================================="
  log ""

  # Tar each path separately
  while IFS=: read -r in_path tarball; do
    [ -z "$in_path" ] && continue
    host_path="${KUBO_RESOLVED[$in_path]:-}"
    [ -z "$host_path" ] && continue
    out_tgz="$W/kubo/data-${tarball}.tgz"
    log "  tarring $host_path → kubo/data-${tarball}.tgz"
    if ! _low_impact tar -c -C "$(dirname "$host_path")" "$(basename "$host_path")" \
           2>>"${OUT_DIR}/kubo_tar.err" \
           | _compress 1 > "$out_tgz"; then
      log "    WARN: tar for $host_path produced errors — check ${OUT_DIR}/kubo_tar.err"
    fi
    if [ -f "$out_tgz" ]; then
      log "    done: $(du -sh "$out_tgz" | cut -f1) compressed"
    fi
  done <<< "$KUBO_PATHS_TO_TAR"
fi

# ============================================================================
# 19. Manifest + checksums + final tarball
# ============================================================================
log "manifest + tarball"
( cd "$W" && find . -type f -size -100M -exec sha256sum {} \; > MANIFEST.sha256 2>/dev/null || true )
( cd "$W" && du -ah . | sort -k1h ) > "$W/MANIFEST.tree" 2>/dev/null || true
{
  echo "Bundle: $NAME"
  echo "Generated: $(date -u +%FT%TZ)"
  echo "Hostname: $(hostname)"
  if [ -f "$W/kubo/id.json" ]; then
    echo "kubo peer ID: $(jq -r .ID < "$W/kubo/id.json" 2>/dev/null || echo unknown)"
  fi
  if [ -f "$W/cluster/identity.json" ]; then
    echo "cluster peer ID: $(jq -r .id < "$W/cluster/identity.json" 2>/dev/null || echo unknown)"
  fi
} > "$W/MANIFEST.metadata"

log "creating final bundle tarball ($OUT_DIR/${NAME}.tgz)"
log "  level-1 compression on already-compressed inner contents (kubo data,"
log "  pg dump, fula-gateway image are all already gzipped); the outer pass"
log "  is essentially a tar concatenation, NOT a re-compression cycle"
( cd "$OUT_DIR" && _low_impact tar -c "${NAME}/" 2>/dev/null | _compress 1 > "${NAME}.tgz" ) \
  || { log "FATAL: outer tarball creation failed"; exit 1; }
sha256sum "$OUT_DIR/${NAME}.tgz" > "$OUT_DIR/${NAME}.tgz.sha256"
chmod 600 "$OUT_DIR/${NAME}.tgz" "$OUT_DIR/${NAME}.tgz.sha256"

echo
echo "==================================================================="
echo " Bundle ready"
echo "  $OUT_DIR/${NAME}.tgz   ($(du -h "$OUT_DIR/${NAME}.tgz" | cut -f1))"
echo "  $OUT_DIR/${NAME}.tgz.sha256"
echo "==================================================================="
echo
echo "Transfer to new server (private channel):"
echo "  scp $OUT_DIR/${NAME}.tgz $OUT_DIR/${NAME}.tgz.sha256 root@<new-server>:/tmp2/"
echo
echo "On the new server:"
echo "  cd /tmp2 && sha256sum -c ${NAME}.tgz.sha256"
echo "  bash /opt/pinning-service/scripts/recover.sh \\"
echo "      --bundle /tmp2/${NAME}.tgz \\"
echo "      --backup-key <64-char hex> \\"
echo "      --db-ipns       k51qzi5uqu5dmguoei6kc4qdrnnawmvew4o8x5fzzg5346x4nii9qis3lpiub9 \\"
echo "      --registry-ipns k51qzi5uqu5dle8iqcdd8snk2xedugpt7kjh5bu3fip639pjoqrd2cwa5vu96q"
echo
if ! $INCLUDE_BLOCKS; then
  # Use mount-prefix matching to resolve the kubo data dir to its real host
  # path. For Fula Box this is /home/root/.fula/ipfs_data, NOT the docker volume.
  KUBO_HOST_PATH=$(_resolve_container_path ipfs_host "${KUBO_PATH_IN_CONTAINER:-/data/ipfs}" 2>/dev/null || echo "")
  if [ -z "$KUBO_HOST_PATH" ]; then
    KUBO_HOST_PATH=$(docker inspect ipfs_host --format '{{range .Mounts}}{{if eq .Destination "/data/ipfs"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)
  fi
  if [ -n "$KUBO_HOST_PATH" ] && [ -d "$KUBO_HOST_PATH" ]; then
    KUBO_HOST_SIZE=$(du -sh "$KUBO_HOST_PATH" 2>/dev/null | cut -f1)
    echo "==[ KUBO DATA — sync separately ]======================================"
    echo "Kubo blocks NOT included in bundle (you used --no-blocks)."
    echo
    echo "Container path:        ${KUBO_PATH_IN_CONTAINER:-/data/ipfs}"
    echo "Default-path source:   $KUBO_HOST_PATH ($KUBO_HOST_SIZE)"
    echo

    # If the user has a custom datastore_spec (Fula Box pattern), the actual
    # blocks live at a path OUTSIDE the IPFS_PATH dir. Read the spec and
    # display every path referenced.
    SPEC_FILE=""
    if [ -f "$W/kubo/datastore_spec" ]; then
      SPEC_FILE="$W/kubo/datastore_spec"
    fi
    if [ -n "$SPEC_FILE" ]; then
      echo "datastore_spec mounts (from your kubo config):"
      python3 - "$SPEC_FILE" <<'PY' 2>/dev/null
import json, sys, os
with open(sys.argv[1]) as f:
    spec = json.load(f)
seen = set()
def walk(n, mountpoint=""):
    if isinstance(n, dict):
        mp = n.get("mountpoint", mountpoint)
        if "path" in n and isinstance(n["path"], str):
            print(f"  {n.get('type','?'):>10} at {mp:>10}  →  {n['path']}")
            if n["path"].startswith("/"):
                # Absolute path — host-side this exact path is what to rsync
                seen.add(n["path"])
        for v in n.values():
            walk(v, mp)
    elif isinstance(n, list):
        for v in n:
            walk(v, mountpoint)
walk(spec)
print()
if seen:
    print("RSYNC THESE ABSOLUTE PATHS (each present on this host):")
    for p in sorted(seen):
        try:
            size = os.popen(f"du -sh {p} 2>/dev/null").read().split('\t')[0].strip()
        except Exception:
            size = "?"
        print(f"  {p}  ({size})")
PY
      echo
      echo "Recommended workflow — run THESE COMMANDS ON THE NEW SERVER (pulling):"
      echo "  1. Mount your external drive at /mnt/ipfs-data (or any path)."
      echo "  2. For EACH absolute-path directory above, run on the new server:"
      echo "       sudo rsync -aHP --partial --info=progress2 --bwlimit=50M \\"
      echo "         root@${MIGRATE_HOSTNAME:-<old-server>}:<absolute-path-on-old-server>/ \\"
      echo "         /mnt/ipfs-data/<last-path-component>/"
      echo
      # Print exact commands for THIS host's paths
      python3 - "$SPEC_FILE" "${MIGRATE_HOSTNAME:-<old-server>}" <<'PY' 2>/dev/null
import json, sys
with open(sys.argv[1]) as f:
    spec = json.load(f)
host = sys.argv[2]
seen = []
def walk(n):
    if isinstance(n, dict):
        if "path" in n and isinstance(n["path"], str) and n["path"].startswith("/"):
            if n["path"] not in seen:
                seen.append(n["path"])
        for v in n.values():
            walk(v)
    elif isinstance(n, list):
        for v in n:
            walk(v)
walk(spec)
if seen:
    print("     Concrete commands for your dataset:")
    for p in seen:
        last = p.rstrip("/").split("/")[-1]
        print(f"       sudo rsync -aHP --partial --info=progress2 --bwlimit=50M \\")
        print(f"         root@{host}:{p}/ \\")
        print(f"         /mnt/ipfs-data/{last}/")
        print()
PY
      echo "  3. Run recover.sh with --kubo-data-host-path /mnt/ipfs-data — it will"
      echo "     translate the datastore_spec absolute paths to relative ones so"
      echo "     kubo reads from /mnt/ipfs-data/<subdir> on the new host."
      echo
      echo "  (Push-style alternative — run on the OLD server if firewall blocks new→old SSH:"
      echo "     swap source/destination of the rsync commands above; same result.)"
      echo
    fi

    # Cluster data — only relevant if user passed --no-cluster-data (rare).
    # By default, the bundle has cluster/data.tgz and recover.sh extracts it
    # to --cluster-data-host-path automatically. Mention this only if the user
    # explicitly disabled cluster bundling.
    if ! $INCLUDE_CLUSTER_DATA; then
      echo "==[ CLUSTER DATA — also needs separate rsync (--no-cluster-data was set) ]"
      echo "  On the new server (pulling from old):"
      echo "    sudo rsync -aHP --partial --info=progress2 \\"
      echo "      root@${MIGRATE_HOSTNAME:-<old-server>}:/uniondrive/ipfs-cluster/ \\"
      echo "      /mnt/cluster-data/"
      echo "  Then pass --cluster-data-host-path /mnt/cluster-data to recover.sh."
      echo
    fi
    echo "======================================================================="
    echo
  fi
fi
