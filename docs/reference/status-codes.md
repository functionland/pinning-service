---
layout: default
title: Status Codes
parent: Reference
nav_order: 1
---

# HTTP Status Codes
{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Success Codes

### 200 OK

Request succeeded.

| Service | Usage |
|:--------|:------|
| Pinning API | GET requests |
| x402 | Downloads, uploads with payment |
| WebUI | All successful requests |

### 202 Accepted

Request accepted for async processing.

| Service | Usage |
|:--------|:------|
| Pinning API | POST /pins, DELETE /pins |

---

## Client Errors

### 400 Bad Request

Invalid request format.

```json
{
  "error": {
    "reason": "BAD_REQUEST",
    "details": "Specific error message"
  }
}
```

| Cause | Solution |
|:------|:---------|
| Invalid JSON | Check JSON syntax |
| Missing field | Include required fields |
| Invalid CID | Verify CID format |
| Invalid date | Use ISO 8601 format |

### 401 Unauthorized

Authentication failed.

```json
{
  "error": {
    "reason": "UNAUTHORIZED",
    "details": "Access token is missing or invalid"
  }
}
```

| Cause | Solution |
|:------|:---------|
| Missing header | Add `Authorization: Bearer <token>` |
| Invalid token | Check token format |
| Revoked key | Generate new key |
| Expired session | Re-authenticate |

### 402 Payment Required

**x402 Gateway only.**

Payment needed or rejected.

```json
{
  "x402Version": 1,
  "accepts": [...],
  "error": "Payment Required"
}
```

| Situation | Meaning |
|:----------|:--------|
| No X-PAYMENT header | Get payment requirements |
| With X-PAYMENT header | Payment was rejected |

### 404 Not Found

Resource doesn't exist.

```json
{
  "error": {
    "reason": "NOT_FOUND",
    "details": "The specified resource was not found"
  }
}
```

| Cause | Solution |
|:------|:---------|
| Invalid ID | Verify requestid |
| Already deleted | Resource is gone |
| Wrong user | Can't access others' pins |

### 409 Conflict

State conflict (usually insufficient funds).

```json
{
  "error": {
    "reason": "INSUFFICIENT_FUNDS",
    "details": "Unable to process request due to the lack of funds"
  }
}
```

| Service | Meaning |
|:--------|:--------|
| Pinning API | Storage exceeds free tier without credits |

### 413 Payload Too Large

Request body too big.

```json
{
  "error": "PAYLOAD_TOO_LARGE"
}
```

### 429 Too Many Requests

Rate limited.

```json
{
  "error": "RATE_LIMITED",
  "retry_after": 60
}
```

---

## Server Errors

### 500 Internal Server Error

Unexpected error.

```json
{
  "error": {
    "reason": "INTERNAL_SERVER_ERROR",
    "details": "An unexpected error occurred"
  }
}
```

**Action:** Retry with exponential backoff.

### 502 Bad Gateway

Upstream service unavailable.

**Action:** Retry after delay.

### 503 Service Unavailable

Service down for maintenance.

**Action:** Wait and retry.

### 504 Gateway Timeout

Request timed out.

**Action:** Retry with smaller payload or longer timeout.

---

## Service-Specific Summary

### Pinning API

| Code | Reason | Description |
|:-----|:-------|:------------|
| 200 | OK | GET success |
| 202 | Accepted | POST/DELETE success |
| 400 | BAD_REQUEST | Invalid request |
| 401 | UNAUTHORIZED | Auth failed |
| 404 | NOT_FOUND | Pin missing |
| 409 | INSUFFICIENT_FUNDS | No credits |
| 500 | INTERNAL_SERVER_ERROR | Server error |

### x402 Gateway

| Code | Reason | Description |
|:-----|:-------|:------------|
| 200 | OK | Upload/download success |
| 400 | BAD_REQUEST | Invalid request |
| 402 | Payment Required | Need payment |
| 413 | PAYLOAD_TOO_LARGE | File too big |
| 500 | INTERNAL_ERROR | Server error |

### WebUI API

| Code | Reason | Description |
|:-----|:-------|:------------|
| 200 | OK | Success |
| 400 | BAD_REQUEST | Invalid input |
| 401 | UNAUTHORIZED | Not logged in |
| 403 | FORBIDDEN | No permission |
| 404 | NOT_FOUND | Missing |

---

## Pin Status Values

Not HTTP codes, but pin lifecycle states:

| Status | Description |
|:-------|:------------|
| `queued` | Waiting to process |
| `pinning` | Fetching from IPFS |
| `pinned` | Successfully stored |
| `failed` | Unable to pin |
