---
layout: default
title: Authentication - Pinning API
---

# Authentication

The Pinning API uses Bearer token authentication for all endpoints.

## Bearer Token Format

Include your API key in the `Authorization` header:

```
Authorization: Bearer YOUR_API_KEY
```

### Example Request

```bash
curl "https://api.cloud.fx.land/pins" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

## Obtaining API Keys

### Via WebUI (Recommended)

1. Go to [cloud.fx.land](https://cloud.fx.land)
2. Sign in with Google OAuth
3. Navigate to **Settings** > **API Keys**
4. Click **Generate New Key** or copy the default key

### Via Native App OAuth Flow

For desktop or mobile applications, use the OAuth redirect flow:

```
GET https://cloud.fx.land/get-key?redirect=YOUR_APP_SCHEME://callback
```

After Google authentication, the user is redirected to:
```
YOUR_APP_SCHEME://callback?key=JWT_TOKEN
```

## API Key Format

API keys are JWT tokens containing:

| Claim | Description |
|-------|-------------|
| `sub` | User email address |
| `scope` | Permissions: `storage:read storage:write` |
| `jti` | Unique token identifier |
| `iat` | Issued at timestamp |

### Decoding a Token (Example)

```bash
# Decode the payload (base64)
echo "eyJzdWIiOiJ1c2VyQGV4YW1wbGUuY29tIn0" | base64 -d
# Output: {"sub":"user@example.com"}
```

## Session Token (Alternative)

For server-to-server authentication, you can create a session token:

### Create Session

```bash
curl -X POST "https://api.cloud.fx.land/auth/token" \
  -H "Content-Type: application/json" \
  -d '{"username": "you@example.com", "password": "your-password"}'
```

**Response:**
```json
{
  "token": "session-uuid-token-here"
}
```

### Delete Session (Logout)

```bash
curl -X DELETE "https://api.cloud.fx.land/auth/token" \
  -H "Authorization: Bearer YOUR_SESSION_TOKEN"
```

## Token Management

### Multiple Keys

You can create multiple API keys for different applications:
- Each key can be revoked independently
- Keys do not expire automatically
- Revoke compromised keys immediately via WebUI

### Security Best Practices

1. **Never expose keys in client-side code** - Use a backend proxy
2. **Use environment variables** - Don't hardcode keys
3. **Rotate keys periodically** - Create new keys and revoke old ones
4. **Use separate keys per application** - Easier to track and revoke

## Error Responses

### 401 Unauthorized

Missing or invalid token:

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
- Malformed token
- Revoked API key
- Expired session token

### Troubleshooting

1. **Check header format**: Must be `Authorization: Bearer <token>` (note the space)
2. **Verify token**: Ensure no extra whitespace or newlines
3. **Check key status**: Verify key hasn't been revoked in WebUI
4. **Try a new key**: Generate a fresh API key
