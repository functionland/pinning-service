---
layout: default
title: Endpoints
parent: Pinning API
nav_order: 2
---

# API Endpoints
{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Base URL

```
https://api.cloud.fx.land
```

All endpoints require `Authorization: Bearer <token>` header.

---

## Create Pin

`POST /pins`

Pin content by CID.

### Request Body

| Field | Type | Required | Description |
|:------|:-----|:---------|:------------|
| `cid` | string | **Yes** | Content Identifier |
| `name` | string | No | Human-readable name (max 255 chars) |
| `origins` | array | No | Multiaddrs of content providers (max 20) |
| `meta` | object | No | Custom key-value metadata |

### Example

```bash
curl -X POST "https://api.cloud.fx.land/pins" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "cid": "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    "name": "my-website",
    "origins": ["/ip4/192.168.1.1/tcp/4001/p2p/QmPeerId"],
    "meta": {
      "app_id": "my-app",
      "version": "1.0"
    }
  }'
```

### Response (202 Accepted)

```json
{
  "requestid": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "queued",
  "created": "2024-01-15T10:30:00.000Z",
  "pin": {
    "cid": "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    "name": "my-website",
    "origins": ["/ip4/192.168.1.1/tcp/4001/p2p/QmPeerId"],
    "meta": {"app_id": "my-app", "version": "1.0"}
  },
  "delegates": ["/ip4/203.0.113.1/tcp/4001/p2p/QmServicePeerId"]
}
```

---

## List Pins

`GET /pins`

List pins with optional filters.

### Query Parameters

| Parameter | Type | Default | Description |
|:----------|:-----|:--------|:------------|
| `cid` | array | - | Filter by CID(s) |
| `name` | string | - | Filter by name |
| `match` | string | `exact` | Name match strategy |
| `status` | array | `pinned` | Filter by status(es) |
| `before` | datetime | - | Created before (ISO 8601) |
| `after` | datetime | - | Created after (ISO 8601) |
| `limit` | integer | 10 | Results per page (1-1000) |
| `meta` | object | - | Filter by metadata (URL-encoded JSON) |

### Match Strategies

| Value | Description |
|:------|:------------|
| `exact` | Case-sensitive exact match |
| `iexact` | Case-insensitive exact match |
| `partial` | Contains substring |
| `ipartial` | Contains substring (case-insensitive) |

### Examples

**List all pinned:**
```bash
curl "https://api.cloud.fx.land/pins" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Filter by status:**
```bash
curl "https://api.cloud.fx.land/pins?status=queued,pinning" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Search by name:**
```bash
curl "https://api.cloud.fx.land/pins?name=website&match=ipartial" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Filter by metadata:**
```bash
# meta={"app_id":"my-app"} URL-encoded
curl "https://api.cloud.fx.land/pins?meta=%7B%22app_id%22%3A%22my-app%22%7D" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Pagination:**
```bash
curl "https://api.cloud.fx.land/pins?before=2024-01-10T00:00:00.000Z&limit=20" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Response (200 OK)

```json
{
  "count": 42,
  "results": [
    {
      "requestid": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "status": "pinned",
      "created": "2024-01-15T10:30:00.000Z",
      "pin": {
        "cid": "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
        "name": "my-website"
      },
      "delegates": []
    }
  ]
}
```

---

## Get Pin

`GET /pins/{requestid}`

Get pin by request ID.

### Example

```bash
curl "https://api.cloud.fx.land/pins/a1b2c3d4-e5f6-7890-abcd-ef1234567890" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Response (200 OK)

```json
{
  "requestid": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "pinned",
  "created": "2024-01-15T10:30:00.000Z",
  "pin": {
    "cid": "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    "name": "my-website",
    "meta": {"app_id": "my-app"}
  },
  "delegates": ["/ip4/203.0.113.1/tcp/4001/p2p/QmServicePeerId"],
  "info": {
    "status_details": "Pinned successfully"
  }
}
```

---

## Replace Pin

`POST /pins/{requestid}`

Atomically replace a pin. Prevents garbage collection of shared blocks between old and new content.

### Example

```bash
curl -X POST "https://api.cloud.fx.land/pins/a1b2c3d4-e5f6-7890-abcd-ef1234567890" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "cid": "QmNewContentCID",
    "name": "my-website-v2"
  }'
```

### Response (202 Accepted)

Returns a **new** PinStatus with a **new requestid**. The old pin is deleted.

```json
{
  "requestid": "new-request-id-here",
  "status": "queued",
  "created": "2024-01-16T10:00:00.000Z",
  "pin": {
    "cid": "QmNewContentCID",
    "name": "my-website-v2"
  },
  "delegates": []
}
```

---

## Delete Pin

`DELETE /pins/{requestid}`

Remove a pin.

### Example

```bash
curl -X DELETE "https://api.cloud.fx.land/pins/a1b2c3d4-e5f6-7890-abcd-ef1234567890" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Response (202 Accepted)

Empty body on success.

---

## PinStatus Object

All responses include this structure:

| Field | Type | Description |
|:------|:-----|:------------|
| `requestid` | string | Unique ID for this pin request |
| `status` | string | `queued`, `pinning`, `pinned`, `failed` |
| `created` | datetime | Creation timestamp (ISO 8601) |
| `pin` | object | Original pin data (cid, name, origins, meta) |
| `delegates` | array | Service peer multiaddrs |
| `info` | object | Optional status details |

### Status Values

| Status | Description |
|:-------|:------------|
| `queued` | Waiting to process |
| `pinning` | Fetching from IPFS |
| `pinned` | Successfully stored |
| `failed` | Could not pin (see `info.status_details`) |

### Info Object

Optional vendor-specific metadata:

| Key | Description |
|:----|:------------|
| `status_details` | Human-readable status |
| `dag_size` | Total DAG size in bytes |
| `pinned_until` | Expiration (if time-limited) |

---

## Using Delegates

The `delegates` array contains multiaddrs of service peers. Connect to them to speed up pinning:

```bash
# After creating a pin, connect to delegates
ipfs swarm connect /ip4/203.0.113.1/tcp/4001/p2p/QmServicePeerId
```

This helps the service fetch your content faster, especially if you're behind NAT.
