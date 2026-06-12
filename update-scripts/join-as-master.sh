#!/usr/bin/env bash
#
# join-as-master.sh — v0 of the Fula federated-master installer (Phase 1.5, Stage A).
#
# Turns a plain Ubuntu/Debian box into a Fula MASTER service stack:
#   postgres-pinning + pinning OpenAPI + pinning-webui (billing + crons) via
#   docker compose (healthchecks, restart policies, watchtower auto-heal),
#   ADOPTING the kubo + ipfs-cluster WRITER provisioned by
#   fula-ota/update-scripts/phase-1-setup-writer.sh (never duplicating them).
#
# Design contract (capstone trajectory — see the decentralization plan):
#   v0  (this): operator-run, detect-installed/adopt-or-halt, idempotent,
#       interactive params persisted to $ENV_FILE, never clobbers.
#   vNext: storage-only profile (Stage B), on-chain whitelist + FULA-staking
#       gate via the Base MasterRegistry (Stage C).
#
# Run as root FROM A CHECKOUT of functionland/pinning-service (the compose
# files and migrations ship in the repo):   sudo bash update-scripts/join-as-master.sh
#
# Env: ENV_FILE (default /opt/fula-master/.env), DRY_RUN=1, SKIP_MIGRATIONS=1.
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/phase-common.sh
. "$SCRIPT_DIR/lib/phase-common.sh"
PC_TAG="join-as-master"

REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_DIR/docker/master/docker-compose.master.yml"
MIGRATIONS_DIR="$REPO_DIR/migrations/postgres"
BASE_DIR="${BASE_DIR:-/opt/fula-master}"
ENV_FILE="${ENV_FILE:-$BASE_DIR/.env}"
DRY_RUN="${DRY_RUN:-0}"

[ -f "$COMPOSE_FILE" ] || die "compose file not found: $COMPOSE_FILE (run from a pinning-service checkout)"
pc_load_env "$ENV_FILE"

# ---- gather params (interactive with saved defaults; non-interactive uses env/.env or halts) ----
pc_prompt POSTGRES_PASSWORD "Postgres password for pinning_service" '^.{8,}$' secret
pc_prompt SYSTEM_KEY "Admin SYSTEM_KEY for the pinning API" '^.{12,}$' secret
# webui hard-requires these in production (server/index.ts FATALs without them).
# Auto-generate once and persist — operator may override via env/.env.
: "${JWT_SECRET:=$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
: "${SESSION_SECRET:=$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
: "${POSTGRES_DB:=pinning_service}"; : "${POSTGRES_USER:=pinning_user}"
: "${BILLING_IDEMPOTENCY:=true}"; : "${CRON_LEADER_LEASE:=true}"
: "${VAULT_ADDRESS:=}"; : "${WEBUI_PORT:=3001}"; : "${PINNING_API_PORT:=6000}"
: "${IPFS_CLUSTER_API_ADDR:=/ip4/127.0.0.1/tcp/9094}"
: "${IPFS_API_ADDR:=/ip4/127.0.0.1/tcp/5001}"

if [ "$DRY_RUN" != 1 ]; then [ "$(id -u)" = 0 ] || die "run as root (docker + system paths)."; fi

# ---- detect / adopt-or-halt ----
if pc_have docker; then info "docker present — skip"
elif [ "$DRY_RUN" = 1 ]; then info "(dry-run) would install Docker"
else info "installing Docker ..."; curl -fsSL https://get.docker.com | sh || die "Docker install failed"; systemctl enable --now docker || die "could not start docker"; fi

if [ "$DRY_RUN" != 1 ]; then
  docker compose version >/dev/null 2>&1 || die "docker compose v2 plugin missing — install docker-compose-plugin."
fi

# kubo + cluster writer: ADOPT (provisioned by fula-ota phase-1-setup-writer.sh).
WRITER_OK=1
pc_service_active ipfs.service        || WRITER_OK=0
pc_service_active ipfscluster.service || WRITER_OK=0
if [ "$WRITER_OK" = 1 ]; then
  info "adopting existing kubo + ipfs-cluster writer (systemd ipfs.service + ipfscluster.service)"
elif [ "$DRY_RUN" = 1 ]; then
  info "(dry-run) writer units not detected — real run would HALT"
else
  die "kubo/ipfs-cluster writer not found (ipfs.service + ipfscluster.service inactive).
A master REQUIRES its cluster writer. Provision it first:
  fula-ota repo -> sudo bash update-scripts/phase-1-setup-writer.sh
then re-run this script. (Refusing to guess or duplicate — adopt-or-halt.)"
fi

# Existing postgres: adopt OUR stack's container, halt on a foreign one.
if pc_container_exists postgres-pinning; then
  owner="$(docker inspect postgres-pinning --format '{{ index .Config.Labels "com.docker.compose.project" }}' 2>/dev/null || true)"
  if [ "$owner" = "fula-master" ]; then info "postgres-pinning belongs to this stack — adopt"
  elif [ "$DRY_RUN" = 1 ]; then info "(dry-run) foreign postgres-pinning present — real run would HALT"
  else die "a postgres-pinning container exists but was NOT created by this stack (compose project: '${owner:-none}').
Refusing to touch it. Either migrate it into the stack manually or remove it, then re-run."
  fi
fi

# Gateway profile: enable only if the fula-gateway image exists on this box.
COMPOSE_PROFILES=""
if docker image inspect "${FULA_GATEWAY_IMAGE:-fula-gateway:latest}" >/dev/null 2>&1; then
  COMPOSE_PROFILES="gateway"
  info "fula-gateway image found — enabling the gateway profile"
else
  info "fula-gateway image not present — S3 gateway profile stays off (build it from the fula-api repo, then re-run)"
fi

pc_save_env "$ENV_FILE" POSTGRES_PASSWORD SYSTEM_KEY JWT_SECRET SESSION_SECRET \
  POSTGRES_DB POSTGRES_USER \
  BILLING_IDEMPOTENCY CRON_LEADER_LEASE VAULT_ADDRESS WEBUI_PORT PINNING_API_PORT \
  IPFS_CLUSTER_API_ADDR IPFS_API_ADDR

cat <<EOF
[join-as-master] plan:
  base=$BASE_DIR  env=$ENV_FILE  compose=$COMPOSE_FILE
  flags: BILLING_IDEMPOTENCY=$BILLING_IDEMPOTENCY CRON_LEADER_LEASE=$CRON_LEADER_LEASE
  cluster REST: $IPFS_CLUSTER_API_ADDR   kubo API: $IPFS_API_ADDR
  gateway profile: ${COMPOSE_PROFILES:-off}
EOF
[ "$DRY_RUN" = 1 ] && { info "DRY_RUN=1 — params saved; no system changes made."; exit 0; }

mkdir -p "$BASE_DIR"

compose() { COMPOSE_PROFILES="$COMPOSE_PROFILES" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# ---- postgres first (migrations need it) ----
info "starting postgres ..."
compose up -d postgres
for i in $(seq 1 30); do
  docker exec postgres-pinning pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1 && break
  [ "$i" = 30 ] && die "postgres did not become healthy"
  sleep 3
done
info "postgres healthy"

# ---- migrations (ordered, skip *.down.sql; marker prevents accidental re-runs;
#      HALTS on the first error — never guesses past a failed migration) ----
MARKER="$BASE_DIR/.migrations-applied"
if [ "${SKIP_MIGRATIONS:-0}" = 1 ]; then info "SKIP_MIGRATIONS=1 — skipping"
elif [ -f "$MARKER" ]; then info "migrations already applied ($(cat "$MARKER")) — skip (rm $MARKER to force)"
else
  info "applying migrations from $MIGRATIONS_DIR ..."
  for f in "$MIGRATIONS_DIR"/[0-9]*.sql; do
    case "$f" in *.down.sql) continue ;; esac
    info "  -> $(basename "$f")"
    docker exec -i postgres-pinning psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 < "$f" \
      || die "migration failed: $(basename "$f") — fix before re-running (state is in postgres; this script applied earlier files already)."
  done
  date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKER"
  info "migrations complete"
fi

# ---- full stack ----
info "building + starting the master stack (first build takes a while) ..."
compose up -d --build

info "waiting for service health ..."
for svc in fula-pinning-api fula-pinning-webui; do
  for i in $(seq 1 40); do
    st="$(docker inspect "$svc" --format '{{.State.Health.Status}}' 2>/dev/null || echo missing)"
    [ "$st" = healthy ] && { info "$svc healthy"; break; }
    [ "$i" = 40 ] && die "$svc not healthy (status: $st) — docker logs $svc"
    sleep 5
  done
done

# ---- safeguard crons (signed pinset snapshots every 6h; replication sweep
#      every 30 min) — idempotent installs ----
bash "$SCRIPT_DIR/pinset-snapshot.sh" --install-cron
bash "$SCRIPT_DIR/replication-sweep.sh" --install-cron
# Take the first snapshot immediately so a restore path exists from minute one.
OUT_DIR=/opt/fula-master/snapshots bash "$SCRIPT_DIR/pinset-snapshot.sh" || info "WARN: first snapshot failed (cluster busy?) — cron will retry"

cat <<EOF
[join-as-master] DONE (idempotent — re-run any time).
  pinning API : 127.0.0.1:$PINNING_API_PORT   webui: 127.0.0.1:$WEBUI_PORT
  postgres    : 127.0.0.1:5432 ($POSTGRES_DB)
  cluster     : adopted writer at $IPFS_CLUSTER_API_ADDR
  flags       : BILLING_IDEMPOTENCY=$BILLING_IDEMPOTENCY CRON_LEADER_LEASE=$CRON_LEADER_LEASE
Front with nginx/TLS before exposing publicly. Status: docker compose -f $COMPOSE_FILE ps
EOF
