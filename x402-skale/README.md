# x402-skale Payment Gateway

An x402-compatible payment gateway for Fula Storage on SKALE network. This gateway enables pay-per-upload storage using USDC micropayments.

## Overview

The gateway acts as a transparent proxy between clients and the S3 backend, adding x402 payment verification while passing through JWT authentication.

```
Client → x402 Gateway → S3 Backend (s3.cloud.fx.land)
              ↓
         Facilitator (SKALE)
              ↓
         Pinning Service (credit adjustment)
```

## Features

- **x402 Payment Protocol**: Standard HTTP 402 payment flow
- **SKALE Network**: Fast, gasless transactions
- **USDC Payments**: Stable pricing in USD
- **JWT Pass-through**: Uses existing authentication
- **Ephemeral Storage**: Automatic cleanup after TTL expires
- **Credit Integration**: Adjusts pinning service credits

## Quick Start

### Using Docker

```bash
# Copy and configure environment
cp .env.example .env
# Edit .env with your configuration

# Start with docker-compose
docker-compose up -d
```

### Using install.sh (Production)

```bash
# Run installation script as root
sudo ./install.sh
```

### Manual Installation

```bash
# Install dependencies
npm install

# Build
npm run build

# Run
npm start
```

## Configuration

Copy `.env.example` to `.env` and configure:

```env
# Required
RECEIVING_ADDRESS=0x...       # Your wallet for payments
PINNING_SYSTEM_KEY=...        # System key for credit adjustment

# Optional (defaults shown)
PORT=4002
FACILITATOR_URL=https://facilitator.dirtroad.dev
NETWORK_CHAIN_ID=324705682
S3_BACKEND_URL=http://127.0.0.1:9000
PINNING_WEBUI_URL=http://127.0.0.1:3001
```

## API Usage

### Upload with Payment (PUT)

```bash
# First request returns 402 with payment requirements
curl -X PUT https://x402.example.com/mybucket/file.txt \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/octet-stream" \
  -H "X-Fula-TTL: 3600" \
  -d "file content"

# Response: 402 Payment Required
{
  "error": "Payment Required",
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:324705682",
    "maxAmountRequired": "10000",
    "payTo": "0x...",
    "asset": "eip155:324705682/erc20:0x2e08..."
  }]
}
```

```bash
# Second request with payment signature
curl -X PUT https://x402.example.com/mybucket/file.txt \
  -H "Authorization: Bearer <jwt>" \
  -H "Payment-Authorization: x402 <signature>" \
  -H "X-Fula-TTL: 3600" \
  -d "file content"

# Response: 200 OK
{
  "success": true,
  "cid": "QmXyz...",
  "expires_at": "2026-01-08T20:00:00Z",
  "tx_hash": "0xabc..."
}
```

### Download (GET)

```bash
curl https://x402.example.com/mybucket/file.txt \
  -H "Authorization: Bearer <jwt>"
```

### Health Check

```bash
curl https://x402.example.com/health

# Pricing info
curl https://x402.example.com/health/pricing
```

## Pricing

| Size | Duration | Price |
|------|----------|-------|
| 1 MB | 1 hour | $0.01 |
| 10 MB | 1 hour | $0.10 |
| 100 MB | 24 hours | $2.40 |
| 1 GB | 7 days | $168.00 |

Base rate: $0.01 per MB-hour (10,000 µUSDC)

## Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | None | Health check |
| `/health/pricing` | GET | None | Pricing info |
| `/:bucket/:key` | PUT | JWT + x402 | Upload with payment |
| `/:bucket/:key` | GET | JWT | Download |
| `/:bucket/:key` | HEAD | JWT | Check existence |
| `/:bucket/:key` | DELETE | JWT | Delete object |

## Development

```bash
# Development with hot reload
npm run dev

# Type checking
npm run typecheck

# Run tests
npm test
```

## Architecture

```
src/
├── index.ts                 # Entry point
├── app.ts                   # Hono app setup
├── config/                  # Configuration
├── database/                # SQLite schema & repos
├── middleware/
│   ├── x402Payment.ts       # x402 verification
│   └── jwtValidator.ts      # JWT validation
├── routes/
│   ├── health.ts            # Health endpoints
│   └── s3Proxy.ts           # S3 proxy routes
└── services/
    ├── s3Proxy.ts           # S3 pass-through
    ├── pinningIntegration.ts # Credit adjustment
    ├── pricing.ts           # Pricing calculations
    └── cleanup.ts           # TTL cleanup cron
```

## License

MIT
