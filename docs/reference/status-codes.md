---
layout: default
title: Status Codes Reference
---

# HTTP Status Codes Reference

Complete reference for HTTP status codes across all Fx.Land services.

## Success Codes

### 200 OK

Request succeeded.

**Used by:**
- GET /pins - List pins
- GET /pins/{requestid} - Get pin details
- GET /api/credits - Credit status
- GET requests on x402 gateway

### 202 Accepted

Request accepted for processing.

**Used by:**
- POST /pins - Create pin (processing asynchronously)
- POST /pins/{requestid} - Replace pin
- DELETE /pins/{requestid} - Delete pin

## Client Error Codes

### 400 Bad Request

Invalid request format or parameters.

```json
{
  "error": {
    "reason": "BAD_REQUEST",
    "details": "Specific error message"
  }
}
```

**Common causes:**
- Invalid JSON body
- Missing required fields
- Invalid parameter values
- Malformed CID

### 401 Unauthorized

Authentication required or failed.

```json
{
  "error": {
    "reason": "UNAUTHORIZED",
    "details": "Access token is missing or invalid"
  }
}
```

**Common causes:**
- Missing Authorization header
- Invalid or expired token
- Revoked API key

### 402 Payment Required

Payment needed for x402 operations.

```json
{
  "x402Version": 1,
  "accepts": [...],
  "error": "Payment Required"
}
```

**Used by:**
- x402 PUT requests (initial and rejected payments)
- x402 DELETE requests

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

**Common causes:**
- Invalid requestid
- Pin already deleted
- Wrong bucket/key on x402

### 409 Conflict / Insufficient Funds

Operation cannot be completed due to state.

```json
{
  "error": {
    "reason": "INSUFFICIENT_FUNDS",
    "details": "Unable to process request due to the lack of funds"
  }
}
```

**Used by:**
- Pinning API when user exceeds free tier without credits

### 413 Payload Too Large

Request body exceeds limits.

```json
{
  "error": "PAYLOAD_TOO_LARGE",
  "message": "Request body too large"
}
```

### 429 Too Many Requests

Rate limit exceeded.

```json
{
  "error": "RATE_LIMITED",
  "message": "Too many requests",
  "retry_after": 60
}
```

## Server Error Codes

### 500 Internal Server Error

Unexpected server error.

```json
{
  "error": {
    "reason": "INTERNAL_SERVER_ERROR",
    "details": "An unexpected error occurred"
  }
}
```

**Action:** Retry after short delay; contact support if persistent.

### 502 Bad Gateway

Upstream service unavailable.

**Action:** Retry after short delay.

### 503 Service Unavailable

Service temporarily down.

**Action:** Retry with exponential backoff.

### 504 Gateway Timeout

Request took too long.

**Action:** Retry with longer timeout or smaller request.

## Service-Specific Codes

### Pinning API

| Code | Reason | Description |
|------|--------|-------------|
| 200 | Success | GET requests |
| 202 | Accepted | POST/DELETE requests |
| 400 | BAD_REQUEST | Invalid request |
| 401 | UNAUTHORIZED | Auth failed |
| 404 | NOT_FOUND | Pin not found |
| 409 | INSUFFICIENT_FUNDS | No credits |
| 500 | INTERNAL_SERVER_ERROR | Server error |

### x402 Gateway

| Code | Reason | Description |
|------|--------|-------------|
| 200 | Success | Upload/download complete |
| 402 | Payment Required | Need payment |
| 400 | BAD_REQUEST | Invalid request |
| 413 | PAYLOAD_TOO_LARGE | File too big |
| 500 | INTERNAL_ERROR | Server error |

### WebUI API

| Code | Reason | Description |
|------|--------|-------------|
| 200 | Success | Request succeeded |
| 400 | BAD_REQUEST | Invalid input |
| 401 | UNAUTHORIZED | Not logged in |
| 403 | FORBIDDEN | Not authorized |
| 404 | NOT_FOUND | Resource missing |

## Pin Status Values

Not HTTP codes, but pin lifecycle states:

| Status | Description |
|--------|-------------|
| `queued` | Added to queue, waiting |
| `pinning` | Actively fetching content |
| `pinned` | Successfully stored |
| `failed` | Unable to pin |

## Error Response Format

### Pinning API Format

```json
{
  "error": {
    "reason": "ERROR_CODE",
    "details": "Human-readable message"
  }
}
```

### x402 Gateway Format

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable message"
}
```

### WebUI API Format

```json
{
  "error": "Human-readable message"
}
```

Or with code:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message"
  }
}
```

## Handling Errors

### Best Practices

1. **Check status code first** before parsing body
2. **Handle 401** by refreshing auth or prompting login
3. **Retry 5xx** with exponential backoff
4. **Don't retry 4xx** (except 429) - fix the request
5. **Log error details** for debugging

### Example Error Handler

```javascript
async function handleResponse(response) {
  if (response.ok) {
    return response.json();
  }

  const error = await response.json().catch(() => ({}));

  switch (response.status) {
    case 401:
      throw new AuthError('Please log in again');
    case 402:
      return { paymentRequired: true, requirements: error };
    case 404:
      throw new NotFoundError(error.error?.details || 'Not found');
    case 409:
      throw new InsufficientFundsError('Add credits to continue');
    case 429:
      const retryAfter = response.headers.get('Retry-After') || 60;
      throw new RateLimitError(`Retry after ${retryAfter}s`);
    default:
      throw new ApiError(
        error.error?.details || error.message || 'Unknown error',
        response.status
      );
  }
}
```
