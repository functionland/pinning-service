#!/usr/bin/env bash
# Phase 3.2 master-side setup for the Fula users-index publisher.
#
# Runs on the **cluster master** — the single server hosting all
# three repos: fula-api (gateway), pinning-service (Go pinner +
# webui + ipfs-server), and mainnet-rewards-server (rewards + chain
# submitter). Edge nodes (fxblox / cluster followers) are deployed
# from the separate fula-ota repo and are not touched here.
#
# Production layout on the master, verified against deploy/install:
#
#   fula-api (gateway):
#     source       ~/fula-api/  →  rsync to  /opt/fula-api/
#     compose      /etc/fula/docker-compose.yml
#     env-file     /etc/fula/.env   (compose's `env_file: .env`)
#     state mount  /var/lib/fula-gateway/   (host == container path)
#     service      systemctl restart fula-gateway
#
#   pinning-service:  /home/root/pinning-service/  (untouched here)
#
#   mainnet-rewards-server (chain-anchor cron lives inside this app):
#     install dir  /opt/mainnet-rewards/
#     env-file     /opt/mainnet-rewards/.env  (mode 600, mainnet-rewards:mainnet-rewards)
#     pm2 cfg      /opt/mainnet-rewards/ecosystem.config.js
#     service      systemctl restart mainnet-rewards-server  (systemd wraps pm2)
#
# What this script does, in one pass on the same host:
#   1. Verify ipfs_host kubo container is running + ≥ v0.5.
#   2. Generate-or-reuse IPNS key under the configured name on ipfs_host.
#   3. Generate-or-reuse a 32-byte hex bearer token.
#   4. Upsert FULA_USERS_INDEX_* env vars into /etc/fula/.env
#      (gateway-side: publisher knobs + the bearer token validator).
#   5. If /opt/mainnet-rewards/.env exists, upsert the chain-anchor
#      cron's vars into it (FULA_USERS_INDEX_ANCHOR_ENABLED + the
#      SAME bearer token + localhost URL since same host).
#   6. Preserve mode + ownership on both .env files.
#   7. Ensure /var/lib/fula-gateway/ exists.
#   8. Restart fula-gateway AND mainnet-rewards-server (unless --no-restart).
#
# Idempotent: re-running with the same args reuses the existing IPNS
# key + token and re-upserts the same env values into both files.
#
# Usage:
#   sudo ./setup-users-index-publisher.sh
#   sudo ./setup-users-index-publisher.sh --token <hex>     # supply your own token
#   sudo ./setup-users-index-publisher.sh --no-restart      # skip both restarts
#   sudo ./setup-users-index-publisher.sh --skip-version-check
#   sudo ./setup-users-index-publisher.sh --no-rewards-env  # skip the rewards-side upsert

set -euo pipefail

# ----- defaults (the master's actual paths, verified by code) -----

ENV_FILE_DEFAULT="/etc/fula/.env"
STATE_DIR_DEFAULT="/var/lib/fula-gateway"
KUBO_CONTAINER_DEFAULT="ipfs_host"
IPNS_KEY_NAME_DEFAULT="fula-users-index"
SYSTEMD_UNIT_DEFAULT="fula-gateway"
FLUSH_INTERVAL_DEFAULT=300

# Rewards-server defaults (chain-anchor cron lives in this app on the
# same master). Empty string in REWARDS_ENV_FILE_DEFAULT means "skip
# this side"; we auto-detect by file existence.
REWARDS_ENV_FILE_DEFAULT="/opt/mainnet-rewards/.env"
REWARDS_SYSTEMD_UNIT_DEFAULT="mainnet-rewards-server"
REWARDS_FETCH_TIMEOUT_DEFAULT=15000
REWARDS_CRON_DEFAULT='0 */12 * * *'

RESTART=1
TOKEN=""
SKIP_VERSION_CHECK=0
NO_REWARDS_ENV=0

# ----- arg parsing -----

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)               ENV_FILE_DEFAULT="$2";        shift 2 ;;
    --state-dir)              STATE_DIR_DEFAULT="$2";       shift 2 ;;
    --kubo-container)         KUBO_CONTAINER_DEFAULT="$2";  shift 2 ;;
    --key-name)               IPNS_KEY_NAME_DEFAULT="$2";   shift 2 ;;
    --systemd-unit)           SYSTEMD_UNIT_DEFAULT="$2";    shift 2 ;;
    --flush-interval)         FLUSH_INTERVAL_DEFAULT="$2";  shift 2 ;;
    --token)                  TOKEN="$2";                   shift 2 ;;
    --no-restart)             RESTART=0;                    shift   ;;
    --skip-version-check)     SKIP_VERSION_CHECK=1;         shift   ;;
    --no-rewards-env)         NO_REWARDS_ENV=1;             shift   ;;
    --rewards-env-file)       REWARDS_ENV_FILE_DEFAULT="$2"; shift 2 ;;
    --rewards-systemd-unit)   REWARDS_SYSTEMD_UNIT_DEFAULT="$2"; shift 2 ;;
    -h|--help)
      grep '^# ' "$0" | sed 's/^# //'
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

ENV_FILE="$ENV_FILE_DEFAULT"
STATE_DIR="$STATE_DIR_DEFAULT"
KUBO_CONTAINER="$KUBO_CONTAINER_DEFAULT"
IPNS_KEY_NAME="$IPNS_KEY_NAME_DEFAULT"
SYSTEMD_UNIT="$SYSTEMD_UNIT_DEFAULT"
FLUSH_INTERVAL="$FLUSH_INTERVAL_DEFAULT"
REWARDS_ENV_FILE="$REWARDS_ENV_FILE_DEFAULT"
REWARDS_SYSTEMD_UNIT="$REWARDS_SYSTEMD_UNIT_DEFAULT"
REWARDS_FETCH_TIMEOUT="$REWARDS_FETCH_TIMEOUT_DEFAULT"
REWARDS_CRON="$REWARDS_CRON_DEFAULT"

# ----- helpers -----

log() { printf '[setup-users-index] %s\n' "$*"; }
err() { printf '[setup-users-index] ERROR: %s\n' "$*" >&2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { err "required command not found: $1"; exit 1; }
}

require_cmd docker
require_cmd jq
require_cmd openssl
require_cmd grep
require_cmd sed

# Must run as root: writing to /etc/fula/.env, /var/lib/fula-gateway/,
# and `systemctl restart` all require it.
if [[ $EUID -ne 0 ]]; then
  err "must run as root (writes to ${ENV_FILE} and runs systemctl)"
  err "  sudo $0 $*"
  exit 1
fi

# Upsert a KEY=VALUE line in an env-file. Preserves every other line.
# Atomic via tempfile + mv. Creates the file if absent.
upsert_env_var() {
  local file="$1" key="$2" value="$3"
  local parent
  parent="$(dirname "$file")"
  mkdir -p "$parent"

  local tmp
  tmp="$(mktemp "${file}.XXXXXX")"

  if [[ -f "$file" ]]; then
    # Filter out any existing lines for this key (line-anchored, not
    # substring — `^KEY=`). Append new value at end.
    grep -v -E "^${key}=" "$file" > "$tmp" || true
  else
    : > "$tmp"
  fi
  printf '%s=%s\n' "$key" "$value" >> "$tmp"

  # Preserve mode AND ownership if the file already exists; otherwise
  # lock to 600 owned by the invoking user (root, since the script
  # requires it). On master deployments the existing /etc/fula/.env
  # is typically `fula:fula` mode 640 — clobbering ownership would
  # signal a config tamper to anyone auditing the file later.
  if [[ -f "$file" ]]; then
    chmod --reference="$file" "$tmp" 2>/dev/null || chmod 600 "$tmp"
    chown --reference="$file" "$tmp" 2>/dev/null || true
  else
    chmod 600 "$tmp"
  fi
  mv "$tmp" "$file"
}

# Look up an existing env var's value in an env-file (returns empty
# string if absent or file missing).
lookup_env_var() {
  local file="$1" key="$2"
  if [[ ! -f "$file" ]]; then
    printf ''
    return 0
  fi
  # Last occurrence wins (mirrors how docker-compose loads .env).
  grep -E "^${key}=" "$file" | tail -n1 | cut -d= -f2- || true
}

# ----- 1. ensure kubo container is running -----

if ! docker ps --format '{{.Names}}' | grep -q "^${KUBO_CONTAINER}$"; then
  err "kubo container '${KUBO_CONTAINER}' is not running."
  err "  docker ps --format '{{.Names}}' to verify."
  err "  override with: --kubo-container <name>"
  exit 1
fi
log "kubo container '${KUBO_CONTAINER}' is running"

# ----- 2. probe kubo version (≥ v0.5 needed for --enc=json) -----

if [[ "$SKIP_VERSION_CHECK" == "0" ]]; then
  KUBO_VERSION_JSON=$(docker exec "$KUBO_CONTAINER" ipfs version --enc=json 2>/dev/null || true)
  if [[ -z "$KUBO_VERSION_JSON" ]]; then
    err "could not run 'ipfs version --enc=json' in '${KUBO_CONTAINER}'"
    err "  Need kubo >= 0.5 for structured key-list output."
    err "  Re-run with --skip-version-check to bypass."
    exit 1
  fi
  KUBO_VERSION=$(printf '%s' "$KUBO_VERSION_JSON" | jq -er '.Version' 2>/dev/null || echo "")
  if [[ -n "$KUBO_VERSION" ]]; then
    log "kubo version: $KUBO_VERSION"
    if [[ "$KUBO_VERSION" =~ ^0\.([0-4])\. ]]; then
      err "kubo $KUBO_VERSION is too old; require >= 0.5 (released Apr 2020)"
      exit 1
    fi
  fi
else
  log "skipping kubo version probe (--skip-version-check)"
fi

# ----- 3. generate or reuse IPNS key -----

KEY_LIST_JSON=$(docker exec "$KUBO_CONTAINER" ipfs key list -l --enc=json 2>/dev/null || true)
if [[ -z "$KEY_LIST_JSON" ]]; then
  err "failed to read 'ipfs key list -l --enc=json' from container '${KUBO_CONTAINER}'"
  exit 1
fi

if IPNS_NAME=$(printf '%s' "$KEY_LIST_JSON" | jq -er --arg n "$IPNS_KEY_NAME" '.Keys[] | select(.Name==$n) | .Id'); then
  log "IPNS key '${IPNS_KEY_NAME}' already exists; reusing (id=${IPNS_NAME})"
else
  log "generating IPNS key '${IPNS_KEY_NAME}'..."
  if ! IPNS_NAME=$(docker exec "$KUBO_CONTAINER" ipfs key gen --type=ed25519 "$IPNS_KEY_NAME" 2>&1); then
    err "ipfs key gen failed: $IPNS_NAME"
    err "  (if the key already exists at this point, re-run this script — the existence check above will succeed next time)"
    exit 1
  fi
  log "generated IPNS key '${IPNS_KEY_NAME}' = ${IPNS_NAME}"
fi

if [[ -z "$IPNS_NAME" ]]; then
  err "failed to obtain IPNS NAME (libp2p key hash) for key '${IPNS_KEY_NAME}'"
  exit 1
fi

# ----- 4. token: reuse from /etc/fula/.env if present -----

if [[ -z "$TOKEN" ]]; then
  EXISTING_TOKEN="$(lookup_env_var "$ENV_FILE" "FULA_USERS_INDEX_INTERNAL_TOKEN")"
  if [[ -n "$EXISTING_TOKEN" ]]; then
    TOKEN="$EXISTING_TOKEN"
    log "reusing existing FULA_USERS_INDEX_INTERNAL_TOKEN from ${ENV_FILE}"
  else
    TOKEN=$(openssl rand -hex 32)
    log "generated new internal bearer token (32 bytes hex)"
  fi
else
  log "using internal token supplied via --token"
fi

# ----- 5. ensure state dir exists -----
#
# /var/lib/fula-gateway is the host side of the volume mount declared
# in fula-api/docker-compose.yml line 17. The fula-gateway container
# runs as root and writes into /var/lib/fula-gateway/ — which appears
# as the same path on the host. The state file `users_index_state.txt`
# will be created by the publisher on first tick; this script just
# guarantees the parent directory exists.
#
# The directory already exists in production (it holds `registry.cid`
# from BucketManager and `db-backup.cid` from the daily backup cron).
# We must NOT change ownership or permissions on an existing dir —
# clobbering them could lock out the backup cron or break Docker's
# bind-mount semantics. Only mkdir+chmod when creating.

if [[ -d "$STATE_DIR" ]]; then
  log "state dir already exists: ${STATE_DIR} (preserving existing ownership + mode)"
else
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  log "created state dir: ${STATE_DIR} (mode 700)"
fi

# ----- 6. upsert env vars into /etc/fula/.env -----
#
# Each call preserves every other line in the file. A re-run updates
# in place rather than appending duplicates. The compose at
# /etc/fula/docker-compose.yml already references this file via
# `env_file: .env` (relative to its own dir) — no compose edit needed.

STATE_FILE_PATH="${STATE_DIR}/users_index_state.txt"

upsert_env_var "$ENV_FILE" "FULA_USERS_INDEX_PUBLISHER_ENABLED"     "1"
upsert_env_var "$ENV_FILE" "FULA_USERS_INDEX_STATE_PATH"            "$STATE_FILE_PATH"
upsert_env_var "$ENV_FILE" "FULA_USERS_INDEX_FLUSH_INTERVAL_SECS"   "$FLUSH_INTERVAL"
upsert_env_var "$ENV_FILE" "FULA_USERS_INDEX_IPNS_KEY_NAME"         "$IPNS_KEY_NAME"
upsert_env_var "$ENV_FILE" "FULA_USERS_INDEX_IPNS_LIFETIME_SECS"    "129600"
upsert_env_var "$ENV_FILE" "FULA_USERS_INDEX_IPNS_TTL_SECS"         "900"
upsert_env_var "$ENV_FILE" "FULA_USERS_INDEX_FIRST_PUBLISH_PINS_PER_S" "100"
upsert_env_var "$ENV_FILE" "FULA_USERS_INDEX_INTERNAL_TOKEN"        "$TOKEN"

# Phase 1.2 dependency — the publisher relies on the bucket-lookup-h
# header consumption. Flip if not already on. (No-op if already 1.)
if [[ "$(lookup_env_var "$ENV_FILE" "FULA_BUCKET_LOOKUP_H_ENABLED")" != "1" ]]; then
  upsert_env_var "$ENV_FILE" "FULA_BUCKET_LOOKUP_H_ENABLED" "1"
  log "set FULA_BUCKET_LOOKUP_H_ENABLED=1 (Phase 1.2 dependency)"
fi

log "upserted FULA_USERS_INDEX_* into ${ENV_FILE}"

# ----- 6b. upsert rewards-side env vars (chain-anchor cron) -----
#
# The chain-anchor cron lives inside the mainnet-rewards-server Node
# app (same host as fula-gateway). It reads `/opt/mainnet-rewards/.env`
# and authenticates to fula-gateway with the SAME bearer token
# generated above. Since both services run on the same host, the
# fetch URL is just localhost:9000 — no inter-host networking needed.
#
# We auto-skip when:
#   - The operator passes --no-rewards-env, OR
#   - /opt/mainnet-rewards/.env does not exist (rewards-server not
#     installed yet on this host).
#
# The contract address (FULA_USERS_INDEX_ANCHOR_BASE / SKALE) is
# operator-supplied AFTER deploying FulaUsersIndexAnchor.sol — the
# script does NOT auto-write it, since "wrong address gets zero on-
# chain submissions" is the wrong failure mode. We print the
# placeholder in the next-steps so the operator fills it in by hand.

REWARDS_TOUCHED=0
if [[ "$NO_REWARDS_ENV" == "1" ]]; then
  log "skipping rewards-side env upsert (--no-rewards-env)"
elif [[ ! -f "$REWARDS_ENV_FILE" ]]; then
  log "rewards-side env file not found: ${REWARDS_ENV_FILE}"
  log "  (mainnet-rewards-server not installed on this host? skipping that side)"
else
  upsert_env_var "$REWARDS_ENV_FILE" "FULA_USERS_INDEX_ANCHOR_ENABLED"  "true"
  upsert_env_var "$REWARDS_ENV_FILE" "FULA_USERS_INDEX_FULA_CLI_URL"    "http://127.0.0.1:9000"
  upsert_env_var "$REWARDS_ENV_FILE" "FULA_USERS_INDEX_INTERNAL_TOKEN"  "$TOKEN"
  upsert_env_var "$REWARDS_ENV_FILE" "FULA_USERS_INDEX_FETCH_TIMEOUT_MS" "$REWARDS_FETCH_TIMEOUT"
  upsert_env_var "$REWARDS_ENV_FILE" "FULA_USERS_INDEX_ANCHOR_CRON"     "$REWARDS_CRON"
  log "upserted FULA_USERS_INDEX_* into ${REWARDS_ENV_FILE}"
  log "  (FULA_USERS_INDEX_ANCHOR_BASE / SKALE NOT auto-set — operator supplies after contract deploy)"
  REWARDS_TOUCHED=1
fi

# ----- 7. summary + next steps -----

cat <<EOF

================================================================
✅ users-index publisher master-side setup complete.

  IPNS key name:        ${IPNS_KEY_NAME}
  IPNS NAME (id):       ${IPNS_NAME}
  Gateway env file:     ${ENV_FILE}
  Gateway state path:   ${STATE_FILE_PATH}
EOF

if [[ "$REWARDS_TOUCHED" == "1" ]]; then
  cat <<EOF
  Rewards env file:     ${REWARDS_ENV_FILE}    (chain-anchor cron, same host)
EOF
fi

cat <<EOF

NEXT STEPS:

  1. Verify fula-gateway is serving the publisher endpoints:
       TOKEN=\$(grep '^FULA_USERS_INDEX_INTERNAL_TOKEN=' ${ENV_FILE} | cut -d= -f2-)
       curl -sH "Authorization: Bearer \$TOKEN" \\
            http://127.0.0.1:9000/_internal/users-index-state | jq

     Expect 200 with a JSON body. The 'cid' is null until the first
     publisher tick fires (after ${FLUSH_INTERVAL}s).

EOF

if [[ "$REWARDS_TOUCHED" == "1" ]]; then
  cat <<EOF
  2. Deploy fula-chain's FulaUsersIndexAnchor.sol (see
     fula-chain/scripts/deployFulaUsersIndexAnchor.ts), then grant
     CONTRACT_OPERATOR_ROLE to the master operator wallet via the
     standard governance proposal flow (24h timelock + 24h
     execution delay).

  3. After the contract is deployed, append the address to
     ${REWARDS_ENV_FILE}:
       FULA_USERS_INDEX_ANCHOR_BASE=<deployed_proxy_address>
       # (or FULA_USERS_INDEX_ANCHOR_SKALE=... if you deployed there)
     Then: systemctl restart ${REWARDS_SYSTEMD_UNIT}

     The cron will start submitting on its 12h cadence. Tail the
     log to confirm:
       journalctl -u ${REWARDS_SYSTEMD_UNIT} -f | grep users-index

  4. Add to fula-client SDK build-time config (apps that ship with
     cold-start support):
         users_index_ipns_name:      ${IPNS_NAME}
         users_index_anchor_address: <deployed_proxy_address>
         users_index_chain_rpc_url:  <chain RPC URL — Base or SKALE>
         users_index_user_key:       <derive_user_key_from_email(user.email) at sign-in>
EOF
else
  cat <<EOF
  2. Rewards-side env was NOT updated. To finish the chain channel:
     either install mainnet-rewards-server first, or run this script
     again on the host where /opt/mainnet-rewards/.env lives. The
     SAME token must end up in both env files.

  3. Then deploy FulaUsersIndexAnchor.sol + grant CONTRACT_OPERATOR_ROLE
     to the operator wallet, append the contract address to
     mainnet-rewards' env, and restart it.

  4. Add to fula-client SDK build-time config:
         users_index_ipns_name:      ${IPNS_NAME}
         users_index_anchor_address: <deployed_proxy_address>
         users_index_chain_rpc_url:  <chain RPC URL>
         users_index_user_key:       <derive_user_key_from_email(user.email) at sign-in>
EOF
fi

cat <<EOF
================================================================
EOF

# ----- 8. optional restart -----

if [[ "$RESTART" == "1" ]]; then
  log "restarting systemd unit ${SYSTEMD_UNIT}..."
  systemctl restart "$SYSTEMD_UNIT"
  sleep 2
  if systemctl is-active --quiet "$SYSTEMD_UNIT"; then
    log "${SYSTEMD_UNIT} is active"
  else
    err "${SYSTEMD_UNIT} did not come up cleanly"
    err "  journalctl -u ${SYSTEMD_UNIT} -n 50 --no-pager"
    exit 1
  fi

  # Restart rewards-server too if we touched its env. Skipped when
  # the env file wasn't there (mainnet-rewards not installed) or
  # --no-rewards-env was set, OR if the rewards systemd unit doesn't
  # exist (defensive: don't kill systemd with a bogus unit name).
  if [[ "$REWARDS_TOUCHED" == "1" ]]; then
    if systemctl list-unit-files "${REWARDS_SYSTEMD_UNIT}.service" >/dev/null 2>&1 \
       && systemctl is-enabled "$REWARDS_SYSTEMD_UNIT" >/dev/null 2>&1; then
      log "restarting systemd unit ${REWARDS_SYSTEMD_UNIT}..."
      systemctl restart "$REWARDS_SYSTEMD_UNIT"
      sleep 2
      if systemctl is-active --quiet "$REWARDS_SYSTEMD_UNIT"; then
        log "${REWARDS_SYSTEMD_UNIT} is active"
      else
        err "${REWARDS_SYSTEMD_UNIT} did not come up cleanly"
        err "  journalctl -u ${REWARDS_SYSTEMD_UNIT} -n 50 --no-pager"
        # Don't exit — fula-gateway is up; rewards-server failure is
        # surfacable but non-fatal for the master's S3 path.
      fi
    else
      log "rewards systemd unit ${REWARDS_SYSTEMD_UNIT} not found / not enabled"
      log "  env was upserted but the service was NOT restarted."
      log "  to activate manually: systemctl restart ${REWARDS_SYSTEMD_UNIT}"
    fi
  fi
else
  log "skipping restart (--no-restart). To activate:"
  log "  systemctl restart ${SYSTEMD_UNIT}"
  if [[ "$REWARDS_TOUCHED" == "1" ]]; then
    log "  systemctl restart ${REWARDS_SYSTEMD_UNIT}"
  fi
fi

log "done."
