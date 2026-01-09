---
layout: default
title: Error Handling - Pinning API
---

# Error Handling

All errors return a JSON response with an `error` object.

## Error Response Format

```json
{
  "error": {
    "reason": "ERROR_CODE",
    "details": "Human-readable explanation"
  }
}
```

| Field | Description |
|-------|-------------|
| `reason` | Machine-readable error code (uppercase with underscores) |
| `details` | Human-readable description with additional context |

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
- Invalid date format in `before`/`after`
- Malformed JSON body

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
- Invalid or malformed token
- Revoked API key
- Expired session

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
- Invalid `requestid` in URL
- Pin was already deleted
- Trying to access another user's pin

### 409 Insufficient Funds

Account has exceeded free tier without credits.

```json
{
  "error": {
    "reason": "INSUFFICIENT_FUNDS",
    "details": "Unable to process request due to the lack of funds"
  }
}
```

**Resolution:**
- Check storage usage in [WebUI dashboard](https://cloud.fx.land)
- Add FULA credits to your account
- Delete unused pins to free up space

### 4XX Custom Errors

Service-specific errors.

```json
{
  "error": {
    "reason": "CUSTOM_ERROR_CODE",
    "details": "Specific error explanation"
  }
}
```

**Examples:**
- `PIN_ALREADY_EXISTS` - Same CID already pinned
- `INVALID_ORIGINS` - Malformed multiaddr in origins array
- `METADATA_TOO_LARGE` - Metadata exceeds size limit

### 5XX Server Errors

Internal service errors.

```json
{
  "error": {
    "reason": "INTERNAL_SERVER_ERROR",
    "details": "An unexpected error occurred"
  }
}
```

**What to do:**
- Retry the request after a short delay
- Check [status page](https://cloud.fx.land) for outages
- Contact support if the error persists

## Error Handling Best Practices

### 1. Check Status Codes First

```python
response = requests.post(url, headers=headers, json=data)

if response.status_code == 202:
    pin = response.json()
elif response.status_code == 401:
    refresh_token()
    retry()
elif response.status_code == 409:
    add_credits()
else:
    error = response.json()['error']
    log(f"Error: {error['reason']} - {error['details']}")
```

### 2. Implement Retries for 5XX

```python
import time

def pin_with_retry(data, max_retries=3):
    for attempt in range(max_retries):
        response = requests.post(url, headers=headers, json=data)

        if response.status_code < 500:
            return response

        # Exponential backoff
        time.sleep(2 ** attempt)

    return response
```

### 3. Handle Rate Limiting

If you receive errors during high-volume operations, implement delays:

```python
import time

for cid in cids_to_pin:
    response = pin(cid)
    time.sleep(0.1)  # 100ms between requests
```

## Debugging Tips

### Verify Request Format

```bash
# Use -v for verbose output
curl -v -X POST "https://api.cloud.fx.land/pins" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"cid": "Qm..."}'
```

### Check Token Validity

```bash
# Decode JWT payload (middle section)
echo "YOUR_TOKEN" | cut -d. -f2 | base64 -d
```

### Test Authentication

```bash
# Simple auth test
curl "https://api.cloud.fx.land/pins?limit=1" \
  -H "Authorization: Bearer YOUR_API_KEY"
```
