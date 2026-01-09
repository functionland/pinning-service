---
layout: default
title: Pinning API
nav_order: 3
has_children: true
permalink: /pinning-api/
---

# Pinning API Documentation
{: .no_toc }

<span class="audience-badge developers">For Developers</span>

Build applications with the IPFS Pinning Service API at `api.cloud.fx.land`.
{: .fs-6 .fw-300 }

---

## Overview

**Base URL**: `https://api.cloud.fx.land`

The Fx.Land Pinning API implements the standard [IPFS Pinning Service API Specification](https://ipfs.github.io/pinning-services-api-spec/) (v1.0.0), making it compatible with:

- IPFS CLI (`ipfs pin remote`)
- Kubo (go-ipfs)
- Any client library for the IPFS Pinning Service spec

---

## Quick Start

### 1. Get an API Key

Get your API key from [cloud.fx.land](https://cloud.fx.land):

1. Sign in with Google
2. Go to **API Keys**
3. Copy your key

### 2. Pin Content

```bash
curl -X POST "https://api.cloud.fx.land/pins" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "cid": "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    "name": "my-file"
  }'
```

### 3. Check Status

```bash
curl "https://api.cloud.fx.land/pins/REQUEST_ID" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

---

## Endpoints

| Method | Endpoint | Description |
|:-------|:---------|:------------|
| `POST` | `/pins` | Create a new pin |
| `GET` | `/pins` | List pins (with filters) |
| `GET` | `/pins/{requestid}` | Get pin by ID |
| `POST` | `/pins/{requestid}` | Replace a pin |
| `DELETE` | `/pins/{requestid}` | Remove a pin |
| `POST` | `/auth/token` | Create session token |
| `DELETE` | `/auth/token` | Delete session |
{: .endpoint-table }

---

## Authentication

All endpoints require Bearer token authentication:

```
Authorization: Bearer YOUR_API_KEY
```

API keys are JWT tokens. See [Authentication]({{ site.baseurl }}/pinning-api/authentication/) for details.

---

## Pin Status Lifecycle

```
POST /pins
    │
    ▼
┌─────────┐     ┌──────────┐     ┌─────────┐
│ queued  │ ──► │ pinning  │ ──► │ pinned  │
└─────────┘     └──────────┘     └─────────┘
                     │
                     ▼
                ┌─────────┐
                │ failed  │
                └─────────┘
```

| Status | Description |
|:-------|:------------|
| `queued` | Added to queue, waiting to process |
| `pinning` | Actively fetching from IPFS network |
| `pinned` | Successfully stored |
| `failed` | Unable to pin (check `info.status_details`) |

---

## IPFS CLI Integration

```bash
# Add remote pinning service
ipfs pin remote service add fxland https://api.cloud.fx.land YOUR_API_KEY

# Pin content
ipfs pin remote add --service=fxland QmYourCID

# List remote pins
ipfs pin remote ls --service=fxland

# Remove remote pin
ipfs pin remote rm --service=fxland --cid=QmYourCID
```

---

## In This Section

| Page | Description |
|:-----|:------------|
| [Authentication]({{ site.baseurl }}/pinning-api/authentication/) | API keys, JWT tokens, OAuth flow |
| [Endpoints]({{ site.baseurl }}/pinning-api/endpoints/) | Full API reference with examples |
| [Filtering & Pagination]({{ site.baseurl }}/pinning-api/filtering/) | Query pins with filters |
| [Error Handling]({{ site.baseurl }}/pinning-api/errors/) | Error responses and codes |
| [Examples]({{ site.baseurl }}/pinning-api/examples/) | Code examples in multiple languages |

---

## Rate Limits

No strict rate limits, but excessive requests may be throttled. For bulk operations, space requests by ~100ms.

## Storage Limits

- **Free tier**: 500 MB per account
- **With credits**: Unlimited (pay as you go)

Exceeding free tier without credits returns `409 INSUFFICIENT_FUNDS`.
