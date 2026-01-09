---
layout: default
title: Authentication
parent: Pinning API
nav_order: 1
---

# Authentication
{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Bearer Token Authentication

All API requests require a Bearer token in the `Authorization` header:

```
Authorization: Bearer YOUR_API_KEY
```

### Example Request

```bash
curl "https://api.cloud.fx.land/pins" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

---

## Getting an API Key

### Via WebUI (Recommended)

1. Go to [cloud.fx.land](https://cloud.fx.land)
2. Sign in with Google
3. Navigate to **API Keys**
4. Copy existing key or click **Generate New Key**

### Via Native App OAuth

For desktop/mobile apps:

```
GET https://cloud.fx.land/get-key?redirect=myapp://callback
```

After authentication:
```
myapp://callback?key=JWT_TOKEN_HERE
```

---

## Token Format

API keys are JWT (JSON Web Token) format:

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyQGV4YW1wbGUuY29tIiwic2NvcGUiOiJzdG9yYWdlOnJlYWQgc3RvcmFnZTp3cml0ZSIsImp0aSI6InVuaXF1ZS1pZCJ9.signature
```

### JWT Claims

| Claim | Description |
|:------|:------------|
| `sub` | User email address |
| `scope` | Permissions: `storage:read storage:write` |
| `jti` | Unique token ID (for revocation) |
| `iat` | Issued at timestamp |

### Decoding Tokens

```bash
# Decode the payload (middle part)
echo "YOUR_TOKEN" | cut -d. -f2 | base64 -d | jq
```

---

## Session Token (Alternative)

For server-to-server auth, create a session token:

### Create Session

```bash
curl -X POST "https://api.cloud.fx.land/auth/token" \
  -H "Content-Type: application/json" \
  -d '{"username": "you@example.com", "password": "your-password"}'
```

**Response:**
```json
{
  "token": "session-uuid-here"
}
```

### Delete Session

```bash
curl -X DELETE "https://api.cloud.fx.land/auth/token" \
  -H "Authorization: Bearer YOUR_SESSION_TOKEN"
```

---

## Token Management

### Multiple Keys

Create separate keys for:
- Different applications
- Development vs. production
- Different team members

### Key Rotation

1. Generate new key
2. Update your application
3. Test functionality
4. Revoke old key

### Revoking Keys

In the WebUI:
1. Go to **API Keys**
2. Find the key to revoke
3. Click **Revoke**

Revoked keys are immediately invalid.

---

## Error Responses

### 401 Unauthorized

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
- Expired session

### Troubleshooting

| Issue | Solution |
|:------|:---------|
| Missing header | Add `Authorization: Bearer <token>` |
| Extra whitespace | Trim the token |
| "Bearer" missing | Format must be `Bearer <token>` |
| Key revoked | Generate a new key |

---

## Security Best Practices

### Do

- Store keys in environment variables
- Use HTTPS only
- Rotate keys periodically
- Use separate keys per application
- Revoke unused keys

### Don't

- Commit keys to source control
- Log tokens in production
- Share keys via insecure channels
- Use the same key everywhere
- Expose keys in client-side code

### Environment Variables

```bash
# .env file (never commit!)
FXLAND_API_KEY=eyJhbGciOiJIUzI1NiIs...

# In code
const apiKey = process.env.FXLAND_API_KEY;
```

---

## Code Examples

### JavaScript/Node.js

```javascript
const API_KEY = process.env.FXLAND_API_KEY;

async function listPins() {
  const response = await fetch('https://api.cloud.fx.land/pins', {
    headers: {
      'Authorization': `Bearer ${API_KEY}`
    }
  });
  return response.json();
}
```

### Python

```python
import os
import requests

API_KEY = os.environ['FXLAND_API_KEY']

def list_pins():
    response = requests.get(
        'https://api.cloud.fx.land/pins',
        headers={'Authorization': f'Bearer {API_KEY}'}
    )
    return response.json()
```

### Go

```go
package main

import (
    "net/http"
    "os"
)

func listPins() (*http.Response, error) {
    apiKey := os.Getenv("FXLAND_API_KEY")

    req, _ := http.NewRequest("GET", "https://api.cloud.fx.land/pins", nil)
    req.Header.Set("Authorization", "Bearer "+apiKey)

    return http.DefaultClient.Do(req)
}
```
