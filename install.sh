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
DEFAULT_IPFS_CLUSTER_API_ADDR="/ip4/127.0.0.1/tcp/9094"
DEFAULT_ENABLE_IPFS_PINNING="false"
DEFAULT_DB_PATH="data/pinning.db"

# Pinning service
SERVICE_NAME="fula-pinning-service"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# IPFS Gateway/Upload server
GATEWAY_SERVICE_NAME="fula-upload-server"
GATEWAY_SERVICE_FILE="/etc/systemd/system/${GATEWAY_SERVICE_NAME}.service"
DEFAULT_GATEWAY_PORT="3300"

# WebUI server
WEBUI_SERVICE_NAME="fula-pinning-webui"
WEBUI_SERVICE_FILE="/etc/systemd/system/${WEBUI_SERVICE_NAME}.service"
DEFAULT_WEBUI_PORT="3001"

# Nginx configuration
NGINX_AVAILABLE="/etc/nginx/sites-available"
NGINX_ENABLED="/etc/nginx/sites-enabled"

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

# Source nvm if available (for correct Node.js version)
setup_node_env() {
    # Try to source nvm from common locations
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [ -s "$NVM_DIR/nvm.sh" ]; then
        source "$NVM_DIR/nvm.sh"
        print_info "Using nvm Node.js: $(node -v)"
    elif [ -s "/root/.nvm/nvm.sh" ]; then
        export NVM_DIR="/root/.nvm"
        source "$NVM_DIR/nvm.sh"
        print_info "Using nvm Node.js: $(node -v)"
    elif [ -s "$HOME/.nvm/nvm.sh" ]; then
        export NVM_DIR="$HOME/.nvm"
        source "$NVM_DIR/nvm.sh"
        print_info "Using nvm Node.js: $(node -v)"
    fi
}

# Load existing .env files from all services if they exist
load_existing_env() {
    local target_dir="$1"
    
    # Load pinning service env
    if [ -f "$target_dir/.env" ]; then
        print_info "Found existing pinning service .env file, loading defaults..."
        source "$target_dir/.env" 2>/dev/null || true
    fi
    
    # Load ipfs-server env
    if [ -f "$target_dir/ipfs-server/.env" ]; then
        print_info "Found existing ipfs-server .env file, loading defaults..."
        source "$target_dir/ipfs-server/.env" 2>/dev/null || true
    fi
    
    # Load webui env
    if [ -f "$target_dir/pinning-webui/.env" ]; then
        print_info "Found existing webui .env file, loading defaults..."
        source "$target_dir/pinning-webui/.env" 2>/dev/null || true
    fi
    
    # Sanitize DATABASE_PATH - fix duplicated paths
    if [ -n "$DATABASE_PATH" ]; then
        # If path contains duplicated target_dir, extract just the relative part
        if [[ "$DATABASE_PATH" == *"$target_dir"*"$target_dir"* ]]; then
            print_warning "Detected corrupted DATABASE_PATH, fixing..."
            DATABASE_PATH="data/pinning.db"
        # If it's already an absolute path, convert to relative
        elif [[ "$DATABASE_PATH" == /* ]]; then
            # Extract just the relative path after target_dir
            DATABASE_PATH="${DATABASE_PATH##$target_dir/}"
            # If still absolute, use default
            if [[ "$DATABASE_PATH" == /* ]]; then
                DATABASE_PATH="data/pinning.db"
            fi
        fi
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
        print_info "Stopping existing pinning service..."
        systemctl stop "$SERVICE_NAME"
        sleep 2
    fi
}

# Stop existing gateway service if running
stop_gateway_service() {
    if systemctl is-active --quiet "$GATEWAY_SERVICE_NAME" 2>/dev/null; then
        print_info "Stopping existing gateway service..."
        systemctl stop "$GATEWAY_SERVICE_NAME"
        sleep 2
    fi
}

# Stop existing webui service if running
stop_webui_service() {
    if systemctl is-active --quiet "$WEBUI_SERVICE_NAME" 2>/dev/null; then
        print_info "Stopping existing WebUI service..."
        systemctl stop "$WEBUI_SERVICE_NAME"
        sleep 2
    fi
}

# Build the application
build_app() {
    local source_dir=$1
    local target_dir=$2
    
    print_info "Building pinning service..."
    
    cd "$source_dir"
    
    # Download dependencies
    go mod download
    
    # Build with SQLite backend
    go build -o "$target_dir/ipfs-pinning" -tags "sqlite" main_sqlite.go
    
    verify_step "Pinning service build" "[ -f '$target_dir/ipfs-pinning' ]"
}

# Build the IPFS gateway server
build_gateway() {
    local source_dir=$1
    local target_dir=$2
    
    print_info "Building IPFS gateway server..."
    
    # Check if Node.js is installed
    if ! command -v node &> /dev/null; then
        print_warning "Node.js not found. Skipping gateway build."
        print_info "Install Node.js 18+ and run: cd $target_dir/ipfs-server && npm install && npm run build"
        return 1
    fi
    
    # Check Node.js version
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        print_warning "Node.js 18+ required. Found: $(node -v). Skipping gateway build."
        return 1
    fi
    
    cd "$source_dir/ipfs-server"
    
    # Install dependencies
    print_info "Installing Node.js dependencies..."
    npm install --production=false
    
    # Build the application
    print_info "Building gateway server..."
    npm run build
    
    # Copy built files to target
    mkdir -p "$target_dir/ipfs-server/dist"
    mkdir -p "$target_dir/ipfs-server/uploads"
    cp -r dist/* "$target_dir/ipfs-server/dist/"
    
    # Copy package files for production dependencies
    cp package.json "$target_dir/ipfs-server/"
    cp package-lock.json "$target_dir/ipfs-server/" 2>/dev/null || true
    
    # Install production dependencies in target directory (for native modules like better-sqlite3)
    print_info "Installing production dependencies in target directory..."
    cd "$target_dir/ipfs-server"
    npm install --production --ignore-scripts=false
    
    verify_step "Gateway build" "[ -f '$target_dir/ipfs-server/dist/index.js' ] || [ -f '$target_dir/ipfs-server/dist/ipfs-gateway' ]"
}

# Build the WebUI
build_webui() {
    local source_dir=$1
    local target_dir=$2
    
    print_info "Building Pinning WebUI..."
    
    # Check if Node.js is installed
    if ! command -v node &> /dev/null; then
        print_warning "Node.js not found. Skipping WebUI build."
        return 1
    fi
    
    # Check Node.js version
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        print_warning "Node.js 18+ required. Found: $(node -v). Skipping WebUI build."
        return 1
    fi
    
    cd "$source_dir/pinning-webui"
    
    # Install dependencies
    print_info "Installing WebUI dependencies..."
    npm install
    
    # Build the application
    # VITE_GOOGLE_CLIENT_ID must be set at build time for Vite to embed it
    print_info "Building WebUI..."
    if [ -n "$GOOGLE_CLIENT_ID" ]; then
        VITE_GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" npm run build
    else
        npm run build
    fi
    
    # Copy built files to target
    mkdir -p "$target_dir/pinning-webui/dist"
    cp -r dist/* "$target_dir/pinning-webui/dist/"
    
    # Copy package files for production dependencies
    cp package.json "$target_dir/pinning-webui/"
    cp package-lock.json "$target_dir/pinning-webui/" 2>/dev/null || true
    
    # Install production dependencies in target directory (for native modules like better-sqlite3)
    print_info "Installing production dependencies in target directory..."
    cd "$target_dir/pinning-webui"
    npm install --production --ignore-scripts=false
    
    # Rebuild native modules with current Node version
    print_info "Rebuilding native modules for Node $(node -v)..."
    npm rebuild
    
    verify_step "WebUI build" "[ -d '$target_dir/pinning-webui/dist/public' ]"
}

# Create directory structure
create_directories() {
    local target_dir=$1
    
    print_info "Creating directory structure..."
    
    mkdir -p "$target_dir"
    mkdir -p "$target_dir/data"
    mkdir -p "$target_dir/logs"
    mkdir -p "$target_dir/ipfs-server/dist"
    mkdir -p "$target_dir/ipfs-server/uploads"
    mkdir -p "$target_dir/ipfs-server/.well-known/acme-challenge"
    mkdir -p "$target_dir/pinning-webui/dist"
    
    verify_step "Directory creation" "[ -d '$target_dir/data' ] && [ -d '$target_dir/ipfs-server' ]"
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
IPFS_CLUSTER_API_ADDR=${IPFS_CLUSTER_API_ADDR}
ENABLE_IPFS_PINNING=${ENABLE_IPFS_PINNING}

# Domain Configuration (for nginx/SSL)
PINNING_DOMAIN=${PINNING_DOMAIN}
SSL_EMAIL=${SSL_EMAIL}

# Admin API (optional - set to enable admin endpoints)
# SYSTEM_KEY=your-secret-admin-key
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
ProtectHome=false
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

# Generate gateway .env file
generate_gateway_env_file() {
    local target_dir=$1
    
    print_info "Generating gateway .env file..."
    
    cat > "$target_dir/ipfs-server/.env" << EOF
# IPFS Gateway Server Configuration
# Generated on $(date)

# Server Configuration
GATEWAY_PORT=${GATEWAY_PORT}

# Database Configuration (read-only access to pinning service DB)
# Use absolute path if DATABASE_PATH starts with /, otherwise relative to target_dir
DATABASE_PATH=$(if [[ "${DATABASE_PATH}" == /* ]]; then echo "${DATABASE_PATH}"; else echo "${target_dir}/${DATABASE_PATH}"; fi)

# IPFS Configuration
IPFS_API_URL=http://127.0.0.1:5001

# Upload Configuration
UPLOAD_DIR=${target_dir}/ipfs-server/uploads
MAX_FILE_SIZE=838860800
IPFS_TIMEOUT=60000

# Domain Configuration (for nginx/SSL)
IPFS_SERVER_DOMAIN=${IPFS_SERVER_DOMAIN}
EOF

    chmod 600 "$target_dir/ipfs-server/.env"
    
    verify_step "Gateway .env file creation" "[ -f '$target_dir/ipfs-server/.env' ]"
}

# Create gateway systemd service file
create_gateway_service_file() {
    local target_dir=$1
    
    print_info "Creating gateway systemd service file..."
    
    cat > "$GATEWAY_SERVICE_FILE" << EOF
[Unit]
Description=IPFS Gateway and Upload Server
Documentation=https://github.com/functionland/pinning-service
After=network.target ipfs.service fula-pinning-service.service
Wants=network-online.target
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
Type=simple
ExecStart=${target_dir}/ipfs-server/dist/ipfs-gateway
Restart=on-failure
RestartSec=10
User=root
WorkingDirectory=${target_dir}/ipfs-server
Environment=PATH=/usr/bin:/usr/local/bin
Environment=NODE_ENV=production
EnvironmentFile=${target_dir}/ipfs-server/.env

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=false
ReadWritePaths=${target_dir}/ipfs-server/uploads ${target_dir}/data

# Resource limits
LimitNOFILE=65535
MemoryMax=2G

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=fula-upload-server

[Install]
WantedBy=multi-user.target
EOF

    chmod 644 "$GATEWAY_SERVICE_FILE"
    
    verify_step "Gateway service file creation" "[ -f '$GATEWAY_SERVICE_FILE' ]"
}

# Generate WebUI .env file
generate_webui_env_file() {
    local target_dir=$1

    print_info "Generating WebUI .env file..."

    # Generate a random session secret
    SESSION_SECRET=$(openssl rand -hex 32 2>/dev/null || cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 64 | head -n 1)

    cat > "$target_dir/pinning-webui/.env" << EOF
# FULA Pinning WebUI Configuration
# Generated on $(date)

# Server port
WEBUI_PORT=${WEBUI_PORT}

# Node environment
NODE_ENV=production

# Database path (same as pinning service)
# Use absolute path if DATABASE_PATH starts with /, otherwise relative to target_dir
DATABASE_PATH=$(if [[ "${DATABASE_PATH}" == /* ]]; then echo "${DATABASE_PATH}"; else echo "${target_dir}/${DATABASE_PATH}"; fi)

# Google OAuth Client ID
# Get this from: https://console.cloud.google.com/apis/credentials
# Both variables use the same value - backend needs GOOGLE_CLIENT_ID, frontend needs VITE_ prefix
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
VITE_GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}

# Session secret (auto-generated)
SESSION_SECRET=${SESSION_SECRET}

# Pinning service URL
PINNING_SERVICE_URL=http://localhost:${PORT}

# Domain Configuration (for nginx/SSL)
WEBUI_DOMAIN=${WEBUI_DOMAIN}

# ============================================
# Web3 Payment Configuration (FULA Token)
# ============================================

# Vault address to receive FULA payments
# IMPORTANT: Set this to your actual wallet address to enable payments
VAULT_ADDRESS=${VAULT_ADDRESS:-0x0000000000000000000000000000000000000000}

# Free tier storage limit in bytes (default: 500MB)
FREE_TIER_BYTES=${FREE_TIER_BYTES:-524288000}

# FULA price per GB per month (default: 3)
FULA_PER_GB_MONTH=${FULA_PER_GB_MONTH:-3}

# Etherscan API key for block scanning (Base/Ethereum)
# Get from: https://etherscan.io/apis
ETHERSCAN_API_KEY=${ETHERSCAN_API_KEY:-}

# Admin emails (comma-separated) - can manage suspended users
ADMIN_EMAILS=${ADMIN_EMAILS:-}
EOF

    chmod 600 "$target_dir/pinning-webui/.env"

    verify_step "WebUI .env file creation" "[ -f '$target_dir/pinning-webui/.env' ]"
}

# Create WebUI systemd service file
create_webui_service_file() {
    local target_dir=$1
    
    print_info "Creating WebUI systemd service file..."
    
    # Get the actual node path
    local node_path=$(which node)
    
    cat > "$WEBUI_SERVICE_FILE" << EOF
[Unit]
Description=FULA Pinning Service WebUI
Documentation=https://github.com/functionland/pinning-service
After=network.target fula-pinning-service.service
Wants=network-online.target
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
Type=simple
ExecStart=${node_path} ${target_dir}/pinning-webui/dist/server.mjs
Restart=on-failure
RestartSec=10
User=root
WorkingDirectory=${target_dir}/pinning-webui
Environment=PATH=/usr/bin:/usr/local/bin:/usr/local/node/bin
Environment=NODE_ENV=production
EnvironmentFile=${target_dir}/pinning-webui/.env

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=false
ReadWritePaths=${target_dir}/data ${target_dir}/pinning-webui

# Resource limits
LimitNOFILE=65535
MemoryMax=512M

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${WEBUI_SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

    chmod 644 "$WEBUI_SERVICE_FILE"
    
    verify_step "WebUI service file creation" "[ -f '$WEBUI_SERVICE_FILE' ]"
}

# Configure and start WebUI service
configure_webui_service() {
    print_info "Configuring WebUI systemd service..."
    
    systemctl daemon-reload
    systemctl enable "$WEBUI_SERVICE_NAME"
    
    verify_step "WebUI service configuration" "systemctl is-enabled '$WEBUI_SERVICE_NAME'"
}

# Start WebUI service
start_webui_service() {
    print_info "Starting WebUI service..."
    
    systemctl start "$WEBUI_SERVICE_NAME"
    sleep 3
    
    if systemctl is-active --quiet "$WEBUI_SERVICE_NAME"; then
        print_success "WebUI service started successfully"
    else
        print_error "WebUI service failed to start"
        journalctl -u "$WEBUI_SERVICE_NAME" -n 20 --no-pager
        return 1
    fi
}

# Configure systemd service
configure_service() {
    print_info "Configuring systemd service..."
    
    systemctl daemon-reload
    verify_step "Systemd daemon reload" "true"
    
    systemctl enable "$SERVICE_NAME"
    verify_step "Service enable" "systemctl is-enabled --quiet $SERVICE_NAME"
}

# Configure gateway systemd service
configure_gateway_service() {
    print_info "Configuring gateway systemd service..."
    
    systemctl daemon-reload
    
    systemctl enable "$GATEWAY_SERVICE_NAME"
    verify_step "Gateway service enable" "systemctl is-enabled --quiet $GATEWAY_SERVICE_NAME"
}

# Start the gateway service
start_gateway_service() {
    print_info "Starting gateway service..."
    
    systemctl start "$GATEWAY_SERVICE_NAME"
    sleep 3
    
    if systemctl is-active --quiet "$GATEWAY_SERVICE_NAME"; then
        print_success "Gateway service started successfully"
        return 0
    else
        print_warning "Gateway service failed to start. Check logs with: journalctl -u $GATEWAY_SERVICE_NAME -f"
        return 1
    fi
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

# ============================================================================
# Nginx and SSL/Certbot Functions
# ============================================================================

# Check if nginx is installed
check_nginx_installed() {
    if command -v nginx &> /dev/null; then
        return 0
    fi
    return 1
}

# Install nginx if not present
install_nginx() {
    if check_nginx_installed; then
        print_info "Nginx is already installed"
        return 0
    fi
    
    print_info "Installing nginx..."
    
    if command -v apt-get &> /dev/null; then
        apt-get update
        apt-get install -y nginx
    elif command -v yum &> /dev/null; then
        yum install -y nginx
    elif command -v dnf &> /dev/null; then
        dnf install -y nginx
    else
        print_error "Could not determine package manager. Please install nginx manually."
        return 1
    fi
    
    systemctl enable nginx
    systemctl start nginx
    
    verify_step "Nginx installation" "check_nginx_installed"
}

# Install certbot if not present
install_certbot() {
    if command -v certbot &> /dev/null; then
        print_info "Certbot is already installed"
        return 0
    fi
    
    print_info "Installing certbot..."
    
    if command -v apt-get &> /dev/null; then
        apt-get update
        apt-get install -y certbot python3-certbot-nginx
    elif command -v yum &> /dev/null; then
        yum install -y certbot python3-certbot-nginx
    elif command -v dnf &> /dev/null; then
        dnf install -y certbot python3-certbot-nginx
    else
        print_error "Could not determine package manager. Please install certbot manually."
        return 1
    fi
    
    verify_step "Certbot installation" "command -v certbot &> /dev/null"
}

# Check if nginx config exists for domain
check_nginx_config_exists() {
    local domain=$1
    
    if [ -f "$NGINX_AVAILABLE/$domain" ] || [ -f "$NGINX_AVAILABLE/${domain}.conf" ]; then
        return 0
    fi
    return 1
}

# Check if SSL certificate exists and is valid for domain
check_ssl_exists() {
    local domain=$1
    
    if [ -d "/etc/letsencrypt/live/$domain" ]; then
        # Check if cert is not expired (valid for at least 7 days)
        if openssl x509 -checkend 604800 -noout -in "/etc/letsencrypt/live/$domain/fullchain.pem" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

# Check if nginx config exists, is enabled, and nginx is running properly
check_nginx_config_valid() {
    local domain=$1
    
    # Check if config file exists
    if [ ! -f "$NGINX_AVAILABLE/$domain" ]; then
        return 1
    fi
    
    # Check if it's enabled (symlink exists)
    if [ ! -L "$NGINX_ENABLED/$domain" ]; then
        return 1
    fi
    
    # Check if nginx config test passes
    if ! nginx -t 2>/dev/null; then
        return 1
    fi
    
    # Check if nginx is running
    if ! systemctl is-active --quiet nginx; then
        return 1
    fi
    
    return 0
}

# Create nginx configuration for the services
create_nginx_config() {
    local domain=$1
    local target_dir=$2
    local pinning_port=$3
    local gateway_port=$4
    
    print_info "Creating nginx configuration for $domain..."
    
    local config_file="$NGINX_AVAILABLE/$domain"
    
    cat > "$config_file" << EOF
# Nginx configuration for IPFS Pinning Service
# Domain: $domain
# Generated on $(date)

# Upstream servers
upstream pinning_service {
    server 127.0.0.1:$pinning_port;
    keepalive 32;
}

upstream gateway_service {
    server 127.0.0.1:$gateway_port;
    keepalive 32;
}

# HTTP server - redirect to HTTPS (will be modified by certbot)
server {
    listen 80;
    listen [::]:80;
    server_name $domain;
    
    # Allow ACME challenge
    location /.well-known/acme-challenge/ {
        root ${target_dir}/ipfs-server;
        allow all;
    }
    
    # Redirect all other traffic to HTTPS
    location / {
        return 301 https://\$host\$request_uri;
    }
}

# HTTPS server (certbot will add SSL config)
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $domain;
    
    # SSL configuration will be added by certbot
    # ssl_certificate /etc/letsencrypt/live/$domain/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/$domain/privkey.pem;
    
    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    
    # Logging
    access_log /var/log/nginx/${domain}_access.log;
    error_log /var/log/nginx/${domain}_error.log;
    
    # Client body size for file uploads
    client_max_body_size 800M;
    
    # Timeouts
    proxy_connect_timeout 60s;
    proxy_send_timeout 300s;
    proxy_read_timeout 300s;
    
    # Pinning Service API (/pins, /admin, etc.)
    location /pins {
        proxy_pass http://pinning_service;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        
        # CORS headers
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, POST, DELETE, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Authorization, Content-Type" always;
        
        if (\$request_method = OPTIONS) {
            return 204;
        }
    }
    
    location /admin {
        proxy_pass http://pinning_service;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
    }
    
    # IPFS Gateway (/gateway, /upload)
    location /gateway {
        proxy_pass http://gateway_service;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        
        # Cache for immutable IPFS content
        proxy_cache_valid 200 365d;
        add_header Cache-Control "public, max-age=31536000, immutable";
        
        # CORS headers
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, OPTIONS" always;
        add_header Access-Control-Allow-Headers "*" always;
    }
    
    location /upload {
        proxy_pass http://gateway_service;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        
        # Large file upload timeout
        proxy_read_timeout 600s;
    }
    
    location /health {
        proxy_pass http://gateway_service;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    
    # Default - serve pinning service
    location / {
        proxy_pass http://pinning_service;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
    }
}
EOF

    chmod 644 "$config_file"
    
    # Enable the site
    if [ ! -L "$NGINX_ENABLED/$domain" ]; then
        ln -s "$config_file" "$NGINX_ENABLED/$domain"
    fi
    
    # Test nginx configuration
    if nginx -t 2>/dev/null; then
        print_success "Nginx configuration created and validated"
        return 0
    else
        print_error "Nginx configuration test failed"
        nginx -t
        return 1
    fi
}

# Create nginx configuration for WebUI
# Creates HTTP-only config first - certbot will add SSL
create_webui_nginx_config() {
    local domain=$1
    local target_dir=$2
    local webui_port=$3
    
    local config_file="$NGINX_AVAILABLE/$domain"
    
    # Check if nginx config is already valid - skip recreation
    if check_nginx_config_valid "$domain"; then
        print_info "Nginx configuration for WebUI at $domain is already valid, skipping..."
        return 0
    fi
    
    print_info "Creating nginx configuration for WebUI at $domain..."
    
    # Remove old config if exists (may have broken SSL blocks)
    rm -f "$config_file" "$NGINX_ENABLED/$domain" 2>/dev/null || true
    
    cat > "$config_file" << EOF
# Nginx configuration for IPFS Pinning WebUI
# Domain: $domain
# Generated on $(date)

# Upstream WebUI server
upstream webui_service {
    server 127.0.0.1:$webui_port;
    keepalive 32;
}

# HTTP server (certbot will add HTTPS redirect and SSL server block)
server {
    listen 80;
    listen [::]:80;
    server_name $domain;
    
    # Allow ACME challenge
    location /.well-known/acme-challenge/ {
        root ${target_dir}/pinning-webui;
        allow all;
    }
    
    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    
    # Logging
    access_log /var/log/nginx/${domain}_access.log;
    error_log /var/log/nginx/${domain}_error.log;
    
    # Proxy all requests to WebUI
    location / {
        proxy_pass http://webui_service;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF

    chmod 644 "$config_file"
    
    # Enable the site
    if [ ! -L "$NGINX_ENABLED/$domain" ]; then
        ln -s "$config_file" "$NGINX_ENABLED/$domain"
    fi
    
    # Test nginx configuration
    if nginx -t 2>/dev/null; then
        print_success "WebUI nginx configuration created and validated"
        return 0
    else
        print_error "WebUI nginx configuration test failed"
        nginx -t
        return 1
    fi
}

# Setup SSL for WebUI domain
setup_webui_nginx_ssl() {
    local domain=$1
    local email=$2
    local target_dir=$3
    local webui_port=$4
    
    # Install nginx if needed
    install_nginx
    
    # Create nginx configuration for WebUI
    if ! create_webui_nginx_config "$domain" "$target_dir" "$webui_port"; then
        print_error "Failed to create WebUI nginx configuration"
        return 1
    fi
    
    # Reload nginx to apply configuration
    reload_nginx
    
    # Setup SSL if email provided
    if [ -n "$email" ]; then
        if setup_ssl "$domain" "$email"; then
            print_success "SSL certificate obtained for WebUI"
        else
            print_warning "SSL setup failed for WebUI, but nginx is configured"
        fi
        
        # Setup auto-renewal
        setup_ssl_auto_renewal
        
        # Reload nginx after SSL setup
        reload_nginx
    else
        print_warning "No email provided, skipping SSL setup for WebUI"
        print_info "You can manually run: certbot --nginx -d $domain"
    fi
    
    return 0
}

# Create nginx configuration for IPFS Server (standalone domain)
# Creates HTTP-only config first - certbot will add SSL
create_ipfs_server_nginx_config() {
    local domain=$1
    local target_dir=$2
    local gateway_port=$3
    
    local config_file="$NGINX_AVAILABLE/$domain"
    
    # Check if nginx config is already valid - skip recreation
    if check_nginx_config_valid "$domain"; then
        print_info "Nginx configuration for IPFS Server at $domain is already valid, skipping..."
        return 0
    fi
    
    print_info "Creating nginx configuration for IPFS Server at $domain..."
    
    # Remove old config if exists (may have broken SSL blocks)
    rm -f "$config_file" "$NGINX_ENABLED/$domain" 2>/dev/null || true
    
    cat > "$config_file" << EOF
# Nginx configuration for IPFS Server (Gateway/Upload)
# Domain: $domain
# Generated on $(date)

# Upstream IPFS server
upstream ipfs_server_${gateway_port} {
    server 127.0.0.1:$gateway_port;
    keepalive 32;
}

# HTTP server (certbot will add HTTPS redirect and SSL server block)
server {
    listen 80;
    listen [::]:80;
    server_name $domain;
    
    # Allow ACME challenge
    location /.well-known/acme-challenge/ {
        root ${target_dir}/ipfs-server;
        allow all;
    }
    
    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    
    # CORS headers for IPFS content
    add_header Access-Control-Allow-Origin "*" always;
    add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
    add_header Access-Control-Allow-Headers "Authorization, Content-Type" always;
    
    # Logging
    access_log /var/log/nginx/${domain}_access.log;
    error_log /var/log/nginx/${domain}_error.log;
    
    # Client body size for file uploads
    client_max_body_size 800M;
    
    # Timeouts for large file uploads
    proxy_connect_timeout 60s;
    proxy_send_timeout 600s;
    proxy_read_timeout 600s;
    
    # Gateway endpoint
    location /gateway {
        proxy_pass http://ipfs_server_${gateway_port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        
        # Cache for immutable IPFS content
        proxy_cache_valid 200 365d;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
    
    # Upload endpoint
    location /upload {
        proxy_pass http://ipfs_server_${gateway_port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
    }
    
    # Health endpoint
    location /health {
        proxy_pass http://ipfs_server_${gateway_port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    
    # Default - proxy to ipfs server
    location / {
        proxy_pass http://ipfs_server_${gateway_port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
    }
}
EOF

    chmod 644 "$config_file"
    
    # Enable the site
    if [ ! -L "$NGINX_ENABLED/$domain" ]; then
        ln -s "$config_file" "$NGINX_ENABLED/$domain"
    fi
    
    # Test nginx configuration
    if nginx -t 2>/dev/null; then
        print_success "IPFS Server nginx configuration created and validated"
        return 0
    else
        print_error "IPFS Server nginx configuration test failed"
        nginx -t
        return 1
    fi
}

# Setup SSL for IPFS Server domain
setup_ipfs_server_nginx_ssl() {
    local domain=$1
    local email=$2
    local target_dir=$3
    local gateway_port=$4
    
    # Install nginx if needed
    install_nginx
    
    # Create nginx configuration for IPFS Server
    if ! create_ipfs_server_nginx_config "$domain" "$target_dir" "$gateway_port"; then
        print_error "Failed to create IPFS Server nginx configuration"
        return 1
    fi
    
    # Reload nginx to apply configuration
    reload_nginx
    
    # Setup SSL if email provided
    if [ -n "$email" ]; then
        if setup_ssl "$domain" "$email"; then
            print_success "SSL certificate obtained for IPFS Server"
        else
            print_warning "SSL setup failed for IPFS Server, but nginx is configured"
        fi
        
        # Setup auto-renewal
        setup_ssl_auto_renewal
        
        # Reload nginx after SSL setup
        reload_nginx
    else
        print_warning "No email provided, skipping SSL setup for IPFS Server"
        print_info "You can manually run: certbot --nginx -d $domain"
    fi
    
    return 0
}

# Create nginx configuration for Pinning API (standalone domain)
# Creates HTTP-only config first - certbot will add SSL
create_pinning_nginx_config() {
    local domain=$1
    local target_dir=$2
    local pinning_port=$3
    
    local config_file="$NGINX_AVAILABLE/$domain"
    
    # Check if nginx config is already valid - skip recreation
    if check_nginx_config_valid "$domain"; then
        print_info "Nginx configuration for Pinning API at $domain is already valid, skipping..."
        return 0
    fi
    
    print_info "Creating nginx configuration for Pinning API at $domain..."
    
    # Remove old config if exists (may have broken SSL blocks)
    rm -f "$config_file" "$NGINX_ENABLED/$domain" 2>/dev/null || true
    
    cat > "$config_file" << EOF
# Nginx configuration for IPFS Pinning Service API
# Domain: $domain
# Generated on $(date)

# Upstream pinning service
upstream pinning_api_${pinning_port} {
    server 127.0.0.1:$pinning_port;
    keepalive 32;
}

# HTTP server (certbot will add HTTPS redirect and SSL server block)
server {
    listen 80;
    listen [::]:80;
    server_name $domain;
    
    # Allow ACME challenge
    location /.well-known/acme-challenge/ {
        root ${target_dir};
        allow all;
    }
    
    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    
    # CORS headers
    add_header Access-Control-Allow-Origin "*" always;
    add_header Access-Control-Allow-Methods "GET, POST, DELETE, OPTIONS" always;
    add_header Access-Control-Allow-Headers "Authorization, Content-Type" always;
    
    # Logging
    access_log /var/log/nginx/${domain}_access.log;
    error_log /var/log/nginx/${domain}_error.log;
    
    # Timeouts
    proxy_connect_timeout 60s;
    proxy_send_timeout 300s;
    proxy_read_timeout 300s;
    
    # Handle OPTIONS preflight
    if (\$request_method = OPTIONS) {
        return 204;
    }
    
    # Proxy all requests to pinning service
    location / {
        proxy_pass http://pinning_api_${pinning_port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
    }
}
EOF

    chmod 644 "$config_file"
    
    # Enable the site
    if [ ! -L "$NGINX_ENABLED/$domain" ]; then
        ln -s "$config_file" "$NGINX_ENABLED/$domain"
    fi
    
    # Test nginx configuration
    if nginx -t 2>/dev/null; then
        print_success "Pinning API nginx configuration created and validated"
        return 0
    else
        print_error "Pinning API nginx configuration test failed"
        nginx -t
        return 1
    fi
}

# Setup SSL for Pinning API domain
setup_pinning_nginx_ssl() {
    local domain=$1
    local email=$2
    local target_dir=$3
    local pinning_port=$4
    
    # Install nginx if needed
    install_nginx
    
    # Create nginx configuration for Pinning API
    if ! create_pinning_nginx_config "$domain" "$target_dir" "$pinning_port"; then
        print_error "Failed to create Pinning API nginx configuration"
        return 1
    fi
    
    # Reload nginx to apply configuration
    reload_nginx
    
    # Setup SSL if email provided
    if [ -n "$email" ]; then
        if setup_ssl "$domain" "$email"; then
            print_success "SSL certificate obtained for Pinning API"
        else
            print_warning "SSL setup failed for Pinning API, but nginx is configured"
        fi
        
        # Setup auto-renewal
        setup_ssl_auto_renewal
        
        # Reload nginx after SSL setup
        reload_nginx
    else
        print_warning "No email provided, skipping SSL setup for Pinning API"
        print_info "You can manually run: certbot --nginx -d $domain"
    fi
    
    return 0
}

# Setup SSL certificate with certbot
setup_ssl() {
    local domain=$1
    local email=$2
    
    if check_ssl_exists "$domain"; then
        print_info "SSL certificate already exists for $domain"
        return 0
    fi
    
    print_info "Obtaining SSL certificate for $domain..."
    
    # Stop nginx temporarily for standalone mode if needed
    # Or use webroot mode if nginx is running
    
    if systemctl is-active --quiet nginx; then
        # Use nginx plugin
        certbot --nginx -d "$domain" --non-interactive --agree-tos --email "$email" --redirect
    else
        # Use standalone mode
        certbot certonly --standalone -d "$domain" --non-interactive --agree-tos --email "$email"
    fi
    
    if [ $? -eq 0 ]; then
        print_success "SSL certificate obtained successfully"
        return 0
    else
        print_error "Failed to obtain SSL certificate"
        return 1
    fi
}

# Setup certbot auto-renewal
setup_ssl_auto_renewal() {
    print_info "Setting up SSL certificate auto-renewal..."
    
    # Check if certbot timer exists (systemd)
    if systemctl list-timers | grep -q certbot; then
        print_info "Certbot auto-renewal timer already active"
        return 0
    fi
    
    # Enable certbot timer if available
    if systemctl list-unit-files | grep -q certbot.timer; then
        systemctl enable certbot.timer
        systemctl start certbot.timer
        print_success "Certbot auto-renewal timer enabled"
        return 0
    fi
    
    # Fallback: add cron job for auto-renewal
    local cron_job="0 0,12 * * * root certbot renew --quiet --post-hook 'systemctl reload nginx'"
    local cron_file="/etc/cron.d/certbot-renewal"
    
    if [ ! -f "$cron_file" ]; then
        echo "$cron_job" > "$cron_file"
        chmod 644 "$cron_file"
        print_success "Certbot auto-renewal cron job created"
    else
        print_info "Certbot auto-renewal cron job already exists"
    fi
    
    return 0
}

# Reload nginx configuration
reload_nginx() {
    print_info "Reloading nginx..."
    
    if nginx -t 2>/dev/null; then
        systemctl reload nginx
        print_success "Nginx reloaded successfully"
        return 0
    else
        print_error "Nginx configuration test failed"
        return 1
    fi
}

# Full nginx and SSL setup
setup_nginx_ssl() {
    local domain=$1
    local email=$2
    local target_dir=$3
    local pinning_port=$4
    local gateway_port=$5
    
    echo ""
    print_info "Setting up Nginx and SSL for $domain..."
    echo ""
    
    # Install nginx if needed
    install_nginx || return 1
    
    # Install certbot if needed
    install_certbot || return 1
    
    # Check if config already exists
    if check_nginx_config_exists "$domain"; then
        print_warning "Nginx configuration for $domain already exists"
        read -p "Overwrite existing configuration? (y/N): " overwrite
        if [ "$overwrite" != "y" ] && [ "$overwrite" != "Y" ]; then
            print_info "Keeping existing nginx configuration"
        else
            create_nginx_config "$domain" "$target_dir" "$pinning_port" "$gateway_port" || return 1
        fi
    else
        create_nginx_config "$domain" "$target_dir" "$pinning_port" "$gateway_port" || return 1
    fi
    
    # Reload nginx to apply config
    reload_nginx || return 1
    
    # Setup SSL if not already configured
    if [ -n "$email" ]; then
        setup_ssl "$domain" "$email" || print_warning "SSL setup failed, continuing without SSL"
        
        # Setup auto-renewal
        setup_ssl_auto_renewal
        
        # Reload nginx after SSL setup
        reload_nginx
    else
        print_warning "No email provided, skipping SSL setup"
        print_info "You can manually run: certbot --nginx -d $domain"
    fi
    
    return 0
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
    
    # Setup Node.js environment (source nvm if available)
    setup_node_env
    
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
        
        # Stop existing services
        stop_service
        stop_gateway_service
        stop_webui_service
    else
        print_info "Fresh installation detected."
    fi
    
    echo ""
    print_info "Please provide configuration values (press Enter for defaults):"
    echo ""
    
    # ===========================================
    # Service 1: Pinning Service (api.cloud.fx.land)
    # ===========================================
    echo "=========================================="
    print_info "1. PINNING SERVICE Configuration (API)"
    echo "=========================================="
    prompt_value "Pinning service port" "${PORT:-$DEFAULT_PORT}" "PORT"
    prompt_value "Database path (relative to install dir)" "${DATABASE_PATH:-$DEFAULT_DB_PATH}" "DATABASE_PATH"
    prompt_value "IPFS API address" "${IPFS_API_ADDR:-$DEFAULT_IPFS_API_ADDR}" "IPFS_API_ADDR"
    prompt_value "IPFS Cluster API address" "${IPFS_CLUSTER_API_ADDR:-$DEFAULT_IPFS_CLUSTER_API_ADDR}" "IPFS_CLUSTER_API_ADDR"
    prompt_value "Enable direct IPFS pinning (true=IPFS+Cluster, false=Cluster only)" "${ENABLE_IPFS_PINNING:-$DEFAULT_ENABLE_IPFS_PINNING}" "ENABLE_IPFS_PINNING"
    prompt_value "Pinning API domain (e.g., api.cloud.fx.land, leave empty to skip nginx)" "${PINNING_DOMAIN:-}" "PINNING_DOMAIN"
    
    # ===========================================
    # Service 2: IPFS Server (ipfs.cloud.fx.land)
    # ===========================================
    echo ""
    echo "=========================================="
    print_info "2. IPFS SERVER Configuration (Gateway/Upload)"
    echo "=========================================="
    prompt_value "IPFS server port" "${GATEWAY_PORT:-$DEFAULT_GATEWAY_PORT}" "GATEWAY_PORT"
    prompt_value "IPFS server domain (e.g., ipfs.cloud.fx.land, leave empty to skip nginx)" "${IPFS_SERVER_DOMAIN:-}" "IPFS_SERVER_DOMAIN"
    
    # ===========================================
    # Service 3: WebUI (cloud.fx.land)
    # ===========================================
    echo ""
    echo "=========================================="
    print_info "3. WEBUI Configuration (User Portal)"
    echo "=========================================="
    echo "  The WebUI provides a web interface for users to manage their pins and API keys."
    echo "  Leave Google Client ID empty to skip WebUI installation."
    prompt_value "WebUI port" "${WEBUI_PORT:-$DEFAULT_WEBUI_PORT}" "WEBUI_PORT"
    prompt_value "Google OAuth Client ID (from console.cloud.google.com)" "${GOOGLE_CLIENT_ID:-}" "GOOGLE_CLIENT_ID"
    
    INSTALL_WEBUI=false
    if [ -n "$GOOGLE_CLIENT_ID" ]; then
        INSTALL_WEBUI=true
        prompt_value "WebUI domain (e.g., cloud.fx.land, leave empty for localhost)" "${WEBUI_DOMAIN:-}" "WEBUI_DOMAIN"
    fi

    # ===========================================
    # Payment Configuration (FULA Token)
    # ===========================================
    echo ""
    echo "=========================================="
    print_info "4. PAYMENT Configuration (Optional)"
    echo "=========================================="
    echo "  Configure FULA token payments for storage beyond the free tier."
    echo "  Leave vault address empty or as 0x000...000 to disable payments."
    echo ""
    prompt_value "Vault address (wallet to receive FULA payments)" "${VAULT_ADDRESS:-0x0000000000000000000000000000000000000000}" "VAULT_ADDRESS"
    prompt_value "Free tier storage in MB (default: 500)" "${FREE_TIER_MB:-500}" "FREE_TIER_MB"
    FREE_TIER_BYTES=$((FREE_TIER_MB * 1024 * 1024))
    prompt_value "FULA per GB per month (default: 3)" "${FULA_PER_GB_MONTH:-3}" "FULA_PER_GB_MONTH"
    prompt_value "Etherscan API key (for Base/Ethereum scanning)" "${ETHERSCAN_API_KEY:-}" "ETHERSCAN_API_KEY"
    prompt_value "Admin emails (comma-separated, for managing suspended users)" "${ADMIN_EMAILS:-}" "ADMIN_EMAILS"

    # ===========================================
    # SSL Configuration
    # ===========================================
    echo ""
    echo "=========================================="
    print_info "SSL Certificate Configuration"
    echo "=========================================="
    
    # Check if any domain was provided
    SETUP_NGINX=false
    if [ -n "$PINNING_DOMAIN" ] || [ -n "$IPFS_SERVER_DOMAIN" ] || [ -n "$WEBUI_DOMAIN" ]; then
        SETUP_NGINX=true
        prompt_value "Email for SSL certificates (Let's Encrypt)" "${SSL_EMAIL:-}" "SSL_EMAIL"
    else
        print_info "No domains configured, skipping nginx/SSL setup"
    fi
    
    # Keep DOMAIN for backward compatibility (use PINNING_DOMAIN)
    DOMAIN="$PINNING_DOMAIN"
    
    echo ""
    print_info "Starting installation..."
    echo ""
    
    # Create directories
    create_directories "$TARGET_DIR"
    
    # Build and copy pinning service
    build_app "$SOURCE_DIR" "$TARGET_DIR"
    
    # Generate pinning service configuration
    generate_env_file "$TARGET_DIR"
    
    # Initialize database
    init_database "$TARGET_DIR"
    
    # Create and configure pinning service
    create_service_file "$TARGET_DIR"
    configure_service
    
    # Start pinning service (continue even if it fails)
    if ! start_service; then
        print_warning "Pinning service failed to start, but continuing with other installations..."
        print_warning "Fix the issue and restart with: systemctl restart $SERVICE_NAME"
    fi
    
    # Build and install IPFS gateway (optional - requires Node.js)
    echo ""
    print_info "Installing IPFS Gateway Server..."
    
    if build_gateway "$SOURCE_DIR" "$TARGET_DIR"; then
        # Generate gateway configuration
        generate_gateway_env_file "$TARGET_DIR"
        
        # Create and configure gateway service
        create_gateway_service_file "$TARGET_DIR"
        configure_gateway_service
        
        # Start gateway service (continue even if it fails)
        if start_gateway_service; then
            GATEWAY_INSTALLED=true
        else
            print_warning "Gateway service failed to start, but installation completed."
            GATEWAY_INSTALLED=true
        fi
    else
        print_warning "Gateway server was not installed (Node.js 18+ required)"
        GATEWAY_INSTALLED=false
    fi
    
    # Build and install WebUI (optional - requires Node.js and Google Client ID)
    WEBUI_INSTALLED=false
    if [ "$INSTALL_WEBUI" = true ]; then
        echo ""
        print_info "Installing Pinning WebUI..."
        
        if build_webui "$SOURCE_DIR" "$TARGET_DIR"; then
            # Generate WebUI configuration
            generate_webui_env_file "$TARGET_DIR"
            
            # Create and configure WebUI service
            create_webui_service_file "$TARGET_DIR"
            configure_webui_service
            
            # Start WebUI service (continue even if it fails)
            if start_webui_service; then
                WEBUI_INSTALLED=true
            else
                print_warning "WebUI service failed to start, but installation completed."
                WEBUI_INSTALLED=true
            fi
        else
            print_warning "WebUI was not installed (Node.js 18+ required)"
        fi
    fi
    
    # ===========================================
    # Setup Nginx and SSL for all services
    # ===========================================
    
    # Setup Nginx and SSL for Pinning API if domain was provided
    PINNING_NGINX_CONFIGURED=false
    if [ -n "$PINNING_DOMAIN" ]; then
        echo ""
        print_info "Setting up Nginx and SSL for Pinning API ($PINNING_DOMAIN)..."
        if setup_pinning_nginx_ssl "$PINNING_DOMAIN" "$SSL_EMAIL" "$TARGET_DIR" "$PORT"; then
            PINNING_NGINX_CONFIGURED=true
        else
            print_warning "Pinning API Nginx/SSL setup encountered issues"
        fi
    fi
    
    # Setup Nginx and SSL for IPFS Server if domain was provided
    IPFS_SERVER_NGINX_CONFIGURED=false
    if [ "$GATEWAY_INSTALLED" = true ] && [ -n "$IPFS_SERVER_DOMAIN" ]; then
        echo ""
        print_info "Setting up Nginx and SSL for IPFS Server ($IPFS_SERVER_DOMAIN)..."
        if setup_ipfs_server_nginx_ssl "$IPFS_SERVER_DOMAIN" "$SSL_EMAIL" "$TARGET_DIR" "$GATEWAY_PORT"; then
            IPFS_SERVER_NGINX_CONFIGURED=true
        else
            print_warning "IPFS Server Nginx/SSL setup encountered issues"
        fi
    fi
    
    # Setup Nginx and SSL for WebUI if domain was provided
    WEBUI_NGINX_CONFIGURED=false
    if [ "$WEBUI_INSTALLED" = true ] && [ -n "$WEBUI_DOMAIN" ]; then
        echo ""
        print_info "Setting up Nginx and SSL for WebUI ($WEBUI_DOMAIN)..."
        if setup_webui_nginx_ssl "$WEBUI_DOMAIN" "$SSL_EMAIL" "$TARGET_DIR" "$WEBUI_PORT"; then
            WEBUI_NGINX_CONFIGURED=true
        else
            print_warning "WebUI Nginx/SSL setup encountered issues"
        fi
    fi
    
    # Keep NGINX_CONFIGURED for backward compatibility
    NGINX_CONFIGURED=false
    if [ "$PINNING_NGINX_CONFIGURED" = true ] || [ "$IPFS_SERVER_NGINX_CONFIGURED" = true ] || [ "$WEBUI_NGINX_CONFIGURED" = true ]; then
        NGINX_CONFIGURED=true
    fi
    
    echo ""
    echo "=========================================="
    print_success "Installation completed successfully!"
    echo "=========================================="
    echo ""
    echo "Pinning Service Status:"
    systemctl status "$SERVICE_NAME" --no-pager -l || true
    echo ""
    
    if [ "$GATEWAY_INSTALLED" = true ]; then
        echo "Gateway Service Status:"
        systemctl status "$GATEWAY_SERVICE_NAME" --no-pager -l || true
        echo ""
    fi
    
    if [ "$WEBUI_INSTALLED" = true ]; then
        echo "WebUI Service Status:"
        systemctl status "$WEBUI_SERVICE_NAME" --no-pager -l || true
        echo ""
    fi
    
    if [ "$NGINX_CONFIGURED" = true ]; then
        echo "Nginx Status:"
        systemctl status nginx --no-pager -l || true
        echo ""
    fi
    
    echo "Useful commands:"
    echo "  Pinning Service:"
    echo "    - View logs:    journalctl -u $SERVICE_NAME -f"
    echo "    - Restart:      systemctl restart $SERVICE_NAME"
    echo ""
    
    if [ "$GATEWAY_INSTALLED" = true ]; then
        echo "  IPFS Server (Gateway/Upload):"
        echo "    - View logs:    journalctl -u $GATEWAY_SERVICE_NAME -f"
        echo "    - Restart:      systemctl restart $GATEWAY_SERVICE_NAME"
        echo ""
    fi
    
    if [ "$WEBUI_INSTALLED" = true ]; then
        echo "  WebUI Service:"
        echo "    - View logs:    journalctl -u $WEBUI_SERVICE_NAME -f"
        echo "    - Restart:      systemctl restart $WEBUI_SERVICE_NAME"
        echo ""
    fi
    
    if [ "$NGINX_CONFIGURED" = true ]; then
        echo "  Nginx:"
        echo "    - Restart:      systemctl restart nginx"
        echo "    - Test config:  nginx -t"
        if [ "$PINNING_NGINX_CONFIGURED" = true ]; then
            echo "    - Pinning logs: tail -f /var/log/nginx/${PINNING_DOMAIN}_access.log"
        fi
        if [ "$IPFS_SERVER_NGINX_CONFIGURED" = true ]; then
            echo "    - IPFS logs:    tail -f /var/log/nginx/${IPFS_SERVER_DOMAIN}_access.log"
        fi
        if [ "$WEBUI_NGINX_CONFIGURED" = true ]; then
            echo "    - WebUI logs:   tail -f /var/log/nginx/${WEBUI_DOMAIN}_access.log"
        fi
        echo ""
    fi
    
    echo "Configuration files:"
    echo "  - Pinning:     $TARGET_DIR/.env"
    echo "  - IPFS Server: $TARGET_DIR/ipfs-server/.env"
    if [ "$WEBUI_INSTALLED" = true ]; then
        echo "  - WebUI:       $TARGET_DIR/pinning-webui/.env"
    fi
    if [ "$PINNING_NGINX_CONFIGURED" = true ]; then
        echo "  - Nginx API:   $NGINX_AVAILABLE/$PINNING_DOMAIN"
    fi
    if [ "$IPFS_SERVER_NGINX_CONFIGURED" = true ]; then
        echo "  - Nginx IPFS:  $NGINX_AVAILABLE/$IPFS_SERVER_DOMAIN"
    fi
    if [ "$WEBUI_NGINX_CONFIGURED" = true ]; then
        echo "  - Nginx WebUI: $NGINX_AVAILABLE/$WEBUI_DOMAIN"
    fi
    echo ""
    echo "Database location: $TARGET_DIR/$DATABASE_PATH"
    echo ""
    echo "Endpoints:"
    
    # Pinning API
    if [ -n "$PINNING_DOMAIN" ]; then
        echo "  - Pinning API: https://$PINNING_DOMAIN/pins"
    else
        echo "  - Pinning API: http://localhost:$PORT/pins"
    fi
    
    # IPFS Server
    if [ "$GATEWAY_INSTALLED" = true ]; then
        if [ -n "$IPFS_SERVER_DOMAIN" ]; then
            echo "  - IPFS Gateway: https://$IPFS_SERVER_DOMAIN/gateway/{cid}"
            echo "  - IPFS Upload:  https://$IPFS_SERVER_DOMAIN/upload"
            echo "  - IPFS Health:  https://$IPFS_SERVER_DOMAIN/health"
        else
            echo "  - IPFS Gateway: http://localhost:$GATEWAY_PORT/gateway/{cid}"
            echo "  - IPFS Upload:  http://localhost:$GATEWAY_PORT/upload"
        fi
    fi
    
    # WebUI
    if [ "$WEBUI_INSTALLED" = true ]; then
        if [ -n "$WEBUI_DOMAIN" ]; then
            echo "  - WebUI:        https://$WEBUI_DOMAIN"
        else
            echo "  - WebUI:        http://localhost:$WEBUI_PORT"
        fi
    fi
    echo ""
    
    if [ "$WEBUI_INSTALLED" = true ]; then
        print_info "WebUI Setup Notes:"
        echo "  - Ensure Google OAuth is configured with the correct redirect URI"
        if [ -n "$WEBUI_DOMAIN" ]; then
            echo "  - Add 'https://$WEBUI_DOMAIN' to authorized redirect URIs"
        else
            echo "  - Add 'http://localhost:$WEBUI_PORT' to authorized redirect URIs"
        fi
        echo "  - Users sign in with Google and get automatic API keys"
        echo ""
    fi
    
    if [ "$NGINX_CONFIGURED" = true ]; then
        echo "SSL Certificates:"
        echo "  - Auto-renewal is configured via certbot"
        echo "  - Check status: certbot certificates"
        echo "  - Manual renew: certbot renew"
        echo ""
    fi
}

# Run main function
main "$@"
