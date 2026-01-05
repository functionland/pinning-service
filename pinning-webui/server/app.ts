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
  `);

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
export function httpGet(url: string, headers: Record<string, string>): Promise<{ status: number; data: string }> {
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
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
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
        connectSrc: ["'self'", "https://accounts.google.com", "https://oauth2.googleapis.com", "https://www.googleapis.com", "https://ipfs.cloud.fx.land"],
        frameSrc: ["https://accounts.google.com"],
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
  // FxFiles stores data in S3-compatible buckets (encrypted):
  // - Playlists: playlists/user-playlists/{playlistId}.json
  // - Outgoing Shares: fula-metadata/.fula/shares/{hashedUserId}.json.enc
  // - Accepted Shares: NOT in cloud (device-only for privacy)
  //
  // Server proxies S3 requests and returns encrypted data.
  // Client handles decryption using existing encryptionService.

  const S3_GATEWAY = process.env.S3_GATEWAY_URL || 'https://ipfs.cloud.fx.land';

  // Get shares with me (items others have shared with the current user)
  // Note: Accepted shares are NOT synced to cloud by design (privacy)
  app.get('/api/shares/with-me', requireAuth, async (_req: Request, res: Response) => {
    return res.json({
      shares: [],
      note: 'Accepted shares are stored on device only. Use share links to access shared content.'
    });
  });

  // Get shares by me - returns encrypted data for client-side decryption
  // Client must provide hashedUserId (computed from public key)
  app.get('/api/shares/by-me', requireAuth, async (req: Request, res: Response) => {
    try {
      const { hashedUserId } = req.query;

      if (!hashedUserId || typeof hashedUserId !== 'string') {
        return res.status(400).json({ error: 'hashedUserId query parameter required' });
      }

      console.log('[webui] Fetching outgoing shares for hashedUserId:', hashedUserId);

      // Fetch encrypted shares file from S3
      const sharesUrl = `${S3_GATEWAY}/fula-metadata/.fula/shares/${hashedUserId}.json.enc`;
      console.log('[webui] Fetching from:', sharesUrl);

      const response = await fetch(sharesUrl);

      if (response.status === 404) {
        console.log('[webui] No shares file found');
        return res.json({ shares: [], encryptedData: null });
      }

      if (!response.ok) {
        console.error('[webui] S3 error:', response.status);
        return res.json({ shares: [], encryptedData: null });
      }

      const encryptedData = Buffer.from(await response.arrayBuffer());
      console.log('[webui] Fetched encrypted shares, size:', encryptedData.length);

      // Return encrypted data as base64 for client-side decryption
      return res.json({
        encryptedData: encryptedData.toString('base64')
      });
    } catch (error) {
      console.error('[webui] Error in shares/by-me:', error);
      res.status(500).json({ error: 'Failed to fetch shares' });
    }
  });

  // List playlist keys from S3 bucket
  app.get('/api/playlists/list', requireAuth, async (_req: Request, res: Response) => {
    try {
      console.log('[webui] Listing playlists from S3');

      // S3 ListObjectsV2: GET /playlists?list-type=2&prefix=user-playlists/
      const listUrl = `${S3_GATEWAY}/playlists?list-type=2&prefix=user-playlists/`;
      console.log('[webui] List URL:', listUrl);

      const response = await fetch(listUrl);

      if (!response.ok) {
        console.error('[webui] S3 list error:', response.status);
        return res.json({ keys: [] });
      }

      const listData = await response.text();
      console.log('[webui] S3 response (first 300):', listData.substring(0, 300));

      // Parse S3 XML response to extract keys
      let keys: string[] = [];

      // Try JSON first (some gateways return JSON)
      try {
        const jsonData = JSON.parse(listData);
        if (jsonData.Contents && Array.isArray(jsonData.Contents)) {
          keys = jsonData.Contents.map((obj: { Key: string }) => obj.Key);
        }
      } catch {
        // Parse S3 XML format
        const keyMatches = listData.matchAll(/<Key>([^<]+)<\/Key>/g);
        for (const match of keyMatches) {
          if (match[1].endsWith('.json')) {
            keys.push(match[1]);
          }
        }
      }

      console.log('[webui] Found playlist keys:', keys);
      return res.json({ keys });
    } catch (error) {
      console.error('[webui] Error listing playlists:', error);
      res.status(500).json({ error: 'Failed to list playlists' });
    }
  });

  // Get encrypted playlist data by key
  app.get('/api/playlists/encrypted/:key(*)', requireAuth, async (req: Request, res: Response) => {
    try {
      const { key } = req.params;
      console.log('[webui] Fetching encrypted playlist:', key);

      const playlistUrl = `${S3_GATEWAY}/playlists/${key}`;
      const response = await fetch(playlistUrl);

      if (!response.ok) {
        console.error('[webui] S3 error:', response.status);
        return res.status(response.status).json({ error: 'Playlist not found' });
      }

      const encryptedData = Buffer.from(await response.arrayBuffer());
      console.log('[webui] Fetched encrypted playlist, size:', encryptedData.length);

      // Return encrypted data as base64 for client-side decryption
      return res.json({
        key,
        encryptedData: encryptedData.toString('base64')
      });
    } catch (error) {
      console.error('[webui] Error fetching playlist:', error);
      res.status(500).json({ error: 'Failed to fetch playlist' });
    }
  });

  // Legacy endpoint - returns empty (use /list and /encrypted/:key instead)
  app.get('/api/playlists', requireAuth, async (_req: Request, res: Response) => {
    return res.json({ playlists: [], note: 'Use /api/playlists/list and /api/playlists/encrypted/:key' });
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

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[webui] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, dbOps };
}
