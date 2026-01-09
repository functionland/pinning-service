---
layout: default
title: Pins Endpoints - Pinning API
---

# Pins Endpoints

CRUD operations for pin objects.

## Create Pin

**POST /pins**

Pin content by CID.

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cid` | string | Yes | Content Identifier to pin |
| `name` | string | No | Human-readable name (max 255 chars) |
| `origins` | array | No | Multiaddrs of content providers (max 20) |
| `meta` | object | No | Custom metadata key-value pairs |

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
    "meta": {
      "app_id": "my-app",
      "version": "1.0"
    }
  },
  "delegates": ["/ip4/203.0.113.1/tcp/4001/p2p/QmServicePeerId"]
}
```

---

## List Pins

**GET /pins**

List pins with optional filtering.

### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `cid` | array | - | Filter by CID(s), comma-separated |
| `name` | string | - | Filter by name |
| `match` | string | `exact` | Name matching: `exact`, `iexact`, `partial`, `ipartial` |
| `status` | array | `pinned` | Filter by status(es): `queued`, `pinning`, `pinned`, `failed` |
| `before` | datetime | - | Created before timestamp (ISO 8601) |
| `after` | datetime | - | Created after timestamp (ISO 8601) |
| `limit` | integer | 10 | Max results (1-1000) |
| `meta` | object | - | Filter by metadata (URL-encoded JSON) |

### Examples

**List all pinned content:**
```bash
curl "https://api.cloud.fx.land/pins" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**List by status:**
```bash
curl "https://api.cloud.fx.land/pins?status=queued,pinning" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Search by name (partial match, case-insensitive):**
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
# Get next page using 'before' from oldest result
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

| Field | Description |
|-------|-------------|
| `count` | Total number of pins matching filters |
| `results` | Array of PinStatus objects (may be less than `count` due to pagination) |

---

## Get Pin

**GET /pins/{requestid}**

Get a specific pin by request ID.

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

**POST /pins/{requestid}**

Replace an existing pin. This atomically removes the old pin and creates a new one, preventing garbage collection of shared blocks.

### Example

```bash
curl -X POST "https://api.cloud.fx.land/pins/a1b2c3d4-e5f6-7890-abcd-ef1234567890" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "cid": "QmNewContentIdentifier",
    "name": "my-website-v2"
  }'
```

### Response (202 Accepted)

Returns a new PinStatus with a **new requestid**. The old pin is automatically deleted.

```json
{
  "requestid": "new-request-id-here",
  "status": "queued",
  "created": "2024-01-16T10:00:00.000Z",
  "pin": {
    "cid": "QmNewContentIdentifier",
    "name": "my-website-v2"
  },
  "delegates": []
}
```

---

## Delete Pin

**DELETE /pins/{requestid}**

Remove a pin.

### Example

```bash
curl -X DELETE "https://api.cloud.fx.land/pins/a1b2c3d4-e5f6-7890-abcd-ef1234567890" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Response (202 Accepted)

Empty response body on success.

---

## Pin Status Object

All responses include a PinStatus object:

| Field | Type | Description |
|-------|------|-------------|
| `requestid` | string | Unique identifier for this pin request |
| `status` | string | Current status: `queued`, `pinning`, `pinned`, `failed` |
| `created` | datetime | When the pin was created (ISO 8601) |
| `pin` | object | Original pin request data |
| `delegates` | array | Multiaddrs of service peers to connect to |
| `info` | object | Optional vendor-specific info |

### Status Values

| Status | Description |
|--------|-------------|
| `queued` | Added to queue, not yet processing |
| `pinning` | Actively fetching from IPFS network |
| `pinned` | Successfully pinned and available |
| `failed` | Could not pin; see `info.status_details` for reason |

### Delegates

The `delegates` array contains multiaddrs of IPFS peers operated by the pinning service. Connect to these peers to speed up pinning:

```bash
ipfs swarm connect /ip4/203.0.113.1/tcp/4001/p2p/QmServicePeerId
```

### Info Object

Optional metadata returned by the service:

| Key | Description |
|-----|-------------|
| `status_details` | Human-readable status message |
| `dag_size` | Size of pinned DAG in bytes |
| `pinned_until` | Expiration timestamp (if applicable) |
