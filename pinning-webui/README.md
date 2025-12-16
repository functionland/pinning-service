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
