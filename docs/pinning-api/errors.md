---
layout: default
title: Error Handling
parent: Pinning API
nav_order: 4
---

# Error Handling
{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Error Response Format

All errors return JSON with an `error` object:

```json
{
  "error": {
    "reason": "ERROR_CODE",
    "details": "Human-readable explanation"
  }
}
```

---

## HTTP Status Codes

### 400 Bad Request

Invalid request format or parameters.

```json
{
  "error": {
    "reason": "BAD_REQUEST",
    "details": "Invalid CID format"
  }
}
```

**Common causes:**
- Invalid CID format
- Missing required field (`cid`)
- Name exceeds 255 characters
- Invalid JSON body
- Invalid date format

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

**Common causes:**
- Missing `Authorization` header
- Invalid token format
- Revoked API key
- Expired session token

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
- Invalid `requestid`
- Pin already deleted
- Accessing another user's pin

### 409 Conflict / Insufficient Funds

Operation cannot complete due to state.

```json
{
  "error": {
    "reason": "INSUFFICIENT_FUNDS",
    "details": "Unable to process request due to the lack of funds"
  }
}
```

**Cause:** Storage exceeds free tier (500 MB) without credits.

**Resolution:**
- Add FULA credits to your account
- Delete unused pins to free space

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

**Action:** Retry after a short delay. Contact support if persistent.

---

## Error Codes Reference

| Code | HTTP | Description |
|:-----|:-----|:------------|
| `BAD_REQUEST` | 400 | Invalid request format |
| `UNAUTHORIZED` | 401 | Auth failed |
| `NOT_FOUND` | 404 | Resource missing |
| `INSUFFICIENT_FUNDS` | 409 | No credits available |
| `INTERNAL_SERVER_ERROR` | 500 | Server error |

---

## Handling Errors

### Check Status Code First

```python
import requests

response = requests.post(url, headers=headers, json=data)

if response.status_code == 202:
    pin = response.json()
    print(f"Created pin: {pin['requestid']}")
elif response.status_code == 401:
    print("Authentication failed - check your API key")
elif response.status_code == 409:
    print("Insufficient funds - add credits or delete pins")
elif response.status_code >= 500:
    print("Server error - retry later")
else:
    error = response.json().get('error', {})
    print(f"Error: {error.get('reason')} - {error.get('details')}")
```

### Retry Logic for Server Errors

```python
import time

def pin_with_retry(data, max_retries=3):
    for attempt in range(max_retries):
        response = requests.post(url, headers=headers, json=data)

        if response.status_code < 500:
            return response

        # Exponential backoff
        wait_time = 2 ** attempt
        print(f"Server error, retrying in {wait_time}s...")
        time.sleep(wait_time)

    return response
```

### JavaScript Error Handler

```javascript
async function handlePinResponse(response) {
  if (response.ok) {
    return response.json();
  }

  const error = await response.json();

  switch (response.status) {
    case 401:
      throw new Error('Invalid API key');
    case 404:
      throw new Error('Pin not found');
    case 409:
      throw new Error('Insufficient funds - add credits');
    case 500:
      throw new Error('Server error - try again');
    default:
      throw new Error(error.error?.details || 'Unknown error');
  }
}
```

---

## Common Issues & Solutions

### "Invalid CID format"

```json
{"error": {"reason": "BAD_REQUEST", "details": "Invalid CID format"}}
```

**Solution:** Verify CID is valid. Should start with `Qm` (CIDv0) or `bafy` (CIDv1).

### "Access token is missing"

```json
{"error": {"reason": "UNAUTHORIZED", "details": "Access token is missing or invalid"}}
```

**Solution:**
- Add `Authorization: Bearer YOUR_KEY` header
- Check for typos in the header name
- Regenerate key if needed

### "Insufficient funds"

```json
{"error": {"reason": "INSUFFICIENT_FUNDS", "details": "..."}}
```

**Solution:**
- Check your storage usage at cloud.fx.land
- Add FULA credits
- Delete unused pins

### Pin stuck in "failed" status

The `info.status_details` field explains why:

```json
{
  "status": "failed",
  "info": {
    "status_details": "Could not find content on IPFS network"
  }
}
```

**Common reasons:**
- CID doesn't exist
- Content only on offline peer
- Network timeout

---

## Debugging Tips

### Verbose curl Output

```bash
curl -v "https://api.cloud.fx.land/pins" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Check Token Validity

```bash
# Decode JWT payload
echo "YOUR_TOKEN" | cut -d. -f2 | base64 -d | jq
```

### Test Authentication

```bash
# Simple auth test
curl "https://api.cloud.fx.land/pins?limit=1" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

If this returns 401, your token is invalid.
