#!/bin/bash
#
# x402-skale Gateway Installation Script
#
# This script:
# 1. Prompts for configuration
# 2. Installs Node.js 20+ if needed
# 3. Installs npm dependencies
# 4. Sets up SQLite database
# 5. Configures systemd service
# 6. Installs and configures Nginx
# 7. Obtains SSL certificate via Certbot
# 8. Starts the service
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
    echo "║       x402-skale Gateway Installation             ║"
    echo "║         SKALE Network • USDC Payments             ║"
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
SERVICE_NAME="x402-gateway"
DEFAULT_INSTALL_DIR="/home/root/pinning-service/x402-skale"
DEFAULT_DATA_DIR="/home/root/pinning-service/data"

# Default values
DEFAULT_PORT=4002
DEFAULT_FACILITATOR_URL="https://facilitator.dirtroad.dev"
DEFAULT_NETWORK_CHAIN_ID=324705682
DEFAULT_PAYMENT_TOKEN_ADDRESS="0x2e08028E3C4c2356572E096d8EF835cD5C6030bD"
DEFAULT_PAYMENT_TOKEN_NAME="Bridged USDC (SKALE Bridge)"
DEFAULT_S3_BACKEND_URL="http://127.0.0.1:9000"
DEFAULT_PINNING_WEBUI_URL="http://127.0.0.1:3001"
DEFAULT_BASE_PRICE=10000
DEFAULT_MIN_PAYMENT=1000

# Prompt for configuration
collect_config() {
    print_step "Collecting configuration..."
    echo ""

    # Install directory
    read -p "Enter install directory [${DEFAULT_INSTALL_DIR}]: " INSTALL_DIR
    INSTALL_DIR=${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}

    # Data directory (for shared database)
    DATA_DIR=$(dirname "$INSTALL_DIR")/data

    # Domain
    read -p "Enter domain name (e.g., x402.cloud.fx.land): " DOMAIN
    if [ -z "$DOMAIN" ]; then
        print_error "Domain is required"
        exit 1
    fi

    # Receiving address
    read -p "Enter receiving wallet address (0x...): " RECEIVING_ADDRESS
    if [[ ! "$RECEIVING_ADDRESS" =~ ^0x[a-fA-F0-9]{40}$ ]]; then
        print_error "Invalid Ethereum address"
        exit 1
    fi

    # Facilitator URL
    read -p "Enter facilitator URL [${DEFAULT_FACILITATOR_URL}]: " FACILITATOR_URL
    FACILITATOR_URL=${FACILITATOR_URL:-$DEFAULT_FACILITATOR_URL}

    # Pinning service system key
    read -p "Enter pinning service system key: " PINNING_SYSTEM_KEY
    if [ -z "$PINNING_SYSTEM_KEY" ]; then
        print_error "Pinning system key is required"
        exit 1
    fi

    # Pinning webui URL
    read -p "Enter pinning webui URL [${DEFAULT_PINNING_WEBUI_URL}]: " PINNING_WEBUI_URL
    PINNING_WEBUI_URL=${PINNING_WEBUI_URL:-$DEFAULT_PINNING_WEBUI_URL}

    # S3 backend URL
    read -p "Enter S3 backend URL [${DEFAULT_S3_BACKEND_URL}]: " S3_BACKEND_URL
    S3_BACKEND_URL=${S3_BACKEND_URL:-$DEFAULT_S3_BACKEND_URL}

    # Shared database path (pinning.db)
    read -p "Enter shared database path [${DATA_DIR}/pinning.db]: " DATABASE_PATH
    DATABASE_PATH=${DATABASE_PATH:-$DATA_DIR/pinning.db}

    # Verify database exists
    if [ ! -f "$DATABASE_PATH" ]; then
        print_warn "Database not found at $DATABASE_PATH"
        print_info "Make sure pinning-service is installed first, or the database will be created."
    fi

    # Optional: JWT secret
    read -p "Enter JWT secret (optional, press enter to skip): " JWT_SECRET

    # Port
    read -p "Enter gateway port [${DEFAULT_PORT}]: " PORT
    PORT=${PORT:-$DEFAULT_PORT}

    echo ""
    print_info "Configuration summary:"
    echo "  Install Dir:       $INSTALL_DIR"
    echo "  Domain:            $DOMAIN"
    echo "  Receiving Address: $RECEIVING_ADDRESS"
    echo "  Facilitator:       $FACILITATOR_URL"
    echo "  Pinning WebUI:     $PINNING_WEBUI_URL"
    echo "  S3 Backend:        $S3_BACKEND_URL"
    echo "  Database:          $DATABASE_PATH"
    echo "  Port:              $PORT"
    echo ""

    read -p "Continue with installation? [y/N]: " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        print_info "Installation cancelled"
        exit 0
    fi
}

# Install Node.js 20
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

    # Install via NodeSource
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs

    print_info "Node.js $(node -v) installed"
}

# Install system dependencies
install_dependencies() {
    print_step "Installing system dependencies..."

    apt-get update
    apt-get install -y \
        build-essential \
        python3 \
        nginx \
        certbot \
        python3-certbot-nginx \
        sqlite3

    print_info "System dependencies installed"
}

# Copy application files
copy_files() {
    print_step "Copying application files..."

    # Create directories
    mkdir -p "$INSTALL_DIR"

    # Ensure database directory exists
    DB_DIR=$(dirname "$DATABASE_PATH")
    if [ ! -d "$DB_DIR" ]; then
        print_info "Creating database directory: $DB_DIR"
        mkdir -p "$DB_DIR"
    fi

    # Copy source files
    cp -r "$SCRIPT_DIR/src" "$INSTALL_DIR/"
    cp -r "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"
    cp -r "$SCRIPT_DIR/tsconfig.json" "$INSTALL_DIR/"

    # Create .env file
    cat > "$INSTALL_DIR/.env" << EOF
# x402-skale Gateway Configuration
# Generated by install.sh on $(date)

# Server
PORT=$PORT
NODE_ENV=production

# x402 Payment (SKALE)
FACILITATOR_URL=$FACILITATOR_URL
RECEIVING_ADDRESS=$RECEIVING_ADDRESS
NETWORK_CHAIN_ID=$DEFAULT_NETWORK_CHAIN_ID
PAYMENT_TOKEN_ADDRESS=$DEFAULT_PAYMENT_TOKEN_ADDRESS
PAYMENT_TOKEN_NAME=$DEFAULT_PAYMENT_TOKEN_NAME

# S3 Backend
S3_BACKEND_URL=$S3_BACKEND_URL

# Pinning Service
PINNING_WEBUI_URL=$PINNING_WEBUI_URL
PINNING_SYSTEM_KEY=$PINNING_SYSTEM_KEY

# Database (shared with pinning service)
DATABASE_PATH=$DATABASE_PATH

# Pricing
BASE_PRICE_MICRO_USDC=$DEFAULT_BASE_PRICE
MIN_PAYMENT_MICRO_USDC=$DEFAULT_MIN_PAYMENT
FULA_EXCHANGE_RATE=1.0

# JWT (optional)
JWT_SECRET=$JWT_SECRET
EOF

    chmod 600 "$INSTALL_DIR/.env"

    print_info "Files copied to $INSTALL_DIR"
}

# Install npm dependencies
install_npm() {
    print_step "Installing npm dependencies..."

    cd "$INSTALL_DIR"
    npm install --production=false

    print_info "Dependencies installed"
}

# Build TypeScript
build_app() {
    print_step "Building application..."

    cd "$INSTALL_DIR"
    npm run build

    print_info "Application built"
}

# Create systemd service
create_systemd_service() {
    print_step "Creating systemd service..."

    cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=x402-skale Payment Gateway
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node $INSTALL_DIR/dist/index.js
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=$SERVICE_NAME
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable $SERVICE_NAME

    print_info "Systemd service created"
}

# Configure Nginx
configure_nginx() {
    print_step "Configuring Nginx..."

    # Start with HTTP-only config - Certbot will add HTTPS
    cat > /etc/nginx/sites-available/${SERVICE_NAME} << EOF
# x402-skale Gateway
# Generated by install.sh
# Run certbot to add HTTPS support

server {
    listen 80;
    server_name $DOMAIN;

    # Allow large uploads (100MB)
    client_max_body_size 100M;

    # Proxy settings
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # For large uploads
        proxy_request_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;

        # WebSocket support (if needed)
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # Health check endpoint (no logging)
    location /health {
        proxy_pass http://127.0.0.1:$PORT;
        access_log off;
    }
}
EOF

    # Enable site
    ln -sf /etc/nginx/sites-available/${SERVICE_NAME} /etc/nginx/sites-enabled/

    # Test nginx config
    nginx -t

    print_info "Nginx configured"
}

# Obtain SSL certificate
setup_ssl() {
    print_step "Setting up SSL certificate..."

    read -p "Obtain SSL certificate now? [y/N]: " SSL_CONFIRM
    if [[ ! "$SSL_CONFIRM" =~ ^[Yy]$ ]]; then
        print_warn "Skipping SSL setup. Run 'certbot --nginx -d $DOMAIN' manually later."
        return
    fi

    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "admin@$DOMAIN" || {
        print_warn "Certbot failed. You may need to run it manually."
        print_info "Command: certbot --nginx -d $DOMAIN"
    }

    print_info "SSL certificate configured"
}

# Start services
start_services() {
    print_step "Starting services..."

    systemctl restart nginx
    systemctl start $SERVICE_NAME

    print_info "Services started"
}

# Print final instructions
print_summary() {
    echo ""
    echo -e "${GREEN}╔═══════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║         Installation Complete!                    ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════════════════╝${NC}"
    echo ""
    echo "Service Status:"
    echo "  systemctl status $SERVICE_NAME"
    echo ""
    echo "View Logs:"
    echo "  journalctl -u $SERVICE_NAME -f"
    echo ""
    echo "Endpoints:"
    echo "  https://$DOMAIN/health"
    echo "  https://$DOMAIN/health/pricing"
    echo ""
    echo "Configuration:"
    echo "  $INSTALL_DIR/.env"
    echo ""
    echo "Database (shared with pinning service):"
    echo "  $DATABASE_PATH"
    echo ""
    echo "To restart:"
    echo "  systemctl restart $SERVICE_NAME"
    echo ""
}

# Main installation
main() {
    print_banner
    check_root
    collect_config
    install_dependencies
    install_node
    copy_files
    install_npm
    build_app
    create_systemd_service
    configure_nginx
    setup_ssl
    start_services
    print_summary
}

# Run main
main
