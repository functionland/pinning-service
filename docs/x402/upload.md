---
layout: default
title: Upload (PUT) - x402 Gateway
---

# Upload Endpoint

**PUT /:bucket/:key**

Upload content with x402 payment.

## Request

### URL Parameters

| Parameter | Description |
|-----------|-------------|
| `bucket` | Storage bucket name |
| `key` | Object key (filename/path) |

Example: `PUT /mybucket/images/photo.jpg`

### Required Headers

| Header | Description |
|--------|-------------|
| `Content-Type` | MIME type of content |
| `Content-Length` | Size in bytes |

### Payment Headers

First request (no payment):
- No payment headers needed
- Returns 402 with requirements

Second request (with payment):

| Header | Description |
|--------|-------------|
| `X-PAYMENT` | Base64-encoded signed payment |

Or alternatively:
```
Payment-Authorization: x402 <base64-payload>
```

### Optional Headers

| Header | Default | Description |
|--------|---------|-------------|
| `X-Fula-TTL` | 3600 | Storage duration in seconds |

TTL can also be specified as `X-TTL-Seconds`.

## TTL Limits

| Limit | Value | Duration |
|-------|-------|----------|
| Minimum | 60 | 1 minute |
| Default | 3600 | 1 hour |
| Maximum | 2592000 | 30 days |

Values outside this range are clamped.

## Examples

### Basic Upload

```bash
# Step 1: Get payment requirements
curl -X PUT "https://x402.api.cloud.fx.land/mybucket/hello.txt" \
  -H "Content-Type: text/plain" \
  -H "Content-Length: 12" \
  -d "Hello World!"
# Returns 402 with X-PAYMENT-REQUIRED

# Step 2: Upload with payment
curl -X PUT "https://x402.api.cloud.fx.land/mybucket/hello.txt" \
  -H "Content-Type: text/plain" \
  -H "Content-Length: 12" \
  -H "X-PAYMENT: <base64-signed-payment>" \
  -d "Hello World!"
```

### Upload with Custom TTL

Store for 24 hours (86400 seconds):

```bash
curl -X PUT "https://x402.api.cloud.fx.land/mybucket/file.txt" \
  -H "Content-Type: text/plain" \
  -H "Content-Length: 1024" \
  -H "X-Fula-TTL: 86400" \
  -H "X-PAYMENT: <base64-signed-payment>" \
  -d "File content..."
```

### Upload Binary File

```bash
curl -X PUT "https://x402.api.cloud.fx.land/mybucket/image.png" \
  -H "Content-Type: image/png" \
  -H "Content-Length: $(stat -f%z image.png)" \
  -H "X-Fula-TTL: 3600" \
  -H "X-PAYMENT: <base64-signed-payment>" \
  --data-binary @image.png
```

### Upload from stdin

```bash
echo "Content from pipe" | curl -X PUT "https://x402.api.cloud.fx.land/mybucket/piped.txt" \
  -H "Content-Type: text/plain" \
  -H "Transfer-Encoding: chunked" \
  -H "X-PAYMENT: <base64-signed-payment>" \
  -d @-
```

## Response

### Success (200 OK)

```json
{
  "success": true,
  "cid": "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
  "bucket": "mybucket",
  "key": "hello.txt",
  "size_bytes": 12,
  "expires_at": "2024-01-15T11:30:00.000Z",
  "tx_hash": "0xabc123...",
  "gateway_url": "https://ipfs.cloud.fx.land/ipfs/QmYwAP..."
}
```

### Response Fields

| Field | Description |
|-------|-------------|
| `success` | Boolean success indicator |
| `cid` | IPFS Content Identifier |
| `bucket` | Storage bucket |
| `key` | Object key |
| `size_bytes` | Stored content size |
| `expires_at` | When content expires (ISO 8601) |
| `tx_hash` | Settlement transaction hash |
| `gateway_url` | URL to access via IPFS gateway |

### Response Headers

```
X-PAYMENT-RESPONSE: <base64-encoded settlement info>
```

Decoded:
```json
{
  "success": true,
  "transaction": "0xabc123...",
  "network": "eip155:324705682"
}
```

### Payment Required (402)

When no payment header is provided:

```json
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:324705682",
    "maxAmountRequired": "10000",
    "payTo": "0x...",
    "asset": "eip155:324705682/erc20:0x...",
    "description": "Storage: 0.01 MB for 1 hour",
    "maxTimeoutSeconds": 300,
    "resource": "https://x402.api.cloud.fx.land/mybucket/hello.txt",
    "extra": {
      "facilitatorUrl": "https://facilitator.dirtroad.dev",
      "name": "Bridged USDC (SKALE Bridge)",
      "version": "1"
    }
  }],
  "error": "Payment Required"
}
```

## Content Addressing

After upload, content is addressable via:

1. **S3 Path**: `https://s3.cloud.fx.land/:bucket/:key`
2. **IPFS CID**: The returned `cid` field
3. **IPFS Gateway**: The returned `gateway_url`

## Expiration

Content expires after the specified TTL:

- Expired content is automatically deleted
- CID remains valid but content unavailable
- Re-upload with new payment to extend

## Overwriting

Uploading to an existing key:
- Overwrites the previous content
- Requires new payment
- Previous content immediately unavailable
- CID changes if content is different

## Size Limits

The practical size limit depends on:
- Your network bandwidth
- Payment timeout (5 minutes)
- Server memory limits

For very large files, consider chunking or using the standard Pinning API.

## Error Responses

| Status | Meaning |
|--------|---------|
| 402 | Payment required (see body for requirements) |
| 400 | Invalid request (missing headers, bad format) |
| 413 | Payload too large |
| 500 | Server error |

See [Error Handling](errors/) for details.
