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

## License

MIT
