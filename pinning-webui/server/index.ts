import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import path from 'path';
import http from 'http';
import Database from 'better-sqlite3';
import { OAuth2Client } from 'google-auth-library';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const config = {
  port: parseInt(process.env.WEBUI_PORT || '3001'),
  databasePath: process.env.DATABASE_PATH || '../data/pinning.db',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  sessionSecret: process.env.SESSION_SECRET || 'change-this-in-production-' + uuidv4(),
  jwtSecret: process.env.JWT_SECRET || process.env.SESSION_SECRET || 'change-this-jwt-secret-in-production',
  nodeEnv: process.env.NODE_ENV || 'development',
  pinningServiceUrl: process.env.PINNING_SERVICE_URL || 'http://localhost:8080',
};

// Debug .env loading
console.log('[webui] Configuration loaded:');
console.log(`[webui]   JWT_SECRET: ${config.jwtSecret.substring(0, 10)}...`);
console.log(`[webui]   SESSION_SECRET: ${config.sessionSecret.substring(0, 10)}...`);
console.log(`[webui]   DATABASE_PATH: ${config.databasePath}`);
console.log(`[webui]   NODE_ENV: ${config.nodeEnv}`);

// Initialize Google OAuth client
const googleClient = new OAuth2Client(config.googleClientId);

// Initialize database
let db: Database.Database;

function initializeDatabase(): Database.Database {
  const dbPath = config.databasePath;
  
  // Open database with WAL mode for better concurrency
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
  
  console.log(`[webui] Database connected: ${dbPath}`);
  return database;
}

// Session user type
interface SessionUser {
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

// Generate JWT API key
function generateJwtApiKey(email: string): string {
  const payload = {
    sub: email,
    iat: Math.floor(Date.now() / 1000),
    scope: 'storage:read storage:write',
    jti: uuidv4(), // Unique token ID to ensure each key is unique
  };
  
  return jwt.sign(payload, config.jwtSecret, { algorithm: 'HS256' });
}

// Database operations
const dbOps = {
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
    const keyId = generateJwtApiKey(email);
    db.prepare('INSERT INTO api_keys (key_id, user_email) VALUES (?, ?)').run(keyId, email);
    
    // Also create entry in main users/sessions tables for pinning service compatibility
    const existingMainUser = db.prepare('SELECT * FROM users WHERE username = ?').get(email);
    if (!existingMainUser) {
      // Create user with a placeholder password hash (they use API keys, not passwords)
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
    const keyId = generateJwtApiKey(email);
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
      // Delete all pins for this user
      db.prepare('DELETE FROM pins WHERE username = ?').run(email);
      // Delete user from main table
      db.prepare('DELETE FROM users WHERE username = ?').run(email);
      
      // Delete sessions
      db.prepare('DELETE FROM sessions WHERE username = ?').run(email);
      // Delete API keys
      db.prepare('DELETE FROM api_keys WHERE user_email = ?').run(email);
      // Delete webui user
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

// Create Express app
const app = express();

// Trust proxy (required for secure cookies behind nginx)
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

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Session middleware
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: config.nodeEnv === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
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
      id: sub, // Google user ID for encryption key derivation
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
    
    // Validate CID format (basic check)
    if (!/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/i.test(cid)) {
      return res.status(400).json({ error: 'Invalid CID format' });
    }
    
    // Get user's API key to call the pinning service
    const keys = dbOps.getApiKeys(req.session.user!.email);
    if (!keys || keys.length === 0) {
      return res.status(400).json({ error: 'No API key found. Please create an API key first.' });
    }
    
    // Call the Go pinning service API to add the pin (this triggers IPFS Cluster pinning)
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

// Helper function to make HTTP GET requests using Node's http module (avoids fetch issues)
function httpGet(url: string, headers: Record<string, string>): Promise<{ status: number; data: string }> {
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
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    req.end();
  });
}

// Helper function to make HTTP POST requests using Node's http module
function httpPost(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: parseInt(urlObj.port) || 80,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    
    const req = http.request(options, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        resolve({ status: response.statusCode || 500, data });
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    req.write(body);
    req.end();
  });
}

// Helper function to make HTTP DELETE requests using Node's http module
function httpDelete(url: string, headers: Record<string, string>): Promise<{ status: number; data: string }> {
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
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    req.end();
  });
}

// Bulk unpin - delete multiple pins
app.post('/api/pins/bulk-unpin', requireAuth, async (req: Request, res: Response) => {
  try {
    const { requestIds } = req.body;
    
    if (!requestIds || !Array.isArray(requestIds) || requestIds.length === 0) {
      return res.status(400).json({ error: 'requestIds array is required' });
    }
    
    // Get user's API key to call the pinning service
    const keys = dbOps.getApiKeys(req.session.user!.email);
    if (!keys || keys.length === 0) {
      return res.status(400).json({ error: 'No API key found. Please create an API key first.' });
    }
    
    console.log(`[webui] Bulk unpinning ${requestIds.length} pins`);
    
    const results: { requestId: string; success: boolean; error?: string }[] = [];
    
    // Delete each pin via the pinning service API
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

// Refresh pin status and size from pinning service
app.post('/api/pins/:requestId/refresh', requireAuth, async (req: Request, res: Response) => {
  try {
    const { requestId } = req.params;
    
    // Get user's API key to call the pinning service
    const keys = dbOps.getApiKeys(req.session.user!.email);
    if (!keys || keys.length === 0) {
      return res.status(400).json({ error: 'No API key found. Please create an API key first.' });
    }
    
    // Call the pinning service to get updated status using http module
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
    
    // The pinning service updates the database, so we just return the updated data
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

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Public stats (no auth required) - for login page counter
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

// Serve static files in production
if (config.nodeEnv === 'production') {
  const publicPath = path.join(__dirname, 'public');
  app.use(express.static(publicPath));
  
  // SPA fallback - Express 5 requires named parameter for catch-all
  app.get('/{*splat}', (_req: Request, res: Response) => {
    res.sendFile(path.join(publicPath, 'index.html'));
  });
}

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[webui] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
db = initializeDatabase();

app.listen(config.port, () => {
  console.log(`[webui] FULA Pinning WebUI running on port ${config.port}`);
  console.log(`[webui] Environment: ${config.nodeEnv}`);
  if (!config.googleClientId) {
    console.warn('[webui] WARNING: GOOGLE_CLIENT_ID not set - authentication will not work');
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[webui] Shutting down...');
  db.close();
  process.exit(0);
});
