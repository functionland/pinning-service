#!/bin/bash
#
# Fula AI Service Installation Script
#
# Supports both fresh install and update modes.
# Detects existing installation and preserves configuration.
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print functions
print_banner() {
    echo -e "${BLUE}"
    echo "╔═══════════════════════════════════════════════════╗"
    echo "║       Fula AI Service Installation                ║"
    echo "║         AI-Powered Website Generator              ║"
    echo "╚═══════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

print_step() {
    echo -e "${GREEN}[STEP]${NC} $1"
}

print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
check_root() {
    if [ "$EUID" -ne 0 ]; then
        print_error "Please run as root (sudo ./install.sh)"
        exit 1
    fi
}

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="fula-ai-service"
DEFAULT_INSTALL_DIR="/opt/fula-ai-service"
DEFAULT_PORT=3002
IS_UPDATE=false

# ============================================
# Update Detection
# ============================================

detect_mode() {
    if [ -f "$DEFAULT_INSTALL_DIR/.env" ]; then
        IS_UPDATE=true
        print_info "Existing installation detected — running UPDATE mode"
    else
        print_info "No existing installation — running FRESH INSTALL mode"
    fi
}

# ============================================
# Fresh Install: Collect Configuration
# ============================================

collect_config_fresh() {
    print_step "Collecting configuration..."
    echo ""

    # Install directory
    read -p "Enter install directory [${DEFAULT_INSTALL_DIR}]: " INSTALL_DIR
    INSTALL_DIR=${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}

    # Claude API Key
    read -sp "Enter Claude API key (sk-ant-...): " CLAUDE_API_KEY
    echo
    if [ -z "$CLAUDE_API_KEY" ]; then
        print_error "Claude API key is required"
        exit 1
    fi

    # Generation cost
    read -p "Enter generation cost in FULA [1000]: " GENERATION_COST_FULA
    GENERATION_COST_FULA=${GENERATION_COST_FULA:-1000}

    # Pinning system key
    echo ""
    print_info "The pinning system key is the shared secret (SYSTEM_KEY) configured in"
    print_info "pinning-webui. The AI service uses it to call the pinning-webui admin API"
    print_info "to deduct/refund user credits for website generation."
    read -sp "Enter pinning service system key: " PINNING_SYSTEM_KEY
    echo
    if [ -z "$PINNING_SYSTEM_KEY" ]; then
        print_error "Pinning system key is required"
        exit 1
    fi

    # JWT secret
    echo ""
    print_info "The JWT secret must match the JWT_SECRET from pinning-webui's .env."
    print_info "It is used to verify that user tokens were signed by your pinning-webui."
    read -sp "Enter JWT secret (same as pinning-webui JWT_SECRET): " JWT_SECRET
    echo
    if [ -z "$JWT_SECRET" ]; then
        print_error "JWT secret is required — must match pinning-webui's JWT_SECRET"
        exit 1
    fi

    # PostgreSQL
    read -p "Enter PostgreSQL host [localhost]: " POSTGRES_HOST
    POSTGRES_HOST=${POSTGRES_HOST:-localhost}

    read -p "Enter PostgreSQL port [5432]: " POSTGRES_PORT
    POSTGRES_PORT=${POSTGRES_PORT:-5432}

    read -p "Enter PostgreSQL database [pinning_service]: " POSTGRES_DB
    POSTGRES_DB=${POSTGRES_DB:-pinning_service}

    read -p "Enter PostgreSQL user [pinning_user]: " POSTGRES_USER
    POSTGRES_USER=${POSTGRES_USER:-pinning_user}

    read -sp "Enter PostgreSQL password: " POSTGRES_PASSWORD
    echo

    # IPFS
    read -p "Enter IPFS API URL [http://127.0.0.1:5001]: " IPFS_API_URL
    IPFS_API_URL=${IPFS_API_URL:-http://127.0.0.1:5001}

    read -p "Enter IPFS gateway URL (e.g., https://ipfs.cloud.fx.land/gateway): " IPFS_GATEWAY_URL
    if [ -z "$IPFS_GATEWAY_URL" ]; then
        print_error "IPFS gateway URL is required"
        exit 1
    fi

    # S3 Gateway (fula-api)
    echo ""
    print_info "S3 Gateway Configuration (fula-api running on this server)"
    print_info "The AI service uploads generated website files to the S3 gateway,"
    print_info "which stores them in IPFS and pins them in the cluster."

    read -p "Enter S3 gateway URL [http://127.0.0.1:9000]: " S3_GATEWAY_URL
    S3_GATEWAY_URL=${S3_GATEWAY_URL:-http://127.0.0.1:9000}

    read -p "Enter S3 bucket name [ai-websites]: " S3_BUCKET_NAME
    S3_BUCKET_NAME=${S3_BUCKET_NAME:-ai-websites}

    # Port
    read -p "Enter service port [${DEFAULT_PORT}]: " PORT
    PORT=${PORT:-$DEFAULT_PORT}

    # Domain (for nginx)
    read -p "Enter domain name (e.g., ai.cloud.fx.land, or press enter to skip nginx): " DOMAIN

    echo ""
    print_info "Configuration summary:"
    echo "  Install Dir:     $INSTALL_DIR"
    echo "  Claude API Key:  ****"
    echo "  Cost:            $GENERATION_COST_FULA FULA"
    echo "  Pinning WebUI:   http://127.0.0.1:3001"
    echo "  PostgreSQL:      $POSTGRES_HOST:$POSTGRES_PORT/$POSTGRES_DB"
    echo "  IPFS API:        $IPFS_API_URL"
    echo "  IPFS Gateway:    $IPFS_GATEWAY_URL"
    echo "  S3 Gateway:      $S3_GATEWAY_URL"
    echo "  S3 Bucket:       $S3_BUCKET_NAME"
    echo "  Port:            $PORT"
    echo "  Domain:          ${DOMAIN:-'(none)'}"
    echo ""

    read -p "Continue with installation? [y/N]: " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        print_info "Installation cancelled"
        exit 0
    fi
}

# ============================================
# Update Mode: Collect Configuration
# ============================================

collect_config_update() {
    print_step "Handling configuration update..."

    INSTALL_DIR="$DEFAULT_INSTALL_DIR"

    # Backup existing .env
    BACKUP_SUFFIX=$(date +%Y%m%d%H%M%S)
    cp "$INSTALL_DIR/.env" "$INSTALL_DIR/.env.backup.$BACKUP_SUFFIX"
    print_info "Backed up .env to .env.backup.$BACKUP_SUFFIX"

    # Source existing config
    source "$INSTALL_DIR/.env"

    echo ""
    print_info "Current configuration:"
    echo "  Claude API Key:  ****"
    echo "  Model:           ${CLAUDE_MODEL:-claude-opus-4-6}"
    echo "  Cost:            ${GENERATION_COST_FULA:-1000} FULA"
    echo "  Port:            ${PORT:-3002}"
    echo "  IPFS Gateway:    ${IPFS_GATEWAY_URL:-not set}"
    echo ""

    read -p "Keep existing configuration? [Y/n]: " KEEP_CONFIG
    if [[ "$KEEP_CONFIG" =~ ^[Nn]$ ]]; then
        # Re-prompt for each value with current as default
        read -p "Claude API key [****]: " NEW_CLAUDE_API_KEY
        CLAUDE_API_KEY=${NEW_CLAUDE_API_KEY:-$CLAUDE_API_KEY}

        read -p "Generation cost in FULA [${GENERATION_COST_FULA:-1000}]: " NEW_COST
        GENERATION_COST_FULA=${NEW_COST:-${GENERATION_COST_FULA:-1000}}

        read -p "IPFS gateway URL [${IPFS_GATEWAY_URL}]: " NEW_GATEWAY
        IPFS_GATEWAY_URL=${NEW_GATEWAY:-$IPFS_GATEWAY_URL}

        read -p "Port [${PORT:-3002}]: " NEW_PORT
        PORT=${NEW_PORT:-${PORT:-3002}}

        # Re-write .env
        write_env_file
    fi

    # Check for new env vars from .env.example that don't exist
    check_new_env_vars
}

# ============================================
# Check for new env vars in .env.example
# ============================================

check_new_env_vars() {
    if [ ! -f "$SCRIPT_DIR/.env.example" ]; then
        return
    fi

    local new_vars=()
    while IFS= read -r line; do
        # Skip comments and empty lines
        [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
        # Extract var name
        var_name=$(echo "$line" | cut -d'=' -f1)
        # Check if it exists in current .env
        if ! grep -q "^${var_name}=" "$INSTALL_DIR/.env"; then
            new_vars+=("$line")
        fi
    done < "$SCRIPT_DIR/.env.example"

    if [ ${#new_vars[@]} -gt 0 ]; then
        print_warn "New configuration variables detected:"
        for var in "${new_vars[@]}"; do
            var_name=$(echo "$var" | cut -d'=' -f1)
            var_default=$(echo "$var" | cut -d'=' -f2-)
            read -p "  $var_name [$var_default]: " new_value
            new_value=${new_value:-$var_default}
            echo "${var_name}=${new_value}" >> "$INSTALL_DIR/.env"
        done
    fi
}

# ============================================
# Write .env File
# ============================================

write_env_file() {
    cat > "$INSTALL_DIR/.env" << EOF
# Fula AI Service Configuration
# Generated by install.sh on $(date)

# Server
PORT=${PORT:-3002}
NODE_ENV=production

# Claude API
CLAUDE_API_KEY=$CLAUDE_API_KEY
CLAUDE_MODEL=${CLAUDE_MODEL:-claude-opus-4-6}

# Generation
GENERATION_COST_FULA=${GENERATION_COST_FULA:-1000}
MAX_CONCURRENT_JOBS=${MAX_CONCURRENT_JOBS:-3}
JOB_TIMEOUT_MS=${JOB_TIMEOUT_MS:-300000}
MAX_JOBS_PER_USER_PER_HOUR=${MAX_JOBS_PER_USER_PER_HOUR:-10}

# IPFS
IPFS_API_URL=${IPFS_API_URL:-http://127.0.0.1:5001}
IPFS_GATEWAY_URL=$IPFS_GATEWAY_URL

# S3 Gateway (fula-api) — user's JWT is forwarded for authentication
S3_GATEWAY_URL=${S3_GATEWAY_URL:-http://127.0.0.1:9000}
S3_BUCKET_NAME=${S3_BUCKET_NAME:-ai-websites}

# Pinning Service
PINNING_WEBUI_URL=${PINNING_WEBUI_URL:-http://127.0.0.1:3001}
PINNING_SYSTEM_KEY=$PINNING_SYSTEM_KEY

# JWT
JWT_SECRET=$JWT_SECRET

# PostgreSQL
POSTGRES_HOST=${POSTGRES_HOST:-localhost}
POSTGRES_PORT=${POSTGRES_PORT:-5432}
POSTGRES_DB=${POSTGRES_DB:-pinning_service}
POSTGRES_USER=${POSTGRES_USER:-pinning_user}
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_SSL=${POSTGRES_SSL:-false}
EOF

    chmod 600 "$INSTALL_DIR/.env"
}

# ============================================
# Install Node.js 20
# ============================================

install_node() {
    print_step "Checking Node.js..."

    if command -v node &> /dev/null; then
        NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$NODE_VERSION" -ge 20 ]; then
            print_info "Node.js $(node -v) is already installed"
            return
        fi
    fi

    print_info "Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    print_info "Node.js $(node -v) installed"
}

# ============================================
# Install System Dependencies
# ============================================

install_dependencies() {
    print_step "Installing system dependencies..."

    apt-get update
    apt-get install -y \
        build-essential \
        python3 \
        nginx \
        certbot \
        python3-certbot-nginx

    print_info "System dependencies installed"
}

# ============================================
# Copy Files
# ============================================

copy_files() {
    print_step "Copying application files..."

    mkdir -p "$INSTALL_DIR"

    # Backup dist/ on update
    if [ "$IS_UPDATE" = true ] && [ -d "$INSTALL_DIR/dist" ]; then
        BACKUP_SUFFIX=$(date +%Y%m%d%H%M%S)
        cp -r "$INSTALL_DIR/dist" "$INSTALL_DIR/dist.backup.$BACKUP_SUFFIX"
        print_info "Backed up dist/ to dist.backup.$BACKUP_SUFFIX"
    fi

    cp -r "$SCRIPT_DIR/src" "$INSTALL_DIR/"
    cp -r "$SCRIPT_DIR/migrations" "$INSTALL_DIR/"
    cp "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"
    cp "$SCRIPT_DIR/tsconfig.json" "$INSTALL_DIR/"
    cp "$SCRIPT_DIR/.env.example" "$INSTALL_DIR/" 2>/dev/null || true

    print_info "Files copied to $INSTALL_DIR"
}

# ============================================
# Install NPM & Build
# ============================================

install_and_build() {
    print_step "Installing npm dependencies..."
    cd "$INSTALL_DIR"

    if ! npm install --production=false; then
        print_error "npm install failed"
        rollback_on_failure
        exit 1
    fi

    print_step "Building application..."

    if ! npm run build; then
        print_error "Build failed"
        rollback_on_failure
        exit 1
    fi

    print_info "Application built successfully"
}

# ============================================
# Rollback on Failure (update mode only)
# ============================================

rollback_on_failure() {
    if [ "$IS_UPDATE" != true ]; then
        return
    fi

    print_warn "Rolling back to previous version..."

    # Find most recent backup
    LATEST_DIST_BACKUP=$(ls -td "$INSTALL_DIR"/dist.backup.* 2>/dev/null | head -1)
    LATEST_ENV_BACKUP=$(ls -t "$INSTALL_DIR"/.env.backup.* 2>/dev/null | head -1)

    if [ -n "$LATEST_DIST_BACKUP" ]; then
        rm -rf "$INSTALL_DIR/dist"
        mv "$LATEST_DIST_BACKUP" "$INSTALL_DIR/dist"
        print_info "Restored dist/ from backup"
    fi

    if [ -n "$LATEST_ENV_BACKUP" ]; then
        cp "$LATEST_ENV_BACKUP" "$INSTALL_DIR/.env"
        print_info "Restored .env from backup"
    fi

    # Restart service with old code
    if systemctl is-active --quiet $SERVICE_NAME; then
        systemctl restart $SERVICE_NAME
        print_info "Service restarted with previous version"
    fi
}

# ============================================
# Systemd Service
# ============================================

setup_systemd() {
    print_step "Setting up systemd service..."

    # Update WorkingDirectory and ExecStart paths
    sed "s|WorkingDirectory=.*|WorkingDirectory=$INSTALL_DIR|g; s|ExecStart=.*|ExecStart=/usr/bin/node $INSTALL_DIR/dist/index.js|g" \
        "$SCRIPT_DIR/fula-ai-service.service" > /etc/systemd/system/${SERVICE_NAME}.service

    systemctl daemon-reload
    systemctl enable $SERVICE_NAME

    print_info "Systemd service configured"
}

# ============================================
# Nginx Configuration
# ============================================

configure_nginx() {
    if [ -z "$DOMAIN" ]; then
        print_info "No domain specified, skipping nginx configuration"
        return
    fi

    print_step "Configuring Nginx..."

    PORT=${PORT:-$DEFAULT_PORT}

    cat > /etc/nginx/sites-available/${SERVICE_NAME} << EOF
# Fula AI Service
# Generated by install.sh

server {
    listen 80;
    server_name $DOMAIN;

    client_max_body_size 10M;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location /health {
        proxy_pass http://127.0.0.1:$PORT;
        access_log off;
    }
}
EOF

    ln -sf /etc/nginx/sites-available/${SERVICE_NAME} /etc/nginx/sites-enabled/
    nginx -t

    print_info "Nginx configured for $DOMAIN"
}

# ============================================
# SSL Certificate
# ============================================

setup_ssl() {
    if [ -z "$DOMAIN" ]; then
        return
    fi

    print_step "Setting up SSL certificate..."

    read -p "Obtain SSL certificate now? [y/N]: " SSL_CONFIRM
    if [[ ! "$SSL_CONFIRM" =~ ^[Yy]$ ]]; then
        print_warn "Skipping SSL. Run 'certbot --nginx -d $DOMAIN' manually later."
        return
    fi

    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "admin@$DOMAIN" || {
        print_warn "Certbot failed. Run 'certbot --nginx -d $DOMAIN' manually."
    }

    print_info "SSL certificate configured"
}

# ============================================
# Start Services
# ============================================

start_services() {
    print_step "Starting services..."

    if [ "$IS_UPDATE" = true ]; then
        systemctl restart $SERVICE_NAME
    else
        systemctl start $SERVICE_NAME
    fi

    if [ -n "$DOMAIN" ]; then
        systemctl restart nginx
    fi

    # Verify service is running
    sleep 2
    if systemctl is-active --quiet $SERVICE_NAME; then
        print_info "Service is running"
    else
        print_error "Service failed to start. Check: journalctl -u $SERVICE_NAME -n 50"
        exit 1
    fi
}

# ============================================
# Summary
# ============================================

print_summary() {
    echo ""
    echo -e "${GREEN}╔═══════════════════════════════════════════════════╗${NC}"
    if [ "$IS_UPDATE" = true ]; then
        echo -e "${GREEN}║         Update Complete!                          ║${NC}"
    else
        echo -e "${GREEN}║         Installation Complete!                    ║${NC}"
    fi
    echo -e "${GREEN}╚═══════════════════════════════════════════════════╝${NC}"
    echo ""
    echo "Service Status:"
    echo "  systemctl status $SERVICE_NAME"
    echo ""
    echo "View Logs:"
    echo "  journalctl -u $SERVICE_NAME -f"
    echo ""
    echo "Endpoints:"
    if [ -n "$DOMAIN" ]; then
        echo "  https://$DOMAIN/health"
        echo "  https://$DOMAIN/api/v1/generate"
    else
        echo "  http://localhost:${PORT:-3002}/health"
        echo "  http://localhost:${PORT:-3002}/api/v1/generate"
    fi
    echo ""
    echo "Configuration:"
    echo "  $INSTALL_DIR/.env"
    echo ""
    echo "To restart:"
    echo "  systemctl restart $SERVICE_NAME"
    echo ""
}

# ============================================
# Main
# ============================================

main() {
    print_banner
    check_root
    detect_mode

    if [ "$IS_UPDATE" = true ]; then
        collect_config_update
        # Stop service before update
        if systemctl is-active --quiet $SERVICE_NAME; then
            print_step "Stopping service for update..."
            systemctl stop $SERVICE_NAME
        fi
    else
        collect_config_fresh
        install_dependencies
    fi

    install_node
    copy_files

    if [ "$IS_UPDATE" != true ]; then
        write_env_file
    fi

    install_and_build
    setup_systemd

    if [ "$IS_UPDATE" != true ]; then
        configure_nginx
        setup_ssl
    fi

    start_services
    print_summary
}

# Run main
main
