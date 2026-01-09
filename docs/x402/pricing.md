---
layout: default
title: Pricing - x402 Gateway
---

# x402 Pricing

Understand how storage costs are calculated.

## Pricing Formula

```
price = ceil(size_mb × hours × base_rate_micro_usdc)
```

Where:
- `size_mb` = content size in megabytes (bytes / 1,048,576)
- `hours` = TTL in hours (seconds / 3600)
- `base_rate_micro_usdc` = 10,000 (= $0.01 USDC)

Result is in microUSDC (1 USDC = 1,000,000 microUSDC).

## Base Rate

| Metric | Value |
|--------|-------|
| Base Price | $0.01 per MB per hour |
| In microUSDC | 10,000 per MB per hour |

## Minimum Payment

| Metric | Value |
|--------|-------|
| Minimum Payment | $0.001 USDC |
| In microUSDC | 1,000 |

Payments below the minimum are rounded up.

## Price Examples

| Size | Duration | Calculation | Price |
|------|----------|-------------|-------|
| 1 MB | 1 hour | 1 × 1 × 10,000 | $0.01 |
| 10 MB | 1 hour | 10 × 1 × 10,000 | $0.10 |
| 100 MB | 1 hour | 100 × 1 × 10,000 | $1.00 |
| 1 MB | 24 hours | 1 × 24 × 10,000 | $0.24 |
| 10 MB | 24 hours | 10 × 24 × 10,000 | $2.40 |
| 100 MB | 24 hours | 100 × 24 × 10,000 | $24.00 |
| 1 GB | 1 hour | 1024 × 1 × 10,000 | $10.24 |
| 1 GB | 7 days | 1024 × 168 × 10,000 | $1,720.32 |

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

## Calculating Prices Programmatically

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

// Example: 10 MB for 24 hours
const price = calculatePriceMicroUsdc(10 * 1024 * 1024, 86400);
console.log(`Price: ${price / 1000000} USDC`);
// Output: Price: 2.4 USDC
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

# Example: 10 MB for 24 hours
price = calculate_price_micro_usdc(10 * 1024 * 1024, 86400)
print(f"Price: ${price / 1_000_000} USDC")
# Output: Price: $2.4 USDC
```

## TTL Considerations

| Duration | Seconds | Use Case |
|----------|---------|----------|
| 1 minute | 60 | Minimum; temporary transfers |
| 1 hour | 3600 | Default; short-term sharing |
| 24 hours | 86400 | Day-long access |
| 7 days | 604800 | Week-long projects |
| 30 days | 2592000 | Maximum; month-long storage |

### Cost Optimization Tips

1. **Use shorter TTL for temp files**: Don't pay for 24 hours if you need 1 hour
2. **Clean up unused content**: Delete before TTL expires if no longer needed
3. **Batch small files**: Multiple tiny files each pay minimum; combine if possible
4. **Consider Pinning API for long-term**: FULA credits may be cheaper for permanent storage

## Payment Token

| Property | Value |
|----------|-------|
| Token | USDC |
| Network | SKALE Europa |
| Contract | Query `/health/pricing` for current address |
| Decimals | 6 (1 USDC = 1,000,000 units) |

### Getting USDC on SKALE

1. Bridge USDC from Ethereum to SKALE Europa
2. Use the SKALE Bridge at [bridge.skale.network](https://bridge.skale.network)
3. Ensure you have USDC in your wallet on SKALE

## Comparing to Credit-Based Pricing

| Model | Rate | Best For |
|-------|------|----------|
| x402 (per upload) | $0.01/MB-hour | One-time uploads, no commitment |
| FULA Credits | 3 FULA/GB-month | Long-term storage, high volume |

### Example Comparison

Storing 1 GB for 30 days:

- **x402**: 1024 MB × 720 hours × $0.01 = $7,372.80
- **FULA**: 3 FULA × market rate (varies)

For long-term storage, FULA credits are typically more economical.

## Price Verification

The `maxAmountRequired` in the 402 response tells you exactly what you'll pay:

```json
{
  "accepts": [{
    "maxAmountRequired": "10000",
    "description": "Storage: 0.01 MB for 1 hour"
  }]
}
```

- `maxAmountRequired`: Amount in microUSDC (10000 = $0.01)
- `description`: Human-readable summary

Always verify the amount before signing the payment.
