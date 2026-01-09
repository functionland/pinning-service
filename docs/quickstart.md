---
layout: default
title: Quick Start
---

# Quick Start

Get started with Fx.Land Cloud in 5 minutes.

## Prerequisites

- A Google account (for authentication)
- `curl` or any HTTP client

## Step 1: Get an API Key

1. Go to [cloud.fx.land](https://cloud.fx.land)
2. Sign in with your Google account
3. Navigate to **API Keys** in the dashboard
4. Copy your API key (or create a new one)

Your API key is a JWT token that looks like:
```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## Step 2: Pin Content

Pin existing IPFS content by CID:

```bash
curl -X POST "https://api.cloud.fx.land/pins" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "cid": "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    "name": "my-first-pin"
  }'
```

### Response

```json
{
  "requestid": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "queued",
  "created": "2024-01-15T10:30:00.000Z",
  "pin": {
    "cid": "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    "name": "my-first-pin"
  },
  "delegates": []
}
```

## Step 3: Check Pin Status

Use the `requestid` from the response to check status:

```bash
curl "https://api.cloud.fx.land/pins/a1b2c3d4-e5f6-7890-abcd-ef1234567890" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Pin Status Values

| Status | Description |
|--------|-------------|
| `queued` | Pin added to queue, waiting to process |
| `pinning` | Actively fetching content from IPFS network |
| `pinned` | Content successfully pinned |
| `failed` | Pinning failed (check `info` for details) |

## Step 4: List Your Pins

```bash
curl "https://api.cloud.fx.land/pins" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Filter by Status

```bash
# Only show pinned content
curl "https://api.cloud.fx.land/pins?status=pinned" \
  -H "Authorization: Bearer YOUR_API_KEY"

# Show queued and pinning
curl "https://api.cloud.fx.land/pins?status=queued,pinning" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Step 5: Remove a Pin

```bash
curl -X DELETE "https://api.cloud.fx.land/pins/a1b2c3d4-e5f6-7890-abcd-ef1234567890" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Free Tier

Every account includes **500 MB** of free storage. You can check your usage in the [WebUI dashboard](https://cloud.fx.land).

To store more than 500 MB, add FULA credits to your account. See [Credits & Billing](webui/credits/) for details.

## Next Steps

- [Authentication Guide](pinning-api/authentication/) - Learn about API keys and tokens
- [Full API Reference](pinning-api/pins/) - All endpoints and options
- [WebUI Guide](webui/) - Manage pins through the web interface
- [x402 Gateway](x402/) - Pay-per-upload without credits
