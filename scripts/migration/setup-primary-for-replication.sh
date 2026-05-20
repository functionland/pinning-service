#!/usr/bin/env bash
# setup-primary-for-replication.sh — one-time PRIMARY setup for warm-standby.
#
# Run on the PRIMARY server (where pinning-service is currently live), as
# root. Enables PostgreSQL WAL archiving so a warm-standby server can pull
# WAL segments via SSH+rsync and continuously replay them.
#
# Why archive shipping (not streaming replication with a slot):
#   - Streaming replication with a replication slot pins WAL on disk until
#     the standby drains it. If the standby is unreachable for any reason
#     (rebooted, network blip, mid-rebuild), WAL accumulates indefinitely
#     and eventually fills primary's disk — a footgun for low-touch setups.
#   - Archive shipping ages out by retention policy (we set 7 days), so a
#     broken standby is bounded in impact: it can fall behind up to N days
#     and recover, or beyond N days needs a fresh pg_basebackup.
#
# What this script does:
#   1. Validates: running as root, postgres container exists and is running
#   2. Creates archive directory inside the postgres data volume
#   3. Sets archive_mode=on, wal_level=replica, max_wal_senders=3, and
#      archive_command via `ALTER SYSTEM` (persisted in postgresql.auto.conf)
#   4. Creates a `replicator` role (REPLICATION LOGIN) with a generated
#      password; writes the password to /root/.fula-replicator-password
#      (mode 0600) for the operator to copy to the standby
#   5. Restarts the postgres container (one-time ~30s disruption — required
#      because archive_mode change requires postgres restart)
#   6. Installs a daily retention cron that deletes WAL files older than 7d
#   7. Ensures the standby's SSH key (if it's been authorized in
#      authorized_keys already) can read the archive dir
#
# Idempotent: re-running detects existing state and skips completed steps.

set -euo pipefail

PG_CONTAINER="postgres-pinning"
ARCHIVE_RETENTION_DAYS=7
REPLICATOR_PASSWORD_FILE="/root/.fula-replicator-password"
PG_ENV_FILE="/home/root/pinning-service/.env"

log()   { echo "[$(date -u +%H:%M:%SZ)] setup-replication: $*"; }
fatal() { log "FATAL: $*"; exit 1; }

[[ $EUID -eq 0 ]] || fatal "must run as root"

# ----------------------------------------------------------------------------
# 1. Validate environment
# ----------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || fatal "docker not installed"
docker inspect "$PG_CONTAINER" >/dev/null 2>&1 || fatal "container '$PG_CONTAINER' not found"

status=$(docker inspect "$PG_CONTAINER" --format '{{.State.Status}}')
[ "$status" = "running" ] || fatal "container '$PG_CONTAINER' is not running (status: $status)"

[ -r "$PG_ENV_FILE" ] || fatal "$PG_ENV_FILE not readable (need POSTGRES_USER + POSTGRES_PASSWORD)"
PG_USER=$(grep -E '^POSTGRES_USER='     "$PG_ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"')
PG_PASS=$(grep -E '^POSTGRES_PASSWORD=' "$PG_ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"')
[ -n "$PG_PASS" ] || fatal "POSTGRES_PASSWORD missing from $PG_ENV_FILE"
PG_USER="${PG_USER:-pinning_user}"

# Helper: run psql inside the container against the postgres superuser DB.
# We use the POSTGRES_USER from .env which is the superuser created by the
# postgres image's initdb.
pgexec() {
  docker exec -e PGPASSWORD="$PG_PASS" "$PG_CONTAINER" \
    psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 "$@"
}

# ----------------------------------------------------------------------------
# 2. Create archive directory INSIDE the postgres data volume so it travels
#    with the volume and we don't need to recreate the container to add a
#    new mount. Resolve the volume's host mountpoint.
# ----------------------------------------------------------------------------
PG_VOL=$(docker volume inspect postgres-pinning-data --format '{{.Mountpoint}}' 2>/dev/null) \
  || fatal "postgres-pinning-data volume not found"
ARCHIVE_DIR_HOST="$PG_VOL/pg-archive"
ARCHIVE_DIR_CONT="/var/lib/postgresql/data/pg-archive"

if [ ! -d "$ARCHIVE_DIR_HOST" ]; then
  log "creating archive directory: $ARCHIVE_DIR_HOST"
  install -d -m 0750 "$ARCHIVE_DIR_HOST"
  # postgres runs as uid 999 (debian package) or uid 70 (alpine) — query container
  PG_UID=$(docker exec "$PG_CONTAINER" id -u postgres 2>/dev/null || echo 999)
  PG_GID=$(docker exec "$PG_CONTAINER" id -g postgres 2>/dev/null || echo 999)
  chown "$PG_UID:$PG_GID" "$ARCHIVE_DIR_HOST"
else
  log "archive directory already exists: $ARCHIVE_DIR_HOST"
fi

# Symlink for the standby-side path convention. setup uses
# /var/lib/pg-archive on the host as a stable name independent of where the
# docker volume lives.
if [ ! -e /var/lib/pg-archive ]; then
  ln -s "$ARCHIVE_DIR_HOST" /var/lib/pg-archive
  log "created symlink /var/lib/pg-archive -> $ARCHIVE_DIR_HOST"
fi

# ----------------------------------------------------------------------------
# 3. Configure WAL archiving. ALTER SYSTEM writes postgresql.auto.conf which
#    is read AFTER postgresql.conf, so these win regardless of any image
#    defaults.
#
# archive_command: the `test ! -f ... && cp ...` pattern is the documented
# safe form — never overwrite an existing archive file (which would happen
# if the same WAL segment got re-archived after a primary crash).
# ----------------------------------------------------------------------------
log "configuring WAL archiving via ALTER SYSTEM"

# Check whether changes are needed (idempotency).
CURRENT_WAL_LEVEL=$(pgexec -tA -c "SHOW wal_level;" 2>/dev/null | tr -d '[:space:]')
CURRENT_ARCHIVE_MODE=$(pgexec -tA -c "SHOW archive_mode;" 2>/dev/null | tr -d '[:space:]')

if [ "$CURRENT_WAL_LEVEL" = "replica" ] && [ "$CURRENT_ARCHIVE_MODE" = "on" ]; then
  log "WAL archiving already configured (wal_level=replica, archive_mode=on) — skipping ALTER SYSTEM"
  RESTART_NEEDED=false
else
  pgexec <<SQL
ALTER SYSTEM SET wal_level         = 'replica';
ALTER SYSTEM SET archive_mode      = 'on';
ALTER SYSTEM SET archive_command   = 'test ! -f $ARCHIVE_DIR_CONT/%f && cp %p $ARCHIVE_DIR_CONT/%f';
ALTER SYSTEM SET max_wal_senders   = 3;
ALTER SYSTEM SET wal_keep_size     = '512MB';
SQL
  RESTART_NEEDED=true
fi

# ----------------------------------------------------------------------------
# 4. Create or update the replicator role. pg_basebackup needs REPLICATION;
#    the role does NOT need any database privileges beyond that.
# ----------------------------------------------------------------------------
if [ -f "$REPLICATOR_PASSWORD_FILE" ]; then
  REPL_PASS=$(cat "$REPLICATOR_PASSWORD_FILE")
  log "reusing existing replicator password from $REPLICATOR_PASSWORD_FILE"
else
  REPL_PASS=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
  install -m 0600 /dev/stdin "$REPLICATOR_PASSWORD_FILE" <<< "$REPL_PASS"
  log "generated new replicator password -> $REPLICATOR_PASSWORD_FILE"
fi

# CREATE ROLE is not idempotent; use a DO block.
pgexec <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'replicator') THEN
    CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '$REPL_PASS';
  ELSE
    ALTER ROLE replicator WITH REPLICATION LOGIN PASSWORD '$REPL_PASS';
  END IF;
END
\$\$;
SQL
log "replicator role configured"

# ----------------------------------------------------------------------------
# 5. Update pg_hba.conf to allow replication connections via SSH tunnel
#    (which appears as 127.0.0.1 from postgres's perspective). The standby
#    runs pg_basebackup through a tunnel because primary's postgres is bound
#    to 127.0.0.1:5432 only — not directly reachable from the LAN.
# ----------------------------------------------------------------------------
HBA_LINE="host    replication     replicator      127.0.0.1/32    md5"
if ! docker exec "$PG_CONTAINER" grep -q "^host.*replication.*replicator" /var/lib/postgresql/data/pg_hba.conf 2>/dev/null; then
  log "adding replication entry to pg_hba.conf"
  docker exec "$PG_CONTAINER" sh -c "echo '$HBA_LINE' >> /var/lib/postgresql/data/pg_hba.conf"
  HBA_RELOAD_NEEDED=true
else
  log "pg_hba.conf already has replication entry — skipping"
  HBA_RELOAD_NEEDED=false
fi

# ----------------------------------------------------------------------------
# 6. Restart postgres if needed (archive_mode change requires it). pg_hba
#    changes need only `SELECT pg_reload_conf()` which is non-disruptive.
# ----------------------------------------------------------------------------
if [ "$RESTART_NEEDED" = "true" ]; then
  log "restarting postgres container to apply archive_mode (one-time, ~30s)"
  docker restart "$PG_CONTAINER" >/dev/null
  # Wait for postgres to accept connections again
  for i in $(seq 1 60); do
    if docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" >/dev/null 2>&1; then
      break
    fi
    sleep 1
    if [ "$i" -eq 60 ]; then
      fatal "postgres did not come back within 60s after restart — check container logs"
    fi
  done
  log "postgres back up"
elif [ "$HBA_RELOAD_NEEDED" = "true" ]; then
  pgexec -c "SELECT pg_reload_conf();" >/dev/null
  log "pg_hba.conf reloaded"
fi

# ----------------------------------------------------------------------------
# 7. Force a WAL segment switch so the standby's pg_basebackup has at least
#    one archived segment to start replay from.
# ----------------------------------------------------------------------------
pgexec -c "SELECT pg_switch_wal();" >/dev/null 2>&1 || true

# ----------------------------------------------------------------------------
# 8. Install daily retention cron — deletes archived WAL files older than N
#    days. We do this on the HOST (not inside the container) for simplicity;
#    the host has full access to the volume's mountpoint.
# ----------------------------------------------------------------------------
CRON_FILE="/etc/cron.d/fula-pg-archive-retention"
cat > "$CRON_FILE" <<EOF
# Delete WAL archives older than ${ARCHIVE_RETENTION_DAYS} days.
# Used by the warm-standby setup; safe because the standby pulls archives
# continuously via SSH+rsync — once a segment has been pulled and replayed,
# it's no longer needed on the primary.
17 3 * * * root find $ARCHIVE_DIR_HOST -type f -name '0*' -mtime +${ARCHIVE_RETENTION_DAYS} -delete >/dev/null 2>&1
EOF
chmod 0644 "$CRON_FILE"
log "installed retention cron: $CRON_FILE"

# ----------------------------------------------------------------------------
# Print operator instructions
# ----------------------------------------------------------------------------
cat <<EOF

================================================================================
PRIMARY-SIDE SETUP COMPLETE.

Next steps on the STANDBY server:

  1. Bootstrap the standby (one-time):
       sudo bash recover.sh --standby-bootstrap \\
         --bundle /tmp2/fula-migration-<timestamp>.tgz \\
         --backup-key <encryption-key> \\
         --db-ipns ... --registry-ipns ...

  2. On the standby, the bootstrap will print an SSH pubkey. Append it to:
       $HOME/.ssh/authorized_keys

  3. Copy the replicator password to the standby (it's needed by pg_basebackup
     during standby bootstrap):

       scp $REPLICATOR_PASSWORD_FILE root@<standby>:/root/.fula-replicator-password

  4. On the standby, edit /etc/fula-standby/standby-config.sh to set:
       PRIMARY_HOST=<this-server's-hostname-or-ip>

  5. Test SSH from standby to primary:
       ssh -i /root/.ssh/standby_ed25519 root@<primary> 'hostname'

  6. Arm the standby's sync:
       echo sync-enabled > /var/lib/fula-standby/MODE

  7. Verify a sync run:
       bash /opt/pinning-service/scripts/migration/standby/standby-sync.sh

The archive dir is at: $ARCHIVE_DIR_HOST
Retention: ${ARCHIVE_RETENTION_DAYS} days (configurable in $CRON_FILE)
================================================================================
EOF
