import express, { type Request, type Response, type NextFunction } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import path from 'path';
import http from 'http';
import Database from 'better-sqlite3';
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

// App configuration type
export interface AppConfig {
  port: number;
  databasePath: string;
  googleClientId: string;
  sessionSecret: string;
  jwtSecret: string;
  nodeEnv: string;
  pinningServiceUrl: string;
}

// Database operations type
export interface DbOps {
  getOrCreateUser(email: string, name: string, picture: string): any;
  getUserByEmail(email: string): any;
  getApiKeys(email: string): any[];
  createApiKey(email: string): string;
  deleteApiKey(email: string, keyId: string): boolean;
  getUserPins(email: string, page: number, limit: number, search?: string): { pins: any[]; total: number };
  getUserStats(email: string): any;
  deleteUserProfile(email: string): void;
  addPin(email: string, cid: string, name?: string): string;
}

// Initialize database schema
export function initializeDatabase(dbPath: string): Database.Database {
  const database = new Database(dbPath);
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');

  // Extend schema for webui-specific tables
  database.exec(`
    -- API Keys table (extends existing sessions concept)
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id TEXT NOT NULL UNIQUE,
      user_email TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME,
      is_deleted INTEGER DEFAULT 0,
      deleted_at DATETIME,
      FOREIGN KEY (user_email) REFERENCES webui_users(email)
    );

    -- WebUI Users table
    CREATE TABLE IF NOT EXISTS webui_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      picture TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login_at DATETIME,
      total_upload_size INTEGER DEFAULT 0
    );

    -- Create indexes
    CREATE INDEX IF NOT EXISTS idx_api_keys_user_email ON api_keys(user_email);
    CREATE INDEX IF NOT EXISTS idx_api_keys_key_id ON api_keys(key_id);

    -- ============================================
    -- Web3 Payment Integration Tables
    -- ============================================

    -- User wallets (linked blockchain addresses)
    CREATE TABLE IF NOT EXISTS user_wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      is_verified INTEGER DEFAULT 0,
      connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_email, wallet_address, chain_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_wallets_email ON user_wallets(user_email);
    CREATE INDEX IF NOT EXISTS idx_user_wallets_address ON user_wallets(wallet_address);

    -- Token transactions (FULA payments to vault)
    CREATE TABLE IF NOT EXISTS token_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_hash TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      amount_raw TEXT NOT NULL,
      amount_fula REAL NOT NULL,
      block_number INTEGER NOT NULL,
      block_timestamp INTEGER NOT NULL,
      user_email TEXT,
      claimed_at DATETIME,
      ingestion_source TEXT CHECK(ingestion_source IN ('cron', 'manual')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tx_hash, chain_id)
    );
    CREATE INDEX IF NOT EXISTS idx_token_tx_from ON token_transactions(from_address);
    CREATE INDEX IF NOT EXISTS idx_token_tx_user ON token_transactions(user_email);
    CREATE INDEX IF NOT EXISTS idx_token_tx_hash ON token_transactions(tx_hash);

    -- Chain sync state (for block scanner cron)
    CREATE TABLE IF NOT EXISTS chain_sync_state (
      chain_id INTEGER PRIMARY KEY,
      chain_name TEXT NOT NULL,
      last_scanned_block INTEGER DEFAULT 0,
      last_scan_at DATETIME,
      is_enabled INTEGER DEFAULT 1,
      token_address TEXT NOT NULL,
      vault_address TEXT NOT NULL
    );

    -- User credits (FULA balance for storage)
    CREATE TABLE IF NOT EXISTS user_credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL UNIQUE,
      balance_fula REAL DEFAULT 0,
      total_deposited_fula REAL DEFAULT 0,
      total_deducted_fula REAL DEFAULT 0,
      last_deduction_at DATETIME,
      is_suspended INTEGER DEFAULT 0,
      suspended_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_user_credits_email ON user_credits(user_email);
    CREATE INDEX IF NOT EXISTS idx_user_credits_suspended ON user_credits(is_suspended);

    -- Credit history (audit log)
    CREATE TABLE IF NOT EXISTS credit_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL,
      tx_type TEXT CHECK(tx_type IN ('deposit', 'hourly_deduction', 'adjustment')),
      amount_fula REAL NOT NULL,
      balance_after REAL NOT NULL,
      reference_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_credit_history_email ON credit_history(user_email);
    CREATE INDEX IF NOT EXISTS idx_credit_history_type ON credit_history(tx_type);
  `);

  // Seed chain_sync_state with supported chains (if empty)
  const chainCount = database.prepare('SELECT COUNT(*) as count FROM chain_sync_state').get() as { count: number };
  if (chainCount.count === 0) {
    const vaultAddress = process.env.VAULT_ADDRESS || '0x0000000000000000000000000000000000000000';
    database.prepare(`
      INSERT INTO chain_sync_state (chain_id, chain_name, token_address, vault_address, is_enabled)
      VALUES
        (1, 'Ethereum', '0x92217cCaEDBdbc54C76c15feA18823db1558fDc9', ?, 1),
        (8453, 'Base', '0x9e12735d77c72c5C3670636D428f2F3815d8A4cB', ?, 1),
        (2046399126, 'Skale Europa', '0x9e12735d77c72c5C3670636D428f2F3815d8A4cB', ?, 1)
    `).run(vaultAddress, vaultAddress, vaultAddress);
  }

  return database;
}

// Initialize test database with additional tables needed for testing
export function initializeTestDatabase(): Database.Database {
  const database = new Database(':memory:');
  database.pragma('journal_mode = WAL');

  database.exec(`
    -- Users table (main pinning service table)
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      pool_id INTEGER DEFAULT 1
    );

    -- Sessions table (main pinning service table)
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_token TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Pins table (main pinning service table)
    CREATE TABLE IF NOT EXISTS pins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requestid TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      cid TEXT NOT NULL,
      name TEXT,
      name_lowercase TEXT,
      status TEXT DEFAULT 'queued',
      size INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- API Keys table
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id TEXT NOT NULL UNIQUE,
      user_email TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME,
      is_deleted INTEGER DEFAULT 0,
      deleted_at DATETIME
    );

    -- WebUI Users table
    CREATE TABLE IF NOT EXISTS webui_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      picture TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login_at DATETIME,
      total_upload_size INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_api_keys_user_email ON api_keys(user_email);
    CREATE INDEX IF NOT EXISTS idx_api_keys_key_id ON api_keys(key_id);

    -- Web3 Payment Tables (same as production)
    CREATE TABLE IF NOT EXISTS user_wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      is_verified INTEGER DEFAULT 0,
      connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_email, wallet_address, chain_id)
    );

    CREATE TABLE IF NOT EXISTS token_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_hash TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      amount_raw TEXT NOT NULL,
      amount_fula REAL NOT NULL,
      block_number INTEGER NOT NULL,
      block_timestamp INTEGER NOT NULL,
      user_email TEXT,
      claimed_at DATETIME,
      ingestion_source TEXT CHECK(ingestion_source IN ('cron', 'manual')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tx_hash, chain_id)
    );

    CREATE TABLE IF NOT EXISTS chain_sync_state (
      chain_id INTEGER PRIMARY KEY,
      chain_name TEXT NOT NULL,
      last_scanned_block INTEGER DEFAULT 0,
      last_scan_at DATETIME,
      is_enabled INTEGER DEFAULT 1,
      token_address TEXT NOT NULL,
      vault_address TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL UNIQUE,
      balance_fula REAL DEFAULT 0,
      total_deposited_fula REAL DEFAULT 0,
      total_deducted_fula REAL DEFAULT 0,
      last_deduction_at DATETIME,
      is_suspended INTEGER DEFAULT 0,
      suspended_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS credit_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL,
      tx_type TEXT CHECK(tx_type IN ('deposit', 'hourly_deduction', 'adjustment')),
      amount_fula REAL NOT NULL,
      balance_after REAL NOT NULL,
      reference_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return database;
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

// Create database operations
export function createDbOps(db: Database.Database, jwtSecret: string): DbOps {
  return {
    getOrCreateUser(email: string, name: string, picture: string) {
      const existing = db.prepare('SELECT * FROM webui_users WHERE email = ?').get(email) as any;

      if (existing) {
        db.prepare('UPDATE webui_users SET last_login_at = CURRENT_TIMESTAMP, name = ?, picture = ? WHERE email = ?')
          .run(name, picture, email);
        return { ...existing, isNew: false };
      }

      db.prepare('INSERT INTO webui_users (email, name, picture, last_login_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)')
        .run(email, name, picture);

      // Create first API key automatically
      const keyId = generateJwtApiKey(email, jwtSecret);
      db.prepare('INSERT INTO api_keys (key_id, user_email) VALUES (?, ?)').run(keyId, email);

      // Also create entry in main users/sessions tables for pinning service compatibility
      const existingMainUser = db.prepare('SELECT * FROM users WHERE username = ?').get(email);
      if (!existingMainUser) {
        db.prepare('INSERT INTO users (username, password_hash, pool_id) VALUES (?, ?, 1)')
          .run(email, 'google-oauth-user-' + uuidv4());
      }

      // Create session token that matches the API key
      db.prepare('INSERT OR REPLACE INTO sessions (session_token, username, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
        .run(keyId, email);

      return { email, name, picture, isNew: true };
    },

    getUserByEmail(email: string) {
      return db.prepare('SELECT * FROM webui_users WHERE email = ?').get(email) as any;
    },

    getApiKeys(email: string) {
      return db.prepare(
        'SELECT key_id, created_at, last_used_at FROM api_keys WHERE user_email = ? AND is_deleted = 0 ORDER BY created_at DESC'
      ).all(email) as any[];
    },

    createApiKey(email: string): string {
      const keyId = generateJwtApiKey(email, jwtSecret);
      db.prepare('INSERT INTO api_keys (key_id, user_email) VALUES (?, ?)').run(keyId, email);

      // Also create corresponding session for pinning service
      db.prepare('INSERT OR REPLACE INTO sessions (session_token, username, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
        .run(keyId, email);

      return keyId;
    },

    deleteApiKey(email: string, keyId: string): boolean {
      const result = db.prepare(
        'UPDATE api_keys SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE user_email = ? AND key_id = ? AND is_deleted = 0'
      ).run(email, keyId);

      // Remove from sessions table
      db.prepare('DELETE FROM sessions WHERE session_token = ? AND username = ?').run(keyId, email);

      return result.changes > 0;
    },

    getUserPins(email: string, page: number, limit: number, search?: string) {
      const offset = (page - 1) * limit;

      let whereClause = 'WHERE username = ? AND status != \'deleted\'';
      const params: any[] = [email];

      if (search && search.trim()) {
        whereClause += ' AND (cid LIKE ? OR requestid LIKE ?)';
        const searchPattern = `%${search.trim()}%`;
        params.push(searchPattern, searchPattern);
      }

      const pins = db.prepare(`
        SELECT requestid as request_id, cid, name, created_at, status, size
        FROM pins
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).all(...params, limit, offset) as any[];

      const countResult = db.prepare(`
        SELECT COUNT(*) as total
        FROM pins
        ${whereClause}
      `).get(...params) as any;

      return { pins, total: countResult?.total || 0 };
    },

    getUserStats(email: string) {
      const stats = db.prepare(`
        SELECT
          COUNT(*) as total_pins,
          COALESCE(SUM(size), 0) as total_size
        FROM pins
        WHERE username = ? AND status != 'deleted'
      `).get(email) as any;

      const user = db.prepare('SELECT last_login_at, created_at FROM webui_users WHERE email = ?').get(email) as any;

      return {
        totalPins: stats?.total_pins || 0,
        totalSize: stats?.total_size || 0,
        lastLogin: user?.last_login_at,
        memberSince: user?.created_at,
      };
    },

    deleteUserProfile(email: string) {
      const transaction = db.transaction(() => {
        db.prepare('DELETE FROM pins WHERE username = ?').run(email);
        db.prepare('DELETE FROM users WHERE username = ?').run(email);
        db.prepare('DELETE FROM sessions WHERE username = ?').run(email);
        db.prepare('DELETE FROM api_keys WHERE user_email = ?').run(email);
        db.prepare('DELETE FROM webui_users WHERE email = ?').run(email);
      });

      transaction();
    },

    addPin(email: string, cid: string, name?: string) {
      const requestId = uuidv4();
      const nameLower = (name || '').toLowerCase();
      db.prepare(`
        INSERT INTO pins (requestid, username, cid, name, name_lowercase, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(requestId, email, cid, name || '', nameLower);

      return requestId;
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
export function createApp(config: AppConfig, db: Database.Database, options?: { skipRateLimit?: boolean }) {
  const dbOps = createDbOps(db, config.jwtSecret);
  const googleClient = new OAuth2Client(config.googleClientId);

  const app = express();

  // Trust proxy
  app.set('trust proxy', 1);

  // Security middleware
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://accounts.google.com", "https://apis.google.com", "https://www.gstatic.com"],
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
        ],
        frameSrc: ["'self'", "blob:", "https://accounts.google.com"],
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

  // Auth middleware
  function requireAuth(req: Request, res: Response, next: NextFunction) {
    if (!req.session.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  }

  // Auth routes
  app.post('/auth/google', async (req: Request, res: Response) => {
    try {
      const { credential } = req.body;

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

      const user = dbOps.getOrCreateUser(email, name || '', picture || '');

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
  app.get('/api/keys', requireAuth, (req: Request, res: Response) => {
    try {
      const keys = dbOps.getApiKeys(req.session.user!.email);
      res.json({ keys });
    } catch (error) {
      console.error('[webui] Error fetching API keys:', error);
      res.status(500).json({ error: 'Failed to fetch API keys' });
    }
  });

  app.post('/api/keys', requireAuth, (req: Request, res: Response) => {
    try {
      const keyId = dbOps.createApiKey(req.session.user!.email);
      res.json({ keyId });
    } catch (error) {
      console.error('[webui] Error creating API key:', error);
      res.status(500).json({ error: 'Failed to create API key' });
    }
  });

  app.delete('/api/keys/:keyId', requireAuth, (req: Request, res: Response) => {
    try {
      const { keyId } = req.params;
      const success = dbOps.deleteApiKey(req.session.user!.email, keyId);

      if (!success) {
        return res.status(404).json({ error: 'API key not found' });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('[webui] Error deleting API key:', error);
      res.status(500).json({ error: 'Failed to delete API key' });
    }
  });

  app.get('/api/keys/active', requireAuth, (req: Request, res: Response) => {
    try {
      const email = req.session.user!.email;
      let keys = dbOps.getApiKeys(email);

      if (!keys || keys.length === 0) {
        const newKeyId = dbOps.createApiKey(email);
        keys = [{ key_id: newKeyId, created_at: new Date().toISOString(), last_used_at: null }];
      }

      res.json({ key: keys[0].key_id });
    } catch (error) {
      console.error('[webui] Error getting active API key:', error);
      res.status(500).json({ error: 'Failed to get API key' });
    }
  });

  app.get('/api/pins', requireAuth, (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const search = req.query.search as string | undefined;

      const { pins, total } = dbOps.getUserPins(req.session.user!.email, page, limit, search);
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

      const keys = dbOps.getApiKeys(req.session.user!.email);
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

      const keys = dbOps.getApiKeys(req.session.user!.email);
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

      const keys = dbOps.getApiKeys(req.session.user!.email);
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

      const keys = dbOps.getApiKeys(req.session.user!.email);
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

  app.get('/api/stats', requireAuth, (req: Request, res: Response) => {
    try {
      const stats = dbOps.getUserStats(req.session.user!.email);
      res.json(stats);
    } catch (error) {
      console.error('[webui] Error fetching stats:', error);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  app.delete('/api/profile', requireAuth, (req: Request, res: Response) => {
    try {
      const { confirmation } = req.body;

      if (confirmation !== 'delete') {
        return res.status(400).json({ error: 'Please type "delete" to confirm' });
      }

      dbOps.deleteUserProfile(req.session.user!.email);

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
      const keys = dbOps.getApiKeys(req.session.user!.email);
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
      const keys = dbOps.getApiKeys(req.session.user!.email);
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
        const shareInfoResponse = await httpGet(shareInfoUrl);

        if (shareInfoResponse.status === 200 && shareInfoResponse.data?.cid) {
          const cid = shareInfoResponse.data.cid;
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

  // Health check
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Public stats (no auth required)
  app.get('/api/public/stats', (_req: Request, res: Response) => {
    try {
      const stats = db.prepare(`
        SELECT
          COUNT(*) as total_pins,
          COALESCE(SUM(size), 0) as total_size,
          COUNT(DISTINCT username) as total_users
        FROM pins
        WHERE status != 'deleted'
      `).get() as any;

      res.json({
        totalPins: stats?.total_pins || 0,
        totalSize: stats?.total_size || 0,
        totalUsers: stats?.total_users || 0,
      });
    } catch (error) {
      console.error('[webui] Error fetching public stats:', error);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // ============ Web3 Payment / Credits API Endpoints ============

  // Get credit status (balance, usage, can upload)
  app.get('/api/credits', requireAuth, (req: Request, res: Response) => {
    try {
      const status = getUserCreditStatus(db, req.session.user!.email);
      res.json(status);
    } catch (error) {
      console.error('[webui] Error getting credit status:', error);
      res.status(500).json({ error: 'Failed to get credit status' });
    }
  });

  // Get credit history
  app.get('/api/credits/history', requireAuth, (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const history = getCreditHistory(db, req.session.user!.email, Math.min(limit, 100));
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
      const existing = db.prepare(`
        SELECT user_email, claimed_at FROM token_transactions
        WHERE tx_hash = ? AND chain_id = ?
      `).get(txHash.toLowerCase(), chainId) as { user_email: string | null; claimed_at: string | null } | undefined;

      if (existing?.claimed_at) {
        return res.status(400).json({ error: 'This transaction has already been credited' });
      }

      // Get chain config
      const chain = db.prepare(`
        SELECT token_address, vault_address FROM chain_sync_state
        WHERE chain_id = ? AND is_enabled = 1
      `).get(chainId) as { token_address: string; vault_address: string } | undefined;

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

      const response = await fetch(explorerUrl);
      const data = await response.json();

      if (!data.result || data.result === null) {
        return res.status(404).json({ error: 'Transaction not found or not confirmed' });
      }

      // Parse token transfer from logs
      const receipt = data.result;
      const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)
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
      const userEmail = req.session.user!.email;
      const wallet = db.prepare(`
        SELECT 1 FROM user_wallets
        WHERE user_email = ? AND wallet_address = ? AND is_verified = 1
      `).get(userEmail, fromAddress) as { 1: number } | undefined;

      if (!wallet) {
        return res.status(400).json({
          error: 'Wallet not linked to your account',
          message: `Please link wallet ${fromAddress} to your account first`,
        });
      }

      // Insert or update transaction
      if (existing) {
        // Transaction exists but unclaimed - claim it
        db.prepare(`
          UPDATE token_transactions
          SET user_email = ?, claimed_at = CURRENT_TIMESTAMP, ingestion_source = 'manual'
          WHERE tx_hash = ? AND chain_id = ?
        `).run(userEmail, txHash.toLowerCase(), chainId);
      } else {
        // Insert new transaction
        db.prepare(`
          INSERT INTO token_transactions
            (tx_hash, chain_id, from_address, to_address, amount_raw, amount_fula, block_number, block_timestamp, user_email, claimed_at, ingestion_source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'manual')
        `).run(
          txHash.toLowerCase(),
          chainId,
          fromAddress,
          vaultAddressLower,
          amountRaw,
          amountFula,
          parseInt(receipt.blockNumber, 16),
          Math.floor(Date.now() / 1000),
          userEmail
        );
      }

      // Credit the user
      creditUser(db, userEmail, amountFula, `${chainId}:${txHash}`);

      console.log(`[webui] Manual claim: credited ${amountFula} FULA to ${userEmail} from tx ${txHash}`);

      res.json({
        success: true,
        amountFula,
        newBalance: getUserCreditStatus(db, userEmail).balanceFula,
      });
    } catch (error) {
      console.error('[webui] Error claiming transaction:', error);
      res.status(500).json({ error: 'Failed to claim transaction' });
    }
  });

  // Get user's linked wallets
  app.get('/api/wallets', requireAuth, (req: Request, res: Response) => {
    try {
      const wallets = getUserWallets(db, req.session.user!.email);
      const chains = getSupportedChains(db);
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
      const existingLink = db.prepare(`
        SELECT user_email FROM user_wallets
        WHERE wallet_address = ? AND is_verified = 1
      `).get(normalizedAddress) as { user_email: string } | undefined;

      if (existingLink && existingLink.user_email !== userEmail) {
        return res.status(400).json({
          error: 'Wallet already linked to another account',
          message: 'This wallet is already verified and linked to a different user account.',
        });
      }

      // Check if chain is supported
      const chain = db.prepare('SELECT 1 FROM chain_sync_state WHERE chain_id = ? AND is_enabled = 1').get(chainId);
      if (!chain) {
        return res.status(400).json({ error: 'Unsupported or disabled chain' });
      }

      // Link the wallet (verified)
      linkWallet(db, userEmail, normalizedAddress, chainId, true);

      console.log(`[webui] Wallet ${normalizedAddress} linked to ${userEmail} on chain ${chainId} (signature verified)`);

      res.json({ success: true, address: normalizedAddress, chainId });
    } catch (error) {
      console.error('[webui] Error connecting wallet:', error);
      res.status(500).json({ error: 'Failed to connect wallet' });
    }
  });

  // Disconnect/unlink a wallet
  app.delete('/api/wallets/:address', requireAuth, (req: Request, res: Response) => {
    try {
      const { address } = req.params;

      if (!address) {
        return res.status(400).json({ error: 'Wallet address is required' });
      }

      const success = unlinkWallet(db, req.session.user!.email, address);

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
  app.get('/api/credits/pricing', (_req: Request, res: Response) => {
    res.json({
      freeTierBytes: FREE_TIER_BYTES,
      freeTierMB: Math.round(FREE_TIER_BYTES / (1024 * 1024)),
      fulaPerGBMonth: FULA_PER_GB_MONTH,
      chains: getSupportedChains(db).filter(c => c.isEnabled),
    });
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

  // Get suspended users (admin only)
  app.get('/api/admin/suspended', requireAdmin, (_req: Request, res: Response) => {
    try {
      const users = getSuspendedUsers(db);
      res.json({ users });
    } catch (error) {
      console.error('[webui] Error getting suspended users:', error);
      res.status(500).json({ error: 'Failed to get suspended users' });
    }
  });

  // Unsuspend a user (admin only)
  app.post('/api/admin/unsuspend', requireAdmin, (req: Request, res: Response) => {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }

      const success = unsuspendUser(db, email);

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

  // Manual credit adjustment (admin only)
  app.post('/api/admin/adjust', requireAdmin, (req: Request, res: Response) => {
    try {
      const { email, amount, reason } = req.body;

      if (!email || amount === undefined || !reason) {
        return res.status(400).json({ error: 'email, amount, and reason are required' });
      }

      const numAmount = parseFloat(amount);
      if (isNaN(numAmount)) {
        return res.status(400).json({ error: 'Invalid amount' });
      }

      creditUser(db, email, numAmount, `admin:${req.session.user!.email}:${reason}`, 'adjustment');

      console.log(`[webui] Admin ${req.session.user!.email} adjusted ${email} by ${numAmount} FULA: ${reason}`);

      const newStatus = getUserCreditStatus(db, email);

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

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[webui] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, dbOps };
}
