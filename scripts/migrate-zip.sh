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
TIMESTAMP=$(date -u +%Y%m%d-%H%M%SZ)
NAME="fula-migration-${TIMESTAMP}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)             OUT_DIR="$2"; shift 2 ;;
    --no-blocks)       INCLUDE_BLOCKS=false; shift ;;
    --no-cluster-data) INCLUDE_CLUSTER_DATA=false; shift ;;
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

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }
log "Bundle: $W"

# Detect docker availability up front
HAVE_DOCKER=true
command -v docker >/dev/null 2>&1 || HAVE_DOCKER=false
$HAVE_DOCKER || log "WARN: docker not available — container-related sections will be skipped"

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
  docker exec ipfs_host ipfs config show > "$W/kubo/config.json"  2>/dev/null || true
  docker exec ipfs_host ipfs id          > "$W/kubo/id.json"      2>/dev/null || true
  docker exec ipfs_host ipfs key list -l > "$W/kubo/key-list.txt" 2>/dev/null || true

  # Raw config = peer ID + private key for the kubo node itself
  docker cp ipfs_host:/data/ipfs/config "$W/kubo/raw-config.json" 2>/dev/null || true

  # Export every IPNS key in the keystore (covers fula-db-backup AND fula-registry)
  mkdir -p "$W/kubo/exported-keys"
  docker exec ipfs_host ipfs key list 2>/dev/null | while read -r keyname; do
    [ -z "$keyname" ] && continue
    if docker exec ipfs_host sh -c "cd /tmp && ipfs key export '$keyname'" >/dev/null 2>&1; then
      docker cp "ipfs_host:/tmp/${keyname}.key" "$W/kubo/exported-keys/${keyname}.key" 2>/dev/null
      docker exec ipfs_host rm -f "/tmp/${keyname}.key" 2>/dev/null || true
    fi
  done

  # Defense in depth — grab the raw keystore directory too (alternate restore path)
  docker cp ipfs_host:/data/ipfs/keystore "$W/kubo/keystore" 2>/dev/null || true
fi

# ============================================================================
# 5. ipfs-cluster: identity, service config, pin list, CRDT state
# ============================================================================
if $HAVE_DOCKER && docker inspect ipfs_cluster >/dev/null 2>&1; then
  log "ipfs-cluster identity + state"
  docker cp ipfs_cluster:/data/ipfs-cluster/identity.json "$W/cluster/" 2>/dev/null || true
  docker cp ipfs_cluster:/data/ipfs-cluster/service.json  "$W/cluster/" 2>/dev/null || true
  docker exec ipfs_cluster ipfs-cluster-ctl peers ls          > "$W/cluster/peers.txt"  2>/dev/null || true
  docker exec ipfs_cluster ipfs-cluster-ctl pin ls --enc=json > "$W/cluster/pins.json"  2>/dev/null || true
  docker exec ipfs_cluster ipfs-cluster-ctl status            > "$W/cluster/status.txt" 2>/dev/null || true

  if $INCLUDE_CLUSTER_DATA; then
    log "  pausing ipfs_cluster ~3s for consistent CRDT snapshot"
    docker pause ipfs_cluster >/dev/null
    CLUSTER_SRC=$(docker inspect ipfs_cluster --format '{{range .Mounts}}{{if eq .Destination "/data/ipfs-cluster"}}{{.Source}}{{end}}{{end}}')
    if [ -n "$CLUSTER_SRC" ] && [ -d "$CLUSTER_SRC" ]; then
      tar -cz -C "$(dirname "$CLUSTER_SRC")" "$(basename "$CLUSTER_SRC")" \
        > "$W/cluster/data.tgz" 2>/dev/null || \
        log "  WARN: cluster data tar produced errors"
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
# 10. fula-gateway state (registry.cid, db-backup.cid, history)
# ============================================================================
log "fula-gateway state"
[ -d /var/lib/fula-gateway ] && tar -czf "$W/fula-gateway/state.tgz" /var/lib/fula-gateway/ 2>/dev/null || true

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
  tar --exclude='/opt/mainnet/node_modules' \
      --exclude='/opt/mainnet/.pm2/logs' \
      --exclude='/opt/mainnet/.pm2/pids' \
      --exclude='/opt/mainnet/logs' \
      --exclude='/opt/mainnet/tmp' \
      -czf "$W/services/mainnet-pool-server/opt-mainnet.tgz" /opt/mainnet/ 2>/dev/null || true
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
  docker exec postgres-pinning pg_dump -U "$PG_USER" -d pinning_service -Fc -Z6 \
    > "$W/postgres/pinning-fresh.dump" 2>/dev/null || \
    log "  WARN: pg_dump failed — check POSTGRES_USER"
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
    docker save "$IMG" 2>/dev/null | gzip > "$W/images/fula-gateway.tar.gz" || \
      log "  WARN: docker save failed for $IMG"
  fi
fi

# ============================================================================
# 18. Kubo block data (the BIG one) — append-mostly, live tar is safe
# ============================================================================
if $HAVE_DOCKER && $INCLUDE_BLOCKS; then
  log "kubo blocks (this can take a while)"
  KUBO_SRC=$(docker inspect ipfs_host --format '{{range .Mounts}}{{if eq .Destination "/data/ipfs"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)
  if [ -n "$KUBO_SRC" ] && [ -d "$KUBO_SRC" ]; then
    SIZE=$(du -sh "$KUBO_SRC" 2>/dev/null | cut -f1)
    log "  source: $KUBO_SRC  size: $SIZE"
    tar -cz -C "$(dirname "$KUBO_SRC")" "$(basename "$KUBO_SRC")" > "$W/kubo/data.tgz" 2>/dev/null || \
      log "  WARN: kubo data tar produced errors — verify with 'ipfs repo verify' on new server"
    [ -f "$W/kubo/data.tgz" ] && log "  done: $(du -sh "$W/kubo/data.tgz" | cut -f1)"
  else
    log "  WARN: could not locate kubo data source"
  fi
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

( cd "$OUT_DIR" && tar -czf "${NAME}.tgz" "${NAME}/" )
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
  KUBO_SRC=$(docker inspect ipfs_host --format '{{range .Mounts}}{{if eq .Destination "/data/ipfs"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)
  if [ -n "$KUBO_SRC" ]; then
    echo "Kubo blocks NOT included. Sync separately:"
    echo "  rsync -aHP --info=progress2 ${KUBO_SRC}/ root@<new-server>:/home/root/ipfs_data/"
    echo
  fi
fi
