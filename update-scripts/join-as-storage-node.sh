#!/usr/bin/env bash
#
# join-as-storage-node.sh — Fula STORAGE-ONLY operator installer (Phase 2.5, Stage B).
#
# A vetted third party who provides STORAGE + verified byte ingress, with NO
# cluster write authority and NO database/billing. Dockerized via compose
# (healthchecks, restart policies, watchtower auto-heal). Idempotent +
# re-runnable; params persisted to $ENV_FILE; never clobbers.
#
# The node runs ipfs-cluster in FOLLOWER mode trusting ONLY the master peer
# ids (never itself), so it REPLICATES the pinset but cannot mutate it — the
# mass-unpin blast radius stays first-party until the FM-3 chain backstop
# ships. fula-ingest gates ingestion on a master's storage API (quota), so a
# storage operator can accept client bytes (verified blake3 CID) but never
# unmetered.
#
# Run as root FROM A CHECKOUT of functionland/pinning-service:
#   sudo bash update-scripts/join-as-storage-node.sh
#
# Required master facts (from the master list / pools API, or supplied):
#   MASTER_CLUSTER_PEERIDS   comma-separated trusted master cluster peer ids
#   MASTER_CLUSTER_BOOTSTRAP a master cluster multiaddr to bootstrap from
#   CLUSTERNAME              the pool/cluster name (derives CLUSTER_SECRET)
#   STORAGE_API_URL          a master storage API for the ingest quota gate
#
# Env: ENV_FILE (default /opt/fula-storage/.env), DRY_RUN=1.
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/phase-common.sh
. "$SCRIPT_DIR/lib/phase-common.sh"
PC_TAG="join-as-storage-node"

REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_DIR/docker/master/docker-compose.storage.yml"
BASE_DIR="${BASE_DIR:-/opt/fula-storage}"
ENV_FILE="${ENV_FILE:-$BASE_DIR/.env}"
DRY_RUN="${DRY_RUN:-0}"
POOL_API="${POOL_API:-}"

[ -f "$COMPOSE_FILE" ] || die "compose file not found: $COMPOSE_FILE (run from a pinning-service checkout)"
pc_load_env "$ENV_FILE"

pc_prompt CLUSTERNAME "Cluster/pool name" '^[0-9A-Za-z._-]+$'
[ -n "$POOL_API" ] || POOL_API="https://pools.fx.land/pools/${CLUSTERNAME}"

# Auto-resolve master identity from the masters list / pools API unless supplied.
if [ -z "${MASTER_CLUSTER_PEERIDS:-}" ] || [ -z "${MASTER_CLUSTER_BOOTSTRAP:-}" ]; then
  if pc_have curl && pc_have jq; then
    info "reading master identity from $POOL_API ..."
    resp="$(curl -s --max-time 20 "$POOL_API" 2>/dev/null || true)"
    if printf '%s' "$resp" | jq -e . >/dev/null 2>&1; then
      # Prefer the federation trusted-peers ARRAY (join-server #2); fall back to single.
      [ -n "${MASTER_CLUSTER_PEERIDS:-}" ] || MASTER_CLUSTER_PEERIDS="$(printf '%s' "$resp" \
        | jq -r '(."ipfs-cluster-trustedpeers" // []) | map(select(. != null and . != "")) | join(",")')"
      [ -n "$MASTER_CLUSTER_PEERIDS" ] || MASTER_CLUSTER_PEERIDS="$(printf '%s' "$resp" | jq -r '."ipfs-cluster-peerid" // empty')"
      [ -n "${MASTER_CLUSTER_BOOTSTRAP:-}" ] || MASTER_CLUSTER_BOOTSTRAP="$(printf '%s' "$resp" | jq -r '(.ipfs_cluster.addresses // [])[] | select(test("/tcp/"))' | head -1)"
    fi
  fi
fi

pc_prompt MASTER_CLUSTER_PEERIDS "Trusted master cluster peer ids (comma-separated)" '^(12D3KooW|Qm)'
pc_prompt MASTER_CLUSTER_BOOTSTRAP "Master cluster bootstrap multiaddr" '^/'
pc_prompt STORAGE_API_URL "A master storage API URL (ingest quota gate)" '^https?://'
: "${INGEST_QUOTA_MODE:=open}"; : "${INGEST_PORT:=3601}"

if [ "$DRY_RUN" != 1 ]; then [ "$(id -u)" = 0 ] || die "run as root (docker + system paths)."; fi

# ---- docker present? (install if missing) ----
if pc_have docker; then info "docker present — skip"
elif [ "$DRY_RUN" = 1 ]; then info "(dry-run) would install Docker"
else info "installing Docker ..."; curl -fsSL https://get.docker.com | sh || die "Docker install failed"; systemctl enable --now docker || die "could not start docker"; fi
if [ "$DRY_RUN" != 1 ]; then docker compose version >/dev/null 2>&1 || die "docker compose v2 plugin missing."; fi

# adopt-or-halt: refuse to stomp a kubo/cluster this stack didn't create
for c in ipfs_host ipfs_cluster; do
  if pc_container_exists "$c"; then
    owner="$(docker inspect "$c" --format '{{ index .Config.Labels "com.docker.compose.project" }}' 2>/dev/null || true)"
    if [ "$owner" = "fula-storage" ]; then info "$c belongs to this stack — adopt"
    elif [ "$DRY_RUN" = 1 ]; then info "(dry-run) foreign $c present — real run would HALT"
    else die "a '$c' container exists but was NOT created by this stack (project: '${owner:-none}'). Refusing to touch it."
    fi
  fi
done

# fula-ingest image: build hint if absent (operator builds from fula-ota).
if docker image inspect "${FULA_INGEST_IMAGE:-functionland/fula-ingest:latest}" >/dev/null 2>&1; then
  info "fula-ingest image present"
elif [ "$DRY_RUN" = 1 ]; then info "(dry-run) fula-ingest image absent — real run would HALT"
else
  die "fula-ingest image not found. Build it first:
  fula-ota repo -> docker build -f docker/fula-ingest/Dockerfile -t functionland/fula-ingest:latest docker/fula-ingest
then re-run."
fi

CLUSTER_SECRET="$(printf '%s' "$CLUSTERNAME" | sha256sum | cut -d' ' -f1)"
CLUSTER_PEERNAME="${CLUSTER_PEERNAME:-fula-storage-$(hostname -s 2>/dev/null || echo node)}"

pc_save_env "$ENV_FILE" CLUSTERNAME POOL_API MASTER_CLUSTER_PEERIDS MASTER_CLUSTER_BOOTSTRAP \
  STORAGE_API_URL INGEST_QUOTA_MODE INGEST_PORT CLUSTER_PEERNAME
# CLUSTER_SECRET is derived, not prompted — append it for compose.
grep -q '^CLUSTER_SECRET=' "$ENV_FILE" 2>/dev/null || printf 'CLUSTER_SECRET=%s\n' "$CLUSTER_SECRET" >> "$ENV_FILE"

cat <<EOF
[join-as-storage-node] plan (STORAGE-ONLY, no write authority, no DB):
  base=$BASE_DIR  env=$ENV_FILE  compose=$COMPOSE_FILE
  cluster: FOLLOWER, name=$CLUSTERNAME, trusts masters=[$MASTER_CLUSTER_PEERIDS]
  bootstrap=$MASTER_CLUSTER_BOOTSTRAP
  ingest: :$INGEST_PORT quota=$INGEST_QUOTA_MODE via $STORAGE_API_URL
EOF
[ "$DRY_RUN" = 1 ] && { info "DRY_RUN=1 — params saved; no system changes made."; exit 0; }

mkdir -p "$BASE_DIR"
compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

info "starting storage-only stack ..."
compose up -d

info "waiting for health ..."
for svc in ipfs_host fula-ingest; do
  for i in $(seq 1 40); do
    st="$(docker inspect "$svc" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || echo missing)"
    { [ "$st" = healthy ] || [ "$st" = running ]; } && { info "$svc $st"; break; }
    [ "$i" = 40 ] && die "$svc not healthy ($st) — docker logs $svc"
    sleep 5
  done
done

cat <<EOF
[join-as-storage-node] DONE (idempotent).
  This node REPLICATES the pinset (follower) and accepts verified, quota-gated
  byte ingress on :$INGEST_PORT — but has NO cluster write authority and NO DB.
  Verify it joined:  docker exec ipfs_cluster ipfs-cluster-ctl --host /ip4/127.0.0.1/tcp/9094 peers ls
  Verify ingest:     curl -s http://127.0.0.1:$INGEST_PORT/health
EOF
