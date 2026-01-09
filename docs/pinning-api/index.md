---
layout: default
title: IPFS Pinning API
---

# IPFS Pinning API

**Base URL**: `https://api.cloud.fx.land`

The Fx.Land Pinning API implements the standard [IPFS Pinning Service API Specification](https://ipfs.github.io/pinning-services-api-spec/) (v1.0.0).

## In This Section

- [Authentication](authentication/) - API keys and Bearer tokens
- [Pins Endpoints](pins/) - Create, list, and manage pins
- [Error Handling](errors/) - Error responses and status codes

## Endpoints Overview

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/pins` | Create a new pin |
| GET | `/pins` | List pins with optional filters |
| GET | `/pins/{requestid}` | Get pin status by ID |
| POST | `/pins/{requestid}` | Replace an existing pin |
| DELETE | `/pins/{requestid}` | Remove a pin |
| POST | `/auth/token` | Create a session token |
| DELETE | `/auth/token` | Delete session (logout) |

## Authentication

All endpoints (except `/auth/token` POST) require Bearer token authentication:

```
Authorization: Bearer YOUR_API_KEY
```

API keys are JWT tokens obtained from the [WebUI](https://cloud.fx.land). See the [Authentication Guide](authentication/) for details.

## Pin Lifecycle

```
POST /pins
    |
    v
[queued] --> [pinning] --> [pinned]
                |
                v
            [failed]
```

1. **queued**: Pin request received, waiting to process
2. **pinning**: Actively fetching content from IPFS network
3. **pinned**: Content successfully stored
4. **failed**: Unable to pin (check `info.status_details`)

## Request/Response Format

All requests and responses use JSON:

```bash
curl -X POST "https://api.cloud.fx.land/pins" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"cid": "Qm...", "name": "example"}'
```

## Rate Limits

There are no strict rate limits, but excessive requests may be throttled. For bulk operations, consider spacing requests.

## IPFS Pinning Service Compatibility

This API is compatible with:
- IPFS CLI: `ipfs pin remote add --service=fxland`
- Kubo (go-ipfs) remote pinning
- Any client implementing the IPFS Pinning Service API spec

### Configure IPFS CLI

```bash
ipfs pin remote service add fxland https://api.cloud.fx.land YOUR_API_KEY
ipfs pin remote add --service=fxland QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG
```
