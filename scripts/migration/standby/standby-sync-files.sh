#!/usr/bin/env bash
# standby-sync-files.sh — composite sync of every small/state path that
# isn't covered by sync-kubo / sync-cluster / sync-redis / sync-postgres-wal.
#
# Each section is a function so failures are localized and the script can
# continue past a missing path (e.g. /etc/apple/ may not exist on every
# deploy). Anything truly fatal aborts via `fatal`.

set -uo pipefail   # NOT -e: individual section failures should warn, not abort

CONFIG="/etc/fula-standby/standby-config.sh"
# shellcheck source=/dev/null
. "$CONFIG"

log()  { echo "[$(date -u +%H:%M:%SZ)] sync-files: $*"; }
warn() { log "WARN: $*"; }

RSYNC_SSH=(-e "ssh $SSH_OPTS")

# ----------------------------------------------------------------------------
# .env files — listed explicitly because each lives at a service-specific
# path. Each contains secrets (POSTGRES_PASSWORD, JWT_SECRET, etc.), so mode
# 0600 is mandatory. We rsync to a staging file then `install -m 0600` to
# guarantee the final permissions regardless of primary-side mode bits.
# ----------------------------------------------------------------------------
sync_env_files() {
  log "env files"
  mkdir -p "$STANDBY_STATE_DIR/env-staging"

  # name -> remote absolute path
  local -A paths=(
    [pinning-service]=/home/root/pinning-service/.env
    [ipfs-server]=/home/root/pinning-service/ipfs-server/.env
    [pinning-webui]=/home/root/pinning-service/pinning-webui/.env
    [x402-skale]=/home/root/pinning-service/x402-skale/.env
    [fula-ai-service]=/opt/fula-ai-service/.env
    [mainnet-pool-server]=/opt/mainnet/.env
    [mainnet-rewards-server]=/opt/mainnet-rewards/.env
    [fula-api]=/etc/fula/.env
  )

  local name remote staged
  for name in "${!paths[@]}"; do
    remote="${paths[$name]}"
    staged="$STANDBY_STATE_DIR/env-staging/${name}.env"
    if rsync -t "${RSYNC_SSH[@]}" \
         "$PRIMARY_USER@$PRIMARY_HOST:$remote" "$staged" 2>/dev/null; then
      mkdir -p "$(dirname "$remote")"
      install -m 0600 "$staged" "$remote"
    else
      warn "could not fetch env file: $remote (not present on primary?)"
    fi
  done
}

# ----------------------------------------------------------------------------
# fula-gateway runtime state — registry.cid, db-backup.cid, backup-history.json.
# Tiny dir, plain rsync with --delete is fine; gateway is stopped on standby.
# ----------------------------------------------------------------------------
sync_fula_gateway_state() {
  log "/var/lib/fula-gateway/"
  mkdir -p /var/lib/fula-gateway
  rsync -aH --delete "${RSYNC_SSH[@]}" \
    "$PRIMARY_USER@$PRIMARY_HOST:/var/lib/fula-gateway/" \
    /var/lib/fula-gateway/ \
    || warn "fula-gateway state rsync returned non-zero"
}

# ----------------------------------------------------------------------------
# nginx config. We sync the full /etc/nginx/, run `nginx -t` to validate, but
# do NOT reload — nginx is stopped on standby during steady-state. The config
# will be loaded fresh on failover.
# ----------------------------------------------------------------------------
sync_nginx() {
  log "/etc/nginx/"
  rsync -aH --delete \
    --exclude='*.bak' --exclude='temp-*' \
    "${RSYNC_SSH[@]}" \
    "$PRIMARY_USER@$PRIMARY_HOST:/etc/nginx/" /etc/nginx/ \
    || { warn "nginx config rsync failed"; return; }
  nginx -t 2>&1 | tail -5 || warn "nginx -t reported errors — investigate before failover"
}

# ----------------------------------------------------------------------------
# systemd units. Pull fula-*, mainnet-*, x402-*, libp2p-* units (and their
# override drop-in dirs); daemon-reload; re-assert that every identity-bearing
# unit is disabled. Primary may have enabled new units we don't want started
# on this standby.
# ----------------------------------------------------------------------------
sync_systemd_units() {
  log "/etc/systemd/system/ (filtered)"
  rsync -aH "${RSYNC_SSH[@]}" \
    --include='fula-*.service' \
    --include='fula-*.service.d/' \
    --include='fula-*.service.d/*' \
    --include='mainnet-*.service' \
    --include='mainnet-*.service.d/' \
    --include='mainnet-*.service.d/*' \
    --include='x402-*.service' \
    --include='x402-*.service.d/' \
    --include='x402-*.service.d/*' \
    --include='libp2p-*.service' \
    --include='libp2p-*.service.d/' \
    --include='libp2p-*.service.d/*' \
    --include='hub-server.service' --include='go-fula.service' \
    --exclude='*' \
    "$PRIMARY_USER@$PRIMARY_HOST:/etc/systemd/system/" \
    /etc/systemd/system/ \
    || { warn "systemd unit rsync failed"; return; }

  systemctl daemon-reload 2>&1 | tail -5 || true

  local u
  for u in "${STANDBY_SYSTEMD_OFF[@]}"; do
    systemctl disable "$u" >/dev/null 2>&1 || true
  done
}

# ----------------------------------------------------------------------------
# Let's Encrypt certs. -H preserves hardlinks (certbot uses them between
# archive and live dirs). Permissions on private keys MUST be 0600 — rsync
# usually preserves them but we re-assert.
# ----------------------------------------------------------------------------
sync_letsencrypt() {
  log "/etc/letsencrypt/"
  [ -d /etc/letsencrypt ] || mkdir -p /etc/letsencrypt
  rsync -aHX --delete "${RSYNC_SSH[@]}" \
    "$PRIMARY_USER@$PRIMARY_HOST:/etc/letsencrypt/" /etc/letsencrypt/ \
    || { warn "letsencrypt rsync failed"; return; }
  find /etc/letsencrypt/archive -type f -name 'privkey*.pem' -exec chmod 600 {} \; 2>/dev/null || true
  find /etc/letsencrypt/keys     -type f                   -exec chmod 600 {} \; 2>/dev/null || true
}

# ----------------------------------------------------------------------------
# Apple Sign-In private key — small directory, mode 0600 on every file.
# ----------------------------------------------------------------------------
sync_apple() {
  log "/etc/apple/"
  if rsync -aH --delete "${RSYNC_SSH[@]}" \
       "$PRIMARY_USER@$PRIMARY_HOST:/etc/apple/" /etc/apple/ 2>/dev/null; then
    chmod 600 /etc/apple/* 2>/dev/null || true
  fi
  # Silent if remote doesn't have it — not every deploy uses Apple Sign-In.
}

# ----------------------------------------------------------------------------
# Backup encryption key — single small file with the AES-256 key + DB password.
# Atomic rename ensures we never leave a partial write.
# ----------------------------------------------------------------------------
sync_backup_key() {
  log "/root/.fula-backup-key"
  if rsync -t "${RSYNC_SSH[@]}" \
       "$PRIMARY_USER@$PRIMARY_HOST:/root/.fula-backup-key" \
       /root/.fula-backup-key.new 2>/dev/null; then
    mv /root/.fula-backup-key.new /root/.fula-backup-key
    chmod 600 /root/.fula-backup-key
  fi
}

# ----------------------------------------------------------------------------
# Cron files. Exclude:
#   - fula-standby-sync (our own cron; would be overwritten by primary's empty)
#   - fula-db-backup    (primary owns this IPNS key; standby publishing would
#                        corrupt records)
#   - fula-registry-ipns (same — primary owns the registry IPNS key)
# On failover, the deferred crons are activated by standby-failover.sh from
# /var/lib/fula-standby/deferred-cron/ (populated at bootstrap).
# ----------------------------------------------------------------------------
sync_cron() {
  log "/etc/cron.d/ (filtered)"
  rsync -aH --delete "${RSYNC_SSH[@]}" \
    --exclude='fula-standby-sync' \
    --exclude='fula-standby-wal-puller' \
    --exclude='fula-standby-wal-retention' \
    --exclude='fula-db-backup' \
    --exclude='fula-registry-ipns' \
    --exclude='fula-pg-archive-retention' \
    "$PRIMARY_USER@$PRIMARY_HOST:/etc/cron.d/" /etc/cron.d/ \
    || warn "cron.d rsync returned non-zero"
}

# ----------------------------------------------------------------------------
# Code directories. Mirror primary's deployed state (git pulls, builds, etc.).
# Excludes match migrate-zip.sh's set: anything regenerable or transient.
# node_modules is rebuilt during failover by standby-rebuild-on-promote.sh.
# ----------------------------------------------------------------------------
sync_code_dirs() {
  log "code dirs (/opt/* and /home/root/pinning-service)"
  local code_dirs=(
    /opt/pinning-service
    /opt/fula-api
    /opt/mainnet
    /opt/mainnet-rewards
    /opt/fula-ai-service
    /home/root/pinning-service
  )
  local d
  for d in "${code_dirs[@]}"; do
    # Ensure parent exists so rsync doesn't fail on first run.
    mkdir -p "$d"
    rsync -aH --delete "${RSYNC_SSH[@]}" \
      --exclude='node_modules/' \
      --exclude='target/' \
      --exclude='.git/' \
      --exclude='logs/' \
      --exclude='tmp/' \
      --exclude='.pm2/logs/' \
      --exclude='.pm2/pids/' \
      "$PRIMARY_USER@$PRIMARY_HOST:$d/" "$d/" \
      || warn "rsync of $d returned non-zero (primary may not have this dir)"
  done
}

# ----------------------------------------------------------------------------
# Run everything. Each function is best-effort; warnings accumulate but don't
# abort. The orchestrator (standby-sync.sh) reports the final per-section
# pass/warn state.
# ----------------------------------------------------------------------------
sync_env_files
sync_fula_gateway_state
sync_nginx
sync_systemd_units
sync_letsencrypt
sync_apple
sync_backup_key
sync_cron
sync_code_dirs

log "done"
