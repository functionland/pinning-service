---
layout: default
title: API Keys - WebUI
---

# API Keys

API keys allow programmatic access to the Pinning API.

## Key Format

API keys are JWT (JSON Web Token) format:

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyQGV4YW1wbGUuY29tIiwic2NvcGUiOiJzdG9yYWdlOnJlYWQgc3RvcmFnZTp3cml0ZSIsImp0aSI6InVuaXF1ZS1pZCJ9.signature
```

### Token Claims

| Claim | Description |
|-------|-------------|
| `sub` | Your email address (user identity) |
| `scope` | Permissions: `storage:read storage:write` |
| `jti` | Unique token ID (for revocation) |
| `iat` | Issued at timestamp |

## Managing Keys in WebUI

### View Keys

1. Sign in at [cloud.fx.land](https://cloud.fx.land)
2. Go to **API Keys** section
3. See all your active keys

### Create a New Key

1. Click **Generate New Key**
2. Optionally give it a name/description
3. Copy the key immediately (shown only once)

### Copy Existing Key

1. Find the key in your list
2. Click the **Copy** button
3. Key is copied to clipboard

### Revoke a Key

1. Find the key to revoke
2. Click **Revoke** or the trash icon
3. Confirm the action

Revoked keys are immediately invalid and cannot be restored.

## Using API Keys

### With curl

```bash
curl "https://api.cloud.fx.land/pins" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### With IPFS CLI

```bash
# Add the remote pinning service
ipfs pin remote service add fxland https://api.cloud.fx.land YOUR_API_KEY

# Pin content
ipfs pin remote add --service=fxland QmCID

# List remote pins
ipfs pin remote ls --service=fxland
```

### In Code (JavaScript)

```javascript
const response = await fetch('https://api.cloud.fx.land/pins', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    cid: 'QmYourCID',
    name: 'my-file'
  })
});
```

## Native App OAuth Flow

For desktop or mobile applications that need to obtain a key on behalf of the user:

### Flow

1. Open browser to OAuth URL
2. User signs in with Google
3. User is redirected back to your app with the key

### Implementation

```
GET https://cloud.fx.land/get-key?redirect=myapp://callback
```

After authentication, the user is redirected to:
```
myapp://callback?key=JWT_TOKEN_HERE
```

### Example (Desktop App)

```javascript
// 1. Open browser
const authUrl = 'https://cloud.fx.land/get-key?redirect=myapp://oauth-callback';
shell.openExternal(authUrl);

// 2. Register URL handler for myapp://
app.setAsDefaultProtocolClient('myapp');

// 3. Handle callback
app.on('open-url', (event, url) => {
  const params = new URL(url).searchParams;
  const apiKey = params.get('key');
  // Store and use the key
});
```

## Security Best Practices

### Do

- Store keys in environment variables or secure storage
- Use separate keys for different applications
- Revoke keys when no longer needed
- Rotate keys periodically

### Don't

- Commit keys to version control
- Expose keys in client-side JavaScript
- Share keys between team members (create separate keys)
- Log keys in application output

### Key Rotation

To rotate a key:

1. Generate a new key
2. Update your application to use the new key
3. Test that everything works
4. Revoke the old key

## Troubleshooting

### "Unauthorized" Error

1. Verify the key is correct (no extra spaces)
2. Check the key hasn't been revoked
3. Ensure proper header format: `Authorization: Bearer <key>`

### Key Not Working After Copy

- Browser may add invisible characters
- Try generating a new key
- Copy directly from the WebUI (use the copy button)

### Need to Recover a Key

Keys cannot be recovered after creation. If you lose a key:

1. Generate a new key
2. Update your applications
3. Revoke the lost key (prevents misuse)
