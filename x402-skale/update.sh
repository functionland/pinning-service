#!/bin/bash
#
# x402-skale Update Script
#
# Performs incremental updates to avoid duplicate work:
# - Skips npm install if package.json hasn't changed
# - Skips TypeScript build if no source files changed
# - Copies dist to target only if rebuild happened
# - Only restarts service if files were deployed
#
# Usage: ./update.sh [--force] [--no-restart] [--target /path/to/target]
#
# Options:
#   --force         Force rebuild even if no changes detected
#   --no-restart    Don't restart the service after update
#   --target PATH   Deploy to target directory (default: /opt/x402-gateway)
#

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SERVICE_NAME="x402-gateway"
SRC_DIR="src"
DIST_DIR="dist"
CHECKSUM_DIR=".checksums"
CHECKSUM_PKG="$CHECKSUM_DIR/package.json.md5"
CHECKSUM_SRC="$CHECKSUM_DIR/src.md5"

# Default target directory (where service runs from)
TARGET_DIR="/opt/x402-gateway"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse arguments
FORCE=false
NO_RESTART=false
while [[ $# -gt 0 ]]; do
    case $1 in
        --force)
            FORCE=true
            shift
            ;;
        --no-restart)
            NO_RESTART=true
            shift
            ;;
        --target)
            TARGET_DIR="$2"
            shift 2
            ;;
        --target=*)
            TARGET_DIR="${1#*=}"
            shift
            ;;
        --help|-h)
            echo "Usage: ./update.sh [--force] [--no-restart] [--target /path/to/target]"
            echo ""
            echo "Options:"
            echo "  --force         Force rebuild even if no changes detected"
            echo "  --no-restart    Don't restart the service after update"
            echo "  --target PATH   Deploy to target directory (default: /opt/x402-gateway)"
            echo ""
            echo "Source directory: $SCRIPT_DIR"
            echo "Target directory: $TARGET_DIR"
            exit 0
            ;;
        *)
            shift
            ;;
    esac
done

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[SKIP]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Ensure checksum directory exists
mkdir -p "$CHECKSUM_DIR"

# Calculate checksum of package.json and package-lock.json
get_package_checksum() {
    cat package.json package-lock.json 2>/dev/null | md5sum | cut -d' ' -f1
}

# Calculate checksum of all source files
get_src_checksum() {
    find "$SRC_DIR" -name "*.ts" -type f -exec md5sum {} \; 2>/dev/null | sort | md5sum | cut -d' ' -f1
}

# Check if npm install is needed
check_npm_install() {
    local current_checksum=$(get_package_checksum)
    local stored_checksum=""

    if [ -f "$CHECKSUM_PKG" ]; then
        stored_checksum=$(cat "$CHECKSUM_PKG")
    fi

    if [ "$FORCE" = true ]; then
        return 0  # Need install
    fi

    if [ ! -d "node_modules" ]; then
        return 0  # Need install
    fi

    if [ "$current_checksum" != "$stored_checksum" ]; then
        return 0  # Need install
    fi

    return 1  # No install needed
}

# Check if TypeScript build is needed
check_build_needed() {
    local current_checksum=$(get_src_checksum)
    local stored_checksum=""

    if [ -f "$CHECKSUM_SRC" ]; then
        stored_checksum=$(cat "$CHECKSUM_SRC")
    fi

    if [ "$FORCE" = true ]; then
        return 0  # Need build
    fi

    if [ ! -d "$DIST_DIR" ]; then
        return 0  # Need build
    fi

    if [ "$current_checksum" != "$stored_checksum" ]; then
        return 0  # Need build
    fi

    return 1  # No build needed
}

# Save checksums after successful operations
save_package_checksum() {
    get_package_checksum > "$CHECKSUM_PKG"
}

save_src_checksum() {
    get_src_checksum > "$CHECKSUM_SRC"
}

# Check if service is running
is_service_running() {
    systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null
}

# Deploy to target directory
deploy_to_target() {
    if [ ! -d "$TARGET_DIR" ]; then
        log_info "Creating target directory: $TARGET_DIR"
        sudo mkdir -p "$TARGET_DIR"
    fi

    log_info "Deploying to $TARGET_DIR..."

    # Copy dist folder
    sudo rsync -av --delete "$DIST_DIR/" "$TARGET_DIR/dist/"

    # Copy package files (needed for node to resolve dependencies)
    sudo cp package.json "$TARGET_DIR/"
    sudo cp package-lock.json "$TARGET_DIR/" 2>/dev/null || true

    # Sync node_modules (only copy if target doesn't have it or package changed)
    if [ ! -d "$TARGET_DIR/node_modules" ] || [ "$npm_updated" = true ]; then
        log_info "Syncing node_modules to target..."
        sudo rsync -av --delete "node_modules/" "$TARGET_DIR/node_modules/"
    fi

    # Copy .env if exists and target doesn't have one
    if [ -f ".env" ] && [ ! -f "$TARGET_DIR/.env" ]; then
        log_info "Copying .env to target (first deploy only)"
        sudo cp .env "$TARGET_DIR/.env"
    fi

    # Ensure data directory exists
    sudo mkdir -p "$TARGET_DIR/data"

    # Set ownership (adjust user as needed)
    if id "node" &>/dev/null; then
        sudo chown -R node:node "$TARGET_DIR"
    fi

    log_success "Deployed to $TARGET_DIR"
}

# Main update process
main() {
    echo ""
    echo "=========================================="
    echo "  x402-skale Update Script"
    echo "=========================================="
    echo ""
    echo "  Source: $SCRIPT_DIR"
    echo "  Target: $TARGET_DIR"
    echo ""

    local npm_updated=false
    local build_updated=false
    local deployed=false

    # Step 1: Check and run npm install if needed
    log_info "Checking dependencies..."
    if check_npm_install; then
        log_info "Installing/updating npm dependencies..."
        if npm install --no-bin-links 2>&1; then
            save_package_checksum
            npm_updated=true
            log_success "Dependencies updated"
        else
            log_error "npm install failed"
            exit 1
        fi
    else
        log_warning "Dependencies up to date (skipping npm install)"
    fi

    # Step 2: Check and run TypeScript build if needed
    log_info "Checking source files..."
    if check_build_needed || [ "$npm_updated" = true ]; then
        log_info "Building TypeScript..."
        if npm run build 2>&1; then
            save_src_checksum
            build_updated=true
            log_success "Build completed"
        else
            log_error "Build failed"
            exit 1
        fi
    else
        log_warning "Source unchanged (skipping build)"
    fi

    # Step 3: Deploy to target if build was updated
    if [ "$build_updated" = true ] || [ "$npm_updated" = true ]; then
        deploy_to_target
        deployed=true
    else
        log_warning "No changes to deploy"
    fi

    # Step 4: Run database migrations if deployed
    if [ "$deployed" = true ]; then
        log_info "Running database migrations..."
        if (cd "$TARGET_DIR" && node dist/scripts/migrate.js 2>&1) || \
           (cd "$SCRIPT_DIR" && npm run migrate 2>&1); then
            log_success "Database migrations complete"
        else
            log_warning "Migration script not available (non-fatal)"
        fi
    fi

    # Step 5: Restart service if needed
    if [ "$NO_RESTART" = false ]; then
        if [ "$deployed" = true ]; then
            log_info "Restarting service..."
            if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
                if sudo systemctl restart "$SERVICE_NAME"; then
                    sleep 2
                    if is_service_running; then
                        log_success "Service restarted successfully"
                    else
                        log_error "Service failed to start"
                        sudo journalctl -u "$SERVICE_NAME" -n 20 --no-pager
                        exit 1
                    fi
                else
                    log_error "Failed to restart service"
                    exit 1
                fi
            else
                log_warning "Service not installed (skipping restart)"
            fi
        else
            log_warning "No changes detected (skipping service restart)"
        fi
    else
        log_warning "Service restart disabled (--no-restart)"
    fi

    # Summary
    echo ""
    echo "=========================================="
    echo "  Update Summary"
    echo "=========================================="
    echo ""

    if [ "$npm_updated" = true ]; then
        echo -e "  Dependencies: ${GREEN}Updated${NC}"
    else
        echo -e "  Dependencies: ${YELLOW}Unchanged${NC}"
    fi

    if [ "$build_updated" = true ]; then
        echo -e "  Build:        ${GREEN}Updated${NC}"
    else
        echo -e "  Build:        ${YELLOW}Unchanged${NC}"
    fi

    if [ "$deployed" = true ]; then
        echo -e "  Deployed:     ${GREEN}Yes${NC} -> $TARGET_DIR"
    else
        echo -e "  Deployed:     ${YELLOW}No${NC}"
    fi

    if [ "$NO_RESTART" = false ] && [ "$deployed" = true ]; then
        if is_service_running; then
            echo -e "  Service:      ${GREEN}Running${NC}"
        else
            echo -e "  Service:      ${RED}Not running${NC}"
        fi
    else
        echo -e "  Service:      ${YELLOW}Not restarted${NC}"
    fi

    echo ""
    log_success "Update complete!"
    echo ""
}

# Run main function
main "$@"
