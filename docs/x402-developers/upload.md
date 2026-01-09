---
layout: default
title: Upload Reference
parent: x402 Developers
nav_order: 2
---

# Upload Endpoint (PUT)
{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Endpoint

`PUT /:bucket/:key`

Upload content with x402 payment.

---

## URL Parameters

| Parameter | Description |
|:----------|:------------|
| `bucket` | Storage bucket name |
| `key` | Object key (filename/path) |

Example: `PUT /mybucket/images/photo.jpg`

---

## Request Headers

### Required

| Header | Description |
|:-------|:------------|
| `Content-Type` | MIME type of content |
| `Content-Length` | Size in bytes |

### Payment (Required for actual upload)

| Header | Description |
|:-------|:------------|
| `X-PAYMENT` | Base64-encoded signed payment |

Or alternatively:
```
Payment-Authorization: x402 <base64-payload>
```

### Optional

| Header | Default | Description |
|:-------|:--------|:------------|
| `X-Fula-TTL` | 3600 | Storage duration in seconds |

You can also use `X-TTL-Seconds`.

---

## TTL (Time-To-Live)

| Limit | Value | Duration |
|:------|:------|:---------|
| Minimum | 60 | 1 minute |
| Default | 3600 | 1 hour |
| Maximum | 2592000 | 30 days |

Values outside this range are clamped.

---

## Examples

### Basic Upload

```bash
# Step 1: Get payment requirements
curl -X PUT "https://x402.api.cloud.fx.land/mybucket/hello.txt" \
  -H "Content-Type: text/plain" \
  -H "Content-Length: 12" \
  -d "Hello World!"
# Returns 402

# Step 2: Upload with payment
curl -X PUT "https://x402.api.cloud.fx.land/mybucket/hello.txt" \
  -H "Content-Type: text/plain" \
  -H "Content-Length: 12" \
  -H "X-PAYMENT: <payment>" \
  -d "Hello World!"
```

### Upload with Custom TTL

24 hours (86400 seconds):

```bash
curl -X PUT "https://x402.api.cloud.fx.land/mybucket/file.txt" \
  -H "Content-Type: text/plain" \
  -H "Content-Length: 1024" \
  -H "X-Fula-TTL: 86400" \
  -H "X-PAYMENT: <payment>" \
  -d "Content..."
```

### Upload Binary File

```bash
curl -X PUT "https://x402.api.cloud.fx.land/mybucket/image.png" \
  -H "Content-Type: image/png" \
  -H "Content-Length: $(wc -c < image.png)" \
  -H "X-Fula-TTL: 3600" \
  -H "X-PAYMENT: <payment>" \
  --data-binary @image.png
```

---

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
|:------|:------------|
| `success` | Boolean success indicator |
| `cid` | IPFS Content Identifier |
| `bucket` | Storage bucket |
| `key` | Object key |
| `size_bytes` | Stored content size |
| `expires_at` | Expiration timestamp (ISO 8601) |
| `tx_hash` | Settlement transaction hash |
| `gateway_url` | IPFS gateway URL |

### Response Headers

```
X-PAYMENT-RESPONSE: <base64-encoded settlement>
```

Decoded:
```json
{
  "success": true,
  "transaction": "0xabc123...",
  "network": "eip155:324705682"
}
```

---

## Payment Required (402)

When no payment header:

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
    "maxTimeoutSeconds": 300
  }],
  "error": "Payment Required"
}
```

---

## Accessing Uploaded Content

After upload, access via:

### S3 Path
```
https://s3.cloud.fx.land/:bucket/:key
```

### IPFS CID
Use the `cid` from the response with any IPFS gateway.

### Gateway URL
The `gateway_url` provides direct access.

---

## Content Expiration

- Content expires after TTL
- Expired content is automatically deleted
- CID remains valid but content unavailable
- Re-upload with new payment to extend

---

## Overwriting

Uploading to an existing key:
- Requires new payment
- Previous content immediately unavailable
- CID changes if content differs

---

## Errors

| Status | Meaning |
|:-------|:--------|
| 402 | Payment required/invalid |
| 400 | Invalid request format |
| 413 | Payload too large |
| 500 | Server error |

See [Error Handling]({{ site.baseurl }}/x402-developers/errors/) for details.
