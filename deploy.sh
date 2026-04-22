#!/bin/bash
#
# Master Deployment Script for Pinning Service
#
# Handles database migrations, backup, and auxiliary service deploys (x402, AI).
# Main services (webui, ipfs-server, Go pinning-service) are deployed manually.
#
# Migrations are tracked in a state file so each migration runs exactly once.
# All migrations are idempotent (IF NOT EXISTS / IF EXISTS) and safe to re-run
# if the state file is lost.
#
# Usage: sudo bash ./deploy.sh [OPTIONS]
#
# Options:
#   --skip-pull          Skip git pull (already up to date)
#   --migrations-only    Only run database migrations, skip x402/AI deploys
#   --dry-run            Show what would be done without doing it
#   -h, --help           Show this help message
#

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DEPLOY_DIR="/home/root/pinning-service"
DB_USER="${DB_USER:-pinning_user}"
DB_NAME="${DB_NAME:-pinning_service}"

# PostgreSQL runs in Docker container
PG_CONTAINER="${PG_CONTAINER:-postgres-pinning}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# Flags
SKIP_PULL=false
MIGRATIONS_ONLY=false
DRY_RUN=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-pull) SKIP_PULL=true; shift ;;
        --migrations-only) MIGRATIONS_ONLY=true; shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        -h|--help)
            head -18 "$0" | tail -15
            exit 0
            ;;
        *) echo -e "\033[1;33m  [WARN]\033[0m Unknown argument: $1"; shift ;;
    esac
done

log_step() { echo -e "\n${BOLD}${BLUE}[STEP]${NC} ${BOLD}$1${NC}"; }
log_ok()   { echo -e "${GREEN}  [OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}  [WARN]${NC} $1"; }
log_err()  { echo -e "${RED}  [ERROR]${NC} $1"; }
log_info() { echo -e "${BLUE}  [INFO]${NC} $1"; }

run_cmd() {
    if [ "$DRY_RUN" = true ]; then
        echo -e "  ${YELLOW}[DRY-RUN]${NC} $*"
        return 0
    fi
    "$@"
}

echo ""
echo -e "${BOLD}=========================================="
echo "  Pinning Service Deployment"
echo "==========================================${NC}"
echo ""
echo "  Source: $SCRIPT_DIR"
echo "  Target: $DEPLOY_DIR"
if [ "$DRY_RUN" = true ]; then
    echo -e "  Mode:   ${YELLOW}DRY RUN${NC}"
fi
echo ""

# ============================================
# Step 1: Git Pull
# ============================================
if [ "$SKIP_PULL" = false ]; then
    log_step "Pulling latest code"
    run_cmd git pull
    log_ok "Code updated"
else
    log_info "Skipping git pull"
fi

# ============================================
# Step 2: Database Migrations (BEFORE service restarts)
# ============================================
log_step "Running database migrations"
log_info "Migrations must complete before any service restart"

# Verify Docker container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
    log_err "PostgreSQL container '$PG_CONTAINER' is not running"
    log_err "Check: docker ps | grep postgres"
    log_err "Override container name with: PG_CONTAINER=mycontainer bash deploy.sh"
    exit 1
fi
log_info "Using PostgreSQL container: $PG_CONTAINER"

# Verify database is reachable
if ! docker exec "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1" &>/dev/null; then
    log_err "Cannot connect to database '$DB_NAME' as user '$DB_USER'"
    log_err "Check credentials and container health: docker exec $PG_CONTAINER pg_isready"
    exit 1
fi
log_ok "Database connection verified"

# ---- Pre-migration backup ----
# Take a lightweight dump before touching the schema so we can revert if needed.
BACKUP_DIR="$DEPLOY_DIR/backups"
BACKUP_FILE="$BACKUP_DIR/pre-migration-$(date -u +%Y%m%d_%H%M%S).dump"

if [ "$DRY_RUN" = false ]; then
    mkdir -p "$BACKUP_DIR"
    log_info "Taking pre-migration database backup..."
    if docker exec "$PG_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc -Z6 > "$BACKUP_FILE" 2>/dev/null && [ -s "$BACKUP_FILE" ]; then
        BACKUP_SIZE=$(du -h "$BACKUP_FILE" 2>/dev/null | cut -f1)
        log_ok "Backup saved: $BACKUP_FILE ($BACKUP_SIZE)"
        log_info "To restore if needed:"
        log_info "  docker exec -i $PG_CONTAINER pg_restore -U $DB_USER -d $DB_NAME --clean --if-exists < $BACKUP_FILE"
    else
        log_err "Pre-migration backup FAILED — aborting deployment"
        log_err "Will not modify database without a backup."
        rm -f "$BACKUP_FILE"
        exit 1
    fi

    # Keep only the 5 most recent backups to avoid filling disk
    ls -t "$BACKUP_DIR"/pre-migration-*.dump 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true
else
    log_info "Would take pre-migration backup to $BACKUP_DIR/"
fi

MIGRATION_DIR="$SCRIPT_DIR/migrations/postgres"
MIGRATION_STATE="$DEPLOY_DIR/.migration_state"

# Create state file if it doesn't exist
if [ "$DRY_RUN" = false ]; then
    touch "$MIGRATION_STATE" 2>/dev/null || MIGRATION_STATE="/tmp/.pinning_migration_state"
fi

# All migrations in dependency order.
# Each migration is idempotent (uses IF NOT EXISTS / IF EXISTS / DROP ... IF EXISTS)
# and safe to re-run, but we track state to avoid unnecessary work.
MIGRATION_FILES=(
    "006_encrypted_api_keys.sql"
    "007_cleanup_retry.sql"
    "008_admin_audit_log.sql"
    "009_hash_session_tokens.sql"
    "010_ensure_user_id_columns.sql"
    "011_referral_fk_to_user_id.sql"
    "012_nullable_legacy_columns.sql"
    "013_api_key_hash.sql"
    "014_user_credits_unique_user_id.sql"
    "015_blocked_cids.sql"
)

migrations_applied=0
migrations_skipped=0

for migration in "${MIGRATION_FILES[@]}"; do
    migration_path="$MIGRATION_DIR/$migration"

    # Skip if already applied (tracked in state file)
    if [ "$DRY_RUN" = false ] && grep -qF "$migration" "$MIGRATION_STATE" 2>/dev/null; then
        log_info "$migration — already applied, skipping"
        migrations_skipped=$((migrations_skipped + 1))
        continue
    fi

    if [ ! -f "$migration_path" ]; then
        log_warn "$migration not found at $migration_path — skipping"
        continue
    fi

    log_info "Applying $migration..."
    if run_cmd docker exec -i "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$migration_path"; then
        log_ok "$migration applied"
        migrations_applied=$((migrations_applied + 1))
        # Record successful migration
        if [ "$DRY_RUN" = false ]; then
            echo "$migration $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$MIGRATION_STATE"
        fi
    else
        log_err "$migration FAILED — aborting deployment"
        echo ""
        log_err "Fix the migration issue before restarting services."
        log_err "Services have NOT been restarted."
        log_err ""
        log_err "To debug, run the migration manually:"
        log_err "  docker exec -i $PG_CONTAINER psql -U $DB_USER -d $DB_NAME < $migration_path"
        log_err ""
        log_err "After fixing, re-run: bash deploy.sh --skip-pull"
        exit 1
    fi
done

if [ $migrations_applied -gt 0 ]; then
    log_ok "$migrations_applied migration(s) applied, $migrations_skipped already up to date"
else
    log_ok "All migrations already up to date ($migrations_skipped skipped)"
fi

if [ "$MIGRATIONS_ONLY" = true ]; then
    echo ""
    log_ok "Migrations complete. Deploy services manually."
    exit 0
fi

# ============================================
# Step 3: Deploy x402-skale
# ============================================
log_step "Deploying x402-skale"
if [ -f "$SCRIPT_DIR/x402-skale/update.sh" ]; then
    run_cmd bash "$SCRIPT_DIR/x402-skale/update.sh"
    log_ok "x402-skale deployed"
else
    log_warn "x402-skale/update.sh not found — skipping"
fi

# ============================================
# Step 4: Deploy AI service
# ============================================
log_step "Deploying AI service"
if [ -f "$SCRIPT_DIR/ai/install.sh" ]; then
    run_cmd bash "$SCRIPT_DIR/ai/install.sh"
    log_ok "AI service deployed"
else
    log_warn "ai/install.sh not found — skipping"
fi

# ============================================
# Post-Migration Verification
# ============================================
log_step "Post-migration verification"

ALL_OK=true

# Verify critical migration state
if [ "$DRY_RUN" = false ]; then
    log_info "Verifying migration state..."

    check_column() {
        local table="$1" col="$2" migration="$3"
        if docker exec "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
            "SELECT column_name FROM information_schema.columns WHERE table_name='$table' AND column_name='$col'" 2>/dev/null | grep -q "$col"; then
            log_ok "$table.$col exists"
        else
            log_err "$table.$col MISSING — $migration not applied"
            ALL_OK=false
        fi
    }

    check_table() {
        local table="$1" migration="$2"
        if docker exec "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
            "SELECT tablename FROM pg_tables WHERE tablename='$table'" 2>/dev/null | grep -q "$table"; then
            log_ok "$table table exists"
        else
            log_err "$table table MISSING — $migration not applied"
            ALL_OK=false
        fi
    }

    # Migration 006
    check_column "api_keys" "encrypted_key" "migration 006"
    # Migration 008
    check_table "admin_audit_log" "migration 008"
    # Migration 009
    check_column "sessions" "token_hash" "migration 009"
    # Migration 010
    check_column "webui_users" "user_id" "migration 010"
    check_column "webui_users" "encrypted_email" "migration 010"
    # Migration 011 — check that user_id FK target index exists
    if docker exec "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
        "SELECT indexname FROM pg_indexes WHERE tablename='webui_users' AND indexname='idx_webui_users_user_id_unique'" 2>/dev/null | grep -q "idx_webui_users_user_id_unique"; then
        log_ok "webui_users user_id unique index exists"
    else
        log_err "webui_users user_id unique index MISSING — migration 011 not applied"
        ALL_OK=false
    fi
    # Migration 012 — verify username is nullable (NOT NULL dropped)
    if docker exec "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
        "SELECT is_nullable FROM information_schema.columns WHERE table_name='users' AND column_name='username'" 2>/dev/null | grep -q "YES"; then
        log_ok "users.username is nullable (migration 012 applied)"
    else
        log_warn "users.username is still NOT NULL — migration 012 may not be applied"
        ALL_OK=false
    fi
    # Migration 013
    check_column "api_keys" "key_hash" "migration 013"
    # Migration 015
    check_table "blocked_cids" "migration 015"

    # Check ENCRYPTION_KEY is set (required for new user encrypted_email)
    ENC_KEY=""
    if [ -f "$DEPLOY_DIR/pinning-webui/.env" ]; then
        ENC_KEY=$(grep -oP '^ENCRYPTION_KEY=\K.+' "$DEPLOY_DIR/pinning-webui/.env" 2>/dev/null || true)
    fi
    if [ -n "$ENC_KEY" ]; then
        log_ok "ENCRYPTION_KEY is configured: ${ENC_KEY:0:8}...${ENC_KEY: -4}"
        echo -e "  Press Enter to continue or Ctrl+C to abort..."
        read -r
    else
        log_warn "ENCRYPTION_KEY not set in $DEPLOY_DIR/pinning-webui/.env"
        log_warn "New users will NOT have encrypted_email stored. Generate with: openssl rand -hex 32"
        # Not fatal — system works without it, just no email recovery for new users
    fi
fi

# ============================================
# Summary
# ============================================
echo ""
echo -e "${BOLD}==========================================${NC}"
if [ "$ALL_OK" = true ] || [ "$DRY_RUN" = true ]; then
    echo -e "${BOLD}${GREEN}  Migrations & Auxiliary Deploys Complete${NC}"
else
    echo -e "${BOLD}${YELLOW}  Completed (with warnings)${NC}"
fi
echo -e "${BOLD}==========================================${NC}"
echo ""

if [ "$ALL_OK" = false ]; then
    if [ -n "${BACKUP_FILE:-}" ] && [ -f "${BACKUP_FILE:-}" ]; then
        echo "To revert database changes, restore the pre-migration backup:"
        echo "  docker exec -i $PG_CONTAINER pg_restore -U $DB_USER -d $DB_NAME --clean --if-exists < $BACKUP_FILE"
        echo ""
    fi
fi

echo -e "${BOLD}Next: deploy services manually${NC}"
echo ""
echo "  ## pinning-webui (port 3000)"
echo "  cd ~/pinning-service/pinning-webui && git pull"
echo "  npm install"
echo "  VITE_GOOGLE_CLIENT_ID=<id> VITE_WALLETCONNECT_PROJECT_ID=<id> VITE_APPLE_CLIENT_ID=land.fx.cloud npm run build"
echo "  cp -r dist/* /home/root/pinning-service/pinning-webui/dist/"
echo "  cp package.json package-lock.json /home/root/pinning-service/pinning-webui/"
echo "  cd /home/root/pinning-service/pinning-webui"
echo "  npm install --production --ignore-scripts=false"
echo "  npm audit fix"
echo "  npm rebuild"
echo "  systemctl restart fula-pinning-webui"
echo ""
echo "  ## Go pinning-service (port 6000)"
echo "  cd ~/pinning-service && git pull"
echo "  go mod download"
echo "  go build -o /home/root/pinning-service/ipfs-pinning.new main_postgres.go"
echo "  systemctl stop fula-pinning-service"
echo "  mv /home/root/pinning-service/ipfs-pinning.new /home/root/pinning-service/ipfs-pinning"
echo "  systemctl start fula-pinning-service"
echo ""
echo "  ## ipfs-server (upload gateway)"
echo "  cd ~/pinning-service/ipfs-server && git pull"
echo "  npm install --production=false && npm audit fix && npm run build"
echo "  systemctl stop fula-upload-server"
echo "  cp -r dist/* /home/root/pinning-service/ipfs-server/dist/"
echo "  cp package.json package-lock.json /home/root/pinning-service/ipfs-server/ 2>/dev/null || true"
echo "  cd /home/root/pinning-service/ipfs-server && npm install --production --ignore-scripts=false"
echo "  systemctl start fula-upload-server"
echo ""

# Post-deployment hints
if [ -z "$(grep -oP '^ENCRYPTION_KEY=\K.+' "$DEPLOY_DIR/pinning-webui/.env" 2>/dev/null || true)" ]; then
    echo -e "${YELLOW}  Set ENCRYPTION_KEY (required for encrypted email storage):${NC}"
    echo "       openssl rand -hex 32"
    echo "       Add ENCRYPTION_KEY=<hex> to $DEPLOY_DIR/pinning-webui/.env"
    echo "       systemctl restart fula-pinning-webui"
    echo ""
fi
echo "  Backups (one-time setup):"
echo "    1. Generate IPNS key:  docker exec ipfs_host ipfs key gen fula-db-backup"
echo "    2. Set BACKUP_ENCRYPTION_KEY:  openssl rand -hex 32"
echo "    3. Add cron job:  0 3 * * * BACKUP_ENCRYPTION_KEY=<hex> $SCRIPT_DIR/scripts/backup-db.sh >> /var/log/fula-db-backup.log 2>&1"
echo ""
