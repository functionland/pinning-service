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
DEFAULT_DB_PATH="data/pinning.db"

# Pinning service
SERVICE_NAME="fula-pinning-service"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# IPFS Gateway/Upload server
GATEWAY_SERVICE_NAME="fula-upload-server"
GATEWAY_SERVICE_FILE="/etc/systemd/system/${GATEWAY_SERVICE_NAME}.service"
DEFAULT_GATEWAY_PORT="3300"

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
    
    # Build the binary
    print_info "Building gateway binary..."
    npm run build
    
    # Copy to target
    mkdir -p "$target_dir/ipfs-server/dist"
    mkdir -p "$target_dir/ipfs-server/uploads"
    cp -r dist/* "$target_dir/ipfs-server/dist/"
    
    verify_step "Gateway build" "[ -f '$target_dir/ipfs-server/dist/ipfs-gateway' ]"
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

# Generate gateway .env file
generate_gateway_env_file() {
    local target_dir=$1
    
    print_info "Generating gateway .env file..."
    
    cat > "$target_dir/ipfs-server/.env" << EOF
# IPFS Gateway Server Configuration
# Generated on $(date)

# Server Configuration
PORT=${GATEWAY_PORT}

# Database Configuration (read-only access to pinning service DB)
DATABASE_PATH=${target_dir}/${DATABASE_PATH}

# IPFS Configuration
IPFS_API_URL=http://127.0.0.1:5001

# Upload Configuration
UPLOAD_DIR=${target_dir}/ipfs-server/uploads
MAX_FILE_SIZE=838860800
IPFS_TIMEOUT=60000
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
ProtectHome=true
ReadWritePaths=${target_dir}/ipfs-server/uploads

# Resource limits
LimitNOFILE=65535
MemoryMax=2G

# Restart limits
StartLimitBurst=5
StartLimitIntervalSec=60

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

# Check if SSL certificate exists for domain
check_ssl_exists() {
    local domain=$1
    
    if [ -d "/etc/letsencrypt/live/$domain" ]; then
        return 0
    fi
    return 1
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
    else
        print_info "Fresh installation detected."
    fi
    
    echo ""
    print_info "Please provide configuration values (press Enter for defaults):"
    echo ""
    
    # Prompt for pinning service configuration
    prompt_value "Pinning service port" "${PORT:-$DEFAULT_PORT}" "PORT"
    prompt_value "Database path (relative to install dir)" "${DATABASE_PATH:-$DEFAULT_DB_PATH}" "DATABASE_PATH"
    prompt_value "IPFS API address" "${IPFS_API_ADDR:-$DEFAULT_IPFS_API_ADDR}" "IPFS_API_ADDR"
    
    echo ""
    print_info "IPFS Gateway/Upload Server Configuration:"
    prompt_value "Gateway server port" "${GATEWAY_PORT:-$DEFAULT_GATEWAY_PORT}" "GATEWAY_PORT"
    
    echo ""
    print_info "Nginx and SSL Configuration (optional):"
    echo "  Leave domain empty to skip nginx/SSL setup"
    prompt_value "Domain name (e.g., pinning.example.com)" "${DOMAIN:-}" "DOMAIN"
    
    SETUP_NGINX=false
    if [ -n "$DOMAIN" ]; then
        prompt_value "Email for SSL certificate (Let's Encrypt)" "${SSL_EMAIL:-}" "SSL_EMAIL"
        SETUP_NGINX=true
    fi
    
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
    
    # Start pinning service
    start_service
    
    # Build and install IPFS gateway (optional - requires Node.js)
    echo ""
    print_info "Installing IPFS Gateway Server..."
    
    if build_gateway "$SOURCE_DIR" "$TARGET_DIR"; then
        # Generate gateway configuration
        generate_gateway_env_file "$TARGET_DIR"
        
        # Create and configure gateway service
        create_gateway_service_file "$TARGET_DIR"
        configure_gateway_service
        
        # Start gateway service
        start_gateway_service
        GATEWAY_INSTALLED=true
    else
        print_warning "Gateway server was not installed (Node.js 18+ required)"
        GATEWAY_INSTALLED=false
    fi
    
    # Setup Nginx and SSL if domain was provided
    NGINX_CONFIGURED=false
    if [ "$SETUP_NGINX" = true ] && [ -n "$DOMAIN" ]; then
        if setup_nginx_ssl "$DOMAIN" "$SSL_EMAIL" "$TARGET_DIR" "$PORT" "$GATEWAY_PORT"; then
            NGINX_CONFIGURED=true
        else
            print_warning "Nginx/SSL setup encountered issues"
        fi
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
        echo "  Gateway Service:"
        echo "    - View logs:    journalctl -u $GATEWAY_SERVICE_NAME -f"
        echo "    - Restart:      systemctl restart $GATEWAY_SERVICE_NAME"
        echo ""
    fi
    
    if [ "$NGINX_CONFIGURED" = true ]; then
        echo "  Nginx:"
        echo "    - View logs:    tail -f /var/log/nginx/${DOMAIN}_access.log"
        echo "    - Restart:      systemctl restart nginx"
        echo "    - Test config:  nginx -t"
        echo ""
    fi
    
    echo "Configuration files:"
    echo "  - Pinning:  $TARGET_DIR/.env"
    echo "  - Gateway:  $TARGET_DIR/ipfs-server/.env"
    if [ "$NGINX_CONFIGURED" = true ]; then
        echo "  - Nginx:    $NGINX_AVAILABLE/$DOMAIN"
    fi
    echo ""
    echo "Database location: $TARGET_DIR/$DATABASE_PATH"
    echo ""
    echo "Endpoints:"
    
    if [ "$NGINX_CONFIGURED" = true ] && [ -n "$DOMAIN" ]; then
        echo "  - Pinning API: https://$DOMAIN/pins"
        echo "  - Gateway:     https://$DOMAIN/gateway/{cid}"
        echo "  - Upload:      https://$DOMAIN/upload"
        echo "  - Health:      https://$DOMAIN/health"
    else
        echo "  - Pinning API: http://localhost:$PORT/pins"
        if [ "$GATEWAY_INSTALLED" = true ]; then
            echo "  - Gateway:     http://localhost:$GATEWAY_PORT/gateway/{cid}"
            echo "  - Upload:      http://localhost:$GATEWAY_PORT/upload"
        fi
    fi
    echo ""
    
    if [ "$NGINX_CONFIGURED" = true ]; then
        echo "SSL Certificate:"
        echo "  - Auto-renewal is configured"
        echo "  - Check status: certbot certificates"
        echo "  - Manual renew: certbot renew"
        echo ""
    fi
}

# Run main function
main "$@"
