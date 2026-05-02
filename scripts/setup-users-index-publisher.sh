#!/usr/bin/env bash
# Phase 3.2 master-side setup for the Fula users-index publisher.
#
# This script runs on the **master server** (the ipfs-cluster *leader*
# node, alongside pinning-service / pinning-webui / fula-gateway).
# It does NOT run on fxblox edge devices — those are ipfs-cluster
# follower nodes and never publish the users-index. fxblox-side
# tooling lives in the `fula-ota` repo; this script lives here in
# `pinning-service/scripts/` because it operates on the master stack.
#
# What it does:
#   1. Probes the master kubo container for version (must be >= 0.5
#      for the JSON-encoded key-list output we depend on).
#   2. Generates an IPNS key on the master kubo container (idempotent —
#      reuses an existing key with the same name).
#   3. Generates a bearer token for the gateway's `/_internal/*` HTTP
#      endpoints, OR reuses the existing one from the env-file.
#   4. Ensures the on-disk state file directory exists.
#   5. Writes an env-file fragment the operator can `env_file:` into
#      the fula-gateway compose service.
#
# Idempotent: re-running this script with the same args reuses the
# existing IPNS key (via `ipfs key list -l --enc=json`) and preserves
# the existing token if one is already on disk.
#
# Run on the master, as the user that owns the pinning-service deploy
# (usually the same user that runs `docker compose up`).
#
# Usage:
#   ./setup-users-index-publisher.sh                  # interactive defaults
#   ./setup-users-index-publisher.sh --token <hex>    # supply your own token
#   ./setup-users-index-publisher.sh --no-restart     # skip docker compose restart
#   ./setup-users-index-publisher.sh --compose-file /path/to/master/docker-compose.yml
#
# IMPORTANT — bearer-token parity (Phase 3.2 audit follow-up #8):
#   The token written to FULA_USERS_INDEX_INTERNAL_TOKEN below MUST
#   match the SAME variable on the chain-anchor cron host that runs
#   `mainnet-reward-server`. A drift means the cron silently 401s on
#   `/_internal/users-index-state` and the chain channel goes dark.
#   See "NEXT STEPS" output for how to copy it cross-host.

set -euo pipefail

# ----- defaults ------------------------------------------------------

KUBO_CONTAINER_DEFAULT="ipfs_host"
GATEWAY_CONTAINER_DEFAULT="fula_gateway"
IPNS_KEY_NAME_DEFAULT="fula-users-index"
INTERNAL_DIR_DEFAULT="${HOME}/.internal/fula-gateway"
ENV_OUT_DEFAULT="${HOME}/.internal/fula-gateway/users-index-publisher.env"
COMPOSE_FILE_DEFAULT="${HOME}/pinning-service/docker-compose.yml"
FLUSH_INTERVAL_DEFAULT=300
RESTART=1
TOKEN=""
SKIP_VERSION_CHECK=0

# ----- arg parsing ---------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kubo-container) KUBO_CONTAINER_DEFAULT="$2"; shift 2 ;;
    --gateway-container) GATEWAY_CONTAINER_DEFAULT="$2"; shift 2 ;;
    --key-name) IPNS_KEY_NAME_DEFAULT="$2"; shift 2 ;;
    --internal-dir) INTERNAL_DIR_DEFAULT="$2"; ENV_OUT_DEFAULT="$2/users-index-publisher.env"; shift 2 ;;
    --env-out) ENV_OUT_DEFAULT="$2"; shift 2 ;;
    --compose-file) COMPOSE_FILE_DEFAULT="$2"; shift 2 ;;
    --flush-interval) FLUSH_INTERVAL_DEFAULT="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --no-restart) RESTART=0; shift ;;
    --skip-version-check) SKIP_VERSION_CHECK=1; shift ;;
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

KUBO_CONTAINER="$KUBO_CONTAINER_DEFAULT"
GATEWAY_CONTAINER="$GATEWAY_CONTAINER_DEFAULT"
IPNS_KEY_NAME="$IPNS_KEY_NAME_DEFAULT"
INTERNAL_DIR="$INTERNAL_DIR_DEFAULT"
ENV_OUT="$ENV_OUT_DEFAULT"
COMPOSE_FILE="$COMPOSE_FILE_DEFAULT"
FLUSH_INTERVAL="$FLUSH_INTERVAL_DEFAULT"

# ----- helpers -------------------------------------------------------

log() { printf '[setup-users-index] %s\n' "$*"; }
err() { printf '[setup-users-index] ERROR: %s\n' "$*" >&2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { err "required command not found: $1"; exit 1; }
}

require_cmd docker
require_cmd jq
require_cmd openssl

# ----- 1. ensure kubo container is running ---------------------------

if ! docker ps --format '{{.Names}}' | grep -q "^${KUBO_CONTAINER}$"; then
  err "kubo container '${KUBO_CONTAINER}' is not running."
  err "  docker ps --format '{{.Names}}' to verify."
  err "  pass --kubo-container to override the name (default: ${KUBO_CONTAINER_DEFAULT})."
  exit 1
fi
log "kubo container '${KUBO_CONTAINER}' is running"

# ----- 1b. probe kubo version (audit follow-up #7) --------------------
#
# The script's idempotent IPNS-key check relies on `ipfs key list -l
# --enc=json`, which has been supported since kubo v0.5 (Apr 2020). All
# currently-supported production kubo versions exceed this comfortably,
# but we probe anyway so that a misconfigured or pinned-old container
# fails loudly here rather than producing an unparseable output later.
#
# Bypass via --skip-version-check if the operator is intentionally
# running a fork or a custom build that doesn't expose `ipfs version`.

if [[ "$SKIP_VERSION_CHECK" == "0" ]]; then
  KUBO_VERSION_JSON=$(docker exec "$KUBO_CONTAINER" ipfs version --enc=json 2>/dev/null || true)
  if [[ -z "$KUBO_VERSION_JSON" ]]; then
    err "could not run 'ipfs version --enc=json' in '${KUBO_CONTAINER}'"
    err "  The script depends on kubo >= 0.5 for structured key-list output."
    err "  Re-run with --skip-version-check to bypass this probe (you accept the"
    err "  risk that downstream commands may fail if the daemon is too old)."
    exit 1
  fi
  KUBO_VERSION=$(printf '%s' "$KUBO_VERSION_JSON" | jq -er '.Version' 2>/dev/null || echo "")
  if [[ -z "$KUBO_VERSION" ]]; then
    log "kubo version JSON did not contain .Version field; continuing anyway"
  else
    log "kubo version: $KUBO_VERSION"
    # Reject 0.0.x .. 0.4.x. Anything 0.5+ or 1.x+ is fine.
    if [[ "$KUBO_VERSION" =~ ^0\.([0-4])\. ]]; then
      err "kubo $KUBO_VERSION is too old; require >= 0.5 (released Apr 2020)"
      err "  Upgrade the kubo image or re-run with --skip-version-check."
      exit 1
    fi
  fi
else
  log "skipping kubo version probe (--skip-version-check)"
fi

# ----- 2. generate or reuse IPNS key ---------------------------------

# kubo's `ipfs key list` text output has historically swapped column
# ordering across versions (some emit `<id> <name>`, others
# `<name> <id>`). Use `--enc=json` for a stable, structured response:
#   { "Keys": [ { "Name": "fula-users-index", "Id": "k51..." }, ... ] }
# This is supported by every kubo released since 0.5 and bypasses the
# column-ordering ambiguity entirely.

KEY_LIST_JSON=$(docker exec "$KUBO_CONTAINER" ipfs key list -l --enc=json 2>/dev/null || true)
if [[ -z "$KEY_LIST_JSON" ]]; then
  err "failed to read 'ipfs key list -l --enc=json' from container '${KUBO_CONTAINER}'"
  err "  (kubo too old? requires v0.5+. Or container not running? Or ipfs daemon not yet up?)"
  exit 1
fi

# jq -e returns non-zero if no element matched, which is exactly the
# signal we want for "key does not exist".
if IPNS_NAME=$(printf '%s' "$KEY_LIST_JSON" | jq -er --arg n "$IPNS_KEY_NAME" '.Keys[] | select(.Name==$n) | .Id'); then
  log "IPNS key '${IPNS_KEY_NAME}' already exists; reusing (id=${IPNS_NAME})"
else
  log "generating IPNS key '${IPNS_KEY_NAME}'..."
  # `ipfs key gen` prints just the key id on stdout. If kubo says the
  # key already exists at this point (race with a parallel run), bail
  # — re-running this script is the recovery path.
  if ! IPNS_NAME=$(docker exec "$KUBO_CONTAINER" ipfs key gen --type=ed25519 "$IPNS_KEY_NAME" 2>&1); then
    err "ipfs key gen failed: $IPNS_NAME"
    err "  (if the key already exists, re-run this script — the existence check above will succeed next time)"
    exit 1
  fi
  log "generated IPNS key '${IPNS_KEY_NAME}' = ${IPNS_NAME}"
fi

if [[ -z "$IPNS_NAME" ]]; then
  err "failed to obtain IPNS NAME (libp2p key hash) for key '${IPNS_KEY_NAME}'"
  exit 1
fi

# ----- 3. token: reuse existing if env-file already has one -----------

if [[ -z "$TOKEN" ]]; then
  if [[ -f "$ENV_OUT" ]] && grep -q '^FULA_USERS_INDEX_INTERNAL_TOKEN=' "$ENV_OUT"; then
    TOKEN=$(grep '^FULA_USERS_INDEX_INTERNAL_TOKEN=' "$ENV_OUT" | head -n1 | cut -d= -f2-)
    log "reusing existing internal token from $ENV_OUT"
  else
    TOKEN=$(openssl rand -hex 32)
    log "generated new internal bearer token (32 bytes hex)"
  fi
else
  log "using internal token supplied via --token"
fi

# ----- 4. ensure state directory exists ------------------------------

mkdir -p "$INTERNAL_DIR"
chmod 700 "$INTERNAL_DIR" || true
log "state directory: $INTERNAL_DIR"

# ----- 5. write env-file ---------------------------------------------

# Atomic write via tempfile + mv.
TMP_ENV=$(mktemp)
cat > "$TMP_ENV" <<EOF
# Generated by setup-users-index-publisher.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Phase 3.2 fula users-index publisher config.
# Add the following to fula-gateway's compose service:
#   env_file: ${ENV_OUT}
# Then: docker compose up -d fula-gateway
FULA_USERS_INDEX_PUBLISHER_ENABLED=1
FULA_USERS_INDEX_STATE_PATH=/internal/fula-gateway/users_index_state.txt
FULA_USERS_INDEX_FLUSH_INTERVAL_SECS=${FLUSH_INTERVAL}
FULA_USERS_INDEX_IPNS_KEY_NAME=${IPNS_KEY_NAME}
FULA_USERS_INDEX_IPNS_LIFETIME_SECS=129600
FULA_USERS_INDEX_IPNS_TTL_SECS=900
FULA_USERS_INDEX_FIRST_PUBLISH_PINS_PER_S=100
FULA_USERS_INDEX_INTERNAL_TOKEN=${TOKEN}
EOF
chmod 600 "$TMP_ENV"
mv "$TMP_ENV" "$ENV_OUT"
log "wrote env-file: $ENV_OUT (mode 600)"

# Also turn on Phase 1.2 header consumption while we're at it. The
# publisher relies on it for blinded keys, so this is the natural
# moment to flip it.
if ! grep -q '^FULA_BUCKET_LOOKUP_H_ENABLED=' "$ENV_OUT"; then
  printf 'FULA_BUCKET_LOOKUP_H_ENABLED=1\n' >> "$ENV_OUT"
  log "added FULA_BUCKET_LOOKUP_H_ENABLED=1"
fi

# ----- 6. summary + next steps ---------------------------------------

cat <<EOF

================================================================
✅ users-index publisher setup complete.

  IPNS key name:     ${IPNS_KEY_NAME}
  IPNS NAME (id):    ${IPNS_NAME}
  Internal token:    (in ${ENV_OUT}; do NOT commit this file)
  State file path:   ${INTERNAL_DIR}/users_index_state.txt

NEXT STEPS — operator must do these manually:

  1. Add env_file to fula-gateway in your master compose file. Edit
     ${COMPOSE_FILE}
     under the 'fula-gateway' service:

         services:
           fula-gateway:
             ...
             env_file:
               - ${ENV_OUT}

     (If you already have an env_file: list, append this path.)

  2. Restart fula-gateway:
         docker compose -f ${COMPOSE_FILE} up -d fula-gateway

  3. Verify the publisher is alive (replace TOKEN below):
         curl -H "Authorization: Bearer \$TOKEN" \\
              http://127.0.0.1:9000/_internal/users-index-state

     Expect 200 with a JSON body. The 'cid' will be null until the
     first publisher tick fires (after ${FLUSH_INTERVAL}s).

  4. ★ TOKEN PARITY (audit follow-up #8) — copy the SAME token to the
     mainnet-reward-server host that runs the chain-anchor cron.
     If the tokens drift, the cron silently 401s on /_internal/users-index-state
     and on-chain submissions stop. Set on the cron host:

         FULA_USERS_INDEX_ANCHOR_ENABLED=true
         FULA_USERS_INDEX_FULA_CLI_URL=http://<master-ip>:9000
         FULA_USERS_INDEX_INTERNAL_TOKEN=${TOKEN}    # SAME secret as on master
         FULA_USERS_INDEX_ANCHOR_BASE=<your_anchor_proxy_address>
         (or FULA_USERS_INDEX_ANCHOR_SKALE if deployed on SKALE)

     One-liner to extract just the token from this env-file:
         grep '^FULA_USERS_INDEX_INTERNAL_TOKEN=' ${ENV_OUT} | cut -d= -f2-

  5. Deploy fula-chain's FulaUsersIndexAnchor.sol (see fula-chain
     scripts/deployFulaUsersIndexAnchor.ts), then grant
     CONTRACT_OPERATOR_ROLE to the master operator wallet via the
     governance proposal flow (24h timelock + 24h execution delay).

  6. Add to fula-client SDK build-time config:
         users_index_ipns_name: ${IPNS_NAME}
         users_index_anchor_address: <your_anchor_proxy_address>
         users_index_anchor_rpc_url: <your RPC URL>

================================================================
EOF

# ----- 7. optional restart -------------------------------------------

if [[ "$RESTART" == "1" ]] && [[ -f "$COMPOSE_FILE" ]]; then
  if grep -q "env_file:" "$COMPOSE_FILE" && grep -q "$ENV_OUT" "$COMPOSE_FILE"; then
    log "compose file already references env_file=$ENV_OUT; restarting fula-gateway"
    docker compose -f "$COMPOSE_FILE" up -d fula-gateway
    log "fula-gateway restarted"
  else
    log "compose file at ${COMPOSE_FILE} does NOT yet reference ${ENV_OUT}"
    log "edit it manually (see step 1 above), then run:"
    log "  docker compose -f ${COMPOSE_FILE} up -d fula-gateway"
  fi
else
  log "skipping restart (--no-restart or compose file not found)"
fi

log "done."
