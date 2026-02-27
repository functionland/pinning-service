#!/bin/bash
#
# Master Deployment Script for Pinning Service (Security Audit Release)
#
# This script ensures database migrations run BEFORE any service restarts.
# Without this order, services referencing new columns/tables will crash.
#
# Usage: sudo VITE_GOOGLE_CLIENT_ID=xxx VITE_WALLETCONNECT_PROJECT_ID=xxx bash ./deploy.sh [OPTIONS]
#
# Options:
#   --skip-pull          Skip git pull (already up to date)
#   --skip-go            Skip Go pinning-service rebuild
#   --migrations-only    Only run database migrations, don't deploy services
#   --services-only      Only deploy services (migrations already applied)
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

# Vite build-time env vars for pinning-webui frontend
# Override these or set them in your environment before running
VITE_GOOGLE_CLIENT_ID="${VITE_GOOGLE_CLIENT_ID:-}"
VITE_WALLETCONNECT_PROJECT_ID="${VITE_WALLETCONNECT_PROJECT_ID:-}"
VITE_APPLE_CLIENT_ID="${VITE_APPLE_CLIENT_ID:-land.fx.cloud}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# Flags
SKIP_PULL=false
SKIP_GO=false
MIGRATIONS_ONLY=false
SERVICES_ONLY=false
DRY_RUN=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-pull) SKIP_PULL=true; shift ;;
        --skip-go) SKIP_GO=true; shift ;;
        --migrations-only) MIGRATIONS_ONLY=true; shift ;;
        --services-only) SERVICES_ONLY=true; shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        -h|--help)
            head -18 "$0" | tail -15
            exit 0
            ;;
        *) shift ;;
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
if [ "$SKIP_PULL" = false ] && [ "$SERVICES_ONLY" = false ]; then
    log_step "Pulling latest code"
    run_cmd git pull
    log_ok "Code updated"
else
    log_info "Skipping git pull"
fi

# ============================================
# Step 2: Database Migrations (BEFORE service restarts)
# ============================================
if [ "$SERVICES_ONLY" = false ]; then
    log_step "Running database migrations"
    log_info "Migrations must complete before any service restart"

    MIGRATION_DIR="$SCRIPT_DIR/migrations/postgres"
    MIGRATION_FILES=(
        "006_encrypted_api_keys.sql"
        "007_cleanup_retry.sql"
        "008_admin_audit_log.sql"
    )

    for migration in "${MIGRATION_FILES[@]}"; do
        migration_path="$MIGRATION_DIR/$migration"
        if [ -f "$migration_path" ]; then
            log_info "Applying $migration..."
            if run_cmd psql -U "$DB_USER" -d "$DB_NAME" -f "$migration_path"; then
                log_ok "$migration applied"
            else
                log_err "$migration FAILED — aborting deployment"
                echo ""
                log_err "Fix the migration issue before restarting services."
                log_err "Services have NOT been restarted."
                exit 1
            fi
        else
            log_warn "$migration not found at $migration_path — skipping"
        fi
    done

    log_ok "All migrations applied successfully"
fi

if [ "$MIGRATIONS_ONLY" = true ]; then
    echo ""
    log_ok "Migrations complete. Run with --services-only to deploy services."
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
# Step 5: Deploy pinning-webui
# ============================================
log_step "Deploying pinning-webui"

WEBUI_SRC="$SCRIPT_DIR/pinning-webui"
WEBUI_TARGET="$DEPLOY_DIR/pinning-webui"

if [ -d "$WEBUI_SRC" ]; then
    log_info "Installing dependencies..."
    run_cmd bash -c "cd '$WEBUI_SRC' && npm install"

    log_info "Building pinning-webui (with Vite env vars)..."
    if [ -z "$VITE_GOOGLE_CLIENT_ID" ] || [ -z "$VITE_WALLETCONNECT_PROJECT_ID" ]; then
        log_warn "VITE_GOOGLE_CLIENT_ID or VITE_WALLETCONNECT_PROJECT_ID not set"
        log_warn "Set them via environment or the build will use empty values"
    fi
    run_cmd bash -c "cd '$WEBUI_SRC' && VITE_GOOGLE_CLIENT_ID='$VITE_GOOGLE_CLIENT_ID' VITE_WALLETCONNECT_PROJECT_ID='$VITE_WALLETCONNECT_PROJECT_ID' VITE_APPLE_CLIENT_ID='$VITE_APPLE_CLIENT_ID' npm run build"

    log_info "Copying build output to $WEBUI_TARGET..."
    run_cmd mkdir -p "$WEBUI_TARGET/dist"
    run_cmd bash -c "cp -r '$WEBUI_SRC/dist/'* '$WEBUI_TARGET/dist/'"
    run_cmd cp "$WEBUI_SRC/package.json" "$WEBUI_TARGET/"
    run_cmd cp "$WEBUI_SRC/package-lock.json" "$WEBUI_TARGET/" 2>/dev/null || true

    log_info "Installing production dependencies in target..."
    run_cmd bash -c "cd '$WEBUI_TARGET' && npm install --production --ignore-scripts=false"

    log_info "Running npm audit fix..."
    run_cmd bash -c "cd '$WEBUI_TARGET' && npm audit fix" || true

    log_info "Running npm rebuild..."
    run_cmd bash -c "cd '$WEBUI_TARGET' && npm rebuild"

    log_info "Restarting pinning-webui..."
    run_cmd systemctl restart fula-pinning-webui

    sleep 2
    if [ "$DRY_RUN" = false ] && systemctl is-active --quiet fula-pinning-webui; then
        log_ok "pinning-webui deployed and running"
    elif [ "$DRY_RUN" = false ]; then
        log_err "pinning-webui failed to start"
        journalctl -u fula-pinning-webui -n 10 --no-pager
    else
        log_ok "pinning-webui deploy (dry run)"
    fi
else
    log_warn "pinning-webui directory not found — skipping"
fi

# ============================================
# Step 6: Deploy ipfs-server
# ============================================
log_step "Deploying ipfs-server"

IPFS_SRC="$SCRIPT_DIR/ipfs-server"
IPFS_TARGET="$DEPLOY_DIR/ipfs-server"

if [ -d "$IPFS_SRC" ]; then
    log_info "Installing dependencies..."
    run_cmd bash -c "cd '$IPFS_SRC' && npm install --production=false"

    log_info "Running npm audit fix..."
    run_cmd bash -c "cd '$IPFS_SRC' && npm audit fix" || true

    log_info "Building ipfs-server..."
    run_cmd bash -c "cd '$IPFS_SRC' && npm run build"

    log_info "Stopping fula-upload-server..."
    run_cmd systemctl stop fula-upload-server || true

    log_info "Copying build output to $IPFS_TARGET..."
    run_cmd mkdir -p "$IPFS_TARGET/dist"
    run_cmd bash -c "cp -r '$IPFS_SRC/dist/'* '$IPFS_TARGET/dist/'"
    run_cmd cp "$IPFS_SRC/package.json" "$IPFS_TARGET/"
    run_cmd cp "$IPFS_SRC/package-lock.json" "$IPFS_TARGET/" 2>/dev/null || true

    log_info "Installing production dependencies in target..."
    run_cmd bash -c "cd '$IPFS_TARGET' && npm install --production --ignore-scripts=false"

    log_info "Starting fula-upload-server..."
    run_cmd systemctl start fula-upload-server

    sleep 2
    if [ "$DRY_RUN" = false ] && systemctl is-active --quiet fula-upload-server; then
        log_ok "ipfs-server deployed and running"
    elif [ "$DRY_RUN" = false ]; then
        log_err "ipfs-server failed to start"
        journalctl -u fula-upload-server -n 10 --no-pager
    else
        log_ok "ipfs-server deploy (dry run)"
    fi
else
    log_warn "ipfs-server directory not found — skipping"
fi

# ============================================
# Step 7: Deploy Go pinning-service (optional)
# ============================================
if [ "$SKIP_GO" = false ]; then
    log_step "Deploying Go pinning-service"

    if command -v go &>/dev/null && [ -f "$SCRIPT_DIR/main_postgres.go" ]; then
        log_info "Downloading Go modules..."
        run_cmd bash -c "cd '$SCRIPT_DIR' && go mod download"

        log_info "Building Go binary..."
        run_cmd bash -c "cd '$SCRIPT_DIR' && go build -o '$DEPLOY_DIR/ipfs-pinning' main_postgres.go"

        log_info "Stopping pinning-service..."
        run_cmd systemctl stop fula-pinning-service || true

        log_info "Starting pinning-service..."
        run_cmd systemctl start fula-pinning-service

        sleep 2
        if [ "$DRY_RUN" = false ] && systemctl is-active --quiet fula-pinning-service; then
            log_ok "Go pinning-service deployed and running"
        elif [ "$DRY_RUN" = false ]; then
            log_err "Go pinning-service failed to start"
            journalctl -u fula-pinning-service -n 10 --no-pager
        else
            log_ok "Go pinning-service deploy (dry run)"
        fi
    else
        log_warn "Go or main_postgres.go not found — skipping"
    fi
else
    log_info "Skipping Go pinning-service (--skip-go)"
fi

# ============================================
# Post-Deployment Verification
# ============================================
log_step "Post-deployment verification"

SERVICES=("x402-gateway" "fula-pinning-webui" "fula-upload-server" "fula-ai-service" "fula-pinning-service")
ALL_OK=true

for svc in "${SERVICES[@]}"; do
    if [ "$DRY_RUN" = true ]; then
        log_info "Would check: $svc"
        continue
    fi
    if systemctl is-active --quiet "$svc" 2>/dev/null; then
        log_ok "$svc is running"
    elif systemctl is-enabled --quiet "$svc" 2>/dev/null; then
        log_err "$svc is NOT running (but is enabled)"
        ALL_OK=false
    else
        log_warn "$svc is not installed/enabled — skipping"
    fi
done

# Verify migration columns exist
if [ "$DRY_RUN" = false ]; then
    log_info "Verifying migration columns..."

    if psql -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='api_keys' AND column_name='encrypted_key'" 2>/dev/null | grep -q "encrypted_key"; then
        log_ok "api_keys.encrypted_key column exists"
    else
        log_err "api_keys.encrypted_key column MISSING — migration 006 not applied"
        ALL_OK=false
    fi

    if psql -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='x402_ephemeral_objects' AND column_name='delete_attempts'" 2>/dev/null | grep -q "delete_attempts"; then
        log_ok "x402_ephemeral_objects.delete_attempts column exists"
    else
        log_err "x402_ephemeral_objects.delete_attempts column MISSING — migration 007 not applied"
        ALL_OK=false
    fi

    if psql -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT tablename FROM pg_tables WHERE tablename='admin_audit_log'" 2>/dev/null | grep -q "admin_audit_log"; then
        log_ok "admin_audit_log table exists"
    else
        log_err "admin_audit_log table MISSING — migration 008 not applied"
        ALL_OK=false
    fi
fi

# ============================================
# Summary
# ============================================
echo ""
echo -e "${BOLD}==========================================${NC}"
if [ "$ALL_OK" = true ] || [ "$DRY_RUN" = true ]; then
    echo -e "${BOLD}${GREEN}  Deployment Complete${NC}"
else
    echo -e "${BOLD}${YELLOW}  Deployment Complete (with warnings)${NC}"
fi
echo -e "${BOLD}==========================================${NC}"
echo ""

if [ "$ALL_OK" = false ]; then
    echo "Check service logs for errors:"
    echo "  journalctl -u <service-name> -n 20 --no-pager"
    echo ""
fi

echo "Optional: Set ENCRYPTION_KEY for API key encryption at rest"
echo "  openssl rand -hex 32"
echo "  Add ENCRYPTION_KEY=<hex> to pinning-webui's .env file"
echo ""
