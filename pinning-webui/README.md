# FULA Pinning Service WebUI

A beautiful, production-ready web interface for the FULA IPFS Pinning Service.

## Features

- 🔐 **Google Sign-In** - Secure authentication using Google OAuth
- 🔑 **API Key Management** - Create, view, and delete API keys
- 📌 **Pin Management** - View and add pins with pagination
- 📊 **Dashboard** - Overview of storage usage and statistics
- 👤 **Profile Management** - Account settings and deletion
- 🎨 **Modern UI** - Clean, Google-style minimal design

## Requirements

- Node.js 18+
- SQLite database (shared with pinning service)
- Google OAuth Client ID

## Installation

### Automated (via install.sh)

The WebUI is installed automatically when you run the main installation script:

```bash
sudo ./install.sh
```

### Manual Installation

1. Install dependencies:
```bash
cd pinning-webui
npm install
```

2. Create environment file:
```bash
cp .env.example .env
```

3. Configure `.env`:
   - Set `GOOGLE_CLIENT_ID` from [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   - Set `DATABASE_PATH` to match your pinning service database
   - Generate a secure `SESSION_SECRET`

4. Build for production:
```bash
npm run build
```

5. Start the server:
```bash
npm start
```

## Development

```bash
npm run dev
```

This starts both the Vite dev server (port 5173) and the backend API (port 3001).

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `WEBUI_PORT` | Server port | 3001 |
| `NODE_ENV` | Environment | development |
| `DATABASE_PATH` | SQLite database path | ../data/pinning.db |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | (required) |
| `SESSION_SECRET` | Session encryption key | (auto-generated) |
| `PINNING_SERVICE_URL` | Pinning API endpoint | http://localhost:8080 |

## Native App Integration (Get API Key)

The `/get-key` endpoint allows native applications to obtain an API key through the browser. This enables apps to authenticate users via Google OAuth and receive an API key for subsequent API calls.

### Endpoint

```
GET /get-key?redirect={URL_ENCODED_REDIRECT_URL}
```

### Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `redirect` | string | Yes | URL-encoded redirect URL where the user will be sent after authentication. Must use an allowed scheme. |

### Allowed Redirect Schemes

| Scheme | Example |
|--------|---------|
| `fxblox://` | `fxblox://auth-callback` |
| `fxfiles://` | `fxfiles://auth-callback` |
| `files://` | `files://auth-callback` |
| `http://` | `http://localhost:3000/callback` |
| `https://` | `https://app.example.com/callback` |

### Response

After successful authentication, the user is redirected to:

```
{redirect_url}?key={API_KEY}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `key` | string | JWT API key for authenticating with the Pinning Service API |

### Flow Diagram

```
┌─────────────────┐                    ┌──────────────────────┐
│   Native App    │                    │    Pinning WebUI     │
└────────┬────────┘                    └──────────┬───────────┘
         │                                        │
         │  1. Open browser:                      │
         │     /get-key?redirect=fxblox://cb      │
         │ ──────────────────────────────────────>│
         │                                        │
         │                    2. If not logged in,│
         │                       show login page  │
         │                                        │
         │                    3. User signs in    │
         │                       with Google      │
         │                                        │
         │                    4. Create account   │
         │                       if new user      │
         │                                        │
         │                    5. Get/create       │
         │                       API key          │
         │                                        │
         │  6. Redirect to:                       │
         │     fxblox://cb?key={JWT_API_KEY}      │
         │ <──────────────────────────────────────│
         │                                        │
         │  7. App reads key from URL             │
         │                                        │
```

### Example Usage

**1. Native App Opens Browser**

```
https://your-pinning-service.com/get-key?redirect=fxblox%3A%2F%2Fauth-callback
```

**2. Handle Deep Link Callback (iOS Swift Example)**

```swift
func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
    if url.scheme == "fxblox" {
        if let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let keyParam = components.queryItems?.first(where: { $0.name == "key" }) {
            let apiKey = keyParam.value
            // Store the API key securely
            KeychainHelper.save(apiKey, forKey: "pinning_api_key")
            return true
        }
    }
    return false
}
```

**3. Handle Deep Link Callback (Android Kotlin Example)**

```kotlin
override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    intent?.data?.let { uri ->
        if (uri.scheme == "fxblox") {
            val apiKey = uri.getQueryParameter("key")
            // Store the API key securely
            securePreferences.edit().putString("pinning_api_key", apiKey).apply()
        }
    }
}
```

**4. Handle Deep Link Callback (React Native Example)**

```javascript
import { Linking } from 'react-native';

Linking.addEventListener('url', (event) => {
  const url = new URL(event.url);
  if (url.protocol === 'fxblox:') {
    const apiKey = url.searchParams.get('key');
    // Store the API key securely
    await SecureStore.setItemAsync('pinning_api_key', apiKey);
  }
});
```

### Using the API Key

Once obtained, use the API key in the `Authorization` header for all Pinning Service API requests:

```
Authorization: Bearer {API_KEY}
```

### Error Handling

| Scenario | Behavior |
|----------|----------|
| Missing `redirect` parameter | Shows error page with message |
| Invalid redirect URL format | Shows error page with message |
| Unsupported URL scheme | Shows error page listing allowed schemes |
| User cancels login | Stays on login page |
| API key fetch fails | Shows error page with retry option |

## Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable the Google+ API
4. Go to Credentials → Create Credentials → OAuth Client ID
5. Select "Web application"
6. Add authorized JavaScript origins:
   - `http://localhost:3001` (development)
   - `https://your-domain.com` (production)
7. Copy the Client ID to your `.env` file

## Architecture

```
pinning-webui/
├── server/           # Express.js backend
│   └── index.ts      # API routes and database operations
├── src/              # React frontend
│   ├── components/   # Reusable UI components
│   ├── context/      # React context (auth)
│   ├── pages/        # Page components
│   └── App.tsx       # Main app component
├── dist/             # Production build output
└── package.json
```

## Security

- Session-based authentication with secure cookies
- Rate limiting on API endpoints
- CORS protection
- Helmet security headers
- Input validation and sanitization
- SQL injection prevention via prepared statements

## FxFiles Encryption & Decryption Reference

This section documents how the WebUI fetches and decrypts data from FxFiles cloud storage. This is critical reference material for maintaining compatibility with the FxFiles Flutter app.

### Overview

The WebUI supports three types of encrypted data from FxFiles:

| Data Type | Storage Location | Key Derivation | Notes |
|-----------|------------------|----------------|-------|
| **My Pins (Files)** | IPFS Gateway | `google:{userId}` + salt | Standard file encryption |
| **Shared By Me** | S3: `fula-metadata` bucket | `google:{userId}` + salt | Same as files |
| **Playlists** | S3: `playlists` bucket | `{userId}` (NO prefix!) | Bug in FxFiles app |

### Common Encryption Format

All encrypted data uses **AES-256-GCM** with the following binary format:

```
┌──────────────┬──────────────┬─────────────────┐
│  Nonce (IV)  │   Auth Tag   │   Ciphertext    │
│   12 bytes   │   16 bytes   │   Variable len  │
└──────────────┴──────────────┴─────────────────┘
```

**Total size** = 28 bytes + plaintext length

### Key Derivation

Keys are derived using **PBKDF2** with HMAC-SHA256:

```
PBKDF2(password, salt, iterations=100000, keyLength=32, hash=SHA-256)
```

#### File Encryption Key (My Pins, Shared By Me)

Used by `AuthService._deriveEncryptionKey()` in FxFiles:

```javascript
const password = `google:${googleUserId}`;  // With "google:" prefix
const salt = `fula-files-v1:${userEmail}`;
const key = PBKDF2(password, salt, 100000, 32, 'SHA-256');
```

**Web implementation:** `deriveEncryptionKey()` in `src/services/encryptionService.ts`

#### Playlist Encryption Key

Used by `PlaylistService._getEncryptionKey()` in FxFiles:

```javascript
const password = googleUserId;  // NO "google:" prefix (bug in FxFiles!)
const salt = `fula-files-v1:${userEmail}`;
const key = PBKDF2(password, salt, 100000, 32, 'SHA-256');
```

**Web implementation:** `derivePlaylistEncryptionKey()` in `src/services/encryptionService.ts`

> **Note:** This is a bug in the FxFiles Flutter app where `PlaylistService._getEncryptionKey()`
> uses just `user.id` while `AuthService._deriveEncryptionKey()` uses `${provider}:${id}`.
> The WebUI must use the same "buggy" derivation to maintain compatibility.

#### Keypair Derivation (for Hashed User ID)

Used to compute the user ID hash for the shares file path:

```javascript
const password = `google:${googleUserId}`;  // With "google:" prefix
const salt = `fula-files-keypair-v1:${userEmail}`;  // Different salt!
const seed = PBKDF2(password, salt, 100000, 32, 'SHA-256');

// Derive X25519 public key from seed
const publicKey = X25519_BasePointMult(seed);

// Hash the base64-encoded public key
const publicKeyBase64 = base64Encode(publicKey);
const hash = SHA256(publicKeyBase64);  // Hash the STRING, not raw bytes!
const hashedUserId = base64Encode(hash).substring(0, 16).replace(/\//g, '_').replace(/\+/g, '-');
```

**Web implementation:** `computeHashedUserId()` in `src/services/encryptionService.ts`

---

### 1. My Pins (Encrypted Files)

**Source:** IPFS Gateway
**Endpoint:** `https://ipfs.cloud.fx.land/gateway/{cid}`
**Key:** File encryption key (with `google:` prefix)

#### Fetch & Decrypt Flow

```
1. User clicks "Download Decrypted" on a pin
2. Retrieve stored encryption key from secure storage
   - Key was derived with: deriveEncryptionKey(googleUserId, email)
3. Fetch encrypted file from IPFS gateway: GET /gateway/{cid}
4. Decrypt using AES-256-GCM:
   - nonce = bytes[0:12]
   - tag = bytes[12:28]
   - ciphertext = bytes[28:]
   - plaintext = AES-GCM-Decrypt(key, nonce, ciphertext + tag)
5. Detect MIME type from magic bytes
6. Trigger browser download
```

**Code location:** `downloadDecrypted()` in `src/pages/Pins.tsx`

---

### 2. Shared By Me (Outgoing Shares)

**Source:** S3-compatible storage
**Bucket:** `fula-metadata`
**Key pattern:** `.fula/shares/{hashedUserId}.json.enc`
**Encryption key:** File encryption key (with `google:` prefix)

#### Fetch & Decrypt Flow

```
1. User navigates to "Shared By Me" tab
2. Get JWT token from /api/keys/active
3. Compute hashedUserId:
   - Derive keypair seed with salt "fula-files-keypair-v1:{email}"
   - Get X25519 public key
   - Base64 encode public key
   - SHA256 hash the base64 STRING
   - Take first 16 chars, make URL-safe
4. Create S3 client with JWT authentication:
   - endpoint: https://s3.cloud.fx.land
   - accessKeyId: "JWT:{token}"
   - secretAccessKey: "not-used"
5. Fetch: GET /fula-metadata/.fula/shares/{hashedUserId}.json.enc
6. Decrypt with file encryption key
7. Parse JSON to get share list
```

**Code location:** `fetchSharedByMe()` in `src/pages/Pins.tsx`

#### S3 Authentication

```javascript
const s3Client = new S3Client({
  endpoint: 'https://s3.cloud.fx.land',
  region: 'us-east-1',
  credentials: {
    accessKeyId: `JWT:${jwtToken}`,
    secretAccessKey: 'not-used',
  },
  forcePathStyle: true,
});
```

---

### 3. Playlists

**Source:** S3-compatible storage
**Bucket:** `playlists`
**Key pattern:** `user-playlists/{playlistId}.json`
**Encryption key:** Playlist key (WITHOUT `google:` prefix!)

#### Fetch & Decrypt Flow

```
1. User navigates to "Playlists" tab
2. Derive playlist encryption key:
   - password = googleUserId (NO "google:" prefix!)
   - salt = "fula-files-v1:{email}"
   - key = PBKDF2(...)
3. Get JWT token from /api/keys/active
4. Create S3 client with JWT authentication
5. List objects: GET /playlists?prefix=user-playlists/
6. For each playlist file:
   a. Fetch: GET /playlists/{key}
   b. Decrypt with playlist encryption key
   c. Parse JSON to get playlist data
```

**Code location:** `fetchPlaylists()` in `src/pages/Pins.tsx`

#### Important: Playlist Key Derivation Bug

The FxFiles Flutter app has an inconsistency:

| Location | Code | Password Used |
|----------|------|---------------|
| `AuthService._deriveEncryptionKey()` | Line 185-190 | `${provider.name}:${id}` → `google:12345` |
| `PlaylistService._getEncryptionKey()` | Line 168-171 | `user.id` → `12345` |

This means playlists are encrypted with a **different key** than regular files!

The WebUI must use the same derivation as `PlaylistService` (without prefix) to decrypt playlists.

---

### Decryption Code (JavaScript)

```javascript
async function decrypt(encryptedData, key) {
  const NONCE_LENGTH = 12;
  const TAG_LENGTH = 16;

  // Extract components
  const nonce = encryptedData.slice(0, NONCE_LENGTH);
  const tag = encryptedData.slice(NONCE_LENGTH, NONCE_LENGTH + TAG_LENGTH);
  const ciphertext = encryptedData.slice(NONCE_LENGTH + TAG_LENGTH);

  // WebCrypto expects: ciphertext + tag (tag at end)
  const ciphertextWithTag = new Uint8Array(ciphertext.length + tag.length);
  ciphertextWithTag.set(ciphertext, 0);
  ciphertextWithTag.set(tag, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    key,
    ciphertextWithTag
  );

  return new Uint8Array(decrypted);
}
```

---

### S3 API Compatibility Notes

The S3-compatible storage (MinIO) requires:

1. **Path-style URLs:** Use `forcePathStyle: true` in S3 client config
2. **No trailing slash:** Request `/bucket?prefix=` not `/bucket/?prefix=`
3. **ListObjects v1:** Use `ListObjectsCommand` not `ListObjectsV2Command`
4. **JWT authentication:** Pass as `accessKeyId: "JWT:{token}"`

---

### Summary Table

| Feature | Endpoint | Bucket | Key Path | Password | Salt |
|---------|----------|--------|----------|----------|------|
| Files | IPFS Gateway | - | `/{cid}` | `google:{id}` | `fula-files-v1:{email}` |
| Shares | S3 | `fula-metadata` | `.fula/shares/{hash}.json.enc` | `google:{id}` | `fula-files-v1:{email}` |
| Playlists | S3 | `playlists` | `user-playlists/{uuid}.json` | `{id}` (no prefix!) | `fula-files-v1:{email}` |
| User ID Hash | - | - | - | `google:{id}` | `fula-files-keypair-v1:{email}` |

---

### Related Files

- `src/services/encryptionService.ts` - All encryption/decryption functions
- `src/services/secureStorage.ts` - Secure key storage in browser
- `src/pages/Pins.tsx` - UI and fetch logic for all three data types
- `src/services/sharingService.ts` - Share and playlist data models

## License

MIT
