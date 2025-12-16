# IPFS Pinning Service - Test Mode Startup Script (Windows PowerShell)
# This script starts the service in test mode for compliance testing

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "IPFS Pinning Service - Test Mode" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Check if IPFS is running
Write-Host "Checking IPFS node..." -ForegroundColor Yellow
try {
    $ipfsId = ipfs id 2>$null | ConvertFrom-Json
    Write-Host "✓ IPFS node running: $($ipfsId.ID.Substring(0,12))..." -ForegroundColor Green
} catch {
    Write-Host "✗ IPFS node not running!" -ForegroundColor Red
    Write-Host "  Please start IPFS daemon first: ipfs daemon" -ForegroundColor Yellow
    exit 1
}

# Set environment variables for test mode
$env:TEST_MODE = "true"
$env:PORT = "6000"
$env:DATABASE_PATH = "data/pinning_test.db"
$env:IPFS_API_ADDR = "/ip4/127.0.0.1/tcp/5001"
$env:SYSTEM_KEY = "test-system-key"

# Create data directory if it doesn't exist
if (-not (Test-Path "data")) {
    New-Item -ItemType Directory -Path "data" | Out-Null
}

Write-Host ""
Write-Host "Starting service in TEST MODE..." -ForegroundColor Yellow
Write-Host ""
Write-Host "Test Credentials:" -ForegroundColor Cyan
Write-Host "  Endpoint: http://localhost:$($env:PORT)" -ForegroundColor White
Write-Host "  Token:    test-token-for-ipfs-pinning-compliance" -ForegroundColor White
Write-Host ""
Write-Host "Run compliance tests with:" -ForegroundColor Cyan
Write-Host "  npx @ipfs-shipyard/pinning-service-compliance -s http://localhost:$($env:PORT) test-token-for-ipfs-pinning-compliance" -ForegroundColor White
Write-Host ""
Write-Host "Press Ctrl+C to stop the server" -ForegroundColor Yellow
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Build and run
Write-Host "Building..." -ForegroundColor Yellow
go build -o ipfs-pinning.exe main_sqlite.go
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed!" -ForegroundColor Red
    exit 1
}

Write-Host "Running..." -ForegroundColor Green
./ipfs-pinning.exe
