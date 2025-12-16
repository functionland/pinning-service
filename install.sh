#!/bin/bash

# IPFS Pinning Service Installation Script
# This script installs or upgrades the IPFS Pinning Service with SQLite backend

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
DEFAULT_TARGET_DIR="/home/root/pinning-service"
DEFAULT_PORT="6000"
DEFAULT_IPFS_API_ADDR="/ip4/127.0.0.1/tcp/5001"
DEFAULT_POOL_ID="1"
DEFAULT_DB_PATH="data/pinning.db"
SERVICE_NAME="fula-pinning-service"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# Print colored message
print_msg() {
    local color=$1
    local msg=$2
    echo -e "${color}${msg}${NC}"
}

print_info() { print_msg "$BLUE" "[INFO] $1"; }
print_success() { print_msg "$GREEN" "[SUCCESS] $1"; }
print_warning() { print_msg "$YELLOW" "[WARNING] $1"; }
print_error() { print_msg "$RED" "[ERROR] $1"; }

# Check if running as root
check_root() {
    if [ "$EUID" -ne 0 ]; then
        print_error "Please run as root (use sudo)"
        exit 1
    fi
}

# Verify a step completed successfully
verify_step() {
    local step_name=$1
    local check_cmd=$2
    
    if eval "$check_cmd"; then
        print_success "$step_name completed successfully"
        return 0
    else
        print_error "$step_name failed"
        return 1
    fi
}

# Load existing .env file if it exists
load_existing_env() {
    local env_file="$1/.env"
    if [ -f "$env_file" ]; then
        print_info "Found existing .env file, loading defaults..."
        source "$env_file" 2>/dev/null || true
    fi
}

# Prompt for configuration value with default
prompt_value() {
    local prompt=$1
    local default=$2
    local var_name=$3
    local is_secret=${4:-false}
    
    if [ "$is_secret" = true ]; then
        read -sp "$prompt [$default]: " value
        echo
    else
        read -p "$prompt [$default]: " value
    fi
    
    if [ -z "$value" ]; then
        value="$default"
    fi
    
    eval "$var_name='$value'"
}

# Check if directory is empty (excluding hidden files)
is_dir_empty() {
    local dir=$1
    if [ -d "$dir" ]; then
        if [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then
            return 0
        fi
    fi
    return 1
}

# Detect installation type
detect_install_type() {
    local target_dir=$1
    
    if [ ! -d "$target_dir" ]; then
        echo "fresh"
    elif is_dir_empty "$target_dir"; then
        echo "fresh"
    elif [ -f "$target_dir/ipfs-pinning" ]; then
        echo "upgrade"
    else
        echo "fresh"
    fi
}

# Stop existing service if running
stop_service() {
    if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        print_info "Stopping existing service..."
        systemctl stop "$SERVICE_NAME"
        sleep 2
    fi
}

# Build the application
build_app() {
    local source_dir=$1
    local target_dir=$2
    
    print_info "Building application..."
    
    cd "$source_dir"
    
    # Download dependencies
    go mod download
    
    # Build with SQLite backend
    go build -o "$target_dir/ipfs-pinning" -tags "sqlite" main_sqlite.go
    
    verify_step "Build" "[ -f '$target_dir/ipfs-pinning' ]"
}

# Create directory structure
create_directories() {
    local target_dir=$1
    
    print_info "Creating directory structure..."
    
    mkdir -p "$target_dir"
    mkdir -p "$target_dir/data"
    mkdir -p "$target_dir/logs"
    
    verify_step "Directory creation" "[ -d '$target_dir/data' ] && [ -d '$target_dir/logs' ]"
}

# Generate .env file
generate_env_file() {
    local target_dir=$1
    
    print_info "Generating .env file..."
    
    cat > "$target_dir/.env" << EOF
# IPFS Pinning Service Configuration
# Generated on $(date)

# Server Configuration
PORT=${PORT}

# Database Configuration (SQLite)
DATABASE_PATH=${DATABASE_PATH}

# IPFS Configuration
IPFS_API_ADDR=${IPFS_API_ADDR}

# Blockchain Configuration
BLOCKCHAIN_API_ENDPOINT=${BLOCKCHAIN_API_ENDPOINT}
MASTER_SEED=${MASTER_SEED}
POOL_SEED=${POOL_SEED}
POOL_ID=${POOL_ID}
EOF

    chmod 600 "$target_dir/.env"
    
    verify_step ".env file creation" "[ -f '$target_dir/.env' ]"
}

# Create systemd service file
create_service_file() {
    local target_dir=$1
    
    print_info "Creating systemd service file..."
    
    cat > "$SERVICE_FILE" << EOF
[Unit]
Description=IPFS Pinning Service (SQLite Backend)
After=network.target ipfs.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=${target_dir}/ipfs-pinning
Restart=on-failure
RestartSec=10
User=root
WorkingDirectory=${target_dir}
Environment=PATH=/usr/bin:/usr/local/bin
EnvironmentFile=${target_dir}/.env

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${target_dir}/data ${target_dir}/logs

# Resource limits
LimitNOFILE=65535
MemoryMax=1G

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

    chmod 644 "$SERVICE_FILE"
    
    verify_step "Service file creation" "[ -f '$SERVICE_FILE' ]"
}

# Configure systemd service
configure_service() {
    print_info "Configuring systemd service..."
    
    systemctl daemon-reload
    verify_step "Systemd daemon reload" "true"
    
    systemctl enable "$SERVICE_NAME"
    verify_step "Service enable" "systemctl is-enabled --quiet $SERVICE_NAME"
}

# Start the service
start_service() {
    print_info "Starting service..."
    
    systemctl start "$SERVICE_NAME"
    sleep 3
    
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        print_success "Service started successfully"
        return 0
    else
        print_error "Service failed to start. Check logs with: journalctl -u $SERVICE_NAME -f"
        return 1
    fi
}

# Backup existing installation
backup_existing() {
    local target_dir=$1
    local backup_dir="${target_dir}.backup.$(date +%Y%m%d_%H%M%S)"
    
    print_info "Backing up existing installation to $backup_dir..."
    
    cp -r "$target_dir" "$backup_dir"
    
    verify_step "Backup" "[ -d '$backup_dir' ]"
}

# Initialize database (run a quick check)
init_database() {
    local target_dir=$1
    
    print_info "Initializing database..."
    
    # The application will create tables on first run
    # Just ensure the data directory exists and is writable
    
    touch "$target_dir/data/.init_check"
    rm -f "$target_dir/data/.init_check"
    
    print_success "Database directory ready"
}

# Main installation function
main() {
    echo ""
    echo "=========================================="
    echo "  IPFS Pinning Service Installer"
    echo "  (SQLite Backend)"
    echo "=========================================="
    echo ""
    
    check_root
    
    # Determine source directory (where this script is located)
    SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    
    # Get target directory
    prompt_value "Installation directory" "$DEFAULT_TARGET_DIR" "TARGET_DIR"
    
    # Load existing configuration if upgrading
    load_existing_env "$TARGET_DIR"
    
    # Detect installation type
    INSTALL_TYPE=$(detect_install_type "$TARGET_DIR")
    
    if [ "$INSTALL_TYPE" = "upgrade" ]; then
        print_warning "Existing installation detected. This will upgrade the service."
        read -p "Continue with upgrade? (y/N): " confirm
        if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
            print_info "Installation cancelled."
            exit 0
        fi
        
        # Backup existing installation
        backup_existing "$TARGET_DIR"
        
        # Stop existing service
        stop_service
    else
        print_info "Fresh installation detected."
    fi
    
    echo ""
    print_info "Please provide configuration values (press Enter for defaults):"
    echo ""
    
    # Prompt for configuration
    prompt_value "Server port" "${PORT:-$DEFAULT_PORT}" "PORT"
    prompt_value "Database path (relative to install dir)" "${DATABASE_PATH:-$DEFAULT_DB_PATH}" "DATABASE_PATH"
    prompt_value "IPFS API address" "${IPFS_API_ADDR:-$DEFAULT_IPFS_API_ADDR}" "IPFS_API_ADDR"
    prompt_value "Blockchain API endpoint" "${BLOCKCHAIN_API_ENDPOINT:-}" "BLOCKCHAIN_API_ENDPOINT"
    prompt_value "Master seed" "${MASTER_SEED:-}" "MASTER_SEED" true
    prompt_value "Pool seed" "${POOL_SEED:-}" "POOL_SEED" true
    prompt_value "Pool ID" "${POOL_ID:-$DEFAULT_POOL_ID}" "POOL_ID"
    
    # Validate required fields
    if [ -z "$BLOCKCHAIN_API_ENDPOINT" ] || [ -z "$MASTER_SEED" ] || [ -z "$POOL_SEED" ]; then
        print_error "BLOCKCHAIN_API_ENDPOINT, MASTER_SEED, and POOL_SEED are required."
        exit 1
    fi
    
    echo ""
    print_info "Starting installation..."
    echo ""
    
    # Create directories
    create_directories "$TARGET_DIR"
    
    # Build and copy application
    build_app "$SOURCE_DIR" "$TARGET_DIR"
    
    # Generate configuration
    generate_env_file "$TARGET_DIR"
    
    # Initialize database
    init_database "$TARGET_DIR"
    
    # Create and configure service
    create_service_file "$TARGET_DIR"
    configure_service
    
    # Start service
    start_service
    
    echo ""
    echo "=========================================="
    print_success "Installation completed successfully!"
    echo "=========================================="
    echo ""
    echo "Service Status:"
    systemctl status "$SERVICE_NAME" --no-pager -l || true
    echo ""
    echo "Useful commands:"
    echo "  - View logs:    journalctl -u $SERVICE_NAME -f"
    echo "  - Stop service: systemctl stop $SERVICE_NAME"
    echo "  - Start service: systemctl start $SERVICE_NAME"
    echo "  - Restart:      systemctl restart $SERVICE_NAME"
    echo ""
    echo "Configuration file: $TARGET_DIR/.env"
    echo "Database location:  $TARGET_DIR/$DATABASE_PATH"
    echo ""
}

# Run main function
main "$@"
