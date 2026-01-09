---
layout: default
title: Fx.Land Cloud Documentation
---

# Fx.Land Cloud Documentation

Welcome to the documentation for Fx.Land's decentralized cloud storage infrastructure.

## Services

| Service | URL | Description |
|---------|-----|-------------|
| **Pinning API** | [api.cloud.fx.land](https://api.cloud.fx.land) | OpenAPI-compliant IPFS pinning service |
| **Web Interface** | [cloud.fx.land](https://cloud.fx.land) | Dashboard for managing pins, API keys, and billing |
| **x402 Gateway** | [x402.api.cloud.fx.land](https://x402.api.cloud.fx.land) | Pay-per-upload storage with USDC micropayments |

## Choose Your Path

### For WebUI Users

If you want to manage your files through a web interface:

1. [Getting Started with the WebUI](webui/getting-started/) - Sign up and pin your first file
2. [Managing API Keys](webui/api-keys/) - Create keys for programmatic access
3. [Credits & Billing](webui/credits/) - Understand storage costs and add credits

### For IPFS Developers

If you're building applications that use IPFS pinning:

1. [Quick Start](quickstart/) - Pin content in 5 minutes
2. [Authentication](pinning-api/authentication/) - Set up API access
3. [Pins API Reference](pinning-api/pins/) - Full endpoint documentation

### For x402 Integrators

If you're integrating pay-per-upload storage:

1. [x402 Overview](x402/) - Understand the payment protocol
2. [Payment Flow](x402/payment-flow/) - Step-by-step integration guide
3. [Pricing](x402/pricing/) - Cost calculation and examples

## Quick Links

- [Quick Start Guide](quickstart/) - Get started in 5 minutes
- [API Authentication](pinning-api/authentication/) - Bearer tokens and API keys
- [Pricing Information](x402/pricing/) - Storage costs and calculations
- [Status Codes Reference](reference/status-codes/) - Error handling

## External Resources

- **S3 API**: Content storage backend at [s3.cloud.fx.land](https://s3.cloud.fx.land) - See [Fula API Documentation](https://docs.fx.land/fula-api)
- **IPFS Pinning Service Spec**: [ipfs.github.io/pinning-services-api-spec](https://ipfs.github.io/pinning-services-api-spec/)
- **x402 Protocol**: [github.com/coinbase/x402](https://github.com/coinbase/x402)

## Deprecated Services

The following components are deprecated and no longer maintained:

- `functions/` - Firebase Cloud Functions (legacy)
- `firebase-trigger/` - Firebase triggers (legacy)
- Firebase backend (`main.go`) - Replaced by SQLite backend
