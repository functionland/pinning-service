---
layout: default
title: x402 Developers
nav_order: 4
has_children: true
permalink: /x402-developers/
---

# x402 Developer Guide
{: .no_toc }

<span class="audience-badge x402">For Integrators</span>

Integrate pay-per-upload storage using the HTTP 402 protocol with USDC on SKALE.
{: .fs-6 .fw-300 }

---

## What is x402?

**Base URL**: `https://x402.api.cloud.fx.land`

The [x402 protocol](https://github.com/coinbase/x402) enables HTTP micropayments:

1. **Request** → Client requests upload
2. **402 Response** → Server returns payment requirements
3. **Payment** → Client signs and sends payment
4. **Fulfill** → Server stores content and settles payment

{: .important }
> **No account required** - Your wallet IS your identity. Just pay and upload.

---

## Why x402?

| Feature | Benefit |
|:--------|:--------|
| **No signup** | Upload immediately with wallet payment |
| **Gas-free** | SKALE network has zero gas fees |
| **Pay-as-you-go** | Only pay for what you use |
| **Time-based** | Choose storage duration (1 min to 30 days) |

---

## Quick Example

### Step 1: Request Upload (Get Price)

```bash
curl -X PUT "https://x402.api.cloud.fx.land/mybucket/file.txt" \
  -H "Content-Type: text/plain" \
  -H "Content-Length: 1024" \
  -H "X-Fula-TTL: 3600" \
  -d "Hello World"
```

### Step 2: Receive 402 Payment Required

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

### Step 3: Sign Payment & Retry

```bash
curl -X PUT "https://x402.api.cloud.fx.land/mybucket/file.txt" \
  -H "Content-Type: text/plain" \
  -H "Content-Length: 1024" \
  -H "X-Fula-TTL: 3600" \
  -H "X-PAYMENT: <base64-signed-payment>" \
  -d "Hello World"
```

### Step 4: Success!

```json
{
  "success": true,
  "cid": "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
  "bucket": "mybucket",
  "key": "file.txt",
  "expires_at": "2024-01-15T11:30:00.000Z",
  "tx_hash": "0xabc123..."
}
```

---

## Network Details

| Parameter | Value |
|:----------|:------|
| Network | SKALE Europa |
| Chain ID | `324705682` |
| Network ID | `eip155:324705682` |
| Token | USDC (Bridged) |
| Token Decimals | 6 |

Query live details:
```bash
curl https://x402.api.cloud.fx.land/health/pricing
```

---

## Pricing

| Rate | Value |
|:-----|:------|
| **Base price** | $0.01 per MB per hour |
| **Minimum payment** | $0.001 USDC |
| **TTL range** | 60 seconds to 30 days |

### Formula

```
price = ceil(size_mb × hours × 10000) microUSDC
```

### Examples

| Size | Duration | Price |
|:-----|:---------|:------|
| 1 MB | 1 hour | $0.01 |
| 10 MB | 1 hour | $0.10 |
| 100 MB | 24 hours | $24.00 |
| 1 GB | 7 days | $1,720.32 |

---

## Endpoints

| Method | Endpoint | Payment | Description |
|:-------|:---------|:--------|:------------|
| `PUT` | `/:bucket/:key` | Required | Upload content |
| `GET` | `/:bucket/:key` | No | Download content |
| `HEAD` | `/:bucket/:key` | No | Check existence |
| `DELETE` | `/:bucket/:key` | Required | Delete content |
| `GET` | `/health/pricing` | No | Get current pricing |
{: .endpoint-table }

---

## Headers

### Request Headers

| Header | Required | Description |
|:-------|:---------|:------------|
| `Content-Type` | Yes | MIME type |
| `Content-Length` | Yes | Size in bytes |
| `X-PAYMENT` | For payment | Base64-encoded signed payment |
| `X-Fula-TTL` | No | Storage duration in seconds (default: 3600) |

### Alternative Payment Header

```
Payment-Authorization: x402 <base64-payload>
```

---

## In This Section

| Page | Description |
|:-----|:------------|
| [Payment Flow]({{ site.baseurl }}/x402-developers/payment-flow/) | Complete protocol walkthrough |
| [Upload Reference]({{ site.baseurl }}/x402-developers/upload/) | PUT endpoint details |
| [Download Reference]({{ site.baseurl }}/x402-developers/download/) | GET/HEAD endpoints |
| [Pricing]({{ site.baseurl }}/x402-developers/pricing/) | Cost calculation and examples |
| [Error Handling]({{ site.baseurl }}/x402-developers/errors/) | 402 responses and troubleshooting |
| [Examples]({{ site.baseurl }}/x402-developers/examples/) | JavaScript and Python examples |

---

## When to Use x402 vs Pinning API

| Use x402 When | Use Pinning API When |
|:--------------|:---------------------|
| One-time uploads | Long-term pinning |
| No account needed | Account-based management |
| Wallet-based identity | Email-based identity |
| Short-term storage | Permanent storage |
| Pay per upload | Pay with FULA credits |
