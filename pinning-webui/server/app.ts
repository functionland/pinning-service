import express, { type Request, type Response, type NextFunction } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import http from 'http';
import { OAuth2Client } from 'google-auth-library';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import {
  getUserCreditStatus,
  getUserWallets,
  linkWallet,
  unlinkWallet,
  getCreditHistory,
  creditUser,
  getSuspendedUsers,
  unsuspendUser,
  isAdmin,
  getSupportedChains,
  FREE_TIER_BYTES,
  FULA_PER_GB_MONTH,
  rawToFula,
} from './services/creditService.js';
import {
  createPostgresPool,
  query,
  closePool,
  getOrCreateWebuiUser,
  getWebuiUserByEmail,
  getApiKeys,
  createApiKey,
  deleteApiKey,
  getUserPins,
  getUserStats,
  deleteUserProfile,
  addPin,
  verifyApiKey,
} from './database/postgres.js';

// Session user type
export interface SessionUser {
  id: string; // Google user ID (sub claim)
  email: string;
  name: string;
  picture: string;
}

// Extend express session
declare module 'express-session' {
  interface SessionData {
    user?: SessionUser;
  }
}

// Extend express Request for API token auth
declare global {
  namespace Express {
    interface Request {
      apiUser?: { email: string };
    }
  }
}

// App configuration type
export interface AppConfig {
  port: number;
  googleClientId: string;
  sessionSecret: string;
  jwtSecret: string;
  nodeEnv: string;
  pinningServiceUrl: string;
  systemKey?: string;  // For x402 gateway integration
  s3AdminJwt?: string;  // For internal S3 fetch (share links)
  s3InternalUrl?: string;  // Internal S3 endpoint (default: http://127.0.0.1:9000)
}

// Database operations type (async for PostgreSQL)
export interface DbOps {
  getOrCreateUser(email: string, name: string, picture: string, referralCode?: string): Promise<any>;
  getUserByEmail(email: string): Promise<any>;
  getApiKeys(email: string): Promise<any[]>;
  createApiKey(email: string): Promise<string>;
  deleteApiKey(email: string, keyId: string): Promise<boolean>;
  getUserPins(email: string, page: number, limit: number, search?: string): Promise<{ pins: any[]; total: number }>;
  getUserStats(email: string): Promise<any>;
  deleteUserProfile(email: string): Promise<void>;
  addPin(email: string, cid: string, name?: string): Promise<string>;
}

// Initialize PostgreSQL database connection pool
// Schema is managed via migrations (migrations/postgres/*.sql)
export async function initializeDatabase(): Promise<void> {
  console.log('[webui] Initializing PostgreSQL connection pool...');
  createPostgresPool();

  // Verify connection
  try {
    await query('SELECT 1');
    console.log('[webui] PostgreSQL connection established');
  } catch (error) {
    console.error('[webui] Failed to connect to PostgreSQL:', error);
    throw error;
  }
}

// Seed chain_sync_state with supported chains (if empty)
export async function seedChainSyncState(): Promise<void> {
  const chainCount = await query<{ count: string }>('SELECT COUNT(*) as count FROM chain_sync_state');
  if (parseInt(chainCount.rows[0]?.count || '0', 10) === 0) {
    const vaultAddress = process.env.VAULT_ADDRESS || '0x0000000000000000000000000000000000000000';
    // Starting blocks set to recent blocks to avoid scanning from genesis
    await query(`
      INSERT INTO chain_sync_state (chain_id, chain_name, token_address, vault_address, is_enabled, last_scanned_block)
      VALUES
        (1, 'Ethereum', '0x92217cCaEDBdbc54C76c15feA18823db1558fDc9', $1, 1, 24179670),
        (8453, 'Base', '0x9e12735d77c72c5C3670636D428f2F3815d8A4cB', $2, 1, 40480508),
        (2046399126, 'Skale Europa', '0x9e12735d77c72c5C3670636D428f2F3815d8A4cB', $3, 1, 22856425)
      ON CONFLICT (chain_id) DO NOTHING
    `, [vaultAddress, vaultAddress, vaultAddress]);
    console.log('[webui] Seeded chain_sync_state with supported chains');
  }
}

// Generate JWT API key
export function generateJwtApiKey(email: string, jwtSecret: string): string {
  const payload = {
    sub: email,
    iat: Math.floor(Date.now() / 1000),
    scope: 'storage:read storage:write',
    jti: uuidv4(),
  };

  return jwt.sign(payload, jwtSecret, { algorithm: 'HS256' });
}

// Generate unique referral code (8 characters, alphanumeric, excluding confusing chars)
function generateReferralCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude 0, O, I, 1
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Mask email for privacy (show first 2 chars, mask middle, show last char before @)
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  if (local.length <= 4) {
    return `${local[0]}${'*'.repeat(local.length - 1)}@${domain}`;
  }
  const start = local.slice(0, 2);
  const end = local.slice(-1);
  const masked = '*'.repeat(Math.min(4, local.length - 3));
  return `${start}${masked}${end}@${domain}`;
}

// Create database operations using PostgreSQL
// These functions wrap the postgres.ts module functions
export function createDbOps(jwtSecret: string): DbOps {
  return {
    async getOrCreateUser(email: string, name: string, picture: string, referralCode?: string) {
      return getOrCreateWebuiUser(email, name, picture, jwtSecret, generateJwtApiKey, referralCode);
    },

    async getUserByEmail(email: string) {
      return getWebuiUserByEmail(email);
    },

    async getApiKeys(email: string) {
      return getApiKeys(email);
    },

    async createApiKey(email: string): Promise<string> {
      return createApiKey(email, jwtSecret, generateJwtApiKey);
    },

    async deleteApiKey(email: string, keyId: string): Promise<boolean> {
      return deleteApiKey(email, keyId);
    },

    async getUserPins(email: string, page: number, limit: number, search?: string) {
      return getUserPins(email, page, limit, search);
    },

    async getUserStats(email: string) {
      return getUserStats(email);
    },

    async deleteUserProfile(email: string) {
      return deleteUserProfile(email);
    },

    async addPin(email: string, cid: string, name?: string) {
      return addPin(email, cid, name);
    },
  };
}

// HTTP helpers
export function httpGet(url: string, headers: Record<string, string>, timeoutMs: number = 10000): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: parseInt(urlObj.port) || 80,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: headers
    };

    const req = http.request(options, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        resolve({ status: response.statusCode || 500, data });
      });
    });

    req.on('error', (error) => { reject(error); });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

export function httpPost(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: parseInt(urlObj.port) || 80,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
    };

    const req = http.request(options, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        resolve({ status: response.statusCode || 500, data });
      });
    });

    req.on('error', (error) => { reject(error); });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(body);
    req.end();
  });
}

export function httpDelete(url: string, headers: Record<string, string>): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: parseInt(urlObj.port) || 80,
      path: urlObj.pathname + urlObj.search,
      method: 'DELETE',
      headers: headers
    };

    const req = http.request(options, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        resolve({ status: response.statusCode || 500, data });
      });
    });

    req.on('error', (error) => { reject(error); });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

// Create Express app
export function createApp(config: AppConfig, options?: { skipRateLimit?: boolean }) {
  const dbOps = createDbOps(config.jwtSecret);
  const googleClient = new OAuth2Client(config.googleClientId);

  const app = express();

  // Trust proxy
  app.set('trust proxy', 1);

  // Security middleware
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", "https://accounts.google.com", "https://apis.google.com", "https://www.gstatic.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://accounts.google.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:", "blob:"],
        connectSrc: [
          "'self'",
          // Google OAuth
          "https://accounts.google.com",
          "https://oauth2.googleapis.com",
          "https://www.googleapis.com",
          // IPFS/S3
          "https://ipfs.cloud.fx.land",
          "https://s3.cloud.fx.land",
          // Blockchain RPC endpoints
          "https://mainnet.base.org",
          "https://*.base.org",
          "https://eth.llamarpc.com",
          "https://*.ethereum.org",
          "https://mainnet.skalenodes.com",
          "https://*.skalenodes.com",
          // Wallet connectors
          "https://*.walletconnect.com",
          "https://*.walletconnect.org",
          "wss://*.walletconnect.com",
          "wss://*.walletconnect.org",
          "https://cca-lite.coinbase.com",
          "https://*.coinbase.com",
          // Relay for WalletConnect
          "wss://relay.walletconnect.com",
          "wss://relay.walletconnect.org",
          // RainbowKit
          "https://api.rainbow.me",
          "https://*.rainbow.me",
          // Web3Modal / Reown (WalletConnect v2)
          "https://api.web3modal.org",
          "https://*.web3modal.org",
          "https://api.web3modal.com",
          "https://*.web3modal.com",
          "https://*.reown.com",
          "wss://*.reown.com",
          // Phantom wallet
          "https://api.phantom.app",
          "https://*.phantom.app",
          "https://phantom.app",
          // Solana (for Phantom)
          "https://*.solana.com",
          "wss://*.solana.com",
        ],
        frameSrc: ["'self'", "blob:", "https://accounts.google.com", "https://*.phantom.app", "https://verify.walletconnect.org", "https://verify.walletconnect.com", "https://*.walletconnect.org", "https://*.walletconnect.com"],
        objectSrc: ["'self'", "blob:"],
        mediaSrc: ["'self'", "blob:"],
        frameAncestors: ["'self'"],
      },
    },
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  }));

  app.use(cors({
    origin: config.nodeEnv === 'production' ? false : ['http://localhost:5173', 'http://localhost:3001'],
    credentials: true,
  }));

  app.use(express.json());
  app.use(cookieParser());

  // Rate limiting (skip in tests)
  if (!options?.skipRateLimit) {
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
    });
    app.use('/api/', limiter);
  }

  // Session middleware
  app.use(session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: config.nodeEnv === 'production',
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    },
  }));

  // Auth middleware (session-based for web UI)
  function requireAuth(req: Request, res: Response, next: NextFunction) {
    if (!req.session.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  }

  // API token auth middleware (Bearer token for external apps)
  // Looks up token in api_keys table - same approach as Go pinning service
  async function requireApiAuth(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.substring(7);

    // Lookup token in api_keys table (same token stored when user creates API key)
    try {
      const userEmail = await verifyApiKey(token);

      if (!userEmail) {
        return res.status(401).json({ error: 'Invalid or revoked API key' });
      }

      req.apiUser = { email: userEmail };
      next();
    } catch (error) {
      console.error('[webui] API key verification error:', error);
      return res.status(401).json({ error: 'Invalid or revoked API key' });
    }
  }

  // Auth routes
  app.post('/auth/google', async (req: Request, res: Response) => {
    try {
      const { credential, referralCode } = req.body;

      if (!credential) {
        return res.status(400).json({ error: 'Missing credential' });
      }

      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: config.googleClientId,
      });

      const payload = ticket.getPayload();
      if (!payload || !payload.email) {
        return res.status(400).json({ error: 'Invalid token' });
      }

      const { sub, email, name, picture } = payload;
      if (!sub) {
        return res.status(400).json({ error: 'Invalid token: missing user ID' });
      }

      const user = await dbOps.getOrCreateUser(email, name || '', picture || '', referralCode || undefined);

      req.session.user = {
        id: sub,
        email: email,
        name: name || '',
        picture: picture || '',
      };

      res.json({
        success: true,
        user: req.session.user,
        isNew: user.isNew,
      });
    } catch (error) {
      console.error('[webui] Google auth error:', error);
      res.status(401).json({ error: 'Authentication failed' });
    }
  });

  app.post('/auth/logout', (req: Request, res: Response) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: 'Logout failed' });
      }
      res.clearCookie('connect.sid');
      res.json({ success: true });
    });
  });

  app.get('/auth/me', (req: Request, res: Response) => {
    if (req.session.user) {
      res.json({ user: req.session.user });
    } else {
      res.status(401).json({ error: 'Not authenticated' });
    }
  });

  // API routes
  app.get('/api/keys', requireAuth, async (req: Request, res: Response) => {
    try {
      const keys = await dbOps.getApiKeys(req.session.user!.email);
      res.json({ keys });
    } catch (error) {
      console.error('[webui] Error fetching API keys:', error);
      res.status(500).json({ error: 'Failed to fetch API keys' });
    }
  });

  app.post('/api/keys', requireAuth, async (req: Request, res: Response) => {
    try {
      const keyId = await dbOps.createApiKey(req.session.user!.email);
      res.json({ keyId });
    } catch (error) {
      console.error('[webui] Error creating API key:', error);
      res.status(500).json({ error: 'Failed to create API key' });
    }
  });

  app.delete('/api/keys/:keyId', requireAuth, async (req: Request, res: Response) => {
    try {
      const { keyId } = req.params;
      const success = await dbOps.deleteApiKey(req.session.user!.email, keyId);

      if (!success) {
        return res.status(404).json({ error: 'API key not found' });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('[webui] Error deleting API key:', error);
      res.status(500).json({ error: 'Failed to delete API key' });
    }
  });

  app.get('/api/keys/active', requireAuth, async (req: Request, res: Response) => {
    try {
      const email = req.session.user!.email;
      let keys = await dbOps.getApiKeys(email);

      if (!keys || keys.length === 0) {
        const newKeyId = await dbOps.createApiKey(email);
        keys = [{ key_id: newKeyId, created_at: new Date().toISOString(), last_used_at: null }];
      }

      res.json({ key: keys[0].key_id });
    } catch (error) {
      console.error('[webui] Error getting active API key:', error);
      res.status(500).json({ error: 'Failed to get API key' });
    }
  });

  app.get('/api/pins', requireAuth, async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const search = req.query.search as string | undefined;

      const { pins, total } = await dbOps.getUserPins(req.session.user!.email, page, limit, search);
      res.json({ pins, total, page, limit, totalPages: Math.ceil(total / limit) });
    } catch (error) {
      console.error('[webui] Error fetching pins:', error);
      res.status(500).json({ error: 'Failed to fetch pins' });
    }
  });

  app.post('/api/pins', requireAuth, async (req: Request, res: Response) => {
    try {
      const { cid, name } = req.body;

      if (!cid) {
        return res.status(400).json({ error: 'CID is required' });
      }

      if (!/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/i.test(cid)) {
        return res.status(400).json({ error: 'Invalid CID format' });
      }

      const keys = await dbOps.getApiKeys(req.session.user!.email);
      if (!keys || keys.length === 0) {
        return res.status(400).json({ error: 'No API key found. Please create an API key first.' });
      }

      const fullUrl = 'http://127.0.0.1:6000/pins';
      console.log(`[webui] Adding pin ${cid} via pinning service`);

      const response = await httpPost(fullUrl,
        { 'Authorization': `Bearer ${keys[0].key_id}`, 'Content-Type': 'application/json' },
        JSON.stringify({ cid, name: name || '' })
      );

      if (response.status !== 200 && response.status !== 202) {
        console.error('[webui] Error adding pin:', response.status, response.data);
        return res.status(response.status).json({ error: 'Failed to add pin' });
      }

      const pinData = JSON.parse(response.data);
      res.json({
        requestId: pinData.requestid,
        cid: pinData.pin?.cid || cid,
        status: pinData.status || 'queued'
      });
    } catch (error) {
      console.error('[webui] Error adding pin:', error);
      res.status(500).json({ error: 'Failed to add pin' });
    }
  });

  app.post('/api/pins/bulk-unpin', requireAuth, async (req: Request, res: Response) => {
    try {
      const { requestIds } = req.body;

      if (!requestIds || !Array.isArray(requestIds) || requestIds.length === 0) {
        return res.status(400).json({ error: 'requestIds array is required' });
      }

      const keys = await dbOps.getApiKeys(req.session.user!.email);
      if (!keys || keys.length === 0) {
        return res.status(400).json({ error: 'No API key found. Please create an API key first.' });
      }

      console.log(`[webui] Bulk unpinning ${requestIds.length} pins`);

      const results: { requestId: string; success: boolean; error?: string }[] = [];

      for (const requestId of requestIds) {
        try {
          const fullUrl = `http://127.0.0.1:6000/pins/${requestId}`;
          const response = await httpDelete(fullUrl, {
            'Authorization': `Bearer ${keys[0].key_id}`
          });

          if (response.status === 200 || response.status === 202 || response.status === 204) {
            results.push({ requestId, success: true });
          } else {
            console.error(`[webui] Failed to unpin ${requestId}:`, response.status, response.data);
            results.push({ requestId, success: false, error: 'Failed to unpin' });
          }
        } catch (err) {
          console.error(`[webui] Error unpinning ${requestId}:`, err);
          results.push({ requestId, success: false, error: 'Request failed' });
        }
      }

      const successCount = results.filter(r => r.success).length;
      console.log(`[webui] Bulk unpin complete: ${successCount}/${requestIds.length} successful`);

      res.json({
        success: true,
        results,
        summary: { total: requestIds.length, successful: successCount, failed: requestIds.length - successCount }
      });
    } catch (error) {
      console.error('[webui] Error in bulk unpin:', error);
      res.status(500).json({ error: 'Failed to unpin' });
    }
  });

  app.post('/api/pins/:requestId/refresh', requireAuth, async (req: Request, res: Response) => {
    try {
      const { requestId } = req.params;

      const keys = await dbOps.getApiKeys(req.session.user!.email);
      if (!keys || keys.length === 0) {
        return res.status(400).json({ error: 'No API key found. Please create an API key first.' });
      }

      const fullUrl = `http://127.0.0.1:6000/pins/${requestId}`;
      console.log(`[webui] Refreshing pin ${requestId} via ${fullUrl} (key: ${keys[0].key_id?.substring(0, 8)}...)`);

      const response = await httpGet(fullUrl, {
        'Authorization': `Bearer ${keys[0].key_id}`
      });

      if (response.status !== 200) {
        console.error('[webui] Error refreshing pin:', response.status, response.data);
        return res.status(response.status).json({ error: 'Failed to refresh pin status' });
      }

      const pinData = JSON.parse(response.data);

      res.json({
        request_id: pinData.requestid,
        status: pinData.status,
        cid: pinData.pin?.cid,
        name: pinData.pin?.name,
        size: pinData.info?.size || 0,
        refreshed: true
      });
    } catch (error) {
      console.error('[webui] Error refreshing pin:', error);
      res.status(500).json({ error: 'Failed to refresh pin status' });
    }
  });

  app.get('/api/pins/:requestId/nodes', requireAuth, async (req: Request, res: Response) => {
    try {
      const { requestId } = req.params;

      const keys = await dbOps.getApiKeys(req.session.user!.email);
      if (!keys || keys.length === 0) {
        return res.status(400).json({ error: 'No API key found. Please create an API key first.' });
      }

      const fullUrl = `http://127.0.0.1:6000/pins/${requestId}/nodes`;
      console.log(`[webui] Getting pin nodes for ${requestId} via ${fullUrl}`);

      // Use longer timeout (30s) as cluster may need time to query all peers
      const response = await httpGet(fullUrl, {
        'Authorization': `Bearer ${keys[0].key_id}`
      }, 30000);

      if (response.status !== 200) {
        console.error('[webui] Error getting pin nodes:', response.status, response.data);
        return res.status(response.status).json({ error: 'Failed to get pin nodes' });
      }

      const nodesData = JSON.parse(response.data);
      res.json(nodesData);
    } catch (error) {
      console.error('[webui] Error getting pin nodes:', error);
      res.status(500).json({ error: 'Failed to get pin nodes' });
    }
  });

  app.get('/api/stats', requireAuth, async (req: Request, res: Response) => {
    try {
      const stats = await dbOps.getUserStats(req.session.user!.email);
      res.json(stats);
    } catch (error) {
      console.error('[webui] Error fetching stats:', error);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  app.delete('/api/profile', requireAuth, async (req: Request, res: Response) => {
    try {
      const { confirmation } = req.body;

      if (confirmation !== 'delete') {
        return res.status(400).json({ error: 'Please type "delete" to confirm' });
      }

      await dbOps.deleteUserProfile(req.session.user!.email);

      req.session.destroy((err) => {
        if (err) {
          console.error('[webui] Session destroy error:', err);
        }
        res.clearCookie('connect.sid');
        res.json({ success: true });
      });
    } catch (error) {
      console.error('[webui] Error deleting profile:', error);
      res.status(500).json({ error: 'Failed to delete profile' });
    }
  });

  // ============ Shares and Playlists Endpoints ============
  // Server proxies S3 bucket requests, returns encrypted data for client-side decryption
  // Same pattern as file downloads: fetch encrypted → client decrypts

  const S3_GATEWAY = 'https://ipfs.cloud.fx.land';

  // Get shares with me (items others have shared with the current user)
  // Note: Accepted shares are stored on device only, not in cloud
  app.get('/api/shares/with-me', requireAuth, async (_req: Request, res: Response) => {
    return res.json({
      shares: [],
      note: 'Accepted shares are stored on device only. Use share links to access shared content.'
    });
  });

  // Get shares by me - fetch encrypted file from S3, return for client-side decryption
  // Path: fula-metadata/.fula/shares/{hashedUserId}.json.enc
  // Client provides hashedUserId (derived from public key)
  app.get('/api/shares/by-me', requireAuth, async (req: Request, res: Response) => {
    try {
      const { hashedUserId } = req.query;

      if (!hashedUserId || typeof hashedUserId !== 'string') {
        return res.status(400).json({ error: 'hashedUserId query parameter required' });
      }

      const sharesUrl = `${S3_GATEWAY}/fula-metadata/.fula/shares/${hashedUserId}.json.enc`;
      console.log('[webui] Fetching shares from:', sharesUrl);

      const response = await fetch(sharesUrl);
      console.log('[webui] Shares response status:', response.status);

      if (response.status === 404) {
        return res.json({ encryptedData: null });
      }

      if (!response.ok) {
        console.error('[webui] S3 error:', response.status);
        return res.json({ encryptedData: null });
      }

      const encryptedData = Buffer.from(await response.arrayBuffer());
      console.log('[webui] Fetched encrypted shares, size:', encryptedData.length);

      // Return as base64 for client-side decryption
      return res.json({ encryptedData: encryptedData.toString('base64') });
    } catch (error) {
      console.error('[webui] Error in shares/by-me:', error);
      res.status(500).json({ error: 'Failed to fetch shares' });
    }
  });

  // Get user playlists - fetch encrypted file from S3
  // Path: playlists/user-playlists/{playlistId}.json
  // Client provides playlistId
  app.get('/api/playlists', requireAuth, async (req: Request, res: Response) => {
    try {
      const { playlistId } = req.query;

      if (!playlistId || typeof playlistId !== 'string') {
        return res.status(400).json({ error: 'playlistId query parameter required' });
      }
      console.log('[webui] Fetching encrypted playlist:', playlistId);

      const playlistUrl = `${S3_GATEWAY}/playlists/user-playlists/${playlistId}.json`;
      console.log('[webui] Fetching playlist from:', playlistUrl);

      const response = await fetch(playlistUrl);
      console.log('[webui] Playlist response status:', response.status);

      if (response.status === 404) {
        return res.json({ encryptedData: null });
      }

      if (!response.ok) {
        console.error('[webui] S3 error:', response.status);
        return res.json({ encryptedData: null });
      }

      const encryptedData = Buffer.from(await response.arrayBuffer());
      console.log('[webui] Fetched encrypted playlist, size:', encryptedData.length);

      // Return as base64 for client-side decryption
      return res.json({ encryptedData: encryptedData.toString('base64') });
    } catch (error) {
      console.error('[webui] Error in playlists:', error);
      res.status(500).json({ error: 'Failed to fetch playlist' });
    }
  });

  // Get single playlist by ID
  app.get('/api/playlists/:playlistId', requireAuth, async (req: Request, res: Response) => {
    try {
      const { playlistId } = req.params;
      const keys = await dbOps.getApiKeys(req.session.user!.email);
      if (!keys || keys.length === 0) {
        return res.status(400).json({ error: 'No API key found' });
      }

      const fulaApiUrl = `http://127.0.0.1:6000/playlists/${playlistId}`;

      try {
        const response = await httpGet(fulaApiUrl, {
          'Authorization': `Bearer ${keys[0].key_id}`
        });

        if (response.status === 200) {
          const data = JSON.parse(response.data);
          return res.json({ playlist: data });
        } else if (response.status === 404) {
          return res.status(404).json({ error: 'Playlist not found' });
        } else {
          return res.status(response.status).json({ error: 'Failed to fetch playlist' });
        }
      } catch (apiError) {
        console.warn('[webui] Fula API not available for playlist:', apiError);
        return res.status(404).json({ error: 'Playlist not found' });
      }
    } catch (error) {
      console.error('[webui] Error fetching playlist:', error);
      res.status(500).json({ error: 'Failed to fetch playlist' });
    }
  });

  // Revoke a share
  app.delete('/api/shares/:shareId', requireAuth, async (req: Request, res: Response) => {
    try {
      const { shareId } = req.params;
      const keys = await dbOps.getApiKeys(req.session.user!.email);
      if (!keys || keys.length === 0) {
        return res.status(400).json({ error: 'No API key found' });
      }

      const fulaApiUrl = `http://127.0.0.1:6000/shares/${shareId}`;

      try {
        const response = await httpDelete(fulaApiUrl, {
          'Authorization': `Bearer ${keys[0].key_id}`
        });

        if (response.status === 200 || response.status === 204) {
          return res.json({ success: true });
        } else if (response.status === 404) {
          return res.status(404).json({ error: 'Share not found' });
        } else {
          return res.status(response.status).json({ error: 'Failed to revoke share' });
        }
      } catch (apiError) {
        console.warn('[webui] Fula API not available for share deletion:', apiError);
        return res.status(500).json({ error: 'Failed to revoke share' });
      }
    } catch (error) {
      console.error('[webui] Error revoking share:', error);
      res.status(500).json({ error: 'Failed to revoke share' });
    }
  });

  // Fetch shared content (public - no auth required)
  // This proxies content requests for public share links
  app.get('/api/share/:shareId/content', async (req: Request, res: Response) => {
    try {
      const { shareId } = req.params;
      const { bucket, path } = req.query;

      if (!bucket || !path) {
        return res.status(400).json({ error: 'Missing bucket or path parameter' });
      }

      // Validate shareId format (UUID)
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(shareId)) {
        return res.status(400).json({ error: 'Invalid share ID format' });
      }

      console.log('[webui] Fetching share content for:', shareId, 'bucket:', bucket, 'path:', path);

      // Step 1: Get the share metadata to find the CID
      // Try Fula API first to get share info
      try {
        const shareInfoUrl = `http://127.0.0.1:6000/shares/${shareId}`;
        const shareInfoResponse = await httpGet(shareInfoUrl, {});

        if (shareInfoResponse.status === 200) {
          const shareData = typeof shareInfoResponse.data === 'string' ? JSON.parse(shareInfoResponse.data) : shareInfoResponse.data;
          if (shareData?.cid) {
            const cid = shareData.cid;
            console.log('[webui] Found CID from share metadata:', cid);

            // Fetch content by CID from IPFS gateway
            const gatewayUrl = `https://ipfs.cloud.fx.land/gateway/${cid}`;
            console.log('[webui] Fetching from gateway:', gatewayUrl);

            const contentResponse = await fetch(gatewayUrl);

            if (contentResponse.ok) {
              const buffer = Buffer.from(await contentResponse.arrayBuffer());
              res.setHeader('Content-Type', 'application/octet-stream');
              return res.send(buffer);
            } else {
              console.error('[webui] Gateway fetch failed:', contentResponse.status);
              return res.status(contentResponse.status).json({ error: 'Content not found on gateway' });
            }
          }
        } else if (shareInfoResponse.status === 404) {
          return res.status(404).json({ error: 'Share not found' });
        } else if (shareInfoResponse.status === 403) {
          return res.status(403).json({ error: 'Share has been revoked' });
        }
      } catch (apiError) {
        console.warn('[webui] Fula API not available:', apiError);
      }

      // Fallback: Try to fetch directly from IPFS gateway using bucket/path
      // This works if the Fula gateway supports bucket/path format
      const sanitizedPath = (path as string).startsWith('/') ? (path as string).slice(1) : path;
      const fallbackUrl = `https://ipfs.cloud.fx.land/gateway/${bucket}/${sanitizedPath}`;
      console.log('[webui] Trying fallback gateway URL:', fallbackUrl);

      try {
        const fallbackResponse = await fetch(fallbackUrl);

        if (fallbackResponse.ok) {
          const buffer = Buffer.from(await fallbackResponse.arrayBuffer());
          res.setHeader('Content-Type', 'application/octet-stream');
          return res.send(buffer);
        } else {
          console.error('[webui] Fallback fetch failed:', fallbackResponse.status);
          return res.status(fallbackResponse.status).json({ error: 'Content not found' });
        }
      } catch (fetchError) {
        console.error('[webui] Fallback fetch error:', fetchError);
        return res.status(500).json({ error: 'Failed to fetch content' });
      }
    } catch (error) {
      console.error('[webui] Error fetching shared content:', error);
      res.status(500).json({ error: 'Failed to fetch shared content' });
    }
  });

  // V2 Share fetch - proxies to internal S3 for encrypted content
  // Client decrypts using fula_client after receiving encrypted bytes
  //
  // Route format: /api/share/v2/fetch/:bucket/:storageKey
  // - :bucket = bucket name
  // - :storageKey = IPFS CID to fetch from S3 (same as token.path_scope)
  //
  // fula_client builds URL as: {endpoint}/{bucket}/{storageKey}
  app.get('/api/share/v2/fetch/:bucket/:storageKey', async (req: Request, res: Response) => {
    try {
      const { bucket, storageKey } = req.params;

      if (!bucket || !storageKey) {
        return res.status(400).json({ error: 'Missing bucket or storageKey parameter' });
      }

      // Validate bucket and storageKey (alphanumeric, underscores, hyphens, dots)
      const safePattern = /^[a-zA-Z0-9_\-\.]+$/;
      if (!safePattern.test(bucket) || !safePattern.test(storageKey)) {
        return res.status(400).json({ error: 'Invalid bucket or storageKey format' });
      }

      const s3Jwt = config.s3AdminJwt;
      if (!s3Jwt) {
        console.error('[webui] S3_ADMIN_JWT not configured');
        return res.status(500).json({ error: 'Share fetch not configured' });
      }

      const s3BaseUrl = config.s3InternalUrl || 'http://127.0.0.1:9000';
      const fetchUrl = `${s3BaseUrl}/admin/fetch/${bucket}/${storageKey}`;

      console.log('[webui] V2 share fetch:', { bucket, storageKey, url: fetchUrl });

      const s3Response = await fetch(fetchUrl, {
        headers: {
          'Authorization': `Bearer ${s3Jwt}`,
        },
      });

      if (!s3Response.ok) {
        console.error('[webui] S3 fetch failed:', s3Response.status, await s3Response.text());
        return res.status(s3Response.status).json({
          error: s3Response.status === 404 ? 'Content not found' : 'Failed to fetch content'
        });
      }

      const buffer = Buffer.from(await s3Response.arrayBuffer());

      // Pass through content type if available
      const contentType = s3Response.headers.get('content-type') || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', buffer.length);

      return res.send(buffer);
    } catch (error) {
      console.error('[webui] Error in v2 share fetch:', error);
      res.status(500).json({ error: 'Failed to fetch shared content' });
    }
  });

  // Health check
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Public stats (no auth required)
  app.get('/api/public/stats', async (_req: Request, res: Response) => {
    try {
      const result = await query(`
        SELECT
          COUNT(*) as total_pins,
          COALESCE(SUM(size), 0) as total_size,
          COUNT(DISTINCT username) as total_users
        FROM pins
        WHERE status != 'deleted'
      `);
      const stats = result.rows[0];

      res.json({
        totalPins: parseInt(stats?.total_pins || '0', 10),
        totalSize: parseInt(stats?.total_size || '0', 10),
        totalUsers: parseInt(stats?.total_users || '0', 10),
      });
    } catch (error) {
      console.error('[webui] Error fetching public stats:', error);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // ============ Web3 Payment / Credits API Endpoints ============

  // Get credit status (balance, usage, can upload)
  app.get('/api/credits', requireAuth, async (req: Request, res: Response) => {
    try {
      const status = await getUserCreditStatus(req.session.user!.email);
      res.json(status);
    } catch (error) {
      console.error('[webui] Error getting credit status:', error);
      res.status(500).json({ error: 'Failed to get credit status' });
    }
  });

  // Get credit history
  app.get('/api/credits/history', requireAuth, async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const history = await getCreditHistory(req.session.user!.email, Math.min(limit, 100));
      res.json({ history });
    } catch (error) {
      console.error('[webui] Error getting credit history:', error);
      res.status(500).json({ error: 'Failed to get credit history' });
    }
  });

  // Manual transaction claim
  app.post('/api/credits/claim', requireAuth, async (req: Request, res: Response) => {
    try {
      const { txHash, chainId } = req.body;

      if (!txHash || !chainId) {
        return res.status(400).json({ error: 'txHash and chainId are required' });
      }

      // Validate tx hash format
      if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
        return res.status(400).json({ error: 'Invalid transaction hash format' });
      }

      // Check if already claimed
      const existingResult = await query<{ user_email: string | null; claimed_at: string | null }>(
        `SELECT user_email, claimed_at FROM token_transactions
         WHERE tx_hash = $1 AND chain_id = $2`,
        [txHash.toLowerCase(), chainId]
      );
      const existing = existingResult.rows[0];

      if (existing?.claimed_at) {
        return res.status(400).json({ error: 'This transaction has already been credited' });
      }

      // Get chain config
      const chainResult = await query<{ token_address: string; vault_address: string }>(
        `SELECT token_address, vault_address FROM chain_sync_state
         WHERE chain_id = $1 AND is_enabled = 1`,
        [chainId]
      );
      const chain = chainResult.rows[0];

      if (!chain) {
        return res.status(400).json({ error: 'Unsupported or disabled chain' });
      }

      // Fetch transaction from blockchain explorer
      let explorerUrl: string;
      switch (chainId) {
        case 1:
          explorerUrl = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${process.env.ETHERSCAN_API_KEY || ''}`;
          break;
        case 8453:
          explorerUrl = `https://api.etherscan.io/v2/api?chainid=8453&module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${process.env.ETHERSCAN_API_KEY || ''}`;
          break;
        case 2046399126:
          explorerUrl = `https://elated-tan-skat.explorer.mainnet.skalenodes.com/api?module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}`;
          break;
        default:
          return res.status(400).json({ error: 'Unsupported chain' });
      }

      // Retry logic - transaction may not be indexed immediately
      let data: any = null;
      let retries = 3;
      while (retries > 0) {
        const response = await fetch(explorerUrl);
        data = await response.json();

        if (data.result && data.result !== null && data.result.logs) {
          break; // Got valid result with logs
        }

        retries--;
        if (retries > 0) {
          console.log(`[claim] Transaction ${txHash} not ready, retrying in 3s... (${retries} left)`);
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      if (!data?.result || data.result === null) {
        console.log(`[claim] Transaction ${txHash} not found. API response:`, JSON.stringify(data));
        return res.status(404).json({ error: 'Transaction not found or not confirmed. Please try again in a few seconds.' });
      }

      // Parse token transfer from logs
      const receipt = data.result;
      const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)
      const tokenAddressLower = chain.token_address.toLowerCase();
      const vaultAddressLower = chain.vault_address.toLowerCase();

      console.log(`[claim] Looking for FULA transfer: token=${tokenAddressLower}, vault=${vaultAddressLower}`);
      console.log(`[claim] Transaction has ${receipt.logs?.length || 0} logs`);

      let transferFound = false;
      let fromAddress = '';
      let amountRaw = '0';

      for (const log of receipt.logs || []) {
        const logAddress = log.address.toLowerCase();
        if (logAddress !== tokenAddressLower) {
          console.log(`[claim] Log address ${logAddress} != token ${tokenAddressLower}`);
          continue;
        }
        if (log.topics[0] !== transferTopic) {
          console.log(`[claim] Log topic ${log.topics[0]} != Transfer topic`);
          continue;
        }

        const to = '0x' + log.topics[2].slice(26).toLowerCase();
        console.log(`[claim] Transfer to: ${to}, vault: ${vaultAddressLower}`);
        if (to !== vaultAddressLower) {
          console.log(`[claim] Transfer destination ${to} != vault ${vaultAddressLower}`);
          continue;
        }

        fromAddress = '0x' + log.topics[1].slice(26).toLowerCase();
        amountRaw = BigInt(log.data).toString();
        transferFound = true;
        console.log(`[claim] Found valid transfer: from=${fromAddress}, amount=${amountRaw}`);
        break;
      }

      if (!transferFound) {
        console.log(`[claim] No FULA transfer found in tx ${txHash}. Logs:`, JSON.stringify(receipt.logs || []));
        return res.status(400).json({ error: 'No FULA transfer to vault found in this transaction' });
      }

      const amountFula = rawToFula(amountRaw);
      if (amountFula < 0.001) {
        return res.status(400).json({ error: 'Transfer amount too small' });
      }

      // Check if user has this wallet linked
      const userEmail = req.session.user!.email;
      const walletResult = await query<{ count: string }>(
        `SELECT 1 FROM user_wallets
         WHERE user_email = $1 AND wallet_address = $2 AND is_verified = 1`,
        [userEmail, fromAddress]
      );

      if (!walletResult.rows[0]) {
        return res.status(400).json({
          error: 'Wallet not linked to your account',
          message: `Please link wallet ${fromAddress} to your account first`,
        });
      }

      // Insert or update transaction
      if (existing) {
        // Transaction exists but unclaimed - claim it
        await query(
          `UPDATE token_transactions
           SET user_email = $1, claimed_at = NOW(), ingestion_source = 'manual'
           WHERE tx_hash = $2 AND chain_id = $3`,
          [userEmail, txHash.toLowerCase(), chainId]
        );
      } else {
        // Insert new transaction
        await query(
          `INSERT INTO token_transactions
             (tx_hash, chain_id, from_address, to_address, amount_raw, amount_fula, block_number, block_timestamp, user_email, claimed_at, ingestion_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), 'manual')`,
          [
            txHash.toLowerCase(),
            chainId,
            fromAddress,
            vaultAddressLower,
            amountRaw,
            amountFula,
            parseInt(receipt.blockNumber, 16),
            Math.floor(Date.now() / 1000),
            userEmail
          ]
        );
      }

      // Credit the user
      await creditUser(userEmail, amountFula, `${chainId}:${txHash}`);

      console.log(`[webui] Manual claim: credited ${amountFula} FULA to ${userEmail} from tx ${txHash}`);

      const newStatus = await getUserCreditStatus(userEmail);
      res.json({
        success: true,
        amountFula,
        newBalance: newStatus.balanceFula,
      });
    } catch (error) {
      console.error('[webui] Error claiming transaction:', error);
      res.status(500).json({ error: 'Failed to claim transaction' });
    }
  });

  // Get user's linked wallets
  app.get('/api/wallets', requireAuth, async (req: Request, res: Response) => {
    try {
      const wallets = await getUserWallets(req.session.user!.email);
      const chains = await getSupportedChains();
      res.json({ wallets, supportedChains: chains });
    } catch (error) {
      console.error('[webui] Error getting wallets:', error);
      res.status(500).json({ error: 'Failed to get wallets' });
    }
  });

  // Connect/link a wallet (with signature verification)
  app.post('/api/wallets/connect', requireAuth, async (req: Request, res: Response) => {
    try {
      const { address, chainId, signature, message } = req.body;

      if (!address || !chainId || !signature || !message) {
        return res.status(400).json({ error: 'address, chainId, signature, and message are required' });
      }

      // Validate address format
      if (!/^0x[a-fA-F0-9]{40}$/i.test(address)) {
        return res.status(400).json({ error: 'Invalid wallet address format' });
      }

      const normalizedAddress = address.toLowerCase();
      const userEmail = req.session.user!.email;

      // Verify the message contains user email and wallet address (prevents replay attacks)
      if (!message.includes(userEmail) || !message.toLowerCase().includes(normalizedAddress)) {
        return res.status(400).json({ error: 'Invalid signature message - must include your email and wallet address' });
      }

      // Verify signature format
      if (!/^0x[a-fA-F0-9]+$/.test(signature)) {
        return res.status(400).json({ error: 'Invalid signature format' });
      }

      // Verify the signature using viem
      try {
        const { verifyMessage } = await import('viem');
        const { recoverMessageAddress } = await import('viem');

        const recoveredAddress = await recoverMessageAddress({
          message,
          signature: signature as `0x${string}`,
        });

        if (recoveredAddress.toLowerCase() !== normalizedAddress) {
          return res.status(400).json({ error: 'Signature verification failed - address mismatch' });
        }
      } catch (sigError) {
        console.error('[webui] Signature verification error:', sigError);
        return res.status(400).json({ error: 'Invalid signature' });
      }

      // Check if this wallet is already linked to a DIFFERENT user
      const existingLinkResult = await query<{ user_email: string }>(
        `SELECT user_email FROM user_wallets WHERE wallet_address = $1 AND is_verified = 1`,
        [normalizedAddress]
      );
      const existingLink = existingLinkResult.rows[0];

      if (existingLink && existingLink.user_email !== userEmail) {
        return res.status(400).json({
          error: 'Wallet already linked to another account',
          message: 'This wallet is already verified and linked to a different user account.',
        });
      }

      // Check if chain is supported
      const chainResult = await query('SELECT 1 FROM chain_sync_state WHERE chain_id = $1 AND is_enabled = 1', [chainId]);
      if (chainResult.rows.length === 0) {
        return res.status(400).json({ error: 'Unsupported or disabled chain' });
      }

      // Link the wallet (verified)
      await linkWallet(userEmail, normalizedAddress, chainId, true);

      console.log(`[webui] Wallet ${normalizedAddress} linked to ${userEmail} on chain ${chainId} (signature verified)`);

      res.json({ success: true, address: normalizedAddress, chainId });
    } catch (error) {
      console.error('[webui] Error connecting wallet:', error);
      res.status(500).json({ error: 'Failed to connect wallet' });
    }
  });

  // Disconnect/unlink a wallet
  app.delete('/api/wallets/:address', requireAuth, async (req: Request, res: Response) => {
    try {
      const { address } = req.params;

      if (!address) {
        return res.status(400).json({ error: 'Wallet address is required' });
      }

      const success = await unlinkWallet(req.session.user!.email, address);

      if (!success) {
        return res.status(404).json({ error: 'Wallet not found' });
      }

      console.log(`[webui] Wallet ${address} unlinked from ${req.session.user!.email}`);

      res.json({ success: true });
    } catch (error) {
      console.error('[webui] Error disconnecting wallet:', error);
      res.status(500).json({ error: 'Failed to disconnect wallet' });
    }
  });

  // Get pricing info (public)
  app.get('/api/credits/pricing', async (_req: Request, res: Response) => {
    const chains = await getSupportedChains();
    res.json({
      freeTierBytes: FREE_TIER_BYTES,
      freeTierMB: Math.round(FREE_TIER_BYTES / (1024 * 1024)),
      fulaPerGBMonth: FULA_PER_GB_MONTH,
      chains: chains.filter(c => c.isEnabled),
    });
  });

  // ============ Referral Endpoints ============

  // Get user's referral info (code + stats)
  app.get('/api/referral', requireAuth, async (req: Request, res: Response) => {
    try {
      const email = req.session.user!.email;

      // Get or create referral code
      const codeResult = await query<{ code: string; created_at: string }>(
        'SELECT code, created_at FROM referral_codes WHERE user_email = $1',
        [email]
      );
      let codeRow = codeResult.rows[0];

      if (!codeRow) {
        // Generate code for existing users who don't have one
        let code = generateReferralCode();
        let exists = true;
        while (exists) {
          const checkResult = await query('SELECT 1 FROM referral_codes WHERE code = $1', [code]);
          if (checkResult.rows.length === 0) {
            exists = false;
          } else {
            code = generateReferralCode();
          }
        }
        await query('INSERT INTO referral_codes (user_email, code) VALUES ($1, $2)', [email, code]);
        codeRow = { code, created_at: new Date().toISOString() };
      }

      // Get referral stats with 3-level breakdown using recursive CTE
      const levelStatsResult = await query<{ level: number; count: string; credits: string }>(`
        WITH RECURSIVE referral_chain AS (
          SELECT referred_email, 1 as level
          FROM referrals WHERE referrer_email = $1
          UNION ALL
          SELECT r.referred_email, rc.level + 1
          FROM referrals r
          JOIN referral_chain rc ON r.referrer_email = rc.referred_email
          WHERE rc.level < 3
        )
        SELECT
          rc.level,
          COUNT(*)::text as count,
          COALESCE(SUM(uc.total_deposited_fula), 0)::text as credits
        FROM referral_chain rc
        LEFT JOIN user_credits uc ON rc.referred_email = uc.user_email
        GROUP BY rc.level
        ORDER BY rc.level
      `, [email]);
      const levelStats = levelStatsResult.rows;

      // Build stats object with level breakdown
      const stats = {
        level1: { count: 0, credits: 0 },
        level2: { count: 0, credits: 0 },
        level3: { count: 0, credits: 0 },
        total: { count: 0, credits: 0 },
      };

      for (const row of levelStats) {
        const count = parseInt(row.count, 10);
        const credits = parseFloat(row.credits);
        if (row.level === 1) {
          stats.level1 = { count, credits };
        } else if (row.level === 2) {
          stats.level2 = { count, credits };
        } else if (row.level === 3) {
          stats.level3 = { count, credits };
        }
        stats.total.count += count;
        stats.total.credits += credits;
      }

      res.json({
        code: codeRow.code,
        createdAt: codeRow.created_at,
        stats,
        // Keep legacy fields for backward compatibility
        totalReferred: stats.level1.count,
        totalCreditsFromReferrals: stats.total.credits,
      });
    } catch (error) {
      console.error('[webui] Error getting referral info:', error);
      res.status(500).json({ error: 'Failed to get referral info' });
    }
  });

  // Get list of users referred by current user (paginated)
  app.get('/api/referral/referred', requireAuth, async (req: Request, res: Response) => {
    try {
      const email = req.session.user!.email;
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const offset = (page - 1) * limit;

      const referredResult = await query<{
        referred_email: string;
        joined_at: string;
        total_credits_purchased: number;
        app_downloaded: number;
        app_downloaded_at: string | null;
      }>(`
        SELECT
          r.referred_email,
          wu.created_at as joined_at,
          COALESCE(uc.total_deposited_fula, 0) as total_credits_purchased,
          COALESCE(wu.app_downloaded, 0) as app_downloaded,
          wu.app_downloaded_at
        FROM referrals r
        JOIN webui_users wu ON r.referred_email = wu.email
        LEFT JOIN user_credits uc ON r.referred_email = uc.user_email
        WHERE r.referrer_email = $1
        ORDER BY r.referred_at DESC
        LIMIT $2 OFFSET $3
      `, [email, limit, offset]);
      const referred = referredResult.rows;

      const countResult = await query<{ total: string }>('SELECT COUNT(*)::text as total FROM referrals WHERE referrer_email = $1', [email]);
      const total = parseInt(countResult.rows[0]?.total || '0', 10);

      res.json({
        items: referred.map(r => ({
          email: maskEmail(r.referred_email),
          joinedAt: r.joined_at,
          totalCreditsPurchased: r.total_credits_purchased,
          appDownloaded: r.app_downloaded === 1,
          appDownloadedAt: r.app_downloaded_at,
        })),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      });
    } catch (error) {
      console.error('[webui] Error getting referred users:', error);
      res.status(500).json({ error: 'Failed to get referred users' });
    }
  });

  // Mark app as downloaded (called when user clicks download link)
  app.post('/api/user/app-downloaded', requireAuth, async (req: Request, res: Response) => {
    try {
      const email = req.session.user!.email;

      // Update the user's app_downloaded status
      await query(`
        UPDATE webui_users
        SET app_downloaded = 1, app_downloaded_at = NOW()
        WHERE email = $1 AND app_downloaded = 0
      `, [email]);

      res.json({ success: true });
    } catch (error) {
      console.error('[webui] Error marking app as downloaded:', error);
      res.status(500).json({ error: 'Failed to mark app as downloaded' });
    }
  });

  // Get referrals for a specific user (for multi-level lazy loading)
  // User can only view their own referral chain
  app.get('/api/referral/chain/:email', requireAuth, async (req: Request, res: Response) => {
    try {
      const currentUserEmail = req.session.user!.email;
      const targetEmail = decodeURIComponent(req.params.email);
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const offset = (page - 1) * limit;

      // Verify the target email is in the current user's referral chain (up to 3 levels)
      const isInChainResult = await query(`
        WITH RECURSIVE referral_chain AS (
          SELECT referred_email, 1 as level
          FROM referrals WHERE referrer_email = $1
          UNION ALL
          SELECT r.referred_email, rc.level + 1
          FROM referrals r
          JOIN referral_chain rc ON r.referrer_email = rc.referred_email
          WHERE rc.level < 3
        )
        SELECT 1 FROM referral_chain WHERE referred_email = $2
        UNION
        SELECT 1 WHERE $3 = $4
      `, [currentUserEmail, targetEmail, currentUserEmail, targetEmail]);

      if (isInChainResult.rows.length === 0) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const referredResult = await query<{
        referred_email: string;
        joined_at: string;
        total_credits_purchased: number;
        app_downloaded: number;
        app_downloaded_at: string | null;
        referral_count: string;
      }>(`
        SELECT
          r.referred_email,
          wu.created_at as joined_at,
          COALESCE(uc.total_deposited_fula, 0) as total_credits_purchased,
          COALESCE(wu.app_downloaded, 0) as app_downloaded,
          wu.app_downloaded_at,
          (SELECT COUNT(*)::text FROM referrals WHERE referrer_email = r.referred_email) as referral_count
        FROM referrals r
        JOIN webui_users wu ON r.referred_email = wu.email
        LEFT JOIN user_credits uc ON r.referred_email = uc.user_email
        WHERE r.referrer_email = $1
        ORDER BY r.referred_at DESC
        LIMIT $2 OFFSET $3
      `, [targetEmail, limit, offset]);
      const referred = referredResult.rows;

      const countResult = await query<{ total: string }>('SELECT COUNT(*)::text as total FROM referrals WHERE referrer_email = $1', [targetEmail]);
      const total = parseInt(countResult.rows[0]?.total || '0', 10);

      res.json({
        items: referred.map(r => ({
          email: maskEmail(r.referred_email),
          rawEmail: r.referred_email, // Needed for further chain lookups
          joinedAt: r.joined_at,
          totalCreditsPurchased: r.total_credits_purchased,
          appDownloaded: r.app_downloaded === 1,
          appDownloadedAt: r.app_downloaded_at,
          referralCount: parseInt(r.referral_count, 10),
        })),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      });
    } catch (error) {
      console.error('[webui] Error getting referral chain:', error);
      res.status(500).json({ error: 'Failed to get referral chain' });
    }
  });

  // ============ Admin Endpoints ============

  // Admin middleware
  function requireAdmin(req: Request, res: Response, next: NextFunction) {
    if (!req.session.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!isAdmin(req.session.user.email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  }

  // Admin OR System Key middleware (for x402 gateway integration)
  function requireAdminOrSystemKey(req: Request, res: Response, next: NextFunction) {
    // Check for system key in header
    const systemKeyHeader = req.header('X-System-Key');
    if (systemKeyHeader && config.systemKey && systemKeyHeader === config.systemKey) {
      // System key authentication - mark as system caller
      (req as any).isSystemCall = true;
      return next();
    }

    // Fall back to admin session authentication
    if (!req.session.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!isAdmin(req.session.user.email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  }

  // Get suspended users (admin only)
  app.get('/api/admin/suspended', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const users = await getSuspendedUsers();
      res.json({ users });
    } catch (error) {
      console.error('[webui] Error getting suspended users:', error);
      res.status(500).json({ error: 'Failed to get suspended users' });
    }
  });

  // Unsuspend a user (admin only)
  app.post('/api/admin/unsuspend', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }

      const success = await unsuspendUser(email);

      if (!success) {
        return res.status(404).json({ error: 'User not found or not suspended' });
      }

      console.log(`[webui] Admin ${req.session.user!.email} unsuspended ${email}`);

      res.json({ success: true });
    } catch (error) {
      console.error('[webui] Error unsuspending user:', error);
      res.status(500).json({ error: 'Failed to unsuspend user' });
    }
  });

  // Manual credit adjustment (admin or system key for x402 gateway)
  app.post('/api/admin/adjust', requireAdminOrSystemKey, async (req: Request, res: Response) => {
    try {
      const { email, amount, reason } = req.body;

      if (!email || amount === undefined || !reason) {
        return res.status(400).json({ error: 'email, amount, and reason are required' });
      }

      const numAmount = parseFloat(amount);
      if (isNaN(numAmount)) {
        return res.status(400).json({ error: 'Invalid amount' });
      }

      // Determine caller for audit log
      const isSystemCall = (req as any).isSystemCall;
      const caller = isSystemCall ? 'system:x402' : `admin:${req.session.user!.email}`;

      await creditUser(email, numAmount, `${caller}:${reason}`, 'adjustment');

      console.log(`[webui] ${caller} adjusted ${email} by ${numAmount} FULA: ${reason}`);

      const newStatus = await getUserCreditStatus(email);

      res.json({
        success: true,
        newBalance: newStatus.balanceFula,
        isSuspended: newStatus.isSuspended,
      });
    } catch (error) {
      console.error('[webui] Error adjusting credits:', error);
      res.status(500).json({ error: 'Failed to adjust credits' });
    }
  });

  // Check if current user is admin (for frontend)
  app.get('/api/admin/check', requireAuth, (req: Request, res: Response) => {
    if (isAdmin(req.session.user!.email)) {
      res.json({ isAdmin: true });
    } else {
      res.status(403).json({ isAdmin: false });
    }
  });

  // Get all referrers with stats (admin only, paginated)
  app.get('/api/admin/referrals', requireAdmin, async (req: Request, res: Response) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const offset = (page - 1) * limit;
      const includeZero = req.query.includeZero === 'true';

      // Get referrers with stats
      const referrersResult = await query<{
        email: string;
        code: string;
        codecreatedat: string;
        totalreferred: string;
        totalcreditsfromreferrals: string;
      }>(`
        SELECT
          rc.user_email as email,
          rc.code,
          rc.created_at as codeCreatedAt,
          COUNT(r.id)::text as totalReferred,
          COALESCE(SUM(uc.total_deposited_fula), 0)::text as totalCreditsFromReferrals
        FROM referral_codes rc
        LEFT JOIN referrals r ON rc.user_email = r.referrer_email
        LEFT JOIN user_credits uc ON r.referred_email = uc.user_email
        GROUP BY rc.user_email, rc.code, rc.created_at
        ${includeZero ? '' : 'HAVING COUNT(r.id) > 0'}
        ORDER BY COUNT(r.id) DESC, rc.created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]);
      const referrers = referrersResult.rows.map(r => ({
        email: r.email,
        code: r.code,
        codeCreatedAt: r.codecreatedat,
        totalReferred: parseInt(r.totalreferred, 10),
        totalCreditsFromReferrals: parseFloat(r.totalcreditsfromreferrals),
      }));

      // Get total count
      const countResult = await query<{ total: string }>(`
        SELECT COUNT(*)::text as total FROM (
          SELECT rc.user_email
          FROM referral_codes rc
          LEFT JOIN referrals r ON rc.user_email = r.referrer_email
          GROUP BY rc.user_email
          ${includeZero ? '' : 'HAVING COUNT(r.id) > 0'}
        ) subq
      `);
      const total = parseInt(countResult.rows[0]?.total || '0', 10);

      res.json({
        items: referrers,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      });
    } catch (error) {
      console.error('[webui] Error getting admin referrals:', error);
      res.status(500).json({ error: 'Failed to get referrals' });
    }
  });

  // Export all referral data as CSV (admin only) - MUST be before :email route
  app.get('/api/admin/referrals/export/csv', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const dataResult = await query<{
        referrer_email: string;
        referral_code: string;
        referred_email: string | null;
        referred_user_joined_at: string | null;
        referred_at: string | null;
        credits_purchased: number;
      }>(`
        SELECT
          rc.user_email as referrer_email,
          rc.code as referral_code,
          r.referred_email,
          wu.created_at as referred_user_joined_at,
          r.referred_at,
          COALESCE(uc.total_deposited_fula, 0) as credits_purchased
        FROM referral_codes rc
        LEFT JOIN referrals r ON rc.user_email = r.referrer_email
        LEFT JOIN webui_users wu ON r.referred_email = wu.email
        LEFT JOIN user_credits uc ON r.referred_email = uc.user_email
        ORDER BY rc.user_email, r.referred_at
      `);
      const data = dataResult.rows;

      // Generate CSV
      const headers = ['Referrer Email', 'Referral Code', 'Referred Email', 'Referred User Joined At', 'Referred At', 'Credits Purchased'];
      const csvRows = [headers.join(',')];

      for (const row of data) {
        csvRows.push([
          row.referrer_email,
          row.referral_code,
          row.referred_email || '',
          row.referred_user_joined_at || '',
          row.referred_at || '',
          row.credits_purchased || 0,
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
      }

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="referrals-${new Date().toISOString().split('T')[0]}.csv"`);
      res.send(csvRows.join('\n'));
    } catch (error) {
      console.error('[webui] Error exporting referrals:', error);
      res.status(500).json({ error: 'Failed to export referrals' });
    }
  });

  // Get referral chain for a specific user (admin only, for multi-level viewing)
  // MUST be before the :email route to avoid matching "chain" as an email
  app.get('/api/admin/referrals/chain/:email', requireAdmin, async (req: Request, res: Response) => {
    try {
      const targetEmail = decodeURIComponent(req.params.email);
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const offset = (page - 1) * limit;

      const referredResult = await query<{
        referred_email: string;
        joined_at: string;
        referred_at: string;
        total_credits_purchased: number;
        app_downloaded: number;
        app_downloaded_at: string | null;
        referral_count: string;
      }>(`
        SELECT
          r.referred_email,
          wu.created_at as joined_at,
          r.referred_at,
          COALESCE(uc.total_deposited_fula, 0) as total_credits_purchased,
          COALESCE(wu.app_downloaded, 0) as app_downloaded,
          wu.app_downloaded_at,
          (SELECT COUNT(*)::text FROM referrals WHERE referrer_email = r.referred_email) as referral_count
        FROM referrals r
        JOIN webui_users wu ON r.referred_email = wu.email
        LEFT JOIN user_credits uc ON r.referred_email = uc.user_email
        WHERE r.referrer_email = $1
        ORDER BY r.referred_at DESC
        LIMIT $2 OFFSET $3
      `, [targetEmail, limit, offset]);
      const referred = referredResult.rows;

      const countResult = await query<{ total: string }>('SELECT COUNT(*)::text as total FROM referrals WHERE referrer_email = $1', [targetEmail]);
      const total = parseInt(countResult.rows[0]?.total || '0', 10);

      res.json({
        items: referred.map(r => ({
          email: r.referred_email,
          joinedAt: r.joined_at,
          referredAt: r.referred_at,
          totalCreditsPurchased: r.total_credits_purchased,
          appDownloaded: r.app_downloaded === 1,
          appDownloadedAt: r.app_downloaded_at,
          referralCount: parseInt(r.referral_count, 10),
        })),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      });
    } catch (error) {
      console.error('[webui] Error getting admin referral chain:', error);
      res.status(500).json({ error: 'Failed to get referral chain' });
    }
  });

  // Get referred users for a specific referrer (admin only, paginated)
  app.get('/api/admin/referrals/:email', requireAdmin, async (req: Request, res: Response) => {
    try {
      const referrerEmail = decodeURIComponent(req.params.email);
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const offset = (page - 1) * limit;

      const referredResult = await query<{
        email: string;
        joinedat: string;
        referredat: string;
        totalcreditspurchased: number;
        appdownloaded: number;
        appdownloadedat: string | null;
      }>(`
        SELECT
          r.referred_email as email,
          wu.created_at as joinedAt,
          r.referred_at as referredAt,
          COALESCE(uc.total_deposited_fula, 0) as totalCreditsPurchased,
          COALESCE(wu.app_downloaded, 0) as appDownloaded,
          wu.app_downloaded_at as appDownloadedAt
        FROM referrals r
        JOIN webui_users wu ON r.referred_email = wu.email
        LEFT JOIN user_credits uc ON r.referred_email = uc.user_email
        WHERE r.referrer_email = $1
        ORDER BY r.referred_at DESC
        LIMIT $2 OFFSET $3
      `, [referrerEmail, limit, offset]);
      const referred = referredResult.rows;

      const countResult = await query<{ total: string }>('SELECT COUNT(*)::text as total FROM referrals WHERE referrer_email = $1', [referrerEmail]);
      const total = parseInt(countResult.rows[0]?.total || '0', 10);

      // Get referrer info
      const referrerInfoResult = await query<{ code: string }>('SELECT code FROM referral_codes WHERE user_email = $1', [referrerEmail]);
      const referrerInfo = referrerInfoResult.rows[0];

      res.json({
        referrer: referrerEmail,
        referrerCode: referrerInfo?.code || null,
        items: referred.map(r => ({
          email: r.email,
          joinedAt: r.joinedat,
          referredAt: r.referredat,
          totalCreditsPurchased: r.totalcreditspurchased,
          appDownloaded: r.appdownloaded === 1,
          appDownloadedAt: r.appdownloadedat,
        })),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      });
    } catch (error) {
      console.error('[webui] Error getting admin referrer details:', error);
      res.status(500).json({ error: 'Failed to get referrer details' });
    }
  });

  // ============ API v1 Endpoints (Bearer Token Auth for External Apps) ============
  // These endpoints use API key (JWT) authentication instead of browser sessions
  // Existing /api/* endpoints remain unchanged for web UI compatibility

  // GET /api/v1/storage - Storage usage and credit info
  app.get('/api/v1/storage', requireApiAuth, async (req: Request, res: Response) => {
    try {
      const status = await getUserCreditStatus(req.apiUser!.email);

      // Calculate paid storage from FULA balance
      const paidStorageBytes = Math.floor((status.balanceFula / FULA_PER_GB_MONTH) * 1024 * 1024 * 1024);
      const totalAvailableBytes = FREE_TIER_BYTES + paidStorageBytes;

      // Calculate monthly burn rate (if over free tier)
      const overageBytes = Math.max(0, status.currentStorageBytes - FREE_TIER_BYTES);
      const overageGB = overageBytes / (1024 * 1024 * 1024);
      const monthlyBurnRate = overageGB * FULA_PER_GB_MONTH;
      const isConsuming = overageBytes > 0 && status.balanceFula > 0;

      res.json({
        currentStorageBytes: status.currentStorageBytes,
        freeTierBytes: FREE_TIER_BYTES,
        paidStorageBytes,
        totalAvailableBytes,
        balanceFula: status.balanceFula,
        monthlyBurnRate,
        isConsuming,
        canUpload: status.canUpload,
        isSuspended: status.isSuspended,
      });
    } catch (error) {
      console.error('[api/v1] Error getting storage:', error);
      res.status(500).json({ error: 'Failed to get storage info' });
    }
  });

  // GET /api/v1/wallets - User's linked wallets
  app.get('/api/v1/wallets', requireApiAuth, async (req: Request, res: Response) => {
    try {
      const wallets = await getUserWallets(req.apiUser!.email);
      const chains = await getSupportedChains();
      res.json({
        wallets: wallets.map(w => ({
          address: w.address,
          chainId: w.chainId,
          isVerified: w.isVerified,
          connectedAt: w.connectedAt,
        })),
        supportedChains: chains.filter(c => c.isEnabled).map(c => ({
          chainId: c.chainId,
          chainName: c.chainName,
          vaultAddress: c.vaultAddress,
          tokenAddress: c.tokenAddress,
        })),
      });
    } catch (error) {
      console.error('[api/v1] Error getting wallets:', error);
      res.status(500).json({ error: 'Failed to get wallets' });
    }
  });

  // POST /api/v1/wallets/link - Link wallet with signature verification
  app.post('/api/v1/wallets/link', requireApiAuth, async (req: Request, res: Response) => {
    try {
      const { address, chainId, signature, message } = req.body;

      if (!address || !chainId || !signature || !message) {
        return res.status(400).json({ error: 'address, chainId, signature, and message are required' });
      }

      // Validate address format
      if (!/^0x[a-fA-F0-9]{40}$/i.test(address)) {
        return res.status(400).json({ error: 'Invalid wallet address format' });
      }

      const normalizedAddress = address.toLowerCase();
      const userEmail = req.apiUser!.email;

      // Verify the message contains user email and wallet address (prevents replay attacks)
      if (!message.includes(userEmail) || !message.toLowerCase().includes(normalizedAddress)) {
        return res.status(400).json({ error: 'Invalid signature message - must include your email and wallet address' });
      }

      // Verify signature format
      if (!/^0x[a-fA-F0-9]+$/.test(signature)) {
        return res.status(400).json({ error: 'Invalid signature format' });
      }

      // Verify the signature using viem
      try {
        const { recoverMessageAddress } = await import('viem');

        const recoveredAddress = await recoverMessageAddress({
          message,
          signature: signature as `0x${string}`,
        });

        if (recoveredAddress.toLowerCase() !== normalizedAddress) {
          return res.status(400).json({ error: 'Signature verification failed - address mismatch' });
        }
      } catch (sigError) {
        console.error('[api/v1] Signature verification error:', sigError);
        return res.status(400).json({ error: 'Invalid signature' });
      }

      // Check if this wallet is already linked to a DIFFERENT user
      const existingLinkResult = await query<{ user_email: string }>(
        `SELECT user_email FROM user_wallets WHERE wallet_address = $1 AND is_verified = 1`,
        [normalizedAddress]
      );
      const existingLink = existingLinkResult.rows[0];

      if (existingLink && existingLink.user_email !== userEmail) {
        return res.status(400).json({
          error: 'Wallet already linked to another account',
        });
      }

      // Check if chain is supported
      const chainCheckResult = await query('SELECT 1 FROM chain_sync_state WHERE chain_id = $1 AND is_enabled = 1', [chainId]);
      if (chainCheckResult.rows.length === 0) {
        return res.status(400).json({ error: 'Unsupported or disabled chain' });
      }

      // Link the wallet (verified)
      await linkWallet(userEmail, normalizedAddress, chainId, true);

      console.log(`[api/v1] Wallet ${normalizedAddress} linked to ${userEmail} on chain ${chainId}`);

      res.json({ success: true, address: normalizedAddress, chainId });
    } catch (error) {
      console.error('[api/v1] Error linking wallet:', error);
      res.status(500).json({ error: 'Failed to link wallet' });
    }
  });

  // POST /api/v1/credits/claim - Claim transaction
  app.post('/api/v1/credits/claim', requireApiAuth, async (req: Request, res: Response) => {
    try {
      const { txHash, chainId } = req.body;

      if (!txHash || !chainId) {
        return res.status(400).json({ error: 'txHash and chainId are required' });
      }

      // Validate tx hash format
      if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
        return res.status(400).json({ error: 'Invalid transaction hash format' });
      }

      // Check if already claimed
      const existingResult = await query<{ user_email: string | null; claimed_at: string | null }>(
        `SELECT user_email, claimed_at FROM token_transactions WHERE tx_hash = $1 AND chain_id = $2`,
        [txHash.toLowerCase(), chainId]
      );
      const existing = existingResult.rows[0];

      if (existing?.claimed_at) {
        return res.status(400).json({ error: 'This transaction has already been credited' });
      }

      // Get chain config
      const chainResult = await query<{ token_address: string; vault_address: string }>(
        `SELECT token_address, vault_address FROM chain_sync_state WHERE chain_id = $1 AND is_enabled = 1`,
        [chainId]
      );
      const chain = chainResult.rows[0];

      if (!chain) {
        return res.status(400).json({ error: 'Unsupported or disabled chain' });
      }

      // Fetch transaction from blockchain explorer
      let explorerUrl: string;
      switch (chainId) {
        case 1:
          explorerUrl = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${process.env.ETHERSCAN_API_KEY || ''}`;
          break;
        case 8453:
          explorerUrl = `https://api.etherscan.io/v2/api?chainid=8453&module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${process.env.ETHERSCAN_API_KEY || ''}`;
          break;
        case 2046399126:
          explorerUrl = `https://elated-tan-skat.explorer.mainnet.skalenodes.com/api?module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}`;
          break;
        default:
          return res.status(400).json({ error: 'Unsupported chain' });
      }

      // Retry logic - transaction may not be indexed immediately
      let data: any = null;
      let retries = 3;
      while (retries > 0) {
        const response = await fetch(explorerUrl);
        data = await response.json();

        if (data.result && data.result !== null && data.result.logs) {
          break;
        }

        retries--;
        if (retries > 0) {
          console.log(`[api/v1] Transaction ${txHash} not ready, retrying in 3s... (${retries} left)`);
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      if (!data?.result || data.result === null) {
        return res.status(404).json({ error: 'Transaction not found or not confirmed. Please try again later.' });
      }

      // Parse token transfer from logs
      const receipt = data.result;
      const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      const tokenAddressLower = chain.token_address.toLowerCase();
      const vaultAddressLower = chain.vault_address.toLowerCase();

      let transferFound = false;
      let fromAddress = '';
      let amountRaw = '0';

      for (const log of receipt.logs || []) {
        if (log.address.toLowerCase() !== tokenAddressLower) continue;
        if (log.topics[0] !== transferTopic) continue;

        const to = '0x' + log.topics[2].slice(26).toLowerCase();
        if (to !== vaultAddressLower) continue;

        fromAddress = '0x' + log.topics[1].slice(26).toLowerCase();
        amountRaw = BigInt(log.data).toString();
        transferFound = true;
        break;
      }

      if (!transferFound) {
        return res.status(400).json({ error: 'No FULA transfer to vault found in this transaction' });
      }

      const amountFula = rawToFula(amountRaw);
      if (amountFula < 0.001) {
        return res.status(400).json({ error: 'Transfer amount too small' });
      }

      // Check if user has this wallet linked
      const userEmail = req.apiUser!.email;
      const walletResult = await query(
        `SELECT 1 FROM user_wallets WHERE user_email = $1 AND wallet_address = $2 AND is_verified = 1`,
        [userEmail, fromAddress]
      );

      if (walletResult.rows.length === 0) {
        return res.status(400).json({
          error: 'Wallet not linked to your account',
          walletAddress: fromAddress,
        });
      }

      // Insert or update transaction
      if (existing) {
        await query(
          `UPDATE token_transactions
           SET user_email = $1, claimed_at = NOW(), ingestion_source = 'manual'
           WHERE tx_hash = $2 AND chain_id = $3`,
          [userEmail, txHash.toLowerCase(), chainId]
        );
      } else {
        await query(
          `INSERT INTO token_transactions
            (tx_hash, chain_id, from_address, to_address, amount_raw, amount_fula, block_number, block_timestamp, user_email, claimed_at, ingestion_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), 'manual')`,
          [
            txHash.toLowerCase(),
            chainId,
            fromAddress,
            vaultAddressLower,
            amountRaw,
            amountFula,
            parseInt(receipt.blockNumber, 16),
            Math.floor(Date.now() / 1000),
            userEmail
          ]
        );
      }

      // Credit the user
      await creditUser(userEmail, amountFula, `${chainId}:${txHash}`);

      console.log(`[api/v1] Claim: credited ${amountFula} FULA to ${userEmail} from tx ${txHash}`);

      const newStatus = await getUserCreditStatus(userEmail);
      res.json({
        success: true,
        amountFula,
        newBalance: newStatus.balanceFula,
      });
    } catch (error) {
      console.error('[api/v1] Error claiming transaction:', error);
      res.status(500).json({ error: 'Failed to claim transaction' });
    }
  });

  // GET /api/v1/credits/history - Paginated credit history
  app.get('/api/v1/credits/history', requireApiAuth, async (req: Request, res: Response) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const offset = (page - 1) * limit;

      const userEmail = req.apiUser!.email;

      // Get total count
      const countResult = await query<{ total: string }>(
        `SELECT COUNT(*)::text as total FROM credit_history WHERE user_email = $1`,
        [userEmail]
      );

      const total = parseInt(countResult.rows[0]?.total || '0', 10);
      const totalPages = Math.ceil(total / limit);

      // Get paginated history
      const historyResult = await query<{
        txtype: string;
        amountfula: number;
        balanceafter: number;
        referenceid: string | null;
        createdat: string;
      }>(`
        SELECT tx_type as txType, amount_fula as amountFula, balance_after as balanceAfter,
               reference_id as referenceId, created_at as createdAt
        FROM credit_history
        WHERE user_email = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `, [userEmail, limit, offset]);
      const history = historyResult.rows.map(r => ({
        txType: r.txtype,
        amountFula: r.amountfula,
        balanceAfter: r.balanceafter,
        referenceId: r.referenceid,
        createdAt: r.createdat,
      }));

      res.json({
        history,
        page,
        limit,
        total,
        totalPages,
      });
    } catch (error) {
      console.error('[api/v1] Error getting credit history:', error);
      res.status(500).json({ error: 'Failed to get credit history' });
    }
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[webui] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, dbOps };
}
