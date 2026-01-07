# Fula Pinning Service API Documentation

Base URL: `https://cloud.fx.land` (production)

## Authentication

The API supports two authentication methods:

### 1. Session-Based Authentication (Web UI)
Used by the web interface after Google OAuth login. Sessions are stored in cookies.

### 2. Bearer Token Authentication (External Apps)
For external applications (mobile apps, CLI tools, etc.), use API keys as Bearer tokens.

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" https://cloud.fx.land/api/v1/storage
```

**Getting an API Key:**
1. Log in to the web UI at https://cloud.fx.land
2. Navigate to Settings > API Keys
3. Copy your API key (JWT format)

---

## API v1 Endpoints (Bearer Token Auth)

These endpoints are designed for external applications using API key authentication.

### GET /api/v1/storage

Get storage usage and credit information.

**Headers:**
```
Authorization: Bearer YOUR_API_KEY
```

**Response:**
```json
{
  "currentStorageBytes": 524288000,
  "freeTierBytes": 524288000,
  "paidStorageBytes": 1073741824,
  "totalAvailableBytes": 1598029824,
  "balanceFula": 8.0,
  "monthlyBurnRate": 0,
  "isConsuming": false,
  "canUpload": true,
  "isSuspended": false
}
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `currentStorageBytes` | number | Current storage used in bytes |
| `freeTierBytes` | number | Free tier allowance (500 MB) |
| `paidStorageBytes` | number | Additional storage from FULA balance |
| `totalAvailableBytes` | number | Total available storage (free + paid) |
| `balanceFula` | number | Current FULA token balance |
| `monthlyBurnRate` | number | FULA tokens consumed per month (if over free tier) |
| `isConsuming` | boolean | Whether credits are being consumed |
| `canUpload` | boolean | Whether user can upload new content |
| `isSuspended` | boolean | Whether account is suspended |

---

### GET /api/v1/wallets

Get user's linked blockchain wallets and supported chains.

**Headers:**
```
Authorization: Bearer YOUR_API_KEY
```

**Response:**
```json
{
  "wallets": [
    {
      "address": "0x1234567890abcdef1234567890abcdef12345678",
      "chainId": 8453,
      "isVerified": true,
      "connectedAt": "2024-01-15T10:30:00.000Z"
    }
  ],
  "supportedChains": [
    {
      "chainId": 1,
      "chainName": "Ethereum",
      "vaultAddress": "0x...",
      "tokenAddress": "0x92217cCaEDBdbc54C76c15feA18823db1558fDc9"
    },
    {
      "chainId": 8453,
      "chainName": "Base",
      "vaultAddress": "0x...",
      "tokenAddress": "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB"
    },
    {
      "chainId": 2046399126,
      "chainName": "Skale Europa",
      "vaultAddress": "0x...",
      "tokenAddress": "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB"
    }
  ]
}
```

---

### POST /api/v1/wallets/link

Link a blockchain wallet to your account with signature verification.

**Headers:**
```
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
```

**Request Body:**
```json
{
  "address": "0x1234567890abcdef1234567890abcdef12345678",
  "chainId": 8453,
  "signature": "0x...",
  "message": "Link wallet to Fula Pinning Service\nUser: user@example.com\nWallet: 0x1234567890abcdef1234567890abcdef12345678\nTimestamp: 1704567890"
}
```

**Request Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `address` | string | Yes | Wallet address (0x prefixed, 40 hex chars) |
| `chainId` | number | Yes | Blockchain chain ID |
| `signature` | string | Yes | EIP-191 signature of the message |
| `message` | string | Yes | Message that was signed (must include email and wallet address) |

**Message Format:**
The message must include:
- User's email address
- Wallet address being linked
- Timestamp (recommended for replay protection)

**Response:**
```json
{
  "success": true,
  "address": "0x1234567890abcdef1234567890abcdef12345678",
  "chainId": 8453
}
```

**Errors:**
| Status | Error | Description |
|--------|-------|-------------|
| 400 | `Invalid wallet address format` | Address must be 0x + 40 hex characters |
| 400 | `Invalid signature message` | Message must include email and wallet address |
| 400 | `Signature verification failed` | Recovered address doesn't match |
| 400 | `Wallet already linked to another account` | Wallet is verified for different user |
| 400 | `Unsupported or disabled chain` | Chain ID not supported |

---

### POST /api/v1/credits/claim

Claim FULA tokens from a blockchain transaction.

**Headers:**
```
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
```

**Request Body:**
```json
{
  "txHash": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "chainId": 8453
}
```

**Request Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `txHash` | string | Yes | Transaction hash (0x + 64 hex chars) |
| `chainId` | number | Yes | Chain where transaction occurred |

**Response:**
```json
{
  "success": true,
  "amountFula": 10.0,
  "newBalance": 18.0
}
```

**Errors:**
| Status | Error | Description |
|--------|-------|-------------|
| 400 | `Invalid transaction hash format` | Must be 0x + 64 hex characters |
| 400 | `This transaction has already been credited` | Transaction already claimed |
| 400 | `Unsupported or disabled chain` | Chain ID not supported |
| 400 | `No FULA transfer to vault found` | Transaction doesn't contain valid FULA transfer |
| 400 | `Transfer amount too small` | Amount < 0.001 FULA |
| 400 | `Wallet not linked to your account` | Sender wallet not linked |
| 404 | `Transaction not found or not confirmed` | Transaction not indexed yet |

**Note:** If you get a 404 error immediately after sending a transaction, wait a few seconds and retry. Blockchain explorers may take time to index new transactions.

---

### GET /api/v1/credits/history

Get paginated credit transaction history.

**Headers:**
```
Authorization: Bearer YOUR_API_KEY
```

**Query Parameters:**
| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `page` | number | 1 | - | Page number (1-indexed) |
| `limit` | number | 20 | 100 | Items per page |

**Example:**
```
GET /api/v1/credits/history?page=1&limit=20
```

**Response:**
```json
{
  "history": [
    {
      "txType": "deposit",
      "amountFula": 10.0,
      "balanceAfter": 18.0,
      "referenceId": "8453:0x1234...",
      "createdAt": "2024-01-15T10:30:00.000Z"
    },
    {
      "txType": "hourly_deduction",
      "amountFula": -0.01,
      "balanceAfter": 17.99,
      "referenceId": null,
      "createdAt": "2024-01-15T11:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 45,
  "totalPages": 3
}
```

**Transaction Types:**
| Type | Description |
|------|-------------|
| `deposit` | FULA tokens claimed from blockchain transaction |
| `hourly_deduction` | Automatic hourly deduction for storage over free tier |
| `adjustment` | Manual admin adjustment |

---

## Public Endpoints (No Auth Required)

### GET /api/public/stats

Get public platform statistics.

**Response:**
```json
{
  "totalPins": 12500,
  "totalSize": 5368709120,
  "totalUsers": 450
}
```

---

### GET /api/credits/pricing

Get pricing information and supported chains.

**Response:**
```json
{
  "freeTierBytes": 524288000,
  "freeTierMB": 500,
  "fulaPerGBMonth": 8,
  "chains": [
    {
      "chainId": 1,
      "chainName": "Ethereum",
      "vaultAddress": "0x...",
      "tokenAddress": "0x92217cCaEDBdbc54C76c15feA18823db1558fDc9",
      "isEnabled": true
    },
    {
      "chainId": 8453,
      "chainName": "Base",
      "vaultAddress": "0x...",
      "tokenAddress": "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
      "isEnabled": true
    }
  ]
}
```

---

### GET /api/health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

---

## Session-Based Endpoints (Web UI)

These endpoints require session authentication (cookie-based, after Google OAuth login).

### Authentication

#### POST /auth/google

Authenticate with Google OAuth.

**Request Body:**
```json
{
  "credential": "GOOGLE_ID_TOKEN"
}
```

**Response:**
```json
{
  "success": true,
  "user": {
    "id": "google-user-id",
    "email": "user@example.com",
    "name": "User Name",
    "picture": "https://..."
  },
  "isNew": false
}
```

#### POST /auth/logout

Log out and destroy session.

**Response:**
```json
{
  "success": true
}
```

#### GET /auth/me

Get current authenticated user.

**Response:**
```json
{
  "user": {
    "id": "google-user-id",
    "email": "user@example.com",
    "name": "User Name",
    "picture": "https://..."
  }
}
```

---

### API Keys

#### GET /api/keys

List all API keys for the authenticated user.

**Response:**
```json
{
  "keys": [
    {
      "key_id": "eyJhbGciOiJIUzI1NiIs...",
      "created_at": "2024-01-15T10:30:00.000Z",
      "last_used_at": "2024-01-15T12:00:00.000Z"
    }
  ]
}
```

#### POST /api/keys

Create a new API key.

**Response:**
```json
{
  "keyId": "eyJhbGciOiJIUzI1NiIs..."
}
```

#### DELETE /api/keys/:keyId

Delete an API key.

**Response:**
```json
{
  "success": true
}
```

#### GET /api/keys/active

Get or create the first active API key.

**Response:**
```json
{
  "key": "eyJhbGciOiJIUzI1NiIs..."
}
```

---

### Pins

#### GET /api/pins

List user's pinned content.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `limit` | number | 20 | Items per page (max 100) |
| `search` | string | - | Search by CID or request ID |

**Response:**
```json
{
  "pins": [
    {
      "request_id": "uuid",
      "cid": "Qm...",
      "name": "my-file.txt",
      "created_at": "2024-01-15T10:30:00.000Z",
      "status": "pinned",
      "size": 1024
    }
  ],
  "total": 100,
  "page": 1,
  "limit": 20,
  "totalPages": 5
}
```

#### POST /api/pins

Add a new pin.

**Request Body:**
```json
{
  "cid": "QmYwAPJzv5CZsnAzt8auVZRn4sCfRMPpSEBZ...",
  "name": "optional-name"
}
```

**Response:**
```json
{
  "requestId": "uuid",
  "cid": "Qm...",
  "status": "queued"
}
```

#### POST /api/pins/bulk-unpin

Unpin multiple items at once.

**Request Body:**
```json
{
  "requestIds": ["uuid1", "uuid2", "uuid3"]
}
```

**Response:**
```json
{
  "success": true,
  "results": [
    { "requestId": "uuid1", "success": true },
    { "requestId": "uuid2", "success": true },
    { "requestId": "uuid3", "success": false, "error": "Failed to unpin" }
  ],
  "summary": {
    "total": 3,
    "successful": 2,
    "failed": 1
  }
}
```

#### POST /api/pins/:requestId/refresh

Refresh pin status from the pinning cluster.

**Response:**
```json
{
  "request_id": "uuid",
  "status": "pinned",
  "cid": "Qm...",
  "name": "my-file.txt",
  "size": 1024,
  "refreshed": true
}
```

#### GET /api/pins/:requestId/nodes

Get cluster nodes where content is pinned.

**Response:**
```json
{
  "nodes": [
    {
      "peerId": "12D3KooW...",
      "peerName": "node-1",
      "status": "pinned"
    }
  ]
}
```

---

### Stats

#### GET /api/stats

Get user's storage statistics.

**Response:**
```json
{
  "totalPins": 50,
  "totalSize": 1073741824,
  "lastLogin": "2024-01-15T10:30:00.000Z",
  "memberSince": "2023-06-01T00:00:00.000Z"
}
```

---

### Credits (Session-Based)

#### GET /api/credits

Get credit status (same data as /api/v1/storage but different format).

**Response:**
```json
{
  "balanceFula": 8.0,
  "currentStorageBytes": 524288000,
  "freeTierBytes": 524288000,
  "canUpload": true,
  "isSuspended": false
}
```

#### GET /api/credits/history

Get credit history (session-based version).

**Query Parameters:**
| Parameter | Type | Default | Max |
|-----------|------|---------|-----|
| `limit` | number | 50 | 100 |

**Response:**
```json
{
  "history": [...]
}
```

#### POST /api/credits/claim

Claim transaction (session-based version, same as /api/v1/credits/claim).

---

### Wallets (Session-Based)

#### GET /api/wallets

Get linked wallets (session-based version).

**Response:**
```json
{
  "wallets": [...],
  "supportedChains": [...]
}
```

#### POST /api/wallets/connect

Link wallet (session-based version, same as /api/v1/wallets/link).

#### DELETE /api/wallets/:address

Unlink a wallet.

**Response:**
```json
{
  "success": true
}
```

---

### Profile

#### DELETE /api/profile

Delete user account and all data.

**Request Body:**
```json
{
  "confirmation": "delete"
}
```

**Response:**
```json
{
  "success": true
}
```

---

## Error Responses

All endpoints return errors in a consistent format:

```json
{
  "error": "Error message here",
  "message": "Optional additional details"
}
```

**Common HTTP Status Codes:**
| Status | Description |
|--------|-------------|
| 400 | Bad Request - Invalid input |
| 401 | Unauthorized - Missing or invalid auth |
| 403 | Forbidden - Insufficient permissions |
| 404 | Not Found - Resource doesn't exist |
| 429 | Too Many Requests - Rate limited |
| 500 | Internal Server Error |

---

## Rate Limiting

API endpoints are rate limited to **100 requests per 15 minutes** per IP address.

When rate limited, you'll receive:
```
HTTP/1.1 429 Too Many Requests
Retry-After: 900
```

---

## FULA Token Contracts

| Chain | Token Address |
|-------|---------------|
| Ethereum (1) | `0x92217cCaEDBdbc54C76c15feA18823db1558fDc9` |
| Base (8453) | `0x9e12735d77c72c5C3670636D428f2F3815d8A4cB` |
| Skale Europa (2046399126) | `0x9e12735d77c72c5C3670636D428f2F3815d8A4cB` |

---

## Pricing

- **Free Tier:** 500 MB
- **Paid Storage:** 8 FULA tokens per GB per month
- **Billing:** Hourly deductions when over free tier

**Example:**
- 1 GB stored = 500 MB free + 500 MB paid
- 500 MB paid = 0.5 GB × 8 FULA = 4 FULA/month
- Hourly rate = 4 FULA ÷ 720 hours ≈ 0.0056 FULA/hour
