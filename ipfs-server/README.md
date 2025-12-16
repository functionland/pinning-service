# IPFS Gateway and Upload Server

This server provides:
1. **Authenticated file uploads to IPFS** - Users with valid session tokens (from the pinning service) can upload files
2. **Public IPFS gateway** - Anyone can retrieve content by CID

## Requirements

- Node.js 18+
- IPFS daemon (Kubo) running on port 5001
- Pinning service database (SQLite) - read-only access

## Configuration

Environment variables (can be set in `.env` file):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3300` | Server port |
| `IPFS_API_URL` | `http://127.0.0.1:5001` | IPFS API endpoint |
| `DATABASE_PATH` | `../data/pinning.db` | Path to pinning service SQLite database |
| `UPLOAD_DIR` | `./uploads` | Temporary upload directory |
| `MAX_FILE_SIZE` | `838860800` | Max upload size in bytes (800MB) |
| `IPFS_TIMEOUT` | `60000` | IPFS operation timeout in ms |

## API Endpoints

### `GET /health`
Health check endpoint.

### `POST /upload` (requires authentication)
Upload a file to IPFS.

**Headers:**
- `Authorization: Bearer <session_token>` - Token from pinning service

**Body:** `multipart/form-data` with `file` field

**Response:**
```json
{
  "cid": "bafkreixxxxxxx",
  "poolId": 1,
  "size": 12345
}
```

### `GET /gateway/:cid`
Public IPFS gateway - retrieve content by CID.

**Query Parameters:**
- `raw` - Return raw IPLD block instead of content

**Response:** File content with appropriate Content-Type header

## Installation

### Using install.sh (recommended)

The main `install.sh` script in the parent directory will automatically install this service if Node.js 18+ is available.

```bash
cd ..
sudo ./install.sh
```

### Manual Installation

1. Install dependencies:
```bash
npm install
```

2. Build the binary:
```bash
npm run build
```

3. Copy service file and configure:
```bash
sudo cp fula-upload-server.service /etc/systemd/system/
# Edit the service file to set correct paths
sudo systemctl daemon-reload
sudo systemctl enable fula-upload-server
sudo systemctl start fula-upload-server
```

## Development

```bash
# Run in development mode with auto-reload
npm run dev

# Or run directly
npm start
```

## Authentication

This server shares authentication with the pinning service:
- Uses the same SQLite database (read-only)
- Validates session tokens from the `sessions` table
- Retrieves user pool IDs from the `users` table

Users must first authenticate with the pinning service to get a valid session token.
