#!/usr/bin/env bash
# recover.sh — Bare-metal recovery of the Fula Cloud stack on a new Ubuntu host.
# Driven by a migration bundle produced by migrate-zip.sh on the OLD server.
#
# Run as root on the NEW server:
#   sudo bash recover.sh \
#     --bundle /tmp2/fula-migration-<UTC-timestamp>.tgz \
#     --backup-key <64-char hex> \
#     --db-ipns       k51qzi5uqu5dmguoei6kc4qdrnnawmvew4o8x5fzzg5346x4nii9qis3lpiub9 \
#     --registry-ipns k51qzi5uqu5dle8iqcdd8snk2xedugpt7kjh5bu3fip639pjoqrd2cwa5vu96q \
#     [--phase=NAME]              # run single phase (idempotent)
#     [--ssl-email hi@fx.land]
#     [--mainnet-pool-repo URL]   # fallback if /opt/mainnet snapshot missing from bundle
#                                 # (the canonical URL is
#                                 # https://github.com/functionland/join-server.git)
#     [--prewarm-cluster]         # optional pin pre-warm from DB after start
#     [--skip-ipns-verify]        # skip the IPNS round-trip diagnostic
#     [--blocks-rsync HOST:PATH]  # kubo blocks pre-rsynced separately (skip tar extraction)
#     [--kubo-data-host-path PATH]    # bind kubo data volume to PATH (e.g. /mnt/ipfs-data
#                                     # on an external drive); must be pre-mounted
#     [--cluster-data-host-path PATH] # bind ipfs-cluster data volume to PATH
#     [--defer-dns]                   # skip dns_cutover_pause + certbot issuance.
#                                     # Use this when DNS still points at the old server
#                                     # and you want to validate the new server first via
#                                     # /etc/hosts on a test machine. After DNS cutover,
#                                     # re-run with: --phase=certs (without --defer-dns)
#     [--force-wipe]                  # required for `--phase=pg_restore` re-runs against
#                                     # a database that already has data. Without this,
#                                     # phase_pg_restore refuses to DROP+restore to avoid
#                                     # wiping data accumulated since the bundle was made.
#     [--no-lan-isolation]            # skip the outbound LAN-isolation rules in
#                                     # phase_apply_ufw. Use ONLY if the server needs to
#                                     # reach other home devices outbound (e.g., a NAS for
#                                     # backups, a LAN-only IPFS peer). By default, the
#                                     # script blocks server-initiated connections to other
#                                     # home devices to prevent lateral pivot if the server
#                                     # is compromised. This flag is auto-skipped when the
#                                     # default gateway is a public IP (cloud VPS, etc.).

set -euo pipefail

# ============================================================================
# Globals
# ============================================================================
BUNDLE_TGZ=""
BACKUP_ENCRYPTION_KEY=""
DB_IPNS=""
REGISTRY_IPNS=""
SINGLE_PHASE=""
SSL_EMAIL="hi@fx.land"
MAINNET_POOL_REPO=""
PREWARM_CLUSTER=false
SKIP_IPNS_VERIFY=false
PARALLEL_RUN_MODE=false        # set via --parallel-run OR auto-detected in phase 8 if peer-ID collision present
FINALIZE_CUTOVER=false         # set via --finalize-cutover; activates deferred items after old server stops
DEFERRED_CRON_DIR="/var/lib/fula-recovery/deferred-cron"
BLOCKS_RSYNC=""
KUBO_DATA_HOST_PATH=""
CLUSTER_DATA_HOST_PATH=""
DEFER_DNS=false
FORCE_WIPE=false
NO_LAN_ISOLATION=false

WORK_DIR="/var/lib/fula-recovery"
BUNDLE_DIR="$WORK_DIR/bundle"
STATE_DIR="$WORK_DIR/state"
LOG_FILE="/var/log/fula-recovery.log"

# Service paths (must match old server layout)
PINNING_HOME="/home/root/pinning-service"
PINNING_REPO="/opt/pinning-service"
FULA_API_REPO="/opt/fula-api"
MAINNET_REWARDS_REPO="/opt/mainnet-reward-server"

# Container names (must match old server)
PG_CONTAINER="postgres-pinning"
IPFS_CONTAINER="ipfs_host"
CLUSTER_CONTAINER="ipfs_cluster"
GATEWAY_CONTAINER="fula-gateway-1"

# ============================================================================
# Logging
# ============================================================================
mkdir -p "$WORK_DIR" "$STATE_DIR" "$(dirname "$LOG_FILE")" 2>/dev/null || true
exec > >(tee -a "$LOG_FILE") 2>&1

RUN_START_EPOCH=$(date -u +%s)
PHASE_START_EPOCH=0
CURRENT_PHASE=""

log()       { echo "[$(date -u +%H:%M:%SZ)] $*"; }
log_phase() {
  if [ -n "$CURRENT_PHASE" ] && [ "$PHASE_START_EPOCH" -gt 0 ]; then
    local elapsed=$(( $(date -u +%s) - PHASE_START_EPOCH ))
    log "phase $CURRENT_PHASE finished in ${elapsed}s"
  fi
  CURRENT_PHASE="$1"
  PHASE_START_EPOCH=$(date -u +%s)
  echo
  echo "==[$(date -u +%H:%M:%SZ)]== $* =="
}
fatal()     { log "FATAL: $*"; print_summary FATAL; exit 1; }
warn()      { log "WARN:  $*"; WARN_COUNT=$((WARN_COUNT+1)); WARN_MESSAGES+=("$*"); }

# Counters for the final summary
PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
WARN_MESSAGES=()
FAIL_MESSAGES=()

check_pass() { log "  PASS: $*"; PASS_COUNT=$((PASS_COUNT+1)); }
check_warn() { log "  WARN: $*"; WARN_COUNT=$((WARN_COUNT+1)); WARN_MESSAGES+=("$*"); }
check_fail() { log "  FAIL: $*"; FAIL_COUNT=$((FAIL_COUNT+1)); FAIL_MESSAGES+=("$*"); }

# Print a final summary table when the script exits (success or fatal).
# Idempotent — only prints once even if called multiple times.
SUMMARY_PRINTED=false
print_summary() {
  $SUMMARY_PRINTED && return 0
  SUMMARY_PRINTED=true
  local how="${1:-OK}"
  local total=$(( $(date -u +%s) - RUN_START_EPOCH ))
  # Also log the elapsed time of the last phase, which log_phase normally does
  # at the start of the next phase
  if [ -n "$CURRENT_PHASE" ] && [ "$PHASE_START_EPOCH" -gt 0 ]; then
    local elapsed=$(( $(date -u +%s) - PHASE_START_EPOCH ))
    log "phase $CURRENT_PHASE finished in ${elapsed}s"
  fi
  echo
  echo "============================================================"
  echo " RECOVERY SUMMARY — $how"
  echo "============================================================"
  printf "  total time:    %ds (%dm %ds)\n" "$total" "$((total/60))" "$((total%60))"
  printf "  PASS: %3d   WARN: %3d   FAIL: %3d\n" "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT"
  if [ "${#WARN_MESSAGES[@]}" -gt 0 ]; then
    echo
    echo "  Warnings to investigate:"
    for m in "${WARN_MESSAGES[@]}"; do echo "    - $m"; done
  fi
  if [ "${#FAIL_MESSAGES[@]}" -gt 0 ]; then
    echo
    echo "  Failures (these block production traffic):"
    for m in "${FAIL_MESSAGES[@]}"; do echo "    - $m"; done
  fi
  echo
  echo "  Full log:    $LOG_FILE"
  echo "  Re-run any phase with: $0 --phase=<name> ...same flags..."
  echo "============================================================"
}
# Trap on every exit. If rc!=0 and we're mid-phase, log where we died.
# INT and TERM are also trapped so Ctrl-C and `kill <pid>` produce a summary
# rather than dying silently mid-phase.
trap '
  rc=$?
  if [ "$rc" -ne 0 ] && [ -n "$CURRENT_PHASE" ] && ! $SUMMARY_PRINTED; then
    echo
    log "exited at phase $CURRENT_PHASE (rc=$rc)"
    print_summary "INTERRUPTED (rc=$rc)"
  fi
' EXIT INT TERM

# Phase checkpoint tracking — phases that have completed don't re-run
phase_completed() { [ -f "$STATE_DIR/${1}.done" ]; }
mark_phase_done() { touch "$STATE_DIR/${1}.done"; }

# ============================================================================
# Retry helper — for transient network operations.
# Usage: retry <attempts> <delay_seconds> <command...>
# Returns 0 on success, last exit code on failure after all attempts.
# ============================================================================
retry() {
  local attempts="$1" delay="$2"; shift 2
  local i rc=1
  for i in $(seq 1 "$attempts"); do
    # Run the command on its own line, then capture $?. If we used
    # `if "$@"; then return 0; fi` followed by `rc=$?`, $? would be the
    # if-construct's exit (0 when no branch taken), NOT the command's exit.
    "$@"
    rc=$?
    if [ "$rc" -eq 0 ]; then return 0; fi
    if [ "$i" -lt "$attempts" ]; then
      log "  retry $i/$attempts failed (rc=$rc); waiting ${delay}s"
      sleep "$delay"
    fi
  done
  return "$rc"
}

# ============================================================================
# _safe_tar — wrap a tar invocation so rc=1 (warnings) doesn't kill the script.
# tar exit codes:
#   0 = success
#   1 = warnings (e.g., timestamp implausible, attribute could not be set,
#       file changed during read, file already existed with different attrs)
#   2 = fatal (out of disk, permission denied, corrupt archive)
# Migration almost always wants to tolerate rc=1; it means "extraction
# completed but some non-data attribute was off." Without this wrapper,
# `set -euo pipefail` aborts the script on rc=1.
# ============================================================================
_safe_tar() {
  local desc="$1"; shift
  local rc=0
  tar "$@" || rc=$?
  if [ "$rc" -ge 2 ]; then
    fatal "$desc tar failed (rc=$rc) — out of disk, permission denied, or corrupt archive"
  elif [ "$rc" -ne 0 ]; then
    log "  $desc: tar warnings (rc=$rc); extraction completed, continuing"
  fi
  return 0
}

# ============================================================================
# Network endpoint check helpers
# ============================================================================
# HTTP GET that returns the status code (0 if connection failed)
http_status() {
  local url="$1" timeout="${2:-10}"
  curl -fsS -o /dev/null -w '%{http_code}' --max-time "$timeout" "$url" 2>/dev/null || echo 000
}
# Returns 0 if a TCP port on $1 (host) $2 (port) is reachable within $3 seconds
tcp_check() {
  local host="$1" port="$2" timeout="${3:-3}"
  timeout "$timeout" bash -c "</dev/tcp/$host/$port" 2>/dev/null
}
# Cache of the new server's public IP — fetched once
PUBLIC_IP_CACHE=""
my_public_ip() {
  if [ -z "$PUBLIC_IP_CACHE" ]; then
    PUBLIC_IP_CACHE=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null \
      || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null \
      || curl -fsS --max-time 5 https://icanhazip.com 2>/dev/null \
      || echo "")
  fi
  echo "$PUBLIC_IP_CACHE"
}
# Returns 0 if DNS for $1 currently resolves to this server's public IP.
# Returns 2 if DNS check is inconclusive (no public IP probe, no dig, etc).
# Returns 1 if DNS clearly points elsewhere.
dns_points_here() {
  local domain="$1"
  command -v dig >/dev/null 2>&1 || return 2
  local me targets
  me=$(my_public_ip)
  [ -z "$me" ] && return 2
  # Get ALL A records, not just the first. Multiple records are common during
  # DNS cutover (old + new IP both present transiently) and in round-robin
  # setups. Match if our IP appears anywhere in the result.
  targets=$(dig +short +time=3 +tries=2 "$domain" A 2>/dev/null | grep -E '^[0-9.]+$')
  [ -z "$targets" ] && return 2
  echo "$targets" | grep -qxF "$me"
}

# ============================================================================
# Argument parsing
# ============================================================================
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle)              BUNDLE_TGZ="$2"; shift 2 ;;
    --backup-key)          BACKUP_ENCRYPTION_KEY="$2"; shift 2 ;;
    --db-ipns)             DB_IPNS="$2"; shift 2 ;;
    --registry-ipns)       REGISTRY_IPNS="$2"; shift 2 ;;
    --phase)               SINGLE_PHASE="$2"; shift 2 ;;
    --phase=*)             SINGLE_PHASE="${1#--phase=}"; shift ;;
    --ssl-email)           SSL_EMAIL="$2"; shift 2 ;;
    --mainnet-pool-repo)   MAINNET_POOL_REPO="$2"; shift 2 ;;
    --prewarm-cluster)     PREWARM_CLUSTER=true; shift ;;
    --skip-ipns-verify)    SKIP_IPNS_VERIFY=true; shift ;;
    --parallel-run)        PARALLEL_RUN_MODE=true; SKIP_IPNS_VERIFY=true; shift ;;
    --finalize-cutover)    FINALIZE_CUTOVER=true; shift ;;
    --blocks-rsync)        BLOCKS_RSYNC="$2"; shift 2 ;;
    --kubo-data-host-path) KUBO_DATA_HOST_PATH="$2"; shift 2 ;;
    --cluster-data-host-path) CLUSTER_DATA_HOST_PATH="$2"; shift 2 ;;
    --defer-dns)           DEFER_DNS=true; shift ;;
    --force-wipe)          FORCE_WIPE=true; shift ;;
    --no-lan-isolation)    NO_LAN_ISOLATION=true; shift ;;
    -h|--help)             sed -n '2,32p' "$0"; exit 0 ;;
    *) fatal "Unknown flag: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || fatal "Must run as root"

# ============================================================================
# Helper: safely source one line out of an .env file
# ============================================================================
env_get() {
  local file="$1" key="$2"
  [ -f "$file" ] || { echo ""; return; }
  grep -E "^${key}=" "$file" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^"\(.*\)"$/\1/' || echo ""
}

# Helper: docker exec wrapper
dexec() { docker exec "$@"; }

# Helper: wait for a condition
wait_for() {
  local desc="$1"; shift
  local timeout="${1:-60}"; shift || true
  local i
  for i in $(seq 1 "$timeout"); do
    if "$@"; then return 0; fi
    sleep 1
  done
  fatal "timed out waiting for: $desc"
}

# ============================================================================
# PHASE 1 — preflight
# ============================================================================
phase_preflight() {
  log_phase "1. preflight"
  [ -n "$BUNDLE_TGZ" ]              || fatal "--bundle required"
  [ -f "$BUNDLE_TGZ" ]              || fatal "bundle not found: $BUNDLE_TGZ"
  [ -n "$BACKUP_ENCRYPTION_KEY" ]   || fatal "--backup-key required"

  # Tolerate whitespace + CRLF (paste-from-clipboard / file-with-newlines) and
  # accept either case for hex chars. openssl is case-insensitive on hex
  # passphrases, but the encrypted backup uses the value verbatim — so we
  # canonicalize to lowercase here AND also use the same canonical form in
  # phase_verify_ipns_path. A clear error message helps when the input is
  # genuinely malformed.
  BACKUP_ENCRYPTION_KEY=$(printf '%s' "$BACKUP_ENCRYPTION_KEY" | tr -d '[:space:]' | tr 'A-F' 'a-f')
  if ! [[ "$BACKUP_ENCRYPTION_KEY" =~ ^[0-9a-f]{64}$ ]]; then
    local got_len="${#BACKUP_ENCRYPTION_KEY}"
    local prefix="${BACKUP_ENCRYPTION_KEY:0:4}"
    fatal "--backup-key must be exactly 64 hex chars (got ${got_len} chars after trim, starting with '${prefix}****'). \
Common causes: trailing CR/LF from copy-paste, embedded spaces, quotes, or non-hex characters. \
Verify on the old server: cat /root/.fula-backup-key | grep BACKUP_ENCRYPTION_KEY"
  fi
  export BACKUP_ENCRYPTION_KEY

  [ -n "$DB_IPNS" ]                 || fatal "--db-ipns required"
  [ -n "$REGISTRY_IPNS" ]           || fatal "--registry-ipns required"
  [[ "$DB_IPNS"       =~ ^k51[a-z0-9]{56,}$ ]] || fatal "--db-ipns malformed"
  [[ "$REGISTRY_IPNS" =~ ^k51[a-z0-9]{56,}$ ]] || fatal "--registry-ipns malformed"

  # Verify checksum if a .sha256 file is present alongside the bundle.
  # We don't use `sha256sum -c` directly because the .sha256 file embeds the
  # absolute path the bundle had at creation time (e.g., /tmp2/...). When the
  # bundle is moved to a different directory on the new server, that path
  # doesn't resolve. Extract just the expected hash and compare to the actual
  # hash of the bundle at its current location.
  if [ -f "${BUNDLE_TGZ}.sha256" ]; then
    log "verifying bundle checksum"
    local expected_hash actual_hash
    expected_hash=$(awk 'NF{print $1; exit}' "${BUNDLE_TGZ}.sha256")
    if ! [[ "$expected_hash" =~ ^[0-9a-f]{64}$ ]]; then
      warn "could not parse SHA256 from ${BUNDLE_TGZ}.sha256 — skipping verification"
    else
      actual_hash=$(sha256sum "$BUNDLE_TGZ" | awk '{print $1}')
      if [ "$expected_hash" != "$actual_hash" ]; then
        fatal "bundle checksum mismatch (expected $expected_hash, got $actual_hash) — re-transfer the bundle"
      fi
      log "  checksum OK"
    fi
  fi

  # Extract bundle if not already extracted
  if [ ! -d "$BUNDLE_DIR" ] || [ -z "$(ls -A "$BUNDLE_DIR" 2>/dev/null)" ]; then
    log "extracting bundle to $BUNDLE_DIR"
    rm -rf "$BUNDLE_DIR"
    mkdir -p "$BUNDLE_DIR"
    _safe_tar "outer bundle extract" -xzf "$BUNDLE_TGZ" -C "$BUNDLE_DIR" --strip-components=1
  else
    log "bundle already extracted at $BUNDLE_DIR (re-running)"
  fi

  # Sanity check: bundled metadata exists
  [ -d "$BUNDLE_DIR/env" ]    || fatal "bundle missing env/ dir — wrong file?"
  [ -d "$BUNDLE_DIR/kubo" ]   || fatal "bundle missing kubo/ dir"
  [ -f "$BUNDLE_DIR/postgres/pinning-fresh.dump" ] || \
    log "WARN: bundle missing postgres/pinning-fresh.dump — phase_pg_restore will fall back to IPNS"

  # Show metadata if present
  [ -f "$BUNDLE_DIR/MANIFEST.metadata" ] && cat "$BUNDLE_DIR/MANIFEST.metadata"

  log "preflight OK"
  mark_phase_done preflight
}

# ============================================================================
# PHASE 2 — apt
# ============================================================================
phase_apt() {
  log_phase "2. apt — install required packages"
  export DEBIAN_FRONTEND=noninteractive

  # Pre-flight curl bootstrap — minimal Ubuntu cloud images sometimes ship
  # without curl, which we need for nodesource + Go binary download.
  if ! command -v curl >/dev/null 2>&1; then
    apt-get update -y >/dev/null 2>&1 || true
    apt-get install -y curl ca-certificates || fatal "could not bootstrap curl"
  fi

  retry 3 30 apt-get update || \
    warn "apt-get update had non-zero exits across all retries (mirror flapping?); continuing"

  # Core packages. Notes:
  #  - postgresql-client (no version pin): host-side psql/pg_dump/pg_restore.
  #    The actual postgres SERVER runs in Docker (postgres:15), so client
  #    version mismatch is fine — newer clients connect to v15 servers without
  #    issues, and we're using --no-owner --no-acl during restore anyway.
  #  - dnsutils: provides `dig`, used by dns_points_here() in phase_certs and
  #    _verify_tls.
  #  - python3: used by phase_apply_nginx's heredoc parser to strip listen-443
  #    server blocks. Ubuntu 22.04+ ships it by default but minimal cloud
  #    images sometimes skip it.
  #  - file: used by phase_build_libp2p_service to detect binary arch. Almost
  #    always present, included for explicitness.
  #  - cron: provides crontab for the verification phase; the cron daemon
  #    itself is `cron.service` (Debian/Ubuntu) — installed implicitly.
  #  - dnsutils + iproute2: dig + ss respectively.
  # Required packages — fail if any of these can't install
  retry 3 30 apt-get install -y \
    docker.io \
    nginx certbot python3-certbot-nginx \
    jq openssl build-essential git ufw fail2ban \
    curl ca-certificates rsync \
    redis-server redis-tools \
    postgresql-client \
    dnsutils iproute2 \
    python3 file cron \
    || fatal "apt-get install failed after 3 attempts — check network or mirror config"

  # Optional: docker compose plugin. Package name varies across Ubuntu
  # versions (`docker-compose-plugin` on jammy/older, `docker-compose-v2` on
  # noble/newer; `docker-compose` is the legacy v1 in some distros). We don't
  # actually use `docker compose` in this script (only `docker exec`/`run`),
  # so this is purely operator convenience — install whichever exists, skip
  # otherwise.
  for pkg in docker-compose-v2 docker-compose-plugin docker-compose; do
    if apt-cache show "$pkg" >/dev/null 2>&1; then
      apt-get install -y "$pkg" >/dev/null 2>&1 && \
        log "  installed compose plugin: $pkg" && break
    fi
  done

  # Ensure docker daemon is enabled and running. apt installs the unit but on
  # some Ubuntu cloud-init configurations docker isn't auto-started.
  if ! systemctl is-active --quiet docker; then
    log "  enabling + starting docker.service"
    systemctl enable --now docker || fatal "failed to start docker.service — check 'journalctl -u docker'"
  fi
  # Wait briefly for the daemon to be responsive
  for i in 1 2 3 4 5; do
    docker info >/dev/null 2>&1 && break
    sleep 2
  done
  docker info >/dev/null 2>&1 || fatal "docker installed but daemon not responding"

  # Make sure cron daemon is enabled (some minimal images ship cron disabled)
  systemctl enable --now cron 2>/dev/null || systemctl enable --now crond 2>/dev/null || \
    warn "could not enable cron service — daily backups will not run automatically"

  # Go 1.22 (kubo + main_postgres.go + libp2p-service all want this)
  if ! command -v go >/dev/null 2>&1 || ! /usr/local/go/bin/go version 2>/dev/null | grep -q 'go1\.2[2-9]'; then
    log "  installing Go 1.22.7"
    rm -rf /usr/local/go
    retry 3 15 bash -c "curl -fsSL https://go.dev/dl/go1.22.7.linux-amd64.tar.gz | tar -C /usr/local -xz" \
      || fatal "Go install failed — could not download or extract"
    grep -q '/usr/local/go/bin' /etc/profile.d/go.sh 2>/dev/null || \
      echo 'export PATH=$PATH:/usr/local/go/bin' > /etc/profile.d/go.sh
    export PATH=$PATH:/usr/local/go/bin
  fi
  /usr/local/go/bin/go version >/dev/null 2>&1 || fatal "Go install verification failed"

  # Node 20
  if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v20\.'; then
    log "  installing Node 20"
    retry 3 15 bash -c "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -" \
      || fatal "NodeSource setup failed"
    retry 2 30 apt-get install -y nodejs || fatal "Node 20 install failed"
  fi
  node -v >/dev/null 2>&1 || fatal "node not on PATH after install"
  npm -v  >/dev/null 2>&1 || fatal "npm not on PATH after install"

  # pm2 for mainnet-pool-server
  if ! command -v pm2 >/dev/null 2>&1; then
    log "  installing pm2 globally"
    retry 2 15 npm install -g pm2 || fatal "pm2 install failed"
  fi

  log "apt phase OK — all required packages present"
  mark_phase_done apt
}

# ============================================================================
# PHASE 3 — clone repos
# ============================================================================
phase_clone() {
  log_phase "3. clone repos"
  mkdir -p /opt /home/root

  # Disable git's interactive credential prompt during these clones. Public
  # repos shouldn't need auth; if a URL is wrong, this fails fast with 404
  # rather than blocking on a "Username:" prompt for hours. To override
  # (e.g., for cloning private repos), set GIT_TERMINAL_PROMPT=1 before running.
  export GIT_TERMINAL_PROMPT="${GIT_TERMINAL_PROMPT:-0}"

  # Helper — clone if target dir doesn't exist OR is empty. Treats a populated
  # directory as "already provided by some other means" (rsync, manual copy,
  # bundle extraction) and skips the clone. This makes the phase tolerant of
  # private repos (where the user supplies the source out-of-band) and stale
  # partial-clone state from a previous failed attempt.
  _clone_if_empty() {
    local repo_name="$1" url="$2" dest="$3" required="${4:-required}"
    if [ -d "$dest/.git" ]; then
      log "  $repo_name: already cloned at $dest (skipping)"
      return 0
    fi
    if [ -d "$dest" ] && [ -n "$(ls -A "$dest" 2>/dev/null)" ]; then
      log "  $repo_name: $dest is non-empty (assuming source provided out-of-band — skipping clone)"
      return 0
    fi
    [ -e "$dest" ] && rm -rf "$dest"
    if retry 3 15 git clone "$url" "$dest"; then
      return 0
    fi
    if [ "$required" = "required" ]; then
      fatal "clone $repo_name from $url failed after 3 attempts"
    else
      warn "clone $repo_name failed — if it's a PRIVATE repo, rsync the source from your old server to $dest, OR set GIT_TERMINAL_PROMPT=1 and configure GitHub auth before re-running"
      return 1
    fi
  }

  _clone_if_empty pinning-service "https://github.com/functionland/pinning-service.git" "$PINNING_REPO" required
  _clone_if_empty fula-api        "https://github.com/functionland/fula-api.git"        "$FULA_API_REPO" required
  # mainnet-rewards is PRIVATE — recover.sh prefers the bundle snapshot
  # (extracted later in phase_build_mainnet_rewards). Falling through to clone
  # is a fallback for the rare case the bundle doesn't have the snapshot.
  _clone_if_empty mainnet-rewards "https://github.com/functionland/mainnet-rewards.git" "$MAINNET_REWARDS_REPO" optional || true

  log "clone phase OK"
  mark_phase_done clone
}

# ============================================================================
# PHASE 4 — apply_system_state (letsencrypt, sysctl, apple, redis conf, password)
# ============================================================================
phase_apply_system_state() {
  log_phase "4. apply_system_state"

  # Let's Encrypt
  if [ -f "$BUNDLE_DIR/letsencrypt.tgz" ]; then
    log "restoring /etc/letsencrypt"
    _safe_tar "letsencrypt extract" -xzf "$BUNDLE_DIR/letsencrypt.tgz" -C /
    # Defense in depth: tar preserves source mode, but if anything in the
    # transport chain dropped permissions, force private keys to 0600.
    if [ -d /etc/letsencrypt/archive ]; then
      find /etc/letsencrypt/archive -type f -name 'privkey*.pem' \
        -exec chmod 600 {} \; 2>/dev/null || true
    fi
    if [ -d /etc/letsencrypt/keys ]; then
      find /etc/letsencrypt/keys -type f -exec chmod 600 {} \; 2>/dev/null || true
    fi
  fi

  # sysctl + ulimits
  if [ -d "$BUNDLE_DIR/sysctl/sysctl.d" ]; then
    cp -r "$BUNDLE_DIR/sysctl/sysctl.d/." /etc/sysctl.d/ 2>/dev/null || true
    sysctl --system >/dev/null 2>&1 || true
  fi
  if [ -d "$BUNDLE_DIR/sysctl/limits.d" ]; then
    cp -r "$BUNDLE_DIR/sysctl/limits.d/." /etc/security/limits.d/ 2>/dev/null || true
  fi

  # Apple Sign-In key
  if [ -d "$BUNDLE_DIR/apple" ] && [ -n "$(ls -A "$BUNDLE_DIR/apple" 2>/dev/null)" ]; then
    install -d -m 0700 /etc/apple
    # `-r` is REQUIRED — `cp -p source/. dest/` (without -r) exits rc=1 with
    # "omitting directory" because cp won't descend into a directory without
    # -r/-R. The trailing `|| true` shields set -e from any harmless cp warning.
    cp -rp "$BUNDLE_DIR/apple/." /etc/apple/ 2>/dev/null || true
    chmod 600 /etc/apple/* 2>/dev/null || true
  fi

  # Redis state + config — every command needs `|| true` so a missing/odd
  # destination path doesn't kill phase_apply_system_state under set -e.
  if [ -f "$BUNDLE_DIR/redis/redis.conf" ]; then
    cp "$BUNDLE_DIR/redis/redis.conf" /etc/redis/redis.conf 2>/dev/null || \
      check_warn "could not install redis.conf — /etc/redis may be missing or not writable"
  fi
  if [ -f "$BUNDLE_DIR/redis/dump.rdb" ]; then
    install -d -m 0750 -o redis -g redis /var/lib/redis 2>/dev/null || true
    cp "$BUNDLE_DIR/redis/dump.rdb" /var/lib/redis/dump.rdb 2>/dev/null || \
      check_warn "could not install redis dump.rdb"
    chown redis:redis /var/lib/redis/dump.rdb 2>/dev/null || true
  fi

  # password.txt (if user keeps notes there)
  if [ -f "$BUNDLE_DIR/password.txt" ]; then
    install -m 0600 "$BUNDLE_DIR/password.txt" /home/root/password.txt 2>/dev/null || true
  fi

  log "system state restored"
  mark_phase_done apply_system_state
}

# ============================================================================
# PHASE 5 — apply_env_files
# ============================================================================
phase_apply_env_files() {
  log_phase "5. apply_env_files"

  install -d -m 0755 "$PINNING_HOME"/{ipfs-server,pinning-webui,x402-skale,data}
  install -d -m 0755 /opt/{fula-ai-service,mainnet,mainnet-rewards} /etc/fula

  # Map bundled .env files to their target paths
  declare -A MAP=(
    [pinning-service.env]="$PINNING_HOME/.env"
    [ipfs-server.env]="$PINNING_HOME/ipfs-server/.env"
    [pinning-webui.env]="$PINNING_HOME/pinning-webui/.env"
    [x402-skale.env]="$PINNING_HOME/x402-skale/.env"
    [fula-ai-service.env]=/opt/fula-ai-service/.env
    [mainnet-pool-server.env]=/opt/mainnet/.env
    [mainnet-rewards-server.env]=/opt/mainnet-rewards/.env
    [fula-api.env]=/etc/fula/.env
  )
  for src in "${!MAP[@]}"; do
    if [ -f "$BUNDLE_DIR/env/$src" ]; then
      install -m 0600 "$BUNDLE_DIR/env/$src" "${MAP[$src]}"
      log "  installed: ${MAP[$src]}"
    else
      log "  WARN: missing bundle/env/$src"
    fi
  done

  # Validate critical secrets present
  local pwui="$PINNING_HOME/pinning-webui/.env"
  [ -f "$pwui" ] || fatal "$pwui not installed (missing bundle/env/pinning-webui.env?)"
  for k in ENCRYPTION_KEY JWT_SECRET SESSION_SECRET POSTGRES_PASSWORD PINNING_SYSTEM_KEY GOOGLE_CLIENT_ID; do
    [ -n "$(env_get "$pwui" "$k")" ] || fatal "missing $k in $pwui"
  done

  # Persist BACKUP_ENCRYPTION_KEY for the cron-driven daily backup
  install -m 0600 /dev/null /root/.fula-backup-key
  POSTGRES_PASSWORD=$(env_get "$PINNING_HOME/.env" POSTGRES_PASSWORD)
  cat > /root/.fula-backup-key <<EOF
BACKUP_ENCRYPTION_KEY=$BACKUP_ENCRYPTION_KEY
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
EOF
  chmod 600 /root/.fula-backup-key

  log "env files OK"
  mark_phase_done apply_env_files
}

# ============================================================================
# PHASE 6 — docker_volumes (populate kubo + cluster volumes BEFORE first daemon start)
# ============================================================================
phase_docker_volumes() {
  log_phase "6. docker_volumes — populate volumes before first daemon start"

  # postgres always uses default named volume (small, fast SSD is fine)
  docker volume create postgres-pinning-data >/dev/null

  # Helper: create a named volume bound to a host path, if path provided.
  # Otherwise create a default named volume. Caller passes volume name + host path.
  create_volume_at() {
    local volname="$1" hostpath="$2"
    if [ -n "$hostpath" ]; then
      [ -d "$hostpath" ] || fatal "host path does not exist: $hostpath (mount it before running recover.sh)"
      # Probe writability
      touch "$hostpath/.recovery-write-test" 2>/dev/null && rm -f "$hostpath/.recovery-write-test" \
        || fatal "host path not writable: $hostpath"
      # Probe filesystem type — warn on NFS (badger/leveldb don't like remote locks)
      local fstype
      fstype=$(stat -f -c %T "$hostpath" 2>/dev/null || echo unknown)
      case "$fstype" in
        nfs*|cifs|smbfs) log "  WARN: $hostpath is on $fstype — IPFS uses fcntl locks; consider local storage instead" ;;
      esac
      # Recreate volume as bind to the host path. If volume already exists with
      # different config, remove and recreate (only safe pre-first-start).
      if docker volume inspect "$volname" >/dev/null 2>&1; then
        local current_device
        current_device=$(docker volume inspect "$volname" --format '{{.Options.device}}' 2>/dev/null)
        if [ "$current_device" != "$hostpath" ]; then
          log "  recreating volume $volname → $hostpath (was: ${current_device:-default})"
          docker volume rm "$volname" >/dev/null
        fi
      fi
      if ! docker volume inspect "$volname" >/dev/null 2>&1; then
        docker volume create --driver local \
          --opt type=none --opt o=bind \
          --opt device="$hostpath" \
          "$volname" >/dev/null
      fi
      log "  $volname → $hostpath ($(df -h "$hostpath" | awk 'NR==2 {print $4 " free"}'))"
    else
      docker volume create "$volname" >/dev/null
    fi
  }

  create_volume_at ipfs_host_data    "$KUBO_DATA_HOST_PATH"
  create_volume_at ipfs_cluster_data "$CLUSTER_DATA_HOST_PATH"

  local kubo_vol cluster_vol
  kubo_vol=$(docker volume inspect ipfs_host_data --format '{{.Mountpoint}}')
  cluster_vol=$(docker volume inspect ipfs_cluster_data --format '{{.Mountpoint}}')

  # Kubo data — three possible sources:
  #
  #   1. --blocks-rsync HOST_PATH        (user rsynced data dir directly)
  #   2. bundle has kubo/data-*.tgz      (NEW format: one tarball per
  #                                       datastore_spec storage path)
  #   3. bundle has kubo/data.tgz        (LEGACY format: single tarball)
  #   4. nothing in bundle               (user used --no-blocks; assumes data
  #                                       was rsynced separately to subdirs of
  #                                       $kubo_vol — e.g. /mnt/ipfs-data/blocks)
  #
  # The new format (kubo/data-*.tgz) preserves the basename in tar entries
  # ("blocks/file1", "datastore/file2", etc.), so we extract WITHOUT
  # --strip-components and the data lands at $kubo_vol/blocks/, $kubo_vol/datastore/.
  # Combined with the translated datastore_spec (paths rewritten to relative
  # "blocks", "datastore"), kubo on the new server reads from those subdirs.
  if [ -n "$BLOCKS_RSYNC" ]; then
    log "rsyncing kubo data from $BLOCKS_RSYNC"
    rsync -aHP --info=progress2 "$BLOCKS_RSYNC/" "$kubo_vol/"
  elif ls "$BUNDLE_DIR"/kubo/data-*.tgz >/dev/null 2>&1; then
    log "extracting per-path kubo tarballs into $kubo_vol"
    local tarball name
    for tarball in "$BUNDLE_DIR"/kubo/data-*.tgz; do
      [ -f "$tarball" ] || continue
      name=$(basename "$tarball" .tgz); name="${name#data-}"
      log "  extracting $tarball → $kubo_vol/${name}/ ($(du -sh "$tarball" | cut -f1))"
      # No --strip-components: tarball contains "<basename>/..." entries;
      # extract preserves that prefix at the destination.
      _safe_tar "kubo data-$name extract" -xzf "$tarball" -C "$kubo_vol"
    done
  elif [ -f "$BUNDLE_DIR/kubo/data.tgz" ]; then
    log "extracting legacy single kubo tarball into $kubo_vol"
    _safe_tar "kubo data legacy extract" -xzf "$BUNDLE_DIR/kubo/data.tgz" -C "$kubo_vol" --strip-components=1
  else
    log "no kubo data tarballs in bundle — assuming blocks/datastore were rsynced separately to $kubo_vol/{blocks,datastore}"
  fi

  # Always restore kubo identity files from bundle (small, idempotent). These
  # may already be inside data.tgz from the bundle-with-blocks path; copying
  # again is harmless. If user ran migrate-zip.sh --no-blocks AND rsynced data
  # separately, this is the path that gets the identity into place.
  [ -f "$BUNDLE_DIR/kubo/raw-config.json" ] && cp "$BUNDLE_DIR/kubo/raw-config.json" "$kubo_vol/config"
  if [ -d "$BUNDLE_DIR/kubo/keystore" ]; then
    mkdir -p "$kubo_vol/keystore"
    cp -rT "$BUNDLE_DIR/kubo/keystore" "$kubo_vol/keystore"
  fi

  # Translate kubo datastore paths: when the old daemon ran with custom paths
  # (e.g., Fula Box's /uniondrive/ipfs_datastore/blocks), absolute paths get
  # baked into BOTH files kubo reads:
  #   1. /data/ipfs/config           — the Datastore.Spec field (FULL form,
  #                                    with `measure` wrappers around each mount)
  #   2. /data/ipfs/datastore_spec   — the standalone spec file (SIMPLE form;
  #                                    kubo computes this from config by
  #                                    stripping the measure wrappers, then
  #                                    compares to the disk file on every start)
  # If the two disagree, kubo refuses to start with "datastore configuration
  # ... does not match what is on disk". We must translate paths in BOTH but
  # preserve their distinct shapes — translating only one leaves the other as
  # the absolute-paths source of truth.
  #
  # Pass 1: translate paths in $kubo_vol/config (Datastore.Spec subtree) AND
  # rewrite Addresses.{API,Gateway} from 127.0.0.1 → 0.0.0.0. The original
  # Fula Box config bound API to 127.0.0.1 inside the container; on this new
  # server we run kubo in its own bridge network with `-p 127.0.0.1:5001:5001`,
  # so the host-side mapping enforces localhost-only access externally — but
  # inside the container, traffic arrives with a Docker-bridge source IP, so
  # kubo MUST listen on 0.0.0.0 or it resets all incoming connections (this
  # blocks ipfs-cluster from talking to kubo and breaks pinning entirely).
  if [ -f "$kubo_vol/config" ]; then
    python3 - "$kubo_vol/config" <<'PY'
import json, sys
config_path = sys.argv[1]
with open(config_path) as f:
    config = json.load(f)
def walk(node):
    if isinstance(node, dict):
        if "path" in node and isinstance(node["path"], str) and node["path"].startswith("/"):
            node["path"] = node["path"].rstrip("/").split("/")[-1]
        for v in node.values():
            walk(v)
    elif isinstance(node, list):
        for v in node:
            walk(v)
walk(config.get("Datastore", {}).get("Spec", {}))
addrs = config.setdefault("Addresses", {})
for key in ("API", "Gateway"):
    val = addrs.get(key)
    if isinstance(val, str):
        addrs[key] = val.replace("/ip4/127.0.0.1/tcp/", "/ip4/0.0.0.0/tcp/")
    elif isinstance(val, list):
        addrs[key] = [v.replace("/ip4/127.0.0.1/tcp/", "/ip4/0.0.0.0/tcp/") if isinstance(v, str) else v for v in val]
with open(config_path, "w") as f:
    json.dump(config, f, indent=2)
PY
  fi

  # Pass 2: translate paths in the bundle's standalone datastore_spec (SIMPLE
  # form) and write to $kubo_vol/datastore_spec. We use the bundle's file
  # (not config) as the source so the SIMPLE form is preserved verbatim — the
  # only thing we change is absolute → relative paths.
  if [ -f "$BUNDLE_DIR/kubo/datastore_spec" ]; then
    local spec_in spec_out had_absolute
    spec_in=$(cat "$BUNDLE_DIR/kubo/datastore_spec")
    spec_out=$(python3 - "$spec_in" <<'PY'
import json, sys
spec = json.loads(sys.argv[1])
def walk(node):
    if isinstance(node, dict):
        if "path" in node and isinstance(node["path"], str) and node["path"].startswith("/"):
            node["path"] = node["path"].rstrip("/").split("/")[-1]
        for v in node.values():
            walk(v)
    elif isinstance(node, list):
        for v in node:
            walk(v)
walk(spec)
sys.stdout.write(json.dumps(spec, separators=(",", ":")))
PY
)
    echo "$spec_out" > "$kubo_vol/datastore_spec"

    # Did the bundle have absolute paths? (For logging only — translation is
    # idempotent so this is just informational.)
    if grep -qE '"path"[[:space:]]*:[[:space:]]*"/' "$BUNDLE_DIR/kubo/datastore_spec"; then
      had_absolute=yes
    else
      had_absolute=no
    fi
    if [ "$had_absolute" = "yes" ]; then
      log "  translated kubo paths (absolute → relative) in BOTH config.Datastore.Spec and datastore_spec — kubo will read from IPFS_PATH=/data/ipfs"
      log "  for this to work, kubo data must live at: $kubo_vol/blocks/ and $kubo_vol/datastore/"
      local d_check
      for d_check in blocks datastore; do
        if [ -d "$kubo_vol/$d_check" ] && [ -n "$(ls -A "$kubo_vol/$d_check" 2>/dev/null)" ]; then
          log "    [OK] $kubo_vol/$d_check present ($(du -sh "$kubo_vol/$d_check" 2>/dev/null | cut -f1))"
        else
          check_warn "$kubo_vol/$d_check missing or empty — kubo will start with no $d_check data (use BLOCKS_RSYNC or place data here)"
        fi
      done
    else
      log "  kubo paths are already relative; datastore_spec installed verbatim, config Datastore.Spec untouched"
    fi
  fi

  # Ensure kubo repo skeleton is complete. migrate-zip.sh's --include-blocks
  # path captures the `version` file inside the data tarballs; --no-blocks
  # bundles don't — and without it kubo refuses to open the repo. Same for
  # the blocks/ and datastore/ dirs referenced by datastore_spec.
  if [ ! -f "$kubo_vol/version" ]; then
    local kubo_repo_version
    kubo_repo_version=$(docker run --rm --entrypoint sh ipfs/kubo:release -c \
      'export IPFS_PATH=/tmp/v && ipfs init --empty-repo >/dev/null 2>&1 && cat /tmp/v/version' \
      2>/dev/null | tr -d '[:space:]')
    if ! [[ "$kubo_repo_version" =~ ^[0-9]+$ ]]; then
      fatal "kubo repo missing 'version' file and could not detect from ipfs/kubo:release image — re-bundle with blocks or use --blocks-rsync"
    fi
    echo "$kubo_repo_version" > "$kubo_vol/version"
    log "  wrote kubo repo version $kubo_repo_version (derived from ipfs/kubo:release image)"
  fi
  local d_init
  for d_init in blocks datastore; do
    [ -d "$kubo_vol/$d_init" ] || { mkdir -p "$kubo_vol/$d_init"; log "  created $kubo_vol/$d_init (was missing)"; }
  done

  # Normalize ownership and mode. Kubo image runs as user 'ipfs' (UID 1000)
  # and can't read root-owned files. Tar/rsync paths preserve old-server UIDs
  # (usually 1000 already); cp paths above run as root and produce root-owned
  # files. Force consistent ownership so the container can read its own repo
  # regardless of which restore path populated the volume.
  chown -R 1000:1000 "$kubo_vol"
  chmod 0700 "$kubo_vol/keystore" 2>/dev/null || true
  chmod 0600 "$kubo_vol"/keystore/* 2>/dev/null || true
  chmod 0600 "$kubo_vol/config" 2>/dev/null || true

  # Sanity-check the result so any future regression surfaces with a clear
  # message instead of a kubo crash loop on first start.
  local kubo_missing=()
  [ -f "$kubo_vol/config" ]         || kubo_missing+=("config")
  [ -f "$kubo_vol/datastore_spec" ] || kubo_missing+=("datastore_spec")
  [ -d "$kubo_vol/keystore" ]       || kubo_missing+=("keystore/")
  [ -f "$kubo_vol/version" ]        || kubo_missing+=("version")
  [ -d "$kubo_vol/blocks" ]         || kubo_missing+=("blocks/")
  [ -d "$kubo_vol/datastore" ]      || kubo_missing+=("datastore/")
  if [ ${#kubo_missing[@]} -gt 0 ]; then
    fatal "kubo volume incomplete after restore: missing ${kubo_missing[*]}"
  fi

  # Cluster data — same single-leading-dir layout
  if [ -f "$BUNDLE_DIR/cluster/data.tgz" ]; then
    log "extracting cluster CRDT state into $cluster_vol"
    _safe_tar "cluster CRDT extract" -xzf "$BUNDLE_DIR/cluster/data.tgz" -C "$cluster_vol" --strip-components=1
  else
    log "cluster data.tgz missing — placing identity + service.json only"
    [ -f "$BUNDLE_DIR/cluster/identity.json" ] && cp "$BUNDLE_DIR/cluster/identity.json" "$cluster_vol/"
    [ -f "$BUNDLE_DIR/cluster/service.json" ]  && cp "$BUNDLE_DIR/cluster/service.json"  "$cluster_vol/"
  fi

  # Same ownership/mode normalization as kubo — ipfs-cluster also runs as
  # UID 1000 inside the container and can't read root-owned files.
  chown -R 1000:1000 "$cluster_vol"
  chmod 0600 "$cluster_vol/identity.json" 2>/dev/null || true
  chmod 0600 "$cluster_vol/service.json"  2>/dev/null || true

  local cluster_missing=()
  [ -f "$cluster_vol/identity.json" ] || cluster_missing+=("identity.json")
  [ -f "$cluster_vol/service.json" ]  || cluster_missing+=("service.json")
  if [ ${#cluster_missing[@]} -gt 0 ]; then
    fatal "cluster volume incomplete after restore: missing ${cluster_missing[*]}"
  fi

  log "volumes populated"
  mark_phase_done docker_volumes
}

# ============================================================================
# PHASE 7 — load fula-gateway docker image
# ============================================================================
phase_load_fula_image() {
  log_phase "7. load_fula_image"
  if [ -f "$BUNDLE_DIR/images/fula-gateway.tar.gz" ]; then
    gunzip -c "$BUNDLE_DIR/images/fula-gateway.tar.gz" | docker load
    log "fula-gateway image loaded"
  else
    log "WARN: bundled fula-gateway image missing — will rebuild from source in phase_install_fula_api"
  fi
  mark_phase_done load_fula_image
}

# ============================================================================
# PHASE 8 — docker_infra_start
# ============================================================================
phase_docker_infra_start() {
  log_phase "8. docker_infra_start"

  local pg_user pg_password
  pg_user=$(env_get "$PINNING_HOME/.env" POSTGRES_USER)
  pg_password=$(env_get "$PINNING_HOME/.env" POSTGRES_PASSWORD)
  pg_user="${pg_user:-pinning_user}"
  [ -n "$pg_password" ] || fatal "POSTGRES_PASSWORD not set in $PINNING_HOME/.env"

  # Postgres
  if ! docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
    docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
    docker run -d --name "$PG_CONTAINER" --restart unless-stopped \
      -p 127.0.0.1:5432:5432 \
      -e POSTGRES_USER="$pg_user" -e POSTGRES_PASSWORD="$pg_password" \
      -e POSTGRES_DB=pinning_service \
      -v postgres-pinning-data:/var/lib/postgresql/data postgres:15
  fi
  wait_for "postgres ready" 60 docker exec "$PG_CONTAINER" pg_isready -U "$pg_user" -d postgres

  # Kubo
  if ! docker ps --format '{{.Names}}' | grep -q "^${IPFS_CONTAINER}$"; then
    docker rm -f "$IPFS_CONTAINER" >/dev/null 2>&1 || true
    docker run -d --name "$IPFS_CONTAINER" --restart unless-stopped \
      -p 127.0.0.1:5001:5001 -p 0.0.0.0:4001:4001 -p 0.0.0.0:4001:4001/udp \
      -p 127.0.0.1:8081:8080 \
      -v ipfs_host_data:/data/ipfs ipfs/kubo:release
  fi
  wait_for "kubo ready" 60 docker exec "$IPFS_CONTAINER" ipfs id

  # Verify peer ID matches the bundled identity
  if [ -f "$BUNDLE_DIR/kubo/id.json" ]; then
    local expected actual
    expected=$(jq -r .ID < "$BUNDLE_DIR/kubo/id.json")
    actual=$(docker exec "$IPFS_CONTAINER" ipfs id --format='<id>' 2>/dev/null)
    if [ -n "$expected" ] && [ "$actual" != "$expected" ]; then
      fatal "kubo peer ID mismatch (got $actual, expected $expected) — volume not populated correctly"
    fi
    log "  kubo peer ID OK: $actual"
  fi

  # Verify both IPNS keys are in the keystore
  if docker exec "$IPFS_CONTAINER" ipfs key list -l > /tmp/keys.txt 2>/dev/null; then
    grep -q "$DB_IPNS" /tmp/keys.txt        || fatal "fula-db-backup IPNS key missing or wrong (expected $DB_IPNS)"
    grep -q "$REGISTRY_IPNS" /tmp/keys.txt  || fatal "fula-registry IPNS key missing or wrong (expected $REGISTRY_IPNS)"
    log "  both IPNS keys present and matching"
  fi

  # Detect peer-ID collision: another node currently announcing this peer ID
  # on the public DHT. This is normal during a parallel-run validation window
  # (old server still up, new server being verified). It's NOT normal in
  # actual disaster recovery (old server gone). We detect it by asking the
  # DHT for our own peer ID and checking whether the addresses returned
  # include any we are NOT listening on locally — those would be the other
  # node's announce addresses.
  #
  # When detected, we set PEER_ID_COLLISION_DETECTED=true so later phases
  # know to skip operations that depend on a clean libp2p/DHT state (notably
  # phase 10 IPNS verify, the cron-driven IPNS publishes, and any external
  # bitswap fetches). This keeps the rest of the recovery progressing instead
  # of hanging on bitswap timeouts.
  if [ -n "$actual" ]; then
    log "  checking DHT for peer-ID collision (parallel-run safety)..."
    local local_addrs other_addrs found_addrs
    local_addrs=$(docker exec "$IPFS_CONTAINER" ipfs id --format='<addrs>' 2>/dev/null | tr ',' '\n' | sort -u)
    # findpeer asks the DHT "where is peer X?" — returns multiaddrs from
    # whichever provider records are in the DHT.
    found_addrs=$(timeout 30 docker exec "$IPFS_CONTAINER" ipfs routing findpeer "$actual" 2>/dev/null | sort -u || true)
    if [ -n "$found_addrs" ]; then
      other_addrs=$(comm -23 <(echo "$found_addrs") <(echo "$local_addrs") | grep -E '^/(dns|ip4|ip6)' || true)
      if [ -n "$other_addrs" ]; then
        PARALLEL_RUN_MODE=true
        SKIP_IPNS_VERIFY=true
        log "  WARN: another node is currently announcing the same kubo peer ID on the DHT:"
        echo "$other_addrs" | sed 's/^/    /' | tee -a "$LOG_FILE"
        log "  Auto-enabling parallel-run mode. Phase 10 (IPNS verify) will be skipped, and"
        log "  IPNS publish + DB backup crons will be staged in $DEFERRED_CRON_DIR rather"
        log "  than installed to /etc/cron.d/. Bitswap fetches across the colliding peer ID"
        log "  are unreliable until the old node stops."
        log "  When you've cut over and the old server's kubo is OFF, run:"
        log "    sudo bash $0 --finalize-cutover --bundle <bundle> --backup-key \"\$KEY\" \\"
        log "      --db-ipns <id> --registry-ipns <id> --ssl-email <email>"
        log "  …to activate the staged crons and run phase 10 verification."
      else
        log "  no peer-ID collision (DHT returned only this node's addresses)"
      fi
    else
      log "  DHT findpeer returned nothing yet (DHT bootstrap may still be in progress; collision check inconclusive)"
    fi
  fi

  # ipfs-cluster
  if ! docker ps --format '{{.Names}}' | grep -q "^${CLUSTER_CONTAINER}$"; then
    docker rm -f "$CLUSTER_CONTAINER" >/dev/null 2>&1 || true
    docker run -d --name "$CLUSTER_CONTAINER" --restart unless-stopped --network host \
      -e CLUSTER_IPFSHTTP_NODEMULTIADDRESS=/ip4/127.0.0.1/tcp/5001 \
      -e CLUSTER_RESTAPI_HTTPLISTENMULTIADDRESS=/ip4/127.0.0.1/tcp/9094 \
      -v ipfs_cluster_data:/data/ipfs-cluster ipfs/ipfs-cluster:stable
  fi
  wait_for "cluster ready" 60 docker exec "$CLUSTER_CONTAINER" ipfs-cluster-ctl id

  if [ -f "$BUNDLE_DIR/cluster/identity.json" ]; then
    local expected_cl actual_cl
    expected_cl=$(jq -r .id < "$BUNDLE_DIR/cluster/identity.json")
    actual_cl=$(docker exec "$CLUSTER_CONTAINER" ipfs-cluster-ctl --enc=json id 2>/dev/null | jq -r .id)
    if [ -n "$expected_cl" ] && [ "$actual_cl" != "$expected_cl" ]; then
      fatal "cluster peer ID mismatch (got $actual_cl, expected $expected_cl)"
    fi
    log "  cluster peer ID OK: $actual_cl"
  fi

  log "infrastructure containers up with preserved identities"
  mark_phase_done docker_infra_start
}

# ============================================================================
# PHASE 9 — pg_restore (PRIMARY data path)
# ============================================================================
phase_pg_restore() {
  log_phase "9. pg_restore — restore from fresh dump"
  local dump="$BUNDLE_DIR/postgres/pinning-fresh.dump"
  [ -f "$dump" ] || fatal "missing $dump (re-run migrate-zip.sh on old server, or use --skip-pg-restore)"

  local pg_user
  pg_user=$(env_get "$PINNING_HOME/.env" POSTGRES_USER)
  pg_user="${pg_user:-pinning_user}"

  # Live-data safeguard: if the existing pinning_service DB already has rows,
  # refuse to DROP+restore unless --force-wipe is set. This protects against
  # accidental re-runs of `--phase=pg_restore` on a server that's been live and
  # accumulating data since the bundle was created. The full-run path is fine
  # because the DB doesn't exist on a fresh server.
  local existing_rows=0
  existing_rows=$(docker exec "$PG_CONTAINER" psql -U "$pg_user" -d pinning_service -tAc \
      "SELECT COALESCE(SUM(n_live_tup), 0) FROM pg_stat_user_tables" 2>/dev/null \
      | tr -d '[:space:]' || echo 0)
  existing_rows="${existing_rows:-0}"
  if [ "$existing_rows" -gt 0 ] && ! $FORCE_WIPE; then
    fatal "pinning_service DB already has $existing_rows rows. \
Refusing to DROP+restore — production data would be lost. \
If you intend to wipe and re-restore, re-run with --force-wipe."
  fi
  if [ "$existing_rows" -gt 0 ] && $FORCE_WIPE; then
    log "  --force-wipe: existing $existing_rows rows will be DROPPED"
  fi

  # Terminate any existing connections, drop, recreate, restore
  docker exec -i "$PG_CONTAINER" psql -U "$pg_user" -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'pinning_service' AND pid <> pg_backend_pid();" \
    >/dev/null 2>&1 || true
  docker exec -i "$PG_CONTAINER" psql -U "$pg_user" -d postgres -c \
    "DROP DATABASE IF EXISTS pinning_service;" \
    || fatal "DROP DATABASE failed"
  docker exec -i "$PG_CONTAINER" psql -U "$pg_user" -d postgres -c \
    "CREATE DATABASE pinning_service OWNER \"$pg_user\";" \
    || fatal "CREATE DATABASE failed"
  # pg_restore exits 1 on warnings, 2 on errors. We tolerate warnings (e.g.
  # missing extensions when --no-owner) but bail on hard errors.
  if ! docker exec -i "$PG_CONTAINER" pg_restore -U "$pg_user" -d pinning_service \
        --no-owner --no-acl < "$dump"; then
    local rc=$?
    if [ "$rc" -ge 2 ]; then
      fatal "pg_restore failed with exit code $rc"
    else
      log "  WARN: pg_restore exited with code $rc (warnings only — continuing)"
    fi
  fi

  # Sanity check
  local count
  count=$(docker exec "$PG_CONTAINER" psql -U "$pg_user" -d pinning_service -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null)
  log "  restored: $count public tables"

  # Diff row counts vs the bundle baseline
  if [ -f "$BUNDLE_DIR/postgres/row-counts.txt" ]; then
    docker exec "$PG_CONTAINER" psql -U "$pg_user" -d pinning_service -tAc \
      "SELECT relname||' '||n_live_tup FROM pg_stat_user_tables ORDER BY relname" \
      > /tmp/post-restore-counts.txt
    if diff -q "$BUNDLE_DIR/postgres/row-counts.txt" /tmp/post-restore-counts.txt >/dev/null; then
      log "  row counts match bundle baseline exactly"
    else
      log "  row counts differ from bundle (expected if any traffic between snapshot and now)"
    fi
  fi

  log "pg_restore OK"

  # Apply any migrations newer than the bundle's pg_dump. The bundle captured
  # schema as of when migrate-zip.sh ran. If new migrations have landed in
  # migrations/postgres/ since then, they need to apply on the new server.
  # All migrations in this codebase are written idempotently (CREATE TABLE
  # IF NOT EXISTS, ALTER TABLE ... DROP COLUMN IF EXISTS, etc. — see
  # migrations/postgres/006-016 + deploy.sh:158-170 conventions), so applying
  # them all is safe whether they're already in the dump or not.
  local migrations_dir="$PINNING_REPO/migrations/postgres"
  if [ -d "$migrations_dir" ] && ls "$migrations_dir"/*.sql >/dev/null 2>&1; then
    local applied_count failed_count=0
    applied_count=$(ls "$migrations_dir"/*.sql 2>/dev/null | wc -l)
    log "  applying $applied_count migrations (idempotent re-application)"
    local f
    for f in $(ls "$migrations_dir"/*.sql | sort); do
      local mname
      mname=$(basename "$f")
      if docker exec -i "$PG_CONTAINER" psql -U "$pg_user" -d pinning_service \
            -v ON_ERROR_STOP=0 < "$f" >>"$LOG_FILE" 2>&1; then
        log "    applied: $mname"
      else
        check_warn "migration $mname returned non-zero — check $LOG_FILE for details"
        failed_count=$((failed_count + 1))
      fi
    done
    if [ "$failed_count" -gt 0 ]; then
      log "  $failed_count migration(s) had errors (may be benign for already-applied migrations)"
    else
      log "  all migrations applied cleanly"
    fi
  else
    log "  no migrations directory at $migrations_dir — skipping migration step"
  fi

  mark_phase_done pg_restore
}

# ============================================================================
# PHASE 10 — verify_ipns_path (DIAGNOSTIC)
# ============================================================================
phase_verify_ipns_path() {
  log_phase "10. verify_ipns_path — exercise IPNS-only recovery against production"
  if $PARALLEL_RUN_MODE; then
    log "  skipped: parallel-run mode active (kubo peer-ID collision with old server makes"
    log "  bitswap fetches across the colliding identity unreliable). Re-run with"
    log "  --finalize-cutover after old server's kubo is stopped to validate the IPNS path."
    mark_phase_done verify_ipns_path
    return
  fi
  if $SKIP_IPNS_VERIFY; then
    log "  skipped per --skip-ipns-verify"
    mark_phase_done verify_ipns_path
    return
  fi

  local pg_user
  pg_user=$(env_get "$PINNING_HOME/.env" POSTGRES_USER)
  pg_user="${pg_user:-pinning_user}"
  local tmpdb="pinning_service_ipns_check"
  local tmpdump=/tmp/ipns-check.dump

  log "  resolving IPNS $DB_IPNS (DHT bootstrap can take a minute on a fresh node)"
  local resolved manifest_cid
  # First wait for some DHT peers — fresh nodes may have zero
  for i in 1 2 3 4 5 6; do
    local peer_count
    peer_count=$(docker exec "$IPFS_CONTAINER" ipfs swarm peers 2>/dev/null | wc -l)
    [ "$peer_count" -ge 5 ] && break
    log "  waiting for DHT bootstrap ($peer_count peers, attempt $i/6)"
    sleep 10
  done
  resolved=$(retry 3 20 docker exec "$IPFS_CONTAINER" ipfs name resolve "/ipns/$DB_IPNS" 2>/dev/null) \
    || { check_warn "IPNS resolve failed after 3 attempts — IPNS path verification skipped"; mark_phase_done verify_ipns_path; return; }
  manifest_cid="${resolved#/ipfs/}"
  log "  manifest CID: $manifest_cid"

  # Decrypt manifest. Wrap `ipfs cat` in a host-side `timeout` so a
  # network-level fetch hang (CID not provided by any reachable peer) can't
  # block the recovery script forever — phase 10 is diagnostic-only and must
  # never gate progress to phase 11+.
  local mfile=/tmp/ipns-manifest.json
  local ipns_fetch_timeout="${IPNS_FETCH_TIMEOUT:-300}"
  if ! timeout "$ipns_fetch_timeout" docker exec "$IPFS_CONTAINER" ipfs cat "$manifest_cid" 2>/dev/null | \
      BACKUP_ENCRYPTION_KEY="$BACKUP_ENCRYPTION_KEY" openssl enc -aes-256-cbc -d -salt -pbkdf2 -iter 600000 \
        -pass env:BACKUP_ENCRYPTION_KEY > "$mfile" 2>/dev/null; then
    log "  WARN: manifest fetch/decrypt failed (timeout=${ipns_fetch_timeout}s) — IPNS path verification skipped (production unaffected)"
    rm -f "$mfile"
    mark_phase_done verify_ipns_path
    return
  fi
  if ! [ -s "$mfile" ]; then
    log "  WARN: manifest empty after fetch — provider not advertising or wrong key; IPNS path verification skipped"
    rm -f "$mfile"
    mark_phase_done verify_ipns_path
    return
  fi

  local dump_cid
  dump_cid=$(jq -r .dump_cid < "$mfile" 2>/dev/null)
  [ -n "$dump_cid" ] && [ "$dump_cid" != "null" ] || { log "  WARN: dump_cid missing in manifest"; rm -f "$mfile"; mark_phase_done verify_ipns_path; return; }

  log "  fetching + decrypting dump $dump_cid (timeout=${ipns_fetch_timeout}s)"
  if ! timeout "$ipns_fetch_timeout" docker exec "$IPFS_CONTAINER" ipfs cat "$dump_cid" 2>/dev/null | \
      BACKUP_ENCRYPTION_KEY="$BACKUP_ENCRYPTION_KEY" openssl enc -aes-256-cbc -d -salt -pbkdf2 -iter 600000 \
        -pass env:BACKUP_ENCRYPTION_KEY > "$tmpdump"; then
    log "  WARN: dump fetch/decrypt failed (timeout=${ipns_fetch_timeout}s) — IPNS path verification skipped (production unaffected)"
    rm -f "$mfile" "$tmpdump"
    mark_phase_done verify_ipns_path
    return
  fi

  docker exec -i "$PG_CONTAINER" psql -U "$pg_user" -d postgres -c \
    "DROP DATABASE IF EXISTS $tmpdb; CREATE DATABASE $tmpdb OWNER \"$pg_user\";" >/dev/null
  if ! docker exec -i "$PG_CONTAINER" pg_restore -U "$pg_user" -d "$tmpdb" --no-owner --no-acl < "$tmpdump" 2>/tmp/ipns-restore.err; then
    log "  CRITICAL: IPNS-restored dump failed pg_restore (production unaffected — using fresh dump). Errors:"
    head -20 /tmp/ipns-restore.err
  else
    # Schema diff
    docker exec "$PG_CONTAINER" pg_dump -U "$pg_user" -d pinning_service --schema-only > /tmp/schema-prod.sql
    docker exec "$PG_CONTAINER" pg_dump -U "$pg_user" -d "$tmpdb"          --schema-only > /tmp/schema-ipns.sql
    if diff -q /tmp/schema-prod.sql /tmp/schema-ipns.sql >/dev/null; then
      log "  schema: identical between fresh dump and IPNS path"
    else
      log "  CRITICAL: schema differs between paths"
      diff /tmp/schema-prod.sql /tmp/schema-ipns.sql | head -50
    fi

    # Row count delta (logins is intentionally excluded from IPNS by backup-db.sh:65)
    docker exec "$PG_CONTAINER" psql -U "$pg_user" -d "$tmpdb" -tAc \
      "SELECT relname||' '||n_live_tup FROM pg_stat_user_tables WHERE relname<>'logins' ORDER BY relname" > /tmp/counts-ipns.txt
    docker exec "$PG_CONTAINER" psql -U "$pg_user" -d pinning_service -tAc \
      "SELECT relname||' '||n_live_tup FROM pg_stat_user_tables WHERE relname<>'logins' ORDER BY relname" > /tmp/counts-prod.txt
    log "  row count delta (prod minus IPNS):"
    join -j1 -t' ' /tmp/counts-prod.txt /tmp/counts-ipns.txt 2>/dev/null | \
      awk '{ delta=$2-$3; if (delta != 0) printf "    %s: %d (prod=%d, ipns=%d)\n", $1, delta, $2, $3 }'
  fi

  docker exec -i "$PG_CONTAINER" psql -U "$pg_user" -d postgres -c "DROP DATABASE IF EXISTS $tmpdb;" >/dev/null
  rm -f "$mfile" "$tmpdump" /tmp/ipns-restore.err /tmp/schema-prod.sql /tmp/schema-ipns.sql /tmp/counts-prod.txt /tmp/counts-ipns.txt
  log "  IPNS path verification complete"
  mark_phase_done verify_ipns_path
}

# ============================================================================
# PHASE 11 — apply_kubo_keys (already in keystore from phase 6; just verify)
# ============================================================================
phase_apply_kubo_keys() {
  log_phase "11. apply_kubo_keys (verify)"
  docker exec "$IPFS_CONTAINER" ipfs key list -l | grep -E "fula-(db-backup|registry)" \
    || fatal "expected IPNS keys missing"
  log "  IPNS keys verified"
  mark_phase_done apply_kubo_keys
}

# ============================================================================
# PHASE 12 — resolve_registry_cid
# ============================================================================
phase_resolve_registry_cid() {
  log_phase "12. resolve_registry_cid"
  install -d /var/lib/fula-gateway

  # Restore any saved gateway state first (registry.cid, db-backup.cid, history)
  if [ -f "$BUNDLE_DIR/fula-gateway/state.tgz" ]; then
    _safe_tar "fula-gateway state extract" -xzf "$BUNDLE_DIR/fula-gateway/state.tgz" -C /
  fi

  # Override registry.cid with a fresh resolve (in case the bundled one is stale).
  # Retry — IPNS over a fresh DHT bootstrap can take 30-60s.
  local resolved cid
  resolved=$(retry 4 20 docker exec "$IPFS_CONTAINER" ipfs name resolve "/ipns/$REGISTRY_IPNS" 2>/dev/null) \
    || resolved=""
  if [ -n "$resolved" ]; then
    cid="${resolved#/ipfs/}"
    echo "$cid" > /var/lib/fula-gateway/registry.cid
    log "  registry.cid := $cid"
  elif [ -s /var/lib/fula-gateway/registry.cid ]; then
    warn "registry IPNS resolve failed; keeping bundled registry.cid value"
  else
    warn "registry IPNS resolve failed and no fallback registry.cid present — fula-api will start with empty registry until IPNS converges"
  fi
  mark_phase_done resolve_registry_cid
}

# ============================================================================
# PHASE 13 — ipfs_repo_verify (auto-heal)
# ============================================================================
phase_ipfs_repo_verify() {
  log_phase "13. ipfs_repo_verify"
  docker exec "$IPFS_CONTAINER" ipfs repo verify 2>&1 | tee /tmp/repo-verify.log || true
  local bad
  bad=$(grep -c "did not verify" /tmp/repo-verify.log 2>/dev/null || echo 0)
  if [ "$bad" -gt 0 ]; then
    log "  WARN: $bad corrupted blocks; bitswap will refetch on demand"
  fi
  rm -f /tmp/repo-verify.log
  mark_phase_done ipfs_repo_verify
}

# ============================================================================
# PHASE 14 — build pinning core (Go binary + Node services)
# ============================================================================
phase_build_pinning_core() {
  log_phase "14. build_pinning_core"
  install -d -m 0755 \
    "$PINNING_HOME"/{data,logs,ipfs-server/dist,ipfs-server/uploads,pinning-webui/dist,backups}

  # Go binary — main_postgres.go (NOT main_sqlite.go)
  retry 2 30 bash -c "cd '$PINNING_REPO' && /usr/local/go/bin/go mod download" \
    || fatal "go mod download failed"
  ( cd "$PINNING_REPO" && /usr/local/go/bin/go build -o "$PINNING_HOME/ipfs-pinning" main_postgres.go ) \
    || fatal "go build of main_postgres.go failed — check Go version and source compatibility"
  [ -x "$PINNING_HOME/ipfs-pinning" ] || fatal "ipfs-pinning binary missing after build"

  # Read OAuth IDs needed at build time
  local google_id wc_id apple_id
  google_id=$(env_get "$PINNING_HOME/pinning-webui/.env" GOOGLE_CLIENT_ID)
  wc_id=$(env_get "$PINNING_HOME/pinning-webui/.env" VITE_WALLETCONNECT_PROJECT_ID)
  apple_id=$(env_get "$PINNING_HOME/pinning-webui/.env" APPLE_CLIENT_ID)

  # ipfs-server (upload gateway)
  retry 2 30 bash -c "cd '$PINNING_REPO/ipfs-server' && npm ci" \
    || fatal "npm ci failed for ipfs-server (registry flake?)"
  ( cd "$PINNING_REPO/ipfs-server" && npm run build && \
    cp -r dist/* "$PINNING_HOME/ipfs-server/dist/" ) \
    || fatal "build/copy failed for ipfs-server"

  # pinning-webui (Vite SPA + Node server)
  retry 2 30 bash -c "cd '$PINNING_REPO/pinning-webui' && npm ci" \
    || fatal "npm ci failed for pinning-webui"
  ( cd "$PINNING_REPO/pinning-webui" && \
    VITE_GOOGLE_CLIENT_ID="$google_id" \
    VITE_WALLETCONNECT_PROJECT_ID="$wc_id" \
    VITE_APPLE_CLIENT_ID="${apple_id:-land.fx.cloud}" \
    npm run build && \
    cp -r dist/* "$PINNING_HOME/pinning-webui/dist/" && \
    cp package*.json "$PINNING_HOME/pinning-webui/" ) \
    || fatal "build/copy failed for pinning-webui"
  retry 2 30 bash -c "cd '$PINNING_HOME/pinning-webui' && npm install --omit=dev --ignore-scripts=false && npm rebuild" \
    || fatal "production install/rebuild failed for pinning-webui"

  log "pinning core built"
  mark_phase_done build_pinning_core
}

# ============================================================================
# PHASE 15 — build subservices (x402-skale + fula-ai-service)
# ============================================================================
phase_build_subservices() {
  log_phase "15. build_subservices"

  # x402-skale: build inside the cloned repo, run from /home/root/.../x402-skale
  install -d -m 0755 "$PINNING_HOME/x402-skale/data"
  ( cd "$PINNING_REPO/x402-skale" && npm ci && \
    if [ -f package.json ] && grep -q '"build"' package.json; then npm run build; fi )
  rsync -a --delete "$PINNING_REPO/x402-skale/dist/" "$PINNING_HOME/x402-skale/dist/" 2>/dev/null || true
  cp "$PINNING_REPO/x402-skale/package.json"      "$PINNING_HOME/x402-skale/"      2>/dev/null || true
  cp "$PINNING_REPO/x402-skale/package-lock.json" "$PINNING_HOME/x402-skale/"      2>/dev/null || true
  ( cd "$PINNING_HOME/x402-skale" && npm install --omit=dev )

  # fula-ai-service: build then deploy to /opt/fula-ai-service
  ( cd "$PINNING_REPO/ai" && npm ci && \
    if [ -f package.json ] && grep -q '"build"' package.json; then npm run build; fi )
  install -d -m 0755 /opt/fula-ai-service/dist
  rsync -a --delete "$PINNING_REPO/ai/dist/" /opt/fula-ai-service/dist/ 2>/dev/null || true
  cp "$PINNING_REPO/ai/package.json"      /opt/fula-ai-service/      2>/dev/null || true
  cp "$PINNING_REPO/ai/package-lock.json" /opt/fula-ai-service/      2>/dev/null || true
  ( cd /opt/fula-ai-service && npm install --omit=dev && npm rebuild )

  log "subservices built"
  mark_phase_done build_subservices
}

# ============================================================================
# PHASE 16 — install fula-api gateway (docker)
# ============================================================================
phase_install_fula_api() {
  log_phase "16. install_fula_api"
  # Note: this phase starts the fula-gateway container directly via docker run.
  # The systemd unit 'fula-gateway.service' is applied later in phase 20
  # (apply_systemd_units). Between phases 16-20 the container is managed only by
  # docker's --restart unless-stopped, not systemd. This is acceptable because
  # all subsequent phases run within the same recover.sh invocation.

  install -d -m 0755 /var/lib/fula-gateway /var/log/fula

  # Build image only if not already loaded from bundle
  if ! docker image inspect fula-gateway:local >/dev/null 2>&1 && \
     ! docker image inspect fula-gateway >/dev/null 2>&1; then
    log "  building fula-gateway image from source"
    ( cd "$FULA_API_REPO" && docker build -t fula-gateway:local -f Dockerfile . )
  fi

  if ! docker ps --format '{{.Names}}' | grep -q "^${GATEWAY_CONTAINER}$"; then
    docker rm -f "$GATEWAY_CONTAINER" >/dev/null 2>&1 || true
    local img
    img=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^fula-gateway' | head -1)
    docker run -d --name "$GATEWAY_CONTAINER" --restart unless-stopped \
      --network host --env-file /etc/fula/.env \
      -v /var/lib/fula-gateway:/var/lib/fula-gateway \
      "$img"
  fi

  # Cron: republish registry CID every 10 minutes. In parallel-run mode the
  # old server is still publishing its view of the registry IPNS — having two
  # nodes publish to the same IPNS key would cause readers to oscillate
  # between the two records. Stage the cron file in $DEFERRED_CRON_DIR so
  # --finalize-cutover can activate it after the old node stops.
  local registry_cron_body='*/10 * * * * root /opt/fula-api/publish-registry-ipns.sh >> /var/log/fula-registry-ipns.log 2>&1'
  if $PARALLEL_RUN_MODE; then
    install -d -m 0755 "$DEFERRED_CRON_DIR"
    echo "$registry_cron_body" > "$DEFERRED_CRON_DIR/fula-registry-ipns"
    chmod 644 "$DEFERRED_CRON_DIR/fula-registry-ipns"
    log "  parallel-run: staged registry-ipns cron in $DEFERRED_CRON_DIR (NOT installed to /etc/cron.d/ yet)"
  else
    echo "$registry_cron_body" > /etc/cron.d/fula-registry-ipns
    chmod 644 /etc/cron.d/fula-registry-ipns
  fi

  log "fula-api gateway up"
  mark_phase_done install_fula_api
}

# ============================================================================
# PHASE 17 — build mainnet-rewards-server
# ============================================================================
phase_build_mainnet_rewards() {
  log_phase "17. build_mainnet_rewards"

  # Source resolution priority (in order):
  #  1. Bundle snapshot at services/mainnet-rewards-server/opt-mainnet-rewards.tgz
  #     (preferred — captures exact deployed state from old server, including
  #     any local modifications, and works without GitHub auth for the private repo)
  #  2. Pre-existing $MAINNET_REWARDS_REPO directory (from clone or rsync)
  #  3. Skip with warning
  local snap="$BUNDLE_DIR/services/mainnet-rewards-server/opt-mainnet-rewards.tgz"
  if [ -f "$snap" ]; then
    log "  extracting /opt/mainnet-rewards snapshot from bundle"
    install -d -m 0755 /opt/mainnet-rewards
    _safe_tar "/opt/mainnet-rewards extract" -xzf "$snap" -C /
    chmod 600 /opt/mainnet-rewards/.env 2>/dev/null || true
    # Build directly from the deployed location — no separate clone+build dir
    if [ -f /opt/mainnet-rewards/package.json ]; then
      ( cd /opt/mainnet-rewards && npm ci && \
        if grep -q '"build"' package.json 2>/dev/null; then npm run build; fi && \
        npm install --omit=dev && npm rebuild ) \
        || warn "mainnet-rewards build/install had errors — check logs"
    else
      warn "mainnet-rewards snapshot extracted but no package.json — service may not be runnable"
    fi
  elif [ -d "$MAINNET_REWARDS_REPO" ] && [ -f "$MAINNET_REWARDS_REPO/package.json" ]; then
    log "  building from $MAINNET_REWARDS_REPO (clone or manually-provided source)"
    ( cd "$MAINNET_REWARDS_REPO" && npm ci && \
      if grep -q '"build"' package.json 2>/dev/null; then npm run build; fi )
    install -d -m 0755 /opt/mainnet-rewards
    rsync -a --delete "$MAINNET_REWARDS_REPO/dist/" /opt/mainnet-rewards/dist/ 2>/dev/null || true
    for f in package.json package-lock.json; do
      [ -f "$MAINNET_REWARDS_REPO/$f" ] && cp "$MAINNET_REWARDS_REPO/$f" /opt/mainnet-rewards/
    done
    ( cd /opt/mainnet-rewards && npm install --omit=dev && npm rebuild )
  else
    check_warn "no mainnet-rewards source available (no bundle snapshot, no $MAINNET_REWARDS_REPO/package.json). \
For private repos, either re-bundle on the old server (latest migrate-zip.sh now snapshots /opt/mainnet-rewards) \
or rsync /opt/mainnet-rewards from old server to new server, then re-run --phase=build_mainnet_rewards"
  fi
  mark_phase_done build_mainnet_rewards
}

# ============================================================================
# PHASE 18 — build mainnet-pool-server (pm2-managed)
# ============================================================================
phase_build_mainnet_pool() {
  log_phase "18. build_mainnet_pool"
  local snap="$BUNDLE_DIR/services/mainnet-pool-server/opt-mainnet.tgz"

  if [ -f "$snap" ]; then
    log "  extracting /opt/mainnet snapshot"
    _safe_tar "/opt/mainnet extract" -xzf "$snap" -C /
    chmod 600 /opt/mainnet/.env 2>/dev/null || true
  elif [ -n "$MAINNET_POOL_REPO" ]; then
    log "  cloning $MAINNET_POOL_REPO"
    [ -d /opt/mainnet ] && rm -rf /opt/mainnet.bak.$$ && mv /opt/mainnet /opt/mainnet.bak.$$
    git clone "$MAINNET_POOL_REPO" /opt/mainnet
  else
    log "  WARN: no /opt/mainnet snapshot in bundle and no --mainnet-pool-repo given. Skipping."
    mark_phase_done build_mainnet_pool
    return
  fi

  # pm2 saved process list + ecosystem config
  install -d -m 0755 /opt/mainnet/.pm2
  for f in dump.pm2 ecosystem.config.js; do
    [ -f "$BUNDLE_DIR/services/mainnet-pool-server/$f" ] && \
      cp "$BUNDLE_DIR/services/mainnet-pool-server/$f" /opt/mainnet/.pm2/$f 2>/dev/null
    [ "$f" = "ecosystem.config.js" ] && [ -f "$BUNDLE_DIR/services/mainnet-pool-server/$f" ] && \
      cp "$BUNDLE_DIR/services/mainnet-pool-server/$f" /opt/mainnet/$f
  done

  # npm deps
  ( cd /opt/mainnet && npm ci --omit=dev && npm rebuild )

  [ -f /opt/mainnet/ecosystem.config.js ] || \
    fatal "missing /opt/mainnet/ecosystem.config.js (required by pm2 systemd unit)"

  log "  mainnet-pool-server ready (pm2 will start it via systemd unit in phase_apply_systemd_units)"
  mark_phase_done build_mainnet_pool
}

# ============================================================================
# PHASE 19 — build libp2p-service
# ============================================================================
phase_build_libp2p_service() {
  log_phase "19. build_libp2p_service"
  install -d -m 0755 /opt/mainnet/libp2p-service
  local svc_bundle="$BUNDLE_DIR/services/libp2p-service"

  local rebuild=true

  # Use pre-built binary only if it matches the host architecture
  if [ -x "$svc_bundle/binary" ]; then
    local host_arch="$(uname -m)"
    local file_info
    file_info=$(file "$svc_bundle/binary" 2>/dev/null || echo "")
    case "$host_arch" in
      x86_64) [[ "$file_info" == *"x86-64"* ]] && rebuild=false ;;
      aarch64|arm64) [[ "$file_info" == *"aarch64"* || "$file_info" == *"ARM aarch64"* ]] && rebuild=false ;;
    esac
    if ! $rebuild; then
      cp -p "$svc_bundle/binary" /opt/mainnet/libp2p-service/libp2p-service
      chmod 755 /opt/mainnet/libp2p-service/libp2p-service
      log "  using pre-built binary (arch matches: $host_arch)"
    else
      log "  pre-built binary arch mismatch ($host_arch vs $file_info); rebuilding from source"
    fi
  fi

  if $rebuild; then
    for f in main.go go.mod go.sum; do
      [ -f "$svc_bundle/$f" ] && cp "$svc_bundle/$f" /opt/mainnet/libp2p-service/$f
    done
    [ -f /opt/mainnet/libp2p-service/main.go ] || fatal "no source for libp2p-service rebuild"
    ( cd /opt/mainnet/libp2p-service && /usr/local/go/bin/go build -o libp2p-service . )
  fi

  [ -x /opt/mainnet/libp2p-service/libp2p-service ] || fatal "libp2p-service binary missing after build"
  log "  libp2p-service ready (fresh peer ID per restart — by design; systemd Restart=always covers crashes)"
  mark_phase_done build_libp2p_service
}

# ============================================================================
# PHASE 20 — apply systemd units (verbatim from bundle)
# ============================================================================
phase_apply_systemd_units() {
  log_phase "20. apply_systemd_units"
  if [ -d "$BUNDLE_DIR/systemd" ]; then
    # Unit files
    for f in "$BUNDLE_DIR/systemd"/*.service; do
      [ -f "$f" ] && cp "$f" /etc/systemd/system/ 2>/dev/null || true
    done
    # Override drop-in directories (each is a foo.service.d/ subdirectory)
    for d in "$BUNDLE_DIR/systemd"/*.service.d; do
      [ -d "$d" ] && cp -r "$d" /etc/systemd/system/ 2>/dev/null || true
    done
  fi
  systemctl daemon-reload
  log "  systemd units applied"
  mark_phase_done apply_systemd_units
}

# ============================================================================
# PHASE 21 — apply nginx (sed-strip listen 443 + escaped \$, then reload)
# ============================================================================
phase_apply_nginx() {
  log_phase "21. apply_nginx"

  # Top-level nginx.conf, conf.d, snippets
  [ -f "$BUNDLE_DIR/nginx/nginx.conf" ] && cp "$BUNDLE_DIR/nginx/nginx.conf" /etc/nginx/nginx.conf
  for d in conf.d snippets; do
    [ -d "$BUNDLE_DIR/nginx/$d" ] && cp -r "$BUNDLE_DIR/nginx/$d/." "/etc/nginx/$d/" 2>/dev/null || true
  done

  # Sites — copy and clean each one
  if [ -d "$BUNDLE_DIR/nginx/sites-available" ]; then
    for src in "$BUNDLE_DIR/nginx/sites-available"/*; do
      [ -f "$src" ] || continue
      local name=$(basename "$src")
      # Skip stale temp configs
      case "$name" in temp-*|*.bak) log "  skip $name"; continue ;; esac

      local dst="/etc/nginx/sites-available/$name"
      cp "$src" "$dst"

      # Fix backslash-escaped $ literals from heredoc-generated configs (always)
      sed -i 's/\\\$/$/g' "$dst"

      # Decide whether to strip the listen-443 server block. We strip ONLY when
      # the bundled cert is missing — otherwise nginx loads the existing cert
      # from the restored /etc/letsencrypt and serves HTTPS without needing
      # certbot to recreate the block. This matters when DNS still points at the
      # old server (certbot HTTP-01 would fail), but the bundled cert is valid.
      local domain_in_site
      domain_in_site=$(grep -oP "server_name\s+\K[^ ;]+" "$dst" 2>/dev/null | grep -v '^_$' | head -n1)
      local cert_path=""
      [ -n "$domain_in_site" ] && cert_path="/etc/letsencrypt/live/$domain_in_site/fullchain.pem"

      if [ -n "$cert_path" ] && [ -f "$cert_path" ]; then
        # Cert exists on disk (restored from bundle) — keep listen 443 block as-is
        log "  $name: keeping listen-443 block (cert at $cert_path is present)"
        ln -sfn "$dst" "/etc/nginx/sites-enabled/$name"
        continue
      fi

      log "  $name: stripping listen-443 block (no cert at $cert_path)"
      # Save a pre-strip copy so we can recover by hand if the python block
      # mangles a config (it's a heuristic regex+brace parser; not bulletproof).
      cp "$dst" "${dst}.pre-strip"

      # Strip any "listen 443 ssl" server blocks and Certbot redirect stanzas —
      # certbot --nginx will recreate them with valid /etc/letsencrypt paths
      # (after DNS cutover).
      python3 - "$dst" <<'PY'
import re, sys
p = sys.argv[1]
src = open(p).read()
# Remove entire server { } blocks that contain "listen 443"
out = []
i = 0
N = len(src)
while i < N:
    m = re.search(r'server\s*\{', src[i:])
    if not m:
        out.append(src[i:])
        break
    start = i + m.start()
    out.append(src[i:start])
    # Find matching }
    depth = 0
    j = start
    block_end = None
    while j < N:
        c = src[j]
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                block_end = j + 1
                break
        j += 1
    if block_end is None:
        out.append(src[start:])
        break
    block = src[start:block_end]
    if re.search(r'listen\s+443', block):
        # Skip this 443 block entirely
        pass
    else:
        out.append(block)
    i = block_end

src = ''.join(out)
# Drop trailing "if ($host = ...) { return 301 https...} # managed by Certbot"
src = re.sub(r'\n\s*if\s*\(\s*\$host\s*=[^)]+\)\s*\{[^}]*\}\s*#\s*managed by Certbot[^\n]*\n', '\n', src)
open(p, 'w').write(src)
PY

      ln -sfn "$dst" "/etc/nginx/sites-enabled/$name"
    done
  fi

  if ! nginx -t 2>&1 | tee /tmp/nginx-test.log; then
    log "  nginx -t FAILED after stripping. Pre-strip copies are at:"
    log "    /etc/nginx/sites-available/*.pre-strip"
    log "  To restore one: mv <file>.pre-strip <file> && hand-edit to remove the 443 block"
    fatal "nginx -t failed after applying configs (see /tmp/nginx-test.log)"
  fi
  # Clean up successful .pre-strip backups
  rm -f /etc/nginx/sites-available/*.pre-strip 2>/dev/null || true
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
  log "  nginx reloaded"
  mark_phase_done apply_nginx
}

# ============================================================================
# PHASE 22 — apply cron
# ============================================================================
phase_apply_cron() {
  log_phase "22. apply_cron"

  # In parallel-run mode, stage cron files in $DEFERRED_CRON_DIR instead of
  # installing them. Reason: the db-backup cron publishes encrypted backups
  # to fula-db-backup IPNS — having two nodes publishing to the same key
  # creates conflicting IPNS records and corrupts the disaster-recovery path.
  # The bundle's own cron.d files (if any) likely have similar concerns.
  local cron_target
  if $PARALLEL_RUN_MODE; then
    install -d -m 0755 "$DEFERRED_CRON_DIR"
    cron_target="$DEFERRED_CRON_DIR"
  else
    cron_target="/etc/cron.d"
  fi

  if [ -d "$BUNDLE_DIR/cron/cron.d" ]; then
    for f in "$BUNDLE_DIR/cron/cron.d"/*; do
      [ -f "$f" ] || continue
      cp "$f" "$cron_target/$(basename "$f")"
      chmod 644 "$cron_target/$(basename "$f")"
    done
  fi

  # Belt and suspenders: ensure backup-db cron exists (per plan §postinstall)
  cat > "$cron_target/fula-db-backup" <<'EOF'
0 3 * * * root . /root/.fula-backup-key && /opt/pinning-service/scripts/backup-db.sh >> /var/log/fula-db-backup.log 2>&1
EOF
  chmod 644 "$cron_target/fula-db-backup"

  if $PARALLEL_RUN_MODE; then
    log "  parallel-run: staged crons in $DEFERRED_CRON_DIR (NOT installed to /etc/cron.d/ yet)"
    log "  Run with --finalize-cutover after old server's kubo+cluster are stopped to activate."
  else
    log "  cron applied"
  fi
  mark_phase_done apply_cron
}

# ============================================================================
# PHASE 23 — apply UFW
# ============================================================================
phase_apply_ufw() {
  log_phase "23. apply_ufw"

  # ----------------------------------------------------------------------------
  # Part A: inbound rules (what the world can reach on this server)
  # ----------------------------------------------------------------------------
  # Public services — accept from anywhere (internet + LAN). Replies use
  # conntrack so they're never blocked by Part B's outbound rules.
  ufw allow 22/tcp    comment 'recover.sh: SSH'                 || true
  ufw allow 80/tcp    comment 'recover.sh: HTTP'                || true
  ufw allow 443/tcp   comment 'recover.sh: HTTPS'               || true
  ufw allow 4001/tcp  comment 'recover.sh: IPFS swarm'          || true
  ufw allow 4001/udp  comment 'recover.sh: IPFS swarm QUIC'     || true
  ufw allow 9096/tcp  comment 'recover.sh: cluster swarm'       || true
  ufw allow 9096/udp  comment 'recover.sh: cluster swarm QUIC'  || true
  # Internal-only ports — defense in depth on top of 127.0.0.1 binding.
  # These cover INBOUND only; they don't conflict with Part B (outbound).
  ufw deny  5432/tcp  comment 'recover.sh: postgres internal'   || true
  ufw deny  5001/tcp  comment 'recover.sh: kubo API internal'   || true
  ufw deny  9094/tcp  comment 'recover.sh: cluster API internal'|| true
  ufw deny  9095/tcp  comment 'recover.sh: cluster proxy intl'  || true

  # ----------------------------------------------------------------------------
  # Part B: outbound LAN isolation (server cannot pivot to home devices)
  # ----------------------------------------------------------------------------
  # No collision with Part A: UFW maintains separate INPUT and OUTPUT chains;
  # inbound allow rules above govern packets coming TO the server, the deny
  # rule below governs packets going FROM the server. Replies on existing
  # incoming connections are exempt via UFW's stateful conntrack handling
  # (ESTABLISHED,RELATED).
  if $NO_LAN_ISOLATION; then
    log "  --no-lan-isolation: skipping outbound LAN-isolation rules"
  else
    _apply_lan_isolation
  fi

  ufw --force enable
  mark_phase_done apply_ufw
}

# ----------------------------------------------------------------------------
# Helper for phase_apply_ufw Part B — adds outbound LAN-isolation rules.
# Auto-detects gateway, LAN CIDR, and any LAN-resident DNS servers. Skips
# silently on cloud VPS / public-IP setups where there's no home LAN to isolate.
# Idempotent: rules carry a 'recover.sh: lan-iso' comment marker; re-running
# the phase doesn't duplicate them (UFW dedupes identical rules).
# ----------------------------------------------------------------------------
_apply_lan_isolation() {
  log "  detecting LAN configuration for outbound isolation..."

  local gateway iface server_cidr lan_network
  gateway=$(ip -4 route get 8.8.8.8 2>/dev/null | awk 'NR==1 {print $3}')
  iface=$(ip -4 route get 8.8.8.8 2>/dev/null | awk 'NR==1 {print $5}')
  server_cidr=$(ip -4 addr show "$iface" 2>/dev/null | awk '/inet /{print $2}' | head -1)

  if [ -z "$gateway" ] || [ -z "$iface" ] || [ -z "$server_cidr" ]; then
    check_warn "LAN config detection failed (gateway=$gateway iface=$iface cidr=$server_cidr); skipping LAN isolation"
    return
  fi

  # Skip on public-IP setups (cloud VPS): no home LAN to isolate, and a
  # `deny out to <public-network>` rule could break legitimate traffic.
  # is_private_ipv4 returns 0 if the IP is in RFC1918 / link-local / etc.
  if ! python3 -c "
import ipaddress, sys
sys.exit(0 if ipaddress.ip_address('$gateway').is_private else 1)
" 2>/dev/null; then
    log "  gateway $gateway is public (cloud server / direct-public IP) — LAN isolation does not apply, skipping"
    return
  fi

  # Compute the network address from the server's CIDR.
  lan_network=$(python3 -c "
import ipaddress, sys
try:
    sys.stdout.write(str(ipaddress.ip_network('$server_cidr', strict=False)))
except Exception:
    pass
" 2>/dev/null)
  if [ -z "$lan_network" ]; then
    check_warn "could not compute LAN network from $server_cidr; skipping LAN isolation"
    return
  fi

  # Detect LAN-side DNS servers (Pi-hole, router DNS, etc.) — these need
  # explicit allow-out so the deny rule doesn't break name resolution. Public
  # DNS (1.1.1.1, 8.8.8.8, etc.) is fine — they don't need an explicit allow.
  local lan_dns_servers=()
  if [ -f /etc/resolv.conf ]; then
    local ns
    while read -r ns; do
      [ -z "$ns" ] && continue
      if python3 -c "
import ipaddress, sys
try:
    sys.exit(0 if ipaddress.ip_address('$ns').is_private else 1)
except Exception:
    sys.exit(1)
" 2>/dev/null; then
        lan_dns_servers+=("$ns")
      fi
    done < <(awk '/^nameserver /{print $2}' /etc/resolv.conf)
  fi

  log "  LAN detected:    $lan_network"
  log "  Gateway:         $gateway"
  if [ "${#lan_dns_servers[@]}" -gt 0 ]; then
    log "  LAN DNS servers: ${lan_dns_servers[*]} (will be allowed)"
  else
    log "  LAN DNS servers: none (using public DNS — fine)"
  fi

  # Order matters: more-specific allow rules must precede the broader deny.
  # UFW's iptables chain processes rules top-to-bottom; first match wins.
  # We add allows first, then the deny — UFW preserves insertion order.
  log "  applying outbound LAN-isolation rules..."
  ufw allow out to "$gateway"     comment 'recover.sh: lan-iso gateway' || true
  for ns in "${lan_dns_servers[@]}"; do
    ufw allow out to "$ns"        comment 'recover.sh: lan-iso DNS'     || true
  done
  ufw deny  out to "$lan_network" comment 'recover.sh: lan-iso block'   || true

  log "  LAN isolation applied:"
  log "    [OK]    server can reach internet via $gateway"
  log "    [OK]    server can reach LAN DNS (if any)"
  log "    [BLOCK] server cannot initiate to other home devices on $lan_network"
  log "    [OK]    inbound replies on existing connections still work (conntrack)"
}

# ============================================================================
# PHASE 24 — DNS cutover pause (blocking)
# ============================================================================
phase_dns_cutover_pause() {
  log_phase "24. dns_cutover_pause"
  if $DEFER_DNS; then
    log "  --defer-dns set: skipping DNS-cutover pause."
    log "  Test the new server via /etc/hosts on a test machine, then later run:"
    log "    bash $0 --phase=certs <same flags as before, but WITHOUT --defer-dns>"
    mark_phase_done dns_cutover_pause
    return
  fi
  echo
  echo "============================================================"
  echo " DNS CUTOVER REQUIRED"
  echo "============================================================"
  echo "Update A/AAAA records to this server's public IP ($(my_public_ip))"
  echo "for every hostname in /etc/nginx/sites-enabled/ :"
  ls /etc/nginx/sites-enabled/ 2>/dev/null
  echo
  echo "Verify with:  dig +short <hostname>"
  echo "============================================================"
  echo
  read -rp "Type 'DNS-DONE' when DNS is propagated: " ans
  [ "$ans" = "DNS-DONE" ] || fatal "aborted at DNS cutover"
  mark_phase_done dns_cutover_pause
}

# ============================================================================
# PHASE 25 — certs (re-issue any that didn't survive letsencrypt restore)
# ============================================================================
phase_certs() {
  log_phase "25. certs"
  if $DEFER_DNS; then
    log "  --defer-dns set: skipping certbot issuance for all domains."
    log "  Existing certs (if restored from bundle) continue serving via nginx."
    log "  After DNS cutover, re-run: bash $0 --phase=certs <same flags WITHOUT --defer-dns>"
    mark_phase_done certs
    return
  fi

  # Capture certbot output once; awk-parse for exact domain matches per cert
  local cert_dump
  cert_dump=$(certbot certificates 2>/dev/null || echo "")
  local me
  me=$(my_public_ip)
  if [ -n "$me" ]; then
    log "  this server's public IP: $me"
  else
    log "  WARN: could not determine public IP; per-domain DNS checks will be skipped"
  fi

  for site in /etc/nginx/sites-enabled/*; do
    [ -f "$site" ] || continue
    local d
    d=$(grep -oP "server_name\s+\K[^ ;]+" "$site" 2>/dev/null | grep -v '^_$' | head -n1)
    [ -z "$d" ] && continue

    # Exact-token match within "Domains: a.example.com b.example.com" lines
    if echo "$cert_dump" | awk -v want="$d" '
        $1=="Domains:" { for (i=2;i<=NF;i++) if ($i==want) { found=1; exit } }
        END { exit !found }'; then
      log "  cert exists: $d (skipping issuance)"
      continue
    fi

    # No cert yet → before bothering certbot, check if DNS is pointing here.
    # certbot HTTP-01 fetches http://$d/.well-known/... by resolving public DNS,
    # so if DNS still points at the old server, the validation goes there and
    # fails with a confusing error. Pre-detect and warn-skip instead.
    if dns_points_here "$d"; then
      log "  DNS for $d points here — issuing cert"
      certbot --nginx -d "$d" --non-interactive --agree-tos \
        --email "$SSL_EMAIL" --redirect 2>&1 | tee -a "$LOG_FILE" \
        || warn "$d: certbot issuance failed (see log; rate-limited? domain blocked?)"
    else
      local rc=$?
      if [ "$rc" -eq 1 ]; then
        warn "$d: DNS still points elsewhere — skipping cert issuance. After DNS cutover, run: bash $0 --phase=certs ..."
      else
        warn "$d: DNS check inconclusive (no public-IP probe or no dig). Skipping; re-run when DNS is settled."
      fi
    fi
  done
  mark_phase_done certs
}

# ============================================================================
# PHASE 26 — start (enable + start every relevant unit)
# ============================================================================
phase_start() {
  log_phase "26. start — enable + start services"
  systemctl daemon-reload

  # Order matters: dependencies first (libp2p-service before mainnet-pool-server)
  local services=(
    redis-server
    fula-pinning-service
    fula-upload-server
    fula-pinning-webui
    fula-gateway
    fula-ai-service
    x402-gateway
    libp2p-service
    mainnet-pool-server
    mainnet-rewards-server
  )

  for s in "${services[@]}"; do
    local has_unit=false
    if [ -f "/etc/systemd/system/${s}.service" ] || \
       systemctl list-unit-files 2>/dev/null | grep -q "^${s}\.service"; then
      has_unit=true
    fi
    if ! $has_unit; then
      log "  ${s}: no unit file found — skipping"
      continue
    fi
    systemctl enable "$s"  >/dev/null 2>&1 || true
    if systemctl restart "$s" 2>&1 | tee -a "$LOG_FILE"; then
      # Give the unit a moment, then check it didn't crash immediately
      sleep 2
      if systemctl is-active --quiet "$s"; then
        log "  ${s}: started OK"
      else
        check_warn "${s} restarted but is not active — see 'journalctl -u ${s} --since \"1 minute ago\"'"
      fi
    else
      check_warn "${s} failed to start (rc=$?) — continuing; investigate post-recovery"
    fi
  done

  sleep 3
  if [ -x "$PINNING_REPO/verify-deploy.sh" ]; then
    bash "$PINNING_REPO/verify-deploy.sh" 2>&1 | tee -a "$LOG_FILE" || \
      check_warn "verify-deploy.sh reported issues — see above"
  fi

  mark_phase_done start
}

# ============================================================================
# PHASE 27 — post_verify
# ============================================================================
phase_post_verify() {
  log_phase "27. post_verify — comprehensive health matrix"
  _verify_systemd_services
  _verify_docker_containers
  _verify_network_listeners
  _verify_http_endpoints
  _verify_ipfs
  _verify_cluster
  _verify_postgres
  _verify_redis
  _verify_tls
  _verify_cron
  _verify_backup_readiness
  _verify_disk_resources
  _verify_negative_exposure
  mark_phase_done post_verify
}

# ---------------- systemd services ----------------
_verify_systemd_services() {
  log "  --- systemd units ---"
  local services=(
    fula-pinning-service fula-upload-server fula-pinning-webui
    fula-gateway fula-ai-service x402-gateway libp2p-service
    mainnet-pool-server mainnet-rewards-server redis-server nginx
  )
  local s
  for s in "${services[@]}"; do
    if ! systemctl list-unit-files 2>/dev/null | grep -q "^${s}\.service" && \
       [ ! -f "/etc/systemd/system/${s}.service" ]; then
      continue   # not configured on this host — skip silently
    fi
    if systemctl is-active --quiet "$s"; then
      check_pass "$s active"
    else
      check_fail "$s NOT active (status: $(systemctl is-active "$s" 2>/dev/null))"
      continue
    fi
    if ! systemctl is-enabled --quiet "$s"; then
      check_warn "$s active but NOT enabled — won't start on reboot"
    fi
    # Restart-loop heuristic: any systemd "Failed" lines in last 5 minutes
    local recent_fails
    recent_fails=$(journalctl -u "$s" --since "5 minutes ago" --no-pager 2>/dev/null \
      | grep -cE "(Failed|FATAL|panic|segfault|core dumped)" || true)
    if [ "$recent_fails" -gt 0 ]; then
      check_warn "$s shows $recent_fails error lines in last 5 min — see 'journalctl -u $s --since 5m'"
    fi
  done
}

# ---------------- docker containers ----------------
_verify_docker_containers() {
  log "  --- docker containers ---"
  local c
  for c in postgres-pinning ipfs_host ipfs_cluster fula-gateway-1; do
    if ! docker inspect "$c" >/dev/null 2>&1; then
      check_fail "$c container does not exist"
      continue
    fi
    local state
    state=$(docker inspect "$c" --format '{{.State.Status}}' 2>/dev/null)
    if [ "$state" = "running" ]; then
      check_pass "$c running"
    else
      check_fail "$c state=$state"
      continue
    fi
    # Restart loop check
    local restart_count
    restart_count=$(docker inspect "$c" --format '{{.RestartCount}}' 2>/dev/null)
    if [ "$restart_count" -gt 5 ]; then
      check_warn "$c has restarted $restart_count times — may be unstable"
    fi
    # Health check status (if container defines HEALTHCHECK)
    local health
    health=$(docker inspect "$c" --format '{{.State.Health.Status}}' 2>/dev/null || echo none)
    if [ "$health" = "unhealthy" ]; then
      check_warn "$c reports unhealthy via Docker HEALTHCHECK"
    fi
  done
}

# ---------------- network listeners ----------------
_verify_network_listeners() {
  log "  --- network listeners ---"
  # Public ports (any address OK)
  local public=(
    "22:ssh"
    "80:nginx-http"
    "443:nginx-https"
    "4001:kubo-swarm"
    "9096:cluster-swarm"
  )
  # Localhost-only ports (must NOT be on 0.0.0.0)
  local localhost_only=(
    "5001:kubo-api"
    "5432:postgres"
    "9094:cluster-api"
    "9095:cluster-proxy"
    "6000:pinning-service"
    "3001:pinning-webui"
    "3300:ipfs-server"
    "3002:mainnet-pool-server"
    "3003:fula-ai-service"
    "4002:x402-gateway"
    "5667:mainnet-rewards-server"
    "6379:redis"
    "8081:kubo-gateway"
  )
  local entry port name
  for entry in "${public[@]}"; do
    port="${entry%%:*}"; name="${entry#*:}"
    if ss -tlnH 2>/dev/null | awk '{print $4}' | grep -qE "[*0-9.]+:${port}$"; then
      check_pass "tcp/$port ($name) listening"
    else
      check_warn "tcp/$port ($name) NOT listening"
    fi
  done
  for entry in "${localhost_only[@]}"; do
    port="${entry%%:*}"; name="${entry#*:}"
    local listeners
    listeners=$(ss -tlnH 2>/dev/null | awk '{print $4}' | grep -E ":${port}$" || true)
    if [ -z "$listeners" ]; then
      # Some services may legitimately not be configured — soft warn
      check_warn "tcp/$port ($name) not listening (service may be inactive)"
      continue
    fi
    # Verify ALL listeners are 127.0.0.1 / [::1]
    local exposed
    exposed=$(echo "$listeners" | grep -vE '^(127\.0\.0\.1|\[::1\]):' || true)
    if [ -n "$exposed" ]; then
      check_fail "tcp/$port ($name) exposed publicly: $exposed (expected 127.0.0.1 only)"
    else
      check_pass "tcp/$port ($name) bound to localhost only"
    fi
  done
}

# ---------------- HTTP endpoints ----------------
_verify_http_endpoints() {
  log "  --- HTTP endpoints ---"
  # Probe each local endpoint. 200/401/403 all imply "service responding" — only
  # 000 (connect failed) and 5xx are problems. 401/403 mean auth-protected, OK.
  local probes=(
    "http://127.0.0.1:6000/                    pinning-service"
    "http://127.0.0.1:3001/api/health          pinning-webui"
    "http://127.0.0.1:3300/                    ipfs-server"
    "http://127.0.0.1:3003/health              fula-ai-service"
    "http://127.0.0.1:4002/health              x402-gateway"
    "http://127.0.0.1:3002/health              mainnet-pool-server"
    "http://127.0.0.1:5667/health              mainnet-rewards-server"
    "http://127.0.0.1:9000/healthz             fula-api-gateway"
  )
  local entry url name code
  for entry in "${probes[@]}"; do
    read -r url name <<< "$entry"
    code=$(http_status "$url" 8)
    # Any 2xx/3xx/4xx means "TCP listener responding with HTTP" — the service is
    # up. 4xx on bare paths like `/` is normal for backends that don't define a
    # root route. Reserve fail/warn for the cases that genuinely indicate trouble:
    # 5xx (internal error) and 000 (connection refused / timeout).
    case "$code" in
      2*|3*|4*) check_pass "$name: HTTP $code" ;;
      000)      check_warn "$name: connection refused at $url" ;;
      5*)       check_fail "$name: HTTP $code at $url" ;;
      *)        check_warn "$name: unexpected HTTP $code at $url" ;;
    esac
  done

  # Kubo API uses POST, not GET — check separately
  if curl -fsS -X POST --max-time 5 http://127.0.0.1:5001/api/v0/id >/dev/null 2>&1; then
    check_pass "kubo-api responding"
  else
    check_fail "kubo-api at :5001 not responding"
  fi

  # Cluster API
  if curl -fsS --max-time 5 http://127.0.0.1:9094/id >/dev/null 2>&1; then
    check_pass "cluster-api responding"
  else
    check_warn "cluster-api at :9094 not responding"
  fi
}

# ---------------- IPFS ----------------
_verify_ipfs() {
  log "  --- ipfs (kubo) ---"
  # Peer ID match
  local actual_peer expected_peer
  actual_peer=$(docker exec "$IPFS_CONTAINER" ipfs id --format='<id>' 2>/dev/null)
  if [ -z "$actual_peer" ]; then
    check_fail "could not read kubo peer ID"
    return
  fi
  if [ -f "$BUNDLE_DIR/kubo/id.json" ]; then
    expected_peer=$(jq -r .ID < "$BUNDLE_DIR/kubo/id.json" 2>/dev/null)
    if [ "$actual_peer" = "$expected_peer" ]; then
      check_pass "kubo peer ID preserved: $actual_peer"
    else
      check_fail "kubo peer ID changed (expected $expected_peer, got $actual_peer)"
    fi
  else
    log "  (no bundle/kubo/id.json to compare against — current: $actual_peer)"
  fi

  # IPNS keys present and matching expected k51 names
  local key_listing
  key_listing=$(docker exec "$IPFS_CONTAINER" ipfs key list -l 2>/dev/null)
  if echo "$key_listing" | grep -q "^${DB_IPNS}.* fula-db-backup"; then
    check_pass "fula-db-backup IPNS key matches expected $DB_IPNS"
  else
    check_fail "fula-db-backup IPNS key missing or doesn't match $DB_IPNS"
  fi
  if echo "$key_listing" | grep -q "^${REGISTRY_IPNS}.* fula-registry"; then
    check_pass "fula-registry IPNS key matches expected $REGISTRY_IPNS"
  else
    check_fail "fula-registry IPNS key missing or doesn't match $REGISTRY_IPNS"
  fi

  # DHT bootstrap
  local peer_count
  peer_count=$(docker exec "$IPFS_CONTAINER" ipfs swarm peers 2>/dev/null | wc -l)
  if [ "$peer_count" -ge 10 ]; then
    check_pass "kubo connected to $peer_count DHT peers"
  elif [ "$peer_count" -ge 1 ]; then
    check_warn "kubo only $peer_count DHT peers (still bootstrapping?)"
  else
    check_fail "kubo has 0 DHT peers — IPNS resolve will fail"
  fi

  # IPNS resolves (registry is republished every 10min, so should converge)
  local resolved_reg
  resolved_reg=$(timeout 30 docker exec "$IPFS_CONTAINER" ipfs name resolve "/ipns/$REGISTRY_IPNS" 2>/dev/null || echo "")
  if [[ "$resolved_reg" == /ipfs/* ]]; then
    check_pass "fula-registry IPNS resolves to ${resolved_reg#/ipfs/}"
  else
    check_warn "fula-registry IPNS resolve timed out (>30s) — DHT may need more time, retry later"
  fi

  # Repo verify (sample — full verify is slow on big datasets)
  if docker exec "$IPFS_CONTAINER" ipfs repo stat >/dev/null 2>&1; then
    local repo_size num_objects
    repo_size=$(docker exec "$IPFS_CONTAINER" ipfs repo stat --human 2>/dev/null | awk '/RepoSize/{print $2}')
    num_objects=$(docker exec "$IPFS_CONTAINER" ipfs repo stat 2>/dev/null | awk '/NumObjects/{print $2}')
    check_pass "kubo repo OK: $num_objects objects, $repo_size"
  else
    check_warn "kubo repo stat failed"
  fi
}

# ---------------- IPFS Cluster ----------------
_verify_cluster() {
  log "  --- ipfs-cluster ---"
  local actual_cl expected_cl
  actual_cl=$(docker exec "$CLUSTER_CONTAINER" ipfs-cluster-ctl --enc=json id 2>/dev/null | jq -r .id 2>/dev/null || echo "")
  if [ -z "$actual_cl" ]; then
    check_fail "could not read cluster peer ID"
    return
  fi
  if [ -f "$BUNDLE_DIR/cluster/identity.json" ]; then
    expected_cl=$(jq -r .id < "$BUNDLE_DIR/cluster/identity.json" 2>/dev/null)
    if [ "$actual_cl" = "$expected_cl" ]; then
      check_pass "cluster peer ID preserved: $actual_cl"
    else
      check_fail "cluster peer ID changed (expected $expected_cl, got $actual_cl)"
    fi
  fi

  # Cluster ↔ kubo connection
  if docker exec "$CLUSTER_CONTAINER" ipfs-cluster-ctl id 2>/dev/null | grep -q "ipfs"; then
    check_pass "cluster sees IPFS daemon"
  else
    check_warn "cluster cannot see IPFS daemon — pin operations will fail"
  fi

  # Pin set count
  local pin_count
  pin_count=$(docker exec "$CLUSTER_CONTAINER" ipfs-cluster-ctl pin ls 2>/dev/null | wc -l || echo 0)
  if [ -f "$BUNDLE_DIR/cluster/pins.json" ]; then
    local expected_pins
    expected_pins=$(jq 'length' "$BUNDLE_DIR/cluster/pins.json" 2>/dev/null || echo 0)
    if [ "$pin_count" -ge "$expected_pins" ]; then
      check_pass "cluster pin set: $pin_count (expected ≥ $expected_pins)"
    else
      check_warn "cluster pin set: $pin_count (expected ≥ $expected_pins — may still be syncing)"
    fi
  else
    log "  cluster pin set: $pin_count (no baseline to compare)"
  fi
}

# ---------------- Postgres ----------------
_verify_postgres() {
  log "  --- postgres ---"
  local pg_user
  pg_user=$(env_get "$PINNING_HOME/.env" POSTGRES_USER)
  pg_user="${pg_user:-pinning_user}"

  if ! docker exec "$PG_CONTAINER" pg_isready -U "$pg_user" -d pinning_service >/dev/null 2>&1; then
    check_fail "postgres pg_isready failed for db pinning_service"
    return
  fi
  check_pass "postgres pg_isready OK"

  # Table count (should be ≥ ~20 after migrations 006-016)
  local table_count
  table_count=$(docker exec "$PG_CONTAINER" psql -U "$pg_user" -d pinning_service -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo 0)
  if [ "$table_count" -ge 15 ]; then
    check_pass "postgres has $table_count public tables"
  else
    check_fail "postgres has only $table_count public tables (expected ≥ 15)"
  fi

  # Critical tables present
  local table tables=(webui_users pins api_keys sessions blocked_cids x402_payment_logs)
  for table in "${tables[@]}"; do
    if docker exec "$PG_CONTAINER" psql -U "$pg_user" -d pinning_service -tAc \
        "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='$table'" 2>/dev/null \
        | grep -q 1; then
      local rows
      rows=$(docker exec "$PG_CONTAINER" psql -U "$pg_user" -d pinning_service -tAc \
        "SELECT count(*) FROM $table" 2>/dev/null || echo "?")
      check_pass "table $table present ($rows rows)"
    else
      check_fail "table $table MISSING"
    fi
  done

  # Migrations applied (look for the columns/tables added by migrations 006-016)
  for col in "api_keys.encrypted_key" "webui_users.encrypted_email" "webui_users.user_id" "sessions.token_hash" "api_keys.key_hash"; do
    local t c
    t="${col%.*}"; c="${col#*.}"
    if docker exec "$PG_CONTAINER" psql -U "$pg_user" -d pinning_service -tAc \
        "SELECT 1 FROM information_schema.columns WHERE table_name='$t' AND column_name='$c'" 2>/dev/null \
        | grep -q 1; then
      check_pass "migration column $col present"
    else
      check_warn "migration column $col missing (migrations 006-016 may not all be applied)"
    fi
  done

  # encrypted_email rows (proves ENCRYPTION_KEY is correct AT THE APP LEVEL — we
  # can't decrypt from here without the app's crypto path; but the rows existing
  # is necessary for login to work)
  local enc_rows
  enc_rows=$(docker exec "$PG_CONTAINER" psql -U "$pg_user" -d pinning_service -tAc \
    "SELECT count(*) FROM webui_users WHERE encrypted_email IS NOT NULL" 2>/dev/null || echo 0)
  if [ "$enc_rows" -gt 0 ]; then
    check_pass "$enc_rows webui_users have encrypted_email — verify decrypts via WebUI login"
  else
    check_warn "no rows with encrypted_email — fresh install OR migration 010 not run"
  fi
}

# ---------------- Redis ----------------
_verify_redis() {
  log "  --- redis ---"
  if redis-cli ping 2>/dev/null | grep -q PONG; then
    check_pass "redis-cli ping returns PONG"
  else
    # Redis may require password from mainnet-rewards-server.env
    local rpw
    rpw=$(env_get /opt/mainnet-rewards/.env REDIS_PASSWORD 2>/dev/null)
    if [ -n "$rpw" ] && redis-cli -a "$rpw" ping 2>/dev/null | grep -q PONG; then
      check_pass "redis-cli ping (with password) returns PONG"
    else
      check_warn "redis ping failed — services using redis (mainnet-*) may not work"
    fi
  fi
}

# ---------------- TLS / certificates ----------------
_verify_tls() {
  log "  --- TLS / certificates ---"
  if ! command -v certbot >/dev/null 2>&1; then
    check_warn "certbot not installed — skipping TLS check"
    return
  fi
  if ! [ -d /etc/letsencrypt/live ]; then
    check_warn "no /etc/letsencrypt/live — TLS not configured yet (DNS not propagated?)"
    return
  fi
  local site d cert expiry days_left
  for site in /etc/nginx/sites-enabled/*; do
    [ -f "$site" ] || continue
    d=$(grep -oP "server_name\s+\K[^ ;]+" "$site" 2>/dev/null | grep -v '^_$' | head -n1)
    [ -z "$d" ] && continue
    cert="/etc/letsencrypt/live/$d/fullchain.pem"
    if [ ! -f "$cert" ]; then
      check_warn "$d: no cert at $cert"
      continue
    fi
    expiry=$(openssl x509 -enddate -noout -in "$cert" 2>/dev/null | cut -d= -f2)
    days_left=$(( ( $(date -d "$expiry" +%s 2>/dev/null) - $(date +%s) ) / 86400 ))
    if [ "$days_left" -lt 0 ]; then
      check_fail "$d: cert EXPIRED ($((-days_left)) days ago) — cut DNS over and run 'recover.sh --phase=certs' urgently"
    elif [ "$days_left" -lt 14 ]; then
      if dns_points_here "$d"; then
        check_warn "$d: cert expires in $days_left days — certbot daily cron should renew (DNS already points here)"
      else
        check_warn "$d: cert expires in $days_left days AND DNS does not yet point here — renewal will FAIL until DNS is cutover"
      fi
    else
      check_pass "$d: cert valid ($days_left days left)"
    fi
  done

  # Test that nginx loads without complaints
  if nginx -t >/dev/null 2>&1; then
    check_pass "nginx -t passes"
  else
    check_fail "nginx -t fails — see 'nginx -t' output"
  fi
}

# ---------------- Cron ----------------
_verify_cron() {
  log "  --- cron ---"
  if systemctl is-active --quiet cron 2>/dev/null || systemctl is-active --quiet crond 2>/dev/null; then
    check_pass "cron service running"
  else
    check_fail "cron service not running"
  fi
  for cf in /etc/cron.d/fula-db-backup /etc/cron.d/fula-registry-ipns; do
    if [ -f "$cf" ]; then
      check_pass "cron file present: $cf"
    else
      check_warn "cron file missing: $cf"
    fi
  done
}

# ---------------- Backup readiness ----------------
_verify_backup_readiness() {
  log "  --- backup readiness ---"
  if [ -f /root/.fula-backup-key ]; then
    local perms
    perms=$(stat -c '%a' /root/.fula-backup-key 2>/dev/null)
    if [ "$perms" = "600" ]; then
      check_pass "/root/.fula-backup-key present with 0600"
    else
      check_warn "/root/.fula-backup-key has perms $perms (expected 600)"
    fi
    # Source-only test the file syntax
    if grep -qE '^BACKUP_ENCRYPTION_KEY=[0-9a-f]{64}$' /root/.fula-backup-key; then
      check_pass "BACKUP_ENCRYPTION_KEY format valid in /root/.fula-backup-key"
    else
      check_warn "BACKUP_ENCRYPTION_KEY in /root/.fula-backup-key not 64-hex-char"
    fi
  else
    check_warn "/root/.fula-backup-key missing — daily backup cron will fail until created"
  fi

  # Verify the backup-db.sh script exists and is executable
  local backup_script="$PINNING_REPO/scripts/backup-db.sh"
  if [ -x "$backup_script" ] || [ -f "$backup_script" ]; then
    check_pass "backup-db.sh present at $backup_script"
  else
    check_warn "backup-db.sh missing at $backup_script"
  fi
}

# ---------------- Disk + resources ----------------
_verify_disk_resources() {
  log "  --- disk + resources ---"
  local mount usage_pct
  for mount in / /home /var/lib/docker; do
    [ -d "$mount" ] || continue
    usage_pct=$(df -P "$mount" 2>/dev/null | awk 'NR==2 {gsub("%",""); print $5}')
    [ -z "$usage_pct" ] && continue
    if [ "$usage_pct" -ge 90 ]; then
      check_fail "$mount: ${usage_pct}% full"
    elif [ "$usage_pct" -ge 80 ]; then
      check_warn "$mount: ${usage_pct}% full"
    else
      check_pass "$mount: ${usage_pct}% used"
    fi
  done

  # Kubo data path specifically
  if [ -n "$KUBO_DATA_HOST_PATH" ] && [ -d "$KUBO_DATA_HOST_PATH" ]; then
    usage_pct=$(df -P "$KUBO_DATA_HOST_PATH" | awk 'NR==2 {gsub("%",""); print $5}')
    if [ "$usage_pct" -ge 85 ]; then
      check_warn "kubo data path $KUBO_DATA_HOST_PATH: ${usage_pct}% full — pin growth will hit ceiling soon"
    else
      check_pass "kubo data path $KUBO_DATA_HOST_PATH: ${usage_pct}% used"
    fi
  fi

  # Memory pressure
  local swap_used_mb
  swap_used_mb=$(free -m 2>/dev/null | awk '/Swap:/ {print $3}')
  if [ -n "$swap_used_mb" ] && [ "$swap_used_mb" -gt 1024 ]; then
    check_warn "swap usage: ${swap_used_mb}MB (memory pressure)"
  fi
}

# ---------------- Negative exposure checks ----------------
# Confirm that ports we expect to be private are actually NOT reachable from the
# public internet. We can't actually test from outside here, but we can verify:
#  (a) listener is bound to 127.0.0.1 only (already done in _verify_network_listeners)
#  (b) UFW rules deny the port externally
_verify_negative_exposure() {
  log "  --- negative exposure (private ports stay private) ---"
  if ! command -v ufw >/dev/null 2>&1; then
    check_warn "ufw not installed — cannot verify firewall denies"
    return
  fi
  local ufw_status
  ufw_status=$(ufw status 2>/dev/null || echo "")
  if echo "$ufw_status" | grep -q "Status: active"; then
    check_pass "ufw is active"
  else
    check_fail "ufw is NOT active — internal ports may be exposed despite localhost binding"
  fi
  for port in 5432 5001 9094 9095; do
    if echo "$ufw_status" | grep -qE "^${port}/tcp\s+DENY"; then
      check_pass "ufw denies tcp/$port (defense in depth)"
    else
      check_warn "ufw does not explicitly deny tcp/$port — relies on 127.0.0.1 binding only"
    fi
  done

  # LAN-isolation verification — only relevant on private/home LANs. Cloud
  # servers / public-IP setups skip this check entirely.
  local gateway
  gateway=$(ip -4 route get 8.8.8.8 2>/dev/null | awk 'NR==1 {print $3}')
  if [ -n "$gateway" ] && python3 -c "
import ipaddress, sys
sys.exit(0 if ipaddress.ip_address('$gateway').is_private else 1)
" 2>/dev/null; then
    if $NO_LAN_ISOLATION; then
      check_warn "LAN isolation explicitly disabled (--no-lan-isolation) — server can pivot to other home devices on the same subnet"
    else
      # The deny rule's comment is stored in /etc/ufw/user.rules (UFW
      # `status` doesn't print comments, but the underlying rule file does).
      if grep -q 'recover.sh: lan-iso block' /etc/ufw/user.rules 2>/dev/null; then
        check_pass "outbound LAN-isolation rule active (server cannot pivot to home devices on $gateway's subnet)"
      else
        check_warn "outbound LAN-isolation rule NOT active — re-run phase_apply_ufw or pass --no-lan-isolation explicitly if intentional"
      fi
    fi
  fi
  # else: gateway is public (cloud VPS) — LAN isolation not applicable
}

# ============================================================================
# PHASE 28 (optional) — prewarm cluster pins
# ============================================================================
phase_prewarm_cluster_pins() {
  log_phase "28. prewarm_cluster_pins"
  if ! $PREWARM_CLUSTER; then
    log "  skipped (no --prewarm-cluster)"
    mark_phase_done prewarm_cluster_pins
    return
  fi
  local pg_user
  pg_user=$(env_get "$PINNING_HOME/.env" POSTGRES_USER)
  pg_user="${pg_user:-pinning_user}"
  local n=0
  docker exec "$PG_CONTAINER" psql -U "$pg_user" -d pinning_service -tAc \
    "SELECT cid FROM pins WHERE status='pinned'" 2>/dev/null | \
  while read -r cid; do
    [ -z "$cid" ] && continue
    curl -fsS -X POST "http://127.0.0.1:9094/pins/${cid}" -o /dev/null 2>/dev/null && n=$((n+1)) || true
  done
  log "  pre-warmed pins: $n"
  mark_phase_done prewarm_cluster_pins
}

# ============================================================================
# PHASE 29 — postinstall checklist
# ============================================================================
phase_postinstall_checklist() {
  log_phase "29. postinstall_checklist"
  local me
  me=$(my_public_ip)
  cat <<EOF

============================================================
  Recovery complete. Manual checklist:
============================================================
EOF

  if $DEFER_DNS; then
    cat <<EOF
  -- DEFERRED-DNS WORKFLOW --
  DNS still points at the old server. To validate this server BEFORE cutover:
    1. On a test machine (your laptop), edit /etc/hosts (or C:\\Windows\\System32\\drivers\\etc\\hosts):
         ${me:-<this-server-ip>}  api.cloud.fx.land cloud.fx.land ipfs.cloud.fx.land api1.cloud.fx.land
         ${me:-<this-server-ip>}  pools.fx.land rewards.1.pools.fula.network x402.api.cloud.fx.land
       (add any additional hosts from /etc/nginx/sites-enabled/)
    2. Open https://cloud.fx.land/ in a browser. The TLS cert from the old
       server is presented (because we restored /etc/letsencrypt). The app
       runs against the new server's services.
    3. Run end-to-end tests (login, pin a CID, etc.).
    4. Remove the /etc/hosts entries.
    5. Cut DNS A records over to ${me:-this-server}.
    6. On THIS server, finalize cert handling:
         bash $0 --phase=certs <same flags as your original invocation, MINUS --defer-dns>
       This replaces any near-expiry certs and ensures certbot's daily renew
       cron will work going forward.
EOF
  else
    cat <<EOF
  1. Confirm DNS A records point at this server:
       for d in \$(ls /etc/nginx/sites-enabled/); do
         echo "\$d -> \$(dig +short \$d | tr '\n' ' ')"
       done
EOF
  fi

  cat <<EOF

  2. Open the WebUI in a browser and log in via Google.
     If login succeeds, ENCRYPTION_KEY is correct and
     encrypted_email round-trips.

  3. Trigger a backup smoke test:
       . /root/.fula-backup-key && \\
         /opt/pinning-service/scripts/backup-db.sh

  4. Pin round-trip test:
       curl -X POST https://api.cloud.fx.land/pins \\
         -H "Authorization: Bearer <test-key>" \\
         -d '{"cid":"bafy..."}'
     CID should appear in:
       docker exec ipfs_cluster ipfs-cluster-ctl pin ls

  5. Verify cron is scheduled:
       cat /etc/cron.d/fula-db-backup
       cat /etc/cron.d/fula-registry-ipns
     ${DEFER_DNS:+   NOTE: certbot daily renew will fail silently until DNS cutover.}

  6. Once new server is verified, decommission the old server:
       - Stop services: systemctl stop fula-* x402-* mainnet-*
       - Confirm new server has been processing live traffic for 24+ hours
       - Backup old server's /etc/letsencrypt one more time as belt-and-suspenders
       - Power off / reclaim

  7. Recovery log: $LOG_FILE
============================================================
EOF
  mark_phase_done postinstall_checklist
}

# ============================================================================
# Phase dispatcher
# ============================================================================
PHASE_ORDER=(
  preflight
  apt
  clone
  apply_system_state
  apply_env_files
  docker_volumes
  load_fula_image
  docker_infra_start
  pg_restore
  verify_ipns_path
  apply_kubo_keys
  resolve_registry_cid
  ipfs_repo_verify
  build_pinning_core
  build_subservices
  install_fula_api
  build_mainnet_rewards
  build_mainnet_pool
  build_libp2p_service
  apply_systemd_units
  apply_nginx
  apply_cron
  apply_ufw
  dns_cutover_pause
  certs
  start
  post_verify
  prewarm_cluster_pins
  postinstall_checklist
)

run_phase() {
  local p="$1"
  local force_rerun="${2:-false}"
  local fn="phase_${p}"
  if ! declare -F "$fn" >/dev/null; then
    fatal "unknown phase: $p"
  fi
  if phase_completed "$p" && ! $force_rerun; then
    log "phase $p already completed (state file exists) — skipping. Delete $STATE_DIR/${p}.done to force re-run."
    return 0
  fi
  # When --phase=NAME is invoked explicitly OR when force_rerun is set, clear
  # the checkpoint so the phase actually runs again. This matters for phases
  # that re-derive state (pg_restore, docker_volumes, apply_nginx, certs).
  rm -f "$STATE_DIR/${p}.done"
  "$fn"
}

if $FINALIZE_CUTOVER; then
  log_phase "FINALIZE-CUTOVER — re-validate collision is gone, activate deferred crons, run IPNS verify"

  # Sanity: kubo must be up locally
  docker exec "$IPFS_CONTAINER" ipfs id >/dev/null 2>&1 \
    || fatal "kubo container ($IPFS_CONTAINER) is not running — start it before --finalize-cutover"

  # Re-check the DHT for collision. If the old server's kubo is truly off, we
  # should see only our local addresses returned (or nothing at all if the DHT
  # hasn't propagated our announce yet).
  local actual local_addrs found_addrs other_addrs
  actual=$(docker exec "$IPFS_CONTAINER" ipfs id --format='<id>' 2>/dev/null)
  local_addrs=$(docker exec "$IPFS_CONTAINER" ipfs id --format='<addrs>' 2>/dev/null | tr ',' '\n' | sort -u)
  log "  re-checking DHT for peer-ID collision..."
  found_addrs=$(timeout 30 docker exec "$IPFS_CONTAINER" ipfs routing findpeer "$actual" 2>/dev/null | sort -u || true)
  if [ -n "$found_addrs" ]; then
    other_addrs=$(comm -23 <(echo "$found_addrs") <(echo "$local_addrs") | grep -E '^/(dns|ip4|ip6)' || true)
    if [ -n "$other_addrs" ]; then
      log "  WARN: collision still detected. Other addresses for peer ID $actual:"
      echo "$other_addrs" | sed 's/^/    /' | tee -a "$LOG_FILE"
      log "  The old server may not have stopped its kubo cleanly, or DHT records are still propagating."
      log "  You can force activation anyway with FORCE_FINALIZE=true bash $0 --finalize-cutover ..."
      [ "${FORCE_FINALIZE:-false}" = "true" ] || fatal "refusing to finalize while collision is still active (set FORCE_FINALIZE=true to override)"
      log "  FORCE_FINALIZE=true — proceeding despite still-active collision"
    else
      log "  collision cleared — DHT returns only this node's addresses"
    fi
  else
    log "  DHT findpeer empty — fresh routing state; assuming collision cleared"
  fi

  # Activate any staged crons
  if [ -d "$DEFERRED_CRON_DIR" ] && [ -n "$(ls -A "$DEFERRED_CRON_DIR" 2>/dev/null)" ]; then
    log "  activating staged crons from $DEFERRED_CRON_DIR → /etc/cron.d/"
    for f in "$DEFERRED_CRON_DIR"/*; do
      [ -f "$f" ] || continue
      cp "$f" "/etc/cron.d/$(basename "$f")"
      chmod 644 "/etc/cron.d/$(basename "$f")"
      log "    activated: $(basename "$f")"
    done
    rm -rf "$DEFERRED_CRON_DIR"
  else
    log "  no staged crons to activate (already activated, or recovery wasn't run in parallel-run mode)"
  fi

  # Run phase 10 fresh (forcibly disable parallel-run gating)
  PARALLEL_RUN_MODE=false
  SKIP_IPNS_VERIFY=false
  rm -f "$STATE_DIR/verify_ipns_path.done"
  phase_verify_ipns_path

  # Re-run post_verify for a fresh end-state report
  rm -f "$STATE_DIR/post_verify.done"
  phase_post_verify

  if [ "$FAIL_COUNT" -gt 0 ]; then
    print_summary "FINALIZE COMPLETED WITH FAILURES"
    exit 2
  elif [ "$WARN_COUNT" -gt 0 ]; then
    print_summary "FINALIZE OK with warnings"
    exit 0
  else
    print_summary "FINALIZE ALL GREEN"
    exit 0
  fi
fi

if [ -n "$SINGLE_PHASE" ]; then
  run_phase "$SINGLE_PHASE" true
else
  for p in "${PHASE_ORDER[@]}"; do
    run_phase "$p"
  done
fi

# Decide overall status from check counters
if [ "$FAIL_COUNT" -gt 0 ]; then
  print_summary "COMPLETED WITH FAILURES (verify before going live)"
  exit 2
elif [ "$WARN_COUNT" -gt 0 ]; then
  print_summary "OK with warnings"
  exit 0
else
  print_summary "ALL GREEN"
  exit 0
fi
