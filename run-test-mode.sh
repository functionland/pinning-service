#!/bin/bash
# IPFS Pinning Service - Test Mode Startup Script (Linux/Mac)
# This script starts the service in test mode for compliance testing

echo "============================================"
echo "IPFS Pinning Service - Test Mode"
echo "============================================"
echo ""

# Check if IPFS is running
echo "Checking IPFS node..."
if ipfs id > /dev/null 2>&1; then
    IPFS_ID=$(ipfs id -f="<id>")
    echo "✓ IPFS node running: ${IPFS_ID:0:12}..."
else
    echo "✗ IPFS node not running!"
    echo "  Please start IPFS daemon first: ipfs daemon"
    exit 1
fi

# Set environment variables for test mode
export TEST_MODE=true
export PORT=6000
export DATABASE_PATH=data/pinning_test.db
export IPFS_API_ADDR=/ip4/127.0.0.1/tcp/5001
export SYSTEM_KEY=test-system-key

# Create data directory if it doesn't exist
mkdir -p data

echo ""
echo "Starting service in TEST MODE..."
echo ""
echo "Test Credentials:"
echo "  Endpoint: http://localhost:$PORT"
echo "  Token:    test-token-for-ipfs-pinning-compliance"
echo ""
echo "Run compliance tests with:"
echo "  npx @ipfs-shipyard/pinning-service-compliance -s http://localhost:$PORT test-token-for-ipfs-pinning-compliance"
echo ""
echo "Press Ctrl+C to stop the server"
echo "============================================"
echo ""

# Build and run
echo "Building..."
go build -o ipfs-pinning main_sqlite.go
if [ $? -ne 0 ]; then
    echo "Build failed!"
    exit 1
fi

echo "Running..."
./ipfs-pinning
