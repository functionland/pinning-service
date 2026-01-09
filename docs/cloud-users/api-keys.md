---
layout: default
title: API Keys
parent: Cloud Users
nav_order: 3
---

# API Keys
{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## What Are API Keys?

API keys let you access Fx.Land programmatically:
- Use with scripts and applications
- Integrate with IPFS CLI
- Build automated workflows

Each key is a JWT (JSON Web Token) that identifies your account.

---

## Viewing Your Keys

1. Go to **API Keys** in the sidebar
2. See all your active keys
3. Keys are partially hidden for security (click to reveal)

---

## Creating a New Key

1. Click **Generate New Key**
2. Optionally give it a name/description
3. Copy the key immediately

{: .warning }
> **Copy your key now!** The full key is only shown once. If you lose it, you'll need to generate a new one.

### Key Format

API keys look like:
```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ5b3VAZXhhbXBsZS5jb20iLC...
```

This is a standard JWT containing:
- Your email (sub claim)
- Permissions (scope claim)
- Unique identifier (jti claim)

---

## Using Your Key

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
ipfs pin remote add --service=fxland QmYourCID

# List remote pins
ipfs pin remote ls --service=fxland
```

### In JavaScript

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

### In Python

```python
import requests

response = requests.post(
    'https://api.cloud.fx.land/pins',
    headers={
        'Authorization': f'Bearer {API_KEY}',
        'Content-Type': 'application/json'
    },
    json={
        'cid': 'QmYourCID',
        'name': 'my-file'
    }
)
```

---

## Managing Keys

### Multiple Keys

Create separate keys for:
- Different applications
- Development vs. production
- Different team members

This way you can revoke one without affecting others.

### Renaming Keys

1. Find the key in your list
2. Click the **edit** icon
3. Enter a new name
4. Save

### Revoking Keys

1. Find the key to revoke
2. Click **Revoke** or the trash icon
3. Confirm revocation

{: .important }
> Revoked keys are immediately invalid. Any application using that key will get "Unauthorized" errors.

---

## Native App OAuth Flow

For desktop or mobile apps that need to obtain a key for the user:

### Flow

1. Open browser to OAuth URL
2. User signs in with Google
3. User is redirected back with the key

### Implementation

```
GET https://cloud.fx.land/get-key?redirect=myapp://callback
```

After authentication:
```
myapp://callback?key=JWT_TOKEN_HERE
```

### Example (Electron App)

```javascript
const { shell } = require('electron');

// Open browser for auth
shell.openExternal(
  'https://cloud.fx.land/get-key?redirect=myapp://oauth-callback'
);

// Handle callback (register protocol handler)
app.setAsDefaultProtocolClient('myapp');

app.on('open-url', (event, url) => {
  const params = new URL(url).searchParams;
  const apiKey = params.get('key');
  // Store and use the key
});
```

---

## Security Best Practices

### Do

- Store keys in environment variables
- Use separate keys for each application
- Revoke keys you no longer use
- Rotate keys periodically

### Don't

- Commit keys to Git repositories
- Share keys in chat or email
- Expose keys in client-side JavaScript
- Use the same key everywhere

### If a Key is Compromised

1. Revoke the key immediately
2. Generate a new key
3. Update your applications
4. Check for unauthorized activity

---

## Troubleshooting

### "Unauthorized" Error

- Check the key is correct (no extra spaces)
- Verify the key hasn't been revoked
- Ensure header format is `Authorization: Bearer <key>`

### Key Not Working

- Keys must include `Bearer ` prefix in the header
- Make sure you copied the full key
- Try generating a new key

### Can't Find My Key

- Keys can only be viewed once when created
- Generate a new key if you lost the old one
- Revoke the lost key to prevent misuse
