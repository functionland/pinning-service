---
layout: default
title: x402 Gateway
---

# x402 Gateway

**Base URL**: `https://x402.api.cloud.fx.land`

The x402 Gateway enables pay-per-upload storage using the HTTP 402 Payment Required protocol with USDC on SKALE Network.

## In This Section

- [Payment Flow](payment-flow/) - Complete protocol walkthrough
- [Upload (PUT)](upload/) - Upload content with payment
- [Pricing](pricing/) - Cost calculation and examples
- [Error Handling](errors/) - Payment errors and troubleshooting

## What is x402?

The [x402 protocol](https://github.com/coinbase/x402) standardizes HTTP micropayments:

1. Client requests a resource
2. Server returns `402 Payment Required` with payment details
3. Client signs a payment and retries with the payment header
4. Server verifies, fulfills the request, and settles the payment

## Key Features

### No Account Required

With x402, your wallet IS your identity. You don't need to:
- Create an account
- Generate API keys
- Pre-purchase credits

Just include a payment with your request.

### Gas-Free Transactions

Payments use USDC on SKALE Network, which has zero gas fees for token transfers.

### Time-Based Storage

Pay for the storage duration you need:
- Store 1 MB for 1 hour: $0.01
- Store 10 MB for 24 hours: $2.40
- Minimum: 1 minute, Maximum: 30 days

### S3-Compatible Backend

Content is stored on the S3 backend at `s3.cloud.fx.land`, providing reliable, redundant storage.

## Network Details

| Parameter | Value |
|-----------|-------|
| Network | SKALE Europa |
| Chain ID | 324705682 |
| Network Identifier | eip155:324705682 |
| Token | USDC (Bridged) |
| Token Decimals | 6 |

Query current network details:

```bash
curl https://x402.api.cloud.fx.land/health/pricing
```

## Endpoints

| Method | Endpoint | Payment | Description |
|--------|----------|---------|-------------|
| PUT | `/:bucket/:key` | Required | Upload content |
| GET | `/:bucket/:key` | No | Download content |
| HEAD | `/:bucket/:key` | No | Check existence |
| DELETE | `/:bucket/:key` | Required | Delete content |
| GET | `/health` | No | Health check |
| GET | `/health/pricing` | No | Pricing info |

## Headers

### Standard x402 Headers

| Header | Direction | Description |
|--------|-----------|-------------|
| `X-PAYMENT-REQUIRED` | Response | Payment requirements (402 response) |
| `X-PAYMENT` | Request | Signed payment payload |
| `X-PAYMENT-RESPONSE` | Response | Settlement confirmation |

### Alternative Payment Header

```
Payment-Authorization: x402 <base64-payload>
```

### TTL Header

```
X-Fula-TTL: 3600
```

Specifies storage duration in seconds.

## Quick Example

### Step 1: Request Without Payment

```bash
curl -X PUT "https://x402.api.cloud.fx.land/mybucket/file.txt" \
  -H "Content-Type: text/plain" \
  -H "Content-Length: 1024" \
  -H "X-Fula-TTL: 3600" \
  -d "Hello World"
```

### Step 2: Receive 402 Response

```json
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:324705682",
    "maxAmountRequired": "10000",
    "payTo": "0x...",
    "asset": "eip155:324705682/erc20:0x...",
    "description": "Storage: 0.01 MB for 1 hour"
  }],
  "error": "Payment Required"
}
```

### Step 3: Sign and Retry

Sign the payment using EIP-712 and retry with the `X-PAYMENT` header.

See [Payment Flow](payment-flow/) for complete details.

## When to Use x402

**Use x402 when:**
- You need one-time uploads without account setup
- You want wallet-based authentication
- You're building decentralized applications
- You want pay-as-you-go without pre-funding

**Use the standard Pinning API when:**
- You need long-term pinning
- You prefer account-based management
- You want to use FULA credits
- You need to manage pins (list, delete, etc.)

## Integration Libraries

The x402 protocol is supported by various libraries:
- JavaScript: [@x402/client](https://www.npmjs.com/package/@x402/client)
- See [x402 GitHub](https://github.com/coinbase/x402) for more

## Next Steps

- [Payment Flow](payment-flow/) - Understand the complete protocol
- [Pricing](pricing/) - Calculate costs for your use case
- [Upload](upload/) - PUT endpoint reference
