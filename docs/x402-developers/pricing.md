---
layout: default
title: Pricing
parent: x402 Developers
nav_order: 4
---

# x402 Pricing
{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Pricing Formula

```
price = ceil(size_mb × hours × base_rate_micro_usdc)
```

| Variable | Value |
|:---------|:------|
| `size_mb` | Content size in MB (bytes / 1,048,576) |
| `hours` | TTL in hours (seconds / 3600) |
| `base_rate_micro_usdc` | 10,000 (= $0.01) |

Result is in **microUSDC** (1 USDC = 1,000,000 microUSDC).

---

## Rate Summary

| Metric | Value |
|:-------|:------|
| **Base Price** | $0.01 per MB per hour |
| **Minimum Payment** | $0.001 USDC (1,000 microUSDC) |

---

## Price Examples

| Size | Duration | Calculation | Price |
|:-----|:---------|:------------|:------|
| 1 MB | 1 hour | 1 × 1 × 10,000 | **$0.01** |
| 10 MB | 1 hour | 10 × 1 × 10,000 | **$0.10** |
| 100 MB | 1 hour | 100 × 1 × 10,000 | **$1.00** |
| 1 MB | 24 hours | 1 × 24 × 10,000 | **$0.24** |
| 10 MB | 24 hours | 10 × 24 × 10,000 | **$2.40** |
| 100 MB | 24 hours | 100 × 24 × 10,000 | **$24.00** |
| 1 GB | 1 hour | 1024 × 1 × 10,000 | **$10.24** |
| 1 GB | 7 days | 1024 × 168 × 10,000 | **$1,720.32** |

---

## Query Current Pricing

```bash
curl https://x402.api.cloud.fx.land/health/pricing
```

### Response

```json
{
  "basePriceMicroUsdc": 10000,
  "basePriceUsdc": 0.01,
  "minPaymentMicroUsdc": 1000,
  "minPaymentUsdc": 0.001,
  "fulaExchangeRate": 1.0,
  "network": "eip155:324705682",
  "tokenAddress": "0x...",
  "tokenName": "Bridged USDC (SKALE Bridge)",
  "basePricePerMbHour": "$0.010000 USDC",
  "minimumPayment": "$0.001000 USDC",
  "examples": [
    {"size": "1 MB", "duration": "1 hour", "price": "$0.010000 USDC"},
    {"size": "10 MB", "duration": "1 hour", "price": "$0.100000 USDC"},
    {"size": "100 MB", "duration": "24 hours", "price": "$24.000000 USDC"},
    {"size": "1 GB", "duration": "7 days", "price": "$1720.320000 USDC"}
  ]
}
```

---

## Calculate Prices Programmatically

### JavaScript

```javascript
function calculatePriceMicroUsdc(sizeBytes, ttlSeconds) {
  const sizeMb = sizeBytes / (1024 * 1024);
  const hours = ttlSeconds / 3600;
  const basePriceMicroUsdc = 10000;
  const minPaymentMicroUsdc = 1000;

  const price = Math.ceil(sizeMb * hours * basePriceMicroUsdc);
  return Math.max(price, minPaymentMicroUsdc);
}

function calculatePriceUsdc(sizeBytes, ttlSeconds) {
  return calculatePriceMicroUsdc(sizeBytes, ttlSeconds) / 1_000_000;
}

// Example: 10 MB for 24 hours
const price = calculatePriceUsdc(10 * 1024 * 1024, 86400);
console.log(`Price: $${price} USDC`);
// Output: Price: $2.4 USDC
```

### Python

```python
import math

def calculate_price_micro_usdc(size_bytes: int, ttl_seconds: int) -> int:
    size_mb = size_bytes / (1024 * 1024)
    hours = ttl_seconds / 3600
    base_price_micro_usdc = 10000
    min_payment_micro_usdc = 1000

    price = math.ceil(size_mb * hours * base_price_micro_usdc)
    return max(price, min_payment_micro_usdc)

def calculate_price_usdc(size_bytes: int, ttl_seconds: int) -> float:
    return calculate_price_micro_usdc(size_bytes, ttl_seconds) / 1_000_000

# Example: 10 MB for 24 hours
price = calculate_price_usdc(10 * 1024 * 1024, 86400)
print(f"Price: ${price} USDC")
# Output: Price: $2.4 USDC
```

---

## TTL Options

| Duration | Seconds | Use Case |
|:---------|:--------|:---------|
| 1 minute | 60 | Minimum; quick transfers |
| 1 hour | 3600 | Default; short-term |
| 24 hours | 86400 | Day-long access |
| 7 days | 604800 | Week-long projects |
| 30 days | 2592000 | Maximum; month-long |

---

## Cost Optimization

### Use Shorter TTL

Don't pay for 24 hours if you need 1 hour.

```bash
# 1 hour instead of default
-H "X-Fula-TTL: 3600"
```

### Batch Small Files

Multiple tiny files each pay minimum ($0.001). Consider combining.

### Consider Pinning API for Long-Term

For permanent storage, FULA credits may be cheaper:
- **x402**: $0.01/MB/hour = $7.20/MB/month
- **FULA**: 3 FULA/GB/month (varies by FULA price)

---

## Payment Token

| Property | Value |
|:---------|:------|
| Token | USDC |
| Network | SKALE Europa |
| Decimals | 6 |
| 1 USDC | 1,000,000 microUSDC |

### Getting USDC on SKALE

1. Bridge USDC from Ethereum using [SKALE Bridge](https://bridge.skale.network)
2. Connect to SKALE Europa network
3. Ensure USDC balance before uploading

---

## Price Verification

The 402 response shows exact payment:

```json
{
  "accepts": [{
    "maxAmountRequired": "10000",
    "description": "Storage: 0.01 MB for 1 hour"
  }]
}
```

- `maxAmountRequired`: Amount in microUSDC
- `description`: Human-readable summary

{: .warning }
> Always verify the amount before signing. Never auto-approve without checking.

---

## Comparing Pricing Models

| Model | Rate | Monthly for 1 GB |
|:------|:-----|:-----------------|
| x402 | $0.01/MB/hour | ~$7,200 |
| FULA Credits | 3 FULA/GB/month | ~$0.30* |
| Free Tier | $0 (500 MB) | $0 |

*Assuming 1 FULA ≈ $0.10

**Recommendation:**
- Use x402 for temporary, one-time uploads
- Use FULA credits for long-term storage
