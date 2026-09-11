# IPFS Pinning Service

This is the repository for the IPFS Pinning Service API that runs at https://api1.cloud.fx.land. The requests are distributed through https://api.cloud.fx.land which runs the code inside `pool-server`.

## Features

- **SQLite Backend**: Fast, lightweight local database with WAL mode for optimal concurrency
- **IPFS Pinning API Compliant**: Follows the [IPFS Pinning Service API Specification](https://ipfs.github.io/pinning-services-api-spec/)
- **Production Ready**: Comprehensive error handling, input validation, and graceful shutdown
- **Low Resource Usage**: Optimized for minimal memory footprint

## Requirements

- Go 1.22+
- IPFS node (Kubo) running locally
- IPFS Cluster (optional, for distributed pinning)

## Quick Installation

### Automated Installation (Recommended)

Run the installation script as root:

```bash
sudo ./install.sh
```

The script will:
1. Prompt for configuration values (with defaults from existing `.env` if upgrading)
2. Build the application
3. Create the systemd service
4. Start the service

Default installation directory: `/home/root/pinning-service`

### Manual Installation

1. **Build the application:**
```bash
go build -o ./ipfs-pinning main_sqlite.go
```

2. **Create configuration file:**
```bash
cp .env.example .env
# Edit .env with your configuration
```

3. **Create data directory:**
```bash
mkdir -p data
```

4. **Copy service file:**
```bash
sudo cp ipfs-server/fula-pinning-service.service /etc/systemd/system/
```

5. **Enable and start service:**
```bash
sudo systemctl daemon-reload
sudo systemctl enable fula-pinning-service
sudo systemctl start fula-pinning-service
```

## Configuration

Edit `.env` file with your settings:

```env
# Server Configuration
PORT=6000

# Database Configuration (SQLite)
DATABASE_PATH=data/pinning.db

# IPFS Configuration
IPFS_API_ADDR=/ip4/127.0.0.1/tcp/5001

# Blockchain Configuration
BLOCKCHAIN_API_ENDPOINT=http://your-blockchain-api
MASTER_SEED=your_master_seed
POOL_SEED=your_pool_seed
POOL_ID=1
```

## Database Schema

The SQLite database includes the following optimized tables:

- **users**: User accounts with password hashes and pool assignments
- **sessions**: Active user sessions for authentication
- **pins**: Pin records with CID, metadata, and status tracking
- **logins**: Audit log for login attempts (security monitoring)

All tables have appropriate indexes for fast queries.

## API Endpoints

### Pins API (IPFS Standard)
- `POST /pins` - Add a new pin
- `GET /pins` - List pins with filtering
- `GET /pins/{requestid}` - Get pin by request ID
- `POST /pins/{requestid}` - Replace a pin
- `DELETE /pins/{requestid}` - Delete a pin

### Authentication API
- `POST /auth/register` - Register new user
- `POST /auth/login` - Login and get session token
- `POST /auth/logout` - Logout and invalidate session

### Admin API (System-Only)

These endpoints require `X-System-Key` header or `Authorization: Bearer <SYSTEM_KEY>` for authentication.

#### Get Pending Pins
```
GET /admin/pins/pending?after=2024-01-01T00:00:00Z&before=2024-12-31T23:59:59Z&username=user@example.com&limit=200&status=pending
```
| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `after` | Yes | - | Start time filter (RFC3339) |
| `before` | No | - | End time filter (RFC3339) |
| `username` | No | - | Filter by username |
| `limit` | No | 200 | Max results (1-1000) |
| `status` | No | pending | Status filter: `pending`, `queued`, `pinning`, `pinned`, `failed` |

#### Batch Update Pin Status
```
POST /admin/pins/status
Content-Type: application/json

{
  "updates": [
    {"cid": "Qm...", "status": "pinned"},
    {"cid": "Qm...", "upload_status": "uploaded"}
  ]
}
```

#### Batch Update Pin Size
```
POST /admin/pins/size
Content-Type: application/json

{
  "updates": [
    {"cid": "Qm...", "size": 12345678}
  ]
}
```

#### Get System Stats
```
GET /admin/stats
```

#### Get Storage by User
Returns total storage used by a user across all their sessions/API keys.
```
GET /admin/storage/user/{username}
```
Response includes session breakdown showing storage per API key.

#### Get Storage by Session (API Key)
Returns storage used by a specific session token.
```
GET /admin/storage/session/{token}
```

#### Get Total Storage Stats
```
GET /admin/storage
```

## Service Management

```bash
# View service status
sudo systemctl status fula-pinning-service

# View logs
sudo journalctl -u fula-pinning-service -f

# Restart service
sudo systemctl restart fula-pinning-service

# Stop service
sudo systemctl stop fula-pinning-service
```

## Development

### Running Unit Tests
```bash
cd openapi/go
go test -v ./...
```

### Running Benchmarks
```bash
cd openapi/go
go test -bench=. -benchmem ./...
```

### Running IPFS Pinning Service Compliance Tests

The service supports a **test mode** for running the official IPFS Pinning Service compliance tests.

**Prerequisites:**
- IPFS daemon running locally (`ipfs daemon`)
- Node.js installed (for npx)

**Step 1: Start the service in test mode**

Windows (PowerShell):
```powershell
.\run-test-mode.ps1
```

Linux/Mac:
```bash
./run-test-mode.sh
```

Or manually:
```bash
TEST_MODE=true go run main_sqlite.go
```

**Step 2: Run the compliance tests (in another terminal)**
```bash
npx @ipfs-shipyard/pinning-service-compliance -s http://localhost:6000 test-token-for-ipfs-pinning-compliance
```

**Test Mode Details:**
- Creates a test user: `test@pinning.local`
- Uses a fixed token: `test-token-for-ipfs-pinning-compliance`
- Uses a separate test database: `data/pinning_test.db`
- All operations are real (actual IPFS pinning, real database storage)

## Upgrading

The installation script supports upgrades:

1. Run `sudo ./install.sh`
2. The script will detect the existing installation
3. Creates a backup before upgrading
4. Preserves your `.env` configuration
5. Restarts the service with new binary

## Legacy Firebase Backend

The original Firebase backend is still available in `main.go`. To use it:

```bash
go build -o ./ipfs-pinning main.go
```

Note: Firebase backend requires `GOOGLE_APPLICATION_CREDENTIALS` environment variable.


## UPDATE webui

```
# cd ~/pinning-service/pinning-webui/
~/pinning-service/pinning-webui# git pull
npm install
~/pinning-service/pinning-webui# VITE_GOOGLE_CLIENT_ID={client_id} VITE_WALLETCONNECT_PROJECT_ID={project_id} VITE_APPLE_CLIENT_ID=land.fx.cloud npm run build
~/pinning-service/pinning-webui# cp -r dist/* /home/root/pinning-service/pinning-webui/dist/
/pinning-service/pinning-webui# cp package.json package-lock.json /home/root/pinning-service/pinning-webui/
~/pinning-service/pinning-webui# cd /home/root/pinning-service/pinning-webui
cd /home/root/pinning-service/pinning-webui
/home/root/pinning-service/pinning-webui# npm install --production --ignore-scripts=false
/home/root/pinning-service/pinning-webui# npm audit fix
/home/root/pinning-service/pinning-webui# npm rebuild
# systemctl restart fula-pinning-webui
```

## update pinning-service port 6000
cd /root/pinning-service
git pull
go mod download
systemctl stop fula-pinning-service
go build -o /home/root/pinning-service/ipfs-pinning main_postgres.go
systemctl start fula-pinning-service
systemctl status fula-pinning-service


## update ipfs gateway
cd ~/pinning-service/ipfs-server && git pull
npm install --production=false
npm audit fix
npm run build
sudo systemctl stop fula-upload-server
cp -r dist/* /home/root/pinning-service/ipfs-server/dist/
cp package.json /home/root/pinning-service/ipfs-server/
cp package-lock.json /home/root/pinning-service/ipfs-server/ 2>/dev/null || true
cd /home/root/pinning-service/ipfs-server
npm install --production --ignore-scripts=false
sudo systemctl start fula-upload-server
sudo systemctl status fula-upload-server 


## update ai service (fula-ai-service)
# install.sh does BOTH the build and the systemd restart, but it copies from its
# OWN directory and never fetches -- so `git pull` first is required or you will
# rebuild and redeploy the same old code while it prints "Update Complete!".
cd ~/pinning-service/ai && git pull
sudo bash ./install.sh
# It runs in UPDATE mode (detected via /opt/fula-ai-service/.env) and is INTERACTIVE:
#   "Keep existing configuration? [Y/n]" -> answer Y
# It then backs up .env and dist/, copies src/migrations/skills, npm install,
# npm run build, rewrites the systemd unit and restarts the service. On a build
# failure it rolls dist/ and .env back automatically.
# Note: it runs under `set -e`, so a non-TTY `ssh host 'bash install.sh'` aborts at
# the first prompt without deploying -- use a TTY or feed the answer on stdin.
systemctl status fula-ai-service
# Migrations run on service boot; confirm the newest one applied:
journalctl -u fula-ai-service -n 30 --no-pager | grep "Migration applied"
# Public check (the app reads this to decide which features to offer):
curl -s https://ai.cloud.fx.land/api/v1/pricing
