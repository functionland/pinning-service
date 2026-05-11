import express, { type Request, type Response, type NextFunction } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import http from 'http';
import { OAuth2Client } from 'google-auth-library';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { emailToUserId, hashWalletAddress, getUserId } from './utils/hash.js';
import {
  getUserCreditStatus,
  getUserWallets,
  linkWallet,
  unlinkWallet,
  getCreditHistory,
  creditUser,
  getSuspendedUsers,
  unsuspendUser,
  isAdminById,
  getSupportedChains,
  FREE_TIER_BYTES,
  FULA_PER_GB_MONTH,
  rawToFula,
} from './services/creditService.js';
import {
  createPostgresPool,
  query,
  getOrCreateWebuiUser,
  getWebuiUserByEmail,
  getWebuiUserById,
  getApiKeys,
  createApiKey,
  deleteApiKey,
  getUserPins,
  getUserStats,
  deleteUserProfile,
  addPin,
  verifyApiKey,
  getUserReferralCodes,
  createUserReferralCode,
  updateReferralCodeName,
  deleteUserReferralCode,
  getUserCompany,
  updateUserCompany,
  encryptApiKey,
} from './database/postgres.js';
import { getEnabledChains, processTransfer } from './services/blockScanner.js';

// Session user type
export interface SessionUser {
  id: string; // User ID (Google sub claim or Apple sub)
  userId: string; // SHA-256(email) — used for all DB lookups
  email: string; // Ephemeral, from OAuth — NOT stored in DB, only in session memory
  name: string;
  picture: string;
  provider: 'google' | 'apple'; // Authentication provider
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
      apiUser?: { email: string; userId: string };
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
  // Phase 3.2 admin trigger endpoints — see /api/admin/fula/*.
  // `fulaCliInternalUrl` defaults to `s3InternalUrl` (same host:port,
  // different path namespace). `mainnetRewardsUrl` is a separate
  // service (port 5667 by default per package.json health script).
  // `fulaUsersIndexInternalToken` MUST equal the master's
  // FULA_USERS_INDEX_INTERNAL_TOKEN — the setup script writes that
  // value to /etc/fula/.env and /opt/mainnet-rewards/.env, and the
  // operator must replicate it into the pinning-webui .env too.
  fulaCliInternalUrl?: string;
  mainnetRewardsUrl?: string;
  fulaUsersIndexInternalToken?: string;
  // Apple Sign-In configuration
  appleClientId?: string;
  appleTeamId?: string;
  appleKeyId?: string;
  applePrivateKey?: string;
}

// Database operations type (async for PostgreSQL)
export interface DbOps {
  getOrCreateUser(userId: string, email: string, name: string, picture: string, referralCode?: string): Promise<any>;
  getUserById(userId: string): Promise<any>;
  getApiKeys(userId: string): Promise<any[]>;
  createApiKey(userId: string): Promise<string>;
  deleteApiKey(userId: string, keyId: string): Promise<boolean>;
  getUserPins(userId: string, page: number, limit: number, search?: string): Promise<{ pins: any[]; total: number }>;
  getUserStats(userId: string): Promise<any>;
  deleteUserProfile(userId: string): Promise<void>;
  addPin(userId: string, cid: string, name?: string): Promise<string>;
}

// Safe migration handler — only ignores expected PostgreSQL errors
// 42701 = duplicate column, 42P07 = duplicate table, 42P01 = undefined table (for ALTER on missing table)
function ignoreMigrationError(err: any): void {
  const code = err?.code;
  if (code === '42701' || code === '42P07' || code === '42P01') return;
  console.error('[migration] Unexpected error:', err);
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

  // Create share_manifests table for temporal folder share updates
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS share_manifests (
        share_id TEXT PRIMARY KEY,
        bucket TEXT NOT NULL,
        path_scope TEXT NOT NULL,
        token_json TEXT NOT NULL,
        files JSONB,
        share_mode TEXT DEFAULT 'temporal',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ
      )
    `);
    // Migration: drop secret_key column if it exists (no longer stored server-side for security)
    await query(`
      ALTER TABLE share_manifests DROP COLUMN IF EXISTS secret_key
    `).catch(ignoreMigrationError);
    // Migration: add encrypted_manifest column for privacy
    await query(`
      ALTER TABLE share_manifests ADD COLUMN IF NOT EXISTS encrypted_manifest TEXT
    `).catch(ignoreMigrationError);
    console.log('[webui] share_manifests table ready');
  } catch (error) {
    console.error('[webui] Failed to create share_manifests table:', error);
  }

  // Create collab_manifests table for collaboration group manifest sync
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS collab_manifests (
        group_id TEXT PRIMARY KEY,
        manifest_data TEXT,
        encrypted_manifest TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Migration: add encrypted_manifest column and make manifest_data nullable
    await query(`
      ALTER TABLE collab_manifests ADD COLUMN IF NOT EXISTS encrypted_manifest TEXT
    `).catch(ignoreMigrationError);
    await query(`
      ALTER TABLE collab_manifests ALTER COLUMN manifest_data DROP NOT NULL
    `).catch(ignoreMigrationError);
    await query(`
      ALTER TABLE collab_manifests ADD COLUMN IF NOT EXISTS creator_id VARCHAR(64)
    `).catch(ignoreMigrationError);
    console.log('[webui] collab_manifests table ready');
  } catch (error) {
    console.error('[webui] Failed to create collab_manifests table:', error);
  }

  // Zero-knowledge migration: add user_id columns (SHA-256 hash of email)
  try {
    const zkMigrations = [
      // Add user_id columns to all tables
      `ALTER TABLE webui_users ADD COLUMN IF NOT EXISTS user_id VARCHAR(64)`,
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS user_id VARCHAR(64)`,
      `ALTER TABLE pins ADD COLUMN IF NOT EXISTS user_id VARCHAR(64)`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS user_id VARCHAR(64)`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id VARCHAR(64)`,
      `ALTER TABLE referral_codes ADD COLUMN IF NOT EXISTS user_id VARCHAR(64)`,
      `ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referrer_id VARCHAR(64)`,
      `ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referred_id VARCHAR(64)`,
      `ALTER TABLE user_credits ADD COLUMN IF NOT EXISTS user_id VARCHAR(64)`,
      `ALTER TABLE credit_history ADD COLUMN IF NOT EXISTS user_id VARCHAR(64)`,
      `ALTER TABLE token_transactions ADD COLUMN IF NOT EXISTS user_id VARCHAR(64)`,
      `ALTER TABLE user_wallets ADD COLUMN IF NOT EXISTS user_id VARCHAR(64)`,
      `ALTER TABLE user_wallets ADD COLUMN IF NOT EXISTS wallet_address_hash VARCHAR(64)`,
      `ALTER TABLE user_wallets ADD COLUMN IF NOT EXISTS encrypted_wallet_address TEXT`,
      `ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS actor_id VARCHAR(64)`,
      `ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS target_id VARCHAR(64)`,
    ];
    for (const sql of zkMigrations) {
      await query(sql).catch(ignoreMigrationError);
    }
    console.log('[webui] Zero-knowledge schema columns ready');
  } catch (error) {
    console.error('[webui] Zero-knowledge migration error:', error);
  }

  // Backfill user_id columns from existing email data
  try {
    // Check if backfill is needed (any webui_users row with NULL user_id)
    const needsBackfill = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM webui_users WHERE user_id IS NULL`
    ).catch(() => ({ rows: [{ count: '0' }] }));

    if (parseInt(needsBackfill.rows[0]?.count || '0', 10) > 0) {
      console.log('[webui] Backfilling user_id columns...');
      // Import hash utility
      const { emailToUserId: hashEmail, hashWalletAddress: hashAddr } = await import('./utils/hash.js');

      // Backfill each table using Node.js crypto (no pgcrypto dependency)
      const tables: Array<{ table: string; emailCol: string; idCol: string }> = [
        { table: 'webui_users', emailCol: 'email', idCol: 'user_id' },
        { table: 'api_keys', emailCol: 'user_email', idCol: 'user_id' },
        { table: 'pins', emailCol: 'username', idCol: 'user_id' },
        { table: 'users', emailCol: 'username', idCol: 'user_id' },
        { table: 'sessions', emailCol: 'username', idCol: 'user_id' },
        { table: 'referral_codes', emailCol: 'user_email', idCol: 'user_id' },
        { table: 'user_credits', emailCol: 'user_email', idCol: 'user_id' },
        { table: 'credit_history', emailCol: 'user_email', idCol: 'user_id' },
        { table: 'user_wallets', emailCol: 'user_email', idCol: 'user_id' },
      ];

      for (const { table, emailCol, idCol } of tables) {
        const rows = await query<{ email_val: string }>(
          `SELECT DISTINCT ${emailCol} as email_val FROM ${table} WHERE ${idCol} IS NULL AND ${emailCol} IS NOT NULL`
        ).catch(() => ({ rows: [] }));
        for (const row of rows.rows) {
          const hashed = hashEmail(row.email_val);
          await query(`UPDATE ${table} SET ${idCol} = $1 WHERE ${emailCol} = $2 AND ${idCol} IS NULL`, [hashed, row.email_val]);
        }
      }

      // Backfill token_transactions (user_email can be NULL for unclaimed txns)
      const txRows = await query<{ email_val: string }>(
        `SELECT DISTINCT user_email as email_val FROM token_transactions WHERE user_id IS NULL AND user_email IS NOT NULL`
      ).catch(() => ({ rows: [] }));
      for (const row of txRows.rows) {
        const hashed = hashEmail(row.email_val);
        await query(`UPDATE token_transactions SET user_id = $1 WHERE user_email = $2 AND user_id IS NULL`, [hashed, row.email_val]);
      }

      // Backfill referrals (two email columns)
      const refRows = await query<{ re: string; rd: string }>(
        `SELECT DISTINCT referrer_email as re, referred_email as rd FROM referrals WHERE referrer_id IS NULL`
      ).catch(() => ({ rows: [] }));
      for (const row of refRows.rows) {
        await query(
          `UPDATE referrals SET referrer_id = $1, referred_id = $2 WHERE referrer_email = $3 AND referred_email = $4 AND referrer_id IS NULL`,
          [hashEmail(row.re), hashEmail(row.rd), row.re, row.rd]
        );
      }

      // Backfill admin_audit_log
      const auditRows = await query<{ actor: string; target_email: string | null }>(
        `SELECT DISTINCT actor, target_email FROM admin_audit_log WHERE actor_id IS NULL`
      ).catch(() => ({ rows: [] }));
      for (const row of auditRows.rows) {
        const actorId = row.actor.includes('@') ? hashEmail(row.actor) : row.actor;
        const targetId = row.target_email ? hashEmail(row.target_email) : null;
        await query(
          `UPDATE admin_audit_log SET actor_id = $1, target_id = $2 WHERE actor = $3 AND actor_id IS NULL`,
          [actorId, targetId, row.actor]
        );
      }

      // Backfill wallet_address_hash
      const walletRows = await query<{ addr: string }>(
        `SELECT DISTINCT wallet_address as addr FROM user_wallets WHERE wallet_address_hash IS NULL AND wallet_address IS NOT NULL`
      ).catch(() => ({ rows: [] }));
      for (const row of walletRows.rows) {
        const hashed = hashAddr(row.addr);
        await query(`UPDATE user_wallets SET wallet_address_hash = $1 WHERE wallet_address = $2 AND wallet_address_hash IS NULL`, [hashed, row.addr]);
      }

      console.log('[webui] user_id backfill complete');
    }

    // Backfill encrypted_key for api_keys that have key_id but no encrypted_key
    const unencryptedKeys = await query<{ key_hash: string; key_id: string }>(
      "SELECT key_hash, key_id FROM api_keys WHERE key_id IS NOT NULL AND key_id != '' AND encrypted_key IS NULL"
    );
    for (const row of unencryptedKeys.rows) {
      const encrypted = encryptApiKey(row.key_id);
      if (encrypted) {
        await query('UPDATE api_keys SET encrypted_key = $1 WHERE key_hash = $2', [encrypted, row.key_hash]);
      }
    }
    if (unencryptedKeys.rows.length > 0) {
      console.log(`[webui] Backfilled encrypted_key for ${unencryptedKeys.rows.length} API keys`);
    }

    // Backfill encrypted_wallet_address for wallets that have plain-text wallet_address
    const unencryptedWallets = await query<{ user_id: string; wallet_address_hash: string; wallet_address: string }>(
      "SELECT user_id, wallet_address_hash, wallet_address FROM user_wallets WHERE wallet_address IS NOT NULL AND wallet_address != ''"
    );
    let walletBackfillCount = 0;
    for (const row of unencryptedWallets.rows) {
      const encrypted = encryptApiKey(row.wallet_address.toLowerCase());
      if (encrypted) {
        await query(
          'UPDATE user_wallets SET encrypted_wallet_address = $1 WHERE user_id = $2 AND wallet_address_hash = $3',
          [encrypted, row.user_id, row.wallet_address_hash]
        );
        walletBackfillCount++;
      }
    }
    if (walletBackfillCount > 0) {
      console.log(`[webui] Backfilled encrypted_wallet_address for ${walletBackfillCount} wallets`);
    }
  } catch (error) {
    console.error('[webui] user_id backfill error:', error);
  }

  // Create indexes on user_id columns
  try {
    const indexes = [
      `CREATE INDEX IF NOT EXISTS idx_webui_users_user_id ON webui_users(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_pins_user_id ON pins(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_user_credits_user_id ON user_credits(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_credit_history_user_id ON credit_history(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_user_wallets_user_id ON user_wallets(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_user_wallets_hash ON user_wallets(wallet_address_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_referral_codes_user_id ON referral_codes(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_referred_id ON referrals(referred_id)`,
    ];
    for (const sql of indexes) {
      await query(sql).catch(ignoreMigrationError);
    }

    // Migrate UNIQUE constraint from (user_email, wallet_address, chain_id) to (user_id, wallet_address_hash, chain_id)
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_wallets_uid_hash_chain ON user_wallets(user_id, wallet_address_hash, chain_id)`).catch(ignoreMigrationError);
  } catch (error) {
    console.error('[webui] Index creation error:', error);
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

// Generate JWT API key — sub is now userId (SHA-256 hash), not email
export function generateJwtApiKey(userId: string, jwtSecret: string): string {
  const payload = {
    sub: userId,
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

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 2) return '***' + email.slice(at);
  return email.slice(0, 2) + '***' + email.slice(at);
}

// Create database operations using PostgreSQL
// These functions wrap the postgres.ts module functions
export function createDbOps(jwtSecret: string): DbOps & { getUserByEmail(email: string): Promise<any> } {
  return {
    async getOrCreateUser(userId: string, email: string, name: string, picture: string, referralCode?: string) {
      return getOrCreateWebuiUser(userId, email, name, picture, jwtSecret, generateJwtApiKey, referralCode);
    },

    async getUserByEmail(email: string) {
      return getWebuiUserByEmail(email);
    },

    async getUserById(userId: string) {
      return getWebuiUserByEmail(userId); // TODO: add getWebuiUserById to postgres.ts
    },

    async getApiKeys(userId: string) {
      return getApiKeys(userId);
    },

    async createApiKey(userId: string): Promise<string> {
      return createApiKey(userId, jwtSecret, generateJwtApiKey);
    },

    async deleteApiKey(userId: string, keyId: string): Promise<boolean> {
      return deleteApiKey(userId, keyId);
    },

    async getUserPins(userId: string, page: number, limit: number, search?: string) {
      return getUserPins(userId, page, limit, search);
    },

    async getUserStats(userId: string) {
      return getUserStats(userId);
    },

    async deleteUserProfile(userId: string) {
      return deleteUserProfile(userId);
    },

    async addPin(userId: string, cid: string, name?: string) {
      return addPin(userId, cid, name);
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
        scriptSrc: ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", "https://accounts.google.com", "https://apis.google.com", "https://www.gstatic.com", "https://appleid.cdn-apple.com"],
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
          // Apple Sign-In
          "https://appleid.apple.com",
        ],
        frameSrc: ["'self'", "blob:", "https://accounts.google.com", "https://appleid.apple.com", "https://*.phantom.app", "https://verify.walletconnect.org", "https://verify.walletconnect.com", "https://*.walletconnect.org", "https://*.walletconnect.com"],
        objectSrc: ["'self'", "blob:"],
        mediaSrc: ["'self'", "blob:"],
        frameAncestors: ["'self'"],
        baseUri: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  }));

  app.use(cors({
    origin: config.nodeEnv === 'production' ? false : ['http://localhost:5173', 'http://localhost:3001'],
    credentials: true,
  }));

  // Request ID propagation
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = req.headers['x-request-id'] as string || crypto.randomUUID();
    req.headers['x-request-id'] = requestId;
    res.setHeader('X-Request-ID', requestId);
    next();
  });

  app.use(express.json());
  app.use(cookieParser());

  // Request logging (API calls only, skip static assets)
  app.use('/api/', (req: Request, _res: Response, next: NextFunction) => {
    const source = req.headers['x-system-key'] ? 'system' : req.ip;
    console.log(`<-- ${req.method} ${req.path} [${source}]`);
    next();
  });

  // Rate limiting (skip in tests)
  if (!options?.skipRateLimit) {
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      // Bypass rate limit for server-to-server calls using system key
      skip: (req) => {
        const key = req.headers['x-system-key'] as string;
        if (!key || !config.systemKey) return false;
        try {
          return key.length === config.systemKey.length &&
            crypto.timingSafeEqual(Buffer.from(key), Buffer.from(config.systemKey));
        } catch { return false; }
      },
    });
    app.use('/api/', limiter);

    // Stricter rate limit for auth endpoints
    const authLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many authentication attempts, please try again later' },
    });
    app.use('/api/auth/', authLimiter);
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
      sameSite: 'strict',
    },
  }));

  // CSRF origin validation for state-changing requests using session auth
  app.use('/api/', (req: Request, res: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    // Skip for API key / system key auth (CSRF-immune, no cookies)
    if (req.headers.authorization || req.headers['x-system-key']) return next();
    // Skip for collab and share endpoints (link-secret authorized, no session/cookies)
    const fullPath = req.originalUrl || req.url;
    if (fullPath.includes('/collab/') || fullPath.includes('/share/')) return next();
    const origin = req.headers.origin;
    if (origin) {
      const allowedOrigins = config.nodeEnv === 'production'
        ? [`https://${req.hostname}`]
        : ['http://localhost:5173', 'http://localhost:3001', `http://${req.hostname}:${config.port}`];
      if (!allowedOrigins.some(o => origin === o)) {
        return res.status(403).json({ error: 'Invalid origin' });
      }
    }
    next();
  });

  // Auth middleware (session-based for web UI)
  function requireAuth(req: Request, res: Response, next: NextFunction) {
    if (!req.session.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  }

  // Auth middleware that accepts EITHER session cookie OR Bearer API key.
  // Used for endpoints accessible from both webui (session) and Flutter (Bearer).
  async function requireSessionOrBearer(req: Request, res: Response, next: NextFunction) {
    // Check session first (webui)
    if (req.session.user) {
      return next();
    }
    // Check Bearer token (Flutter / external apps)
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const token = authHeader.substring(7);
        const userEmail = await verifyApiKey(token);
        if (userEmail) {
          const userId = getUserId(userEmail);
          req.apiUser = { email: userEmail, userId };
          return next();
        }
      } catch (_) { /* fall through to 401 */ }
    }
    return res.status(401).json({ error: 'Authentication required. Sign in or provide a valid API key.' });
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

      const userId = getUserId(userEmail);
      req.apiUser = { email: userEmail, userId };
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

      const userId = emailToUserId(email);
      const user = await dbOps.getOrCreateUser(userId, email, name || '', picture || '', referralCode || undefined);

      req.session.user = {
        id: sub,
        userId,
        email: email,
        name: name || '',
        picture: picture || '',
        provider: 'google',
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

  // Apple Sign-In endpoint
  app.post('/auth/apple', async (req: Request, res: Response) => {
    try {
      const { identityToken, user: appleUser, referralCode } = req.body;

      if (!identityToken) {
        return res.status(400).json({ error: 'Missing identity token' });
      }

      if (!config.appleClientId) {
        return res.status(500).json({ error: 'Apple Sign-In not configured' });
      }

      // Dynamically import apple-signin-auth (ESM module)
      const AppleSignIn = await import('apple-signin-auth');

      // Verify the identity token with Apple
      const applePayload = await AppleSignIn.default.verifyIdToken(identityToken, {
        audience: config.appleClientId,
        ignoreExpiration: false,
      });

      const { sub, email: tokenEmail } = applePayload;

      if (!sub) {
        return res.status(400).json({ error: 'Invalid token: missing user ID' });
      }

      // Apple only sends email on first sign-in, so we need to handle both cases
      // Priority: token email > user object email
      const userEmail = tokenEmail || appleUser?.email;

      if (!userEmail) {
        return res.status(400).json({ error: 'Email is required. Please ensure you share your email with the app.' });
      }

      // Get name from user object (only provided on first sign-in)
      const userName = appleUser?.name
        ? `${appleUser.name.firstName || ''} ${appleUser.name.lastName || ''}`.trim()
        : '';

      const userId = emailToUserId(userEmail);
      const user = await dbOps.getOrCreateUser(userId, userEmail, userName, '', referralCode || undefined);

      req.session.user = {
        id: sub,
        userId,
        email: userEmail,
        name: userName || user.name || '',
        picture: '', // Apple doesn't provide profile pictures
        provider: 'apple',
      };

      res.json({
        success: true,
        user: req.session.user,
        isNew: user.isNew,
      });
    } catch (error) {
      console.error('[webui] Apple auth error:', error);
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
      const keys = await dbOps.getApiKeys(req.session.user!.userId);
      res.json({ keys });
    } catch (error) {
      console.error('[webui] Error fetching API keys:', error);
      res.status(500).json({ error: 'Failed to fetch API keys' });
    }
  });

  app.post('/api/keys', requireAuth, async (req: Request, res: Response) => {
    try {
      const keyId = await dbOps.createApiKey(req.session.user!.userId);
      res.json({ keyId });
    } catch (error) {
      console.error('[webui] Error creating API key:', error);
      res.status(500).json({ error: 'Failed to create API key' });
    }
  });

  app.delete('/api/keys/:keyId', requireAuth, async (req: Request, res: Response) => {
    try {
      const { keyId } = req.params;
      const success = await dbOps.deleteApiKey(req.session.user!.userId, keyId);

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
      const userId = req.session.user!.userId;
      let keys = await dbOps.getApiKeys(userId);

      if (!keys || keys.length === 0) {
        const newKeyId = await dbOps.createApiKey(userId);
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

      const { pins, total } = await dbOps.getUserPins(req.session.user!.userId, page, limit, search);
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

      const keys = await dbOps.getApiKeys(req.session.user!.userId);
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

      const keys = await dbOps.getApiKeys(req.session.user!.userId);
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

      const keys = await dbOps.getApiKeys(req.session.user!.userId);
      if (!keys || keys.length === 0) {
        return res.status(400).json({ error: 'No API key found. Please create an API key first.' });
      }

      const fullUrl = `http://127.0.0.1:6000/pins/${requestId}`;
      console.log(`[webui] Refreshing pin ${requestId}`);

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

      const keys = await dbOps.getApiKeys(req.session.user!.userId);
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
      const stats = await dbOps.getUserStats(req.session.user!.userId);
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

      await dbOps.deleteUserProfile(req.session.user!.userId);

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

  // Get user's company/organization
  app.get('/api/profile/company', requireAuth, async (req: Request, res: Response) => {
    try {
      const company = await getUserCompany(req.session.user!.userId);
      res.json({ company: company || '' });
    } catch (error) {
      console.error('[webui] Error getting company:', error);
      res.status(500).json({ error: 'Failed to get company' });
    }
  });

  // Update user's company/organization
  app.put('/api/profile/company', requireAuth, async (req: Request, res: Response) => {
    try {
      const { company } = req.body;

      if (company !== undefined && typeof company !== 'string') {
        return res.status(400).json({ error: 'Company must be a string' });
      }

      // Treat empty string as null
      const companyValue = company && company.trim() ? company.trim() : null;
      await updateUserCompany(req.session.user!.userId, companyValue);
      res.json({ success: true, company: companyValue || '' });
    } catch (error) {
      console.error('[webui] Error updating company:', error);
      res.status(500).json({ error: 'Failed to update company' });
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
      const keys = await dbOps.getApiKeys(req.session.user!.userId);
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
      const keys = await dbOps.getApiKeys(req.session.user!.userId);
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
  // Route format: /api/share/v2/fetch/:bucket/*storageKey
  // - :bucket = bucket name
  // - *storageKey = IPFS CID to fetch from S3, may include path segments for chunked files
  //       e.g., "bafyabc123" or "bafyabc123.chunks/00000000"
  //
  // fula_client builds URL as: {endpoint}/{bucket}/{storageKey}
  // For chunked files: {endpoint}/{bucket}/{cid}.chunks/00000000
  app.get('/api/share/v2/fetch/:bucket/*storageKey', async (req: Request, res: Response) => {
    try {
      const { bucket } = req.params;
      // storageKey captures the full path after bucket (handles chunks paths like "cid.chunks/00000000")
      // Express 5 returns wildcard as array of path segments, so join them
      const rawStorageKey = req.params.storageKey;
      let storageKey: string;
      if (Array.isArray(rawStorageKey)) {
        storageKey = rawStorageKey.join('/');
      } else {
        storageKey = rawStorageKey as string;
      }
      // Strip leading slash if present
      if (storageKey && storageKey.startsWith('/')) {
        storageKey = storageKey.slice(1);
      }

      console.log('[webui] V2 share fetch raw params:', { bucket, rawStorageKey, storageKey });

      if (!bucket || !storageKey) {
        return res.status(400).json({ error: 'Missing bucket or storageKey parameter' });
      }

      // Validate bucket (alphanumeric, underscores, hyphens, dots)
      // Validate storageKey (same, but also allows / for chunk paths)
      const safeBucketPattern = /^[a-zA-Z0-9_\-\.]+$/;
      const safeKeyPattern = /^[a-zA-Z0-9_\-\.\/]+$/;
      if (!safeBucketPattern.test(bucket) || !safeKeyPattern.test(storageKey)) {
        console.log('[webui] V2 share fetch validation failed:', { bucket, storageKey, bucketOk: safeBucketPattern.test(bucket), keyOk: safeKeyPattern.test(storageKey) });
        return res.status(400).json({ error: 'Invalid bucket or storageKey format' });
      }

      const s3Jwt = config.s3AdminJwt;
      if (!s3Jwt) {
        console.error('[webui] S3_ADMIN_JWT not configured');
        return res.status(500).json({ error: 'Share fetch not configured' });
      }

      const s3BaseUrl = config.s3InternalUrl || 'http://127.0.0.1:9000';
      const fetchUrl = `${s3BaseUrl}/admin/fetch/${bucket}/${storageKey}`;

      console.log('[webui] V2 share fetch:', { bucket });

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

  // ============ Share Manifest Endpoints ============
  // Server-managed manifests for temporal folder shares.
  // Flutter POSTs manifest at share creation; portal GETs it at view time.
  // For temporal shares, manifest can be updated without changing the URL.

  const manifestLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many manifest requests, please try again later' },
  });

  // Upsert share manifest (called by Flutter at share creation and on temporal updates)
  app.put('/api/share/v2/manifest/:shareId', manifestLimiter, async (req: Request, res: Response) => {
    try {
      const { shareId } = req.params;
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidPattern.test(shareId)) {
        return res.status(400).json({ error: 'Invalid shareId format' });
      }

      const { encryptedManifest, expiresAt } = req.body;

      if (encryptedManifest) {
        // Encrypted path: store opaque blob, no plaintext metadata
        await query(
          `INSERT INTO share_manifests (share_id, bucket, path_scope, token_json, files, share_mode, expires_at, encrypted_manifest)
           VALUES ($1, '', '', '', NULL, '', $2, $3)
           ON CONFLICT (share_id) DO UPDATE SET
             encrypted_manifest = EXCLUDED.encrypted_manifest, expires_at = EXCLUDED.expires_at,
             bucket = '', path_scope = '', token_json = '', files = NULL, updated_at = NOW()`,
          [shareId, expiresAt || null, encryptedManifest]
        );
      } else {
        // Legacy plaintext path (backward compat)
        const { bucket, pathScope, tokenJson, files, shareMode } = req.body;
        if (!bucket || !pathScope || !tokenJson) {
          return res.status(400).json({ error: 'Missing required fields' });
        }
        await query(
          `INSERT INTO share_manifests (share_id, bucket, path_scope, token_json, files, share_mode, expires_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
           ON CONFLICT (share_id) DO UPDATE SET
             files = EXCLUDED.files, token_json = EXCLUDED.token_json, updated_at = NOW()`,
          [shareId, bucket, pathScope, tokenJson, JSON.stringify(files || null), shareMode || 'temporal', expiresAt || null]
        );
      }

      console.log('[webui] Manifest upserted for share:', shareId);
      res.json({ ok: true });
    } catch (error) {
      console.error('[webui] Error upserting manifest:', error);
      res.status(500).json({ error: 'Failed to save manifest' });
    }
  });

  // Fetch share manifest (called by portal View.tsx at view time)
  app.get('/api/share/v2/manifest/:shareId', manifestLimiter, async (req: Request, res: Response) => {
    try {
      const { shareId } = req.params;

      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidPattern.test(shareId)) {
        return res.status(400).json({ error: 'Invalid shareId format' });
      }

      const result = await query('SELECT * FROM share_manifests WHERE share_id = $1', [shareId]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Not found' });
      }

      const row = result.rows[0];
      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        return res.status(410).json({ error: 'Expired' });
      }

      // Return encrypted manifest if available, otherwise legacy plaintext
      if (row.encrypted_manifest) {
        return res.json({
          shareId: row.share_id,
          encryptedManifest: row.encrypted_manifest,
          expiresAt: row.expires_at,
        });
      }

      res.json({
        shareId: row.share_id,
        bucket: row.bucket,
        pathScope: row.path_scope,
        tokenJson: row.token_json,
        files: row.files,
        shareMode: row.share_mode,
        expiresAt: row.expires_at,
      });
    } catch (error) {
      console.error('[webui] Error fetching manifest:', error);
      res.status(500).json({ error: 'Failed to fetch manifest' });
    }
  });

  // ============ Collaboration Endpoints ============

  // Rate limiter for collaboration uploads
  const collabUploadLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many uploads, please try again later' },
  });

  const collabManifestLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many updates, please try again later' },
  });

  // Resolve S3 JWT for collab operations: creator → session user
  async function getCollabS3Jwt(groupId: string, req: Request): Promise<string | undefined> {
    // Priority 1: Creator's JWT
    try {
      const result = await query<{ creator_id: string | null }>(
        'SELECT creator_id FROM collab_manifests WHERE group_id = $1',
        [groupId]
      );
      const creatorId = result.rows[0]?.creator_id;
      console.log('[webui] getCollabS3Jwt: groupId=%s creatorId=%s', groupId, creatorId ?? 'NULL');
      if (creatorId) {
        const keys = await getApiKeys(creatorId);
        console.log('[webui] getCollabS3Jwt: creator keys count=%d', keys?.length ?? 0);
        if (keys?.length > 0) return keys[0].key_id;
      }
    } catch (e) {
      console.warn('[webui] Failed to look up creator JWT for collab:', groupId, e);
    }
    // Priority 2: Session user's JWT
    if (req.session.user?.userId) {
      try {
        const keys = await getApiKeys(req.session.user.userId);
        console.log('[webui] getCollabS3Jwt: session user keys count=%d', keys?.length ?? 0);
        if (keys?.length > 0) return keys[0].key_id;
      } catch {}
    }
    console.warn('[webui] getCollabS3Jwt: no JWT found for collab:', groupId);
    return undefined;
  }

  // Upload encrypted file for collaboration (public - link-authorized)
  app.post('/api/collab/:groupId/upload',
    requireSessionOrBearer,
    collabUploadLimiter,
    express.raw({ type: 'application/octet-stream', limit: '100mb' }),
    async (req: Request, res: Response) => {
      try {
        const { groupId } = req.params;

        // Validate groupId is UUID format
        const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidPattern.test(groupId)) {
          return res.status(400).json({ error: 'Invalid group ID format' });
        }

        const fileId = req.headers['x-collab-file-id'] as string;

        if (!fileId) {
          return res.status(400).json({ error: 'Missing x-collab-file-id header' });
        }

        const body = req.body as Buffer;
        if (!body || body.length === 0) {
          return res.status(400).json({ error: 'Empty file body' });
        }

        const s3Jwt = await getCollabS3Jwt(groupId, req);
        if (!s3Jwt) {
          console.error('[webui] No S3 JWT available for collab upload');
          return res.status(500).json({ error: 'Upload not configured' });
        }

        const s3BaseUrl = config.s3InternalUrl || 'http://127.0.0.1:9000';
        const bucket = 'fula-metadata';
        const storageKey = `.fula/collab/${groupId}/files/${fileId}`;
        const uploadUrl = `${s3BaseUrl}/${bucket}/${storageKey}`;

        console.log('[webui] Collab upload:', { groupId, fileId, size: body.length });

        const s3Response = await fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${s3Jwt}`,
            'Content-Type': 'application/octet-stream',
            'Content-Length': body.length.toString(),
          },
          body: body as unknown as BodyInit,
        });

        if (!s3Response.ok) {
          console.error('[webui] S3 upload failed:', s3Response.status, await s3Response.text());
          return res.status(s3Response.status).json({ error: 'Failed to upload file' });
        }

        return res.json({
          storageKey,
          bucket,
          fileId,
          size: body.length,
        });
      } catch (error) {
        console.error('[webui] Error in collab upload:', error);
        res.status(500).json({ error: 'Failed to upload file' });
      }
    }
  );

  // Download encrypted collab file using creator's JWT (public - link-authorized)
  app.get('/api/collab/:groupId/file/:fileId', collabManifestLimiter, async (req: Request, res: Response) => {
    try {
      const { groupId, fileId } = req.params;

      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidPattern.test(groupId) || !uuidPattern.test(fileId)) {
        return res.status(400).json({ error: 'Invalid ID format' });
      }

      const s3Jwt = await getCollabS3Jwt(groupId, req);
      if (!s3Jwt) {
        return res.status(500).json({ error: 'Download not configured' });
      }

      const s3BaseUrl = config.s3InternalUrl || 'http://127.0.0.1:9000';
      const storageKey = `.fula/collab/${groupId}/files/${fileId}`;
      const fetchUrl = `${s3BaseUrl}/fula-metadata/${storageKey}`;

      const s3Response = await fetch(fetchUrl, {
        headers: { 'Authorization': `Bearer ${s3Jwt}` },
      });

      if (!s3Response.ok) {
        console.error('[webui] Collab file fetch failed:', s3Response.status);
        return res.status(s3Response.status === 404 ? 404 : 500).json({ error: 'File not found' });
      }

      const buffer = Buffer.from(await s3Response.arrayBuffer());
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', buffer.length.toString());
      res.send(buffer);
    } catch (error) {
      console.error('[webui] Error fetching collab file:', error);
      res.status(500).json({ error: 'Failed to fetch file' });
    }
  });

  // Delete encrypted collab file from S3 (cleanup after manifest removal)
  app.delete('/api/collab/:groupId/file/:fileId',
    requireSessionOrBearer,
    collabManifestLimiter,
    async (req: Request, res: Response) => {
      try {
        const { groupId, fileId } = req.params;

        const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidPattern.test(groupId) || !uuidPattern.test(fileId)) {
          return res.status(400).json({ error: 'Invalid ID format' });
        }

        const s3Jwt = await getCollabS3Jwt(groupId, req);
        if (!s3Jwt) {
          return res.status(500).json({ error: 'Delete not configured' });
        }

        const s3BaseUrl = config.s3InternalUrl || 'http://127.0.0.1:9000';
        const storageKey = `.fula/collab/${groupId}/files/${fileId}`;
        const deleteUrl = `${s3BaseUrl}/fula-metadata/${storageKey}`;

        console.log('[webui] Collab file delete:', { groupId, fileId });

        const s3Response = await fetch(deleteUrl, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${s3Jwt}` },
        });

        if (!s3Response.ok && s3Response.status !== 404) {
          console.error('[webui] S3 delete failed:', s3Response.status);
          return res.status(s3Response.status).json({ error: 'Failed to delete file' });
        }

        return res.json({ ok: true, fileId });
      } catch (error) {
        console.error('[webui] Error deleting collab file:', error);
        res.status(500).json({ error: 'Failed to delete file' });
      }
    }
  );

  // Proxy fetch for fula files in a collab group using creator's JWT (public - link-authorized)
  app.get('/api/collab/:groupId/fula-fetch', collabManifestLimiter, async (req: Request, res: Response) => {
    try {
      const { groupId } = req.params;
      const bucket = req.query.bucket as string;
      const key = req.query.key as string;

      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidPattern.test(groupId)) {
        return res.status(400).json({ error: 'Invalid group ID' });
      }
      if (!bucket || !key) {
        return res.status(400).json({ error: 'Missing bucket or key' });
      }

      const safeBucketPattern = /^[a-zA-Z0-9_\-\.]+$/;
      const safeKeyPattern = /^[a-zA-Z0-9_\-\.\/]+$/;
      if (!safeBucketPattern.test(bucket) || !safeKeyPattern.test(key)) {
        return res.status(400).json({ error: 'Invalid bucket or key format' });
      }
      // Prevent path traversal attacks
      if (key.includes('..')) {
        return res.status(400).json({ error: 'Invalid key: path traversal not allowed' });
      }

      const s3Jwt = await getCollabS3Jwt(groupId, req);
      if (!s3Jwt) {
        return res.status(500).json({ error: 'Download not configured' });
      }

      const s3BaseUrl = config.s3InternalUrl || 'http://127.0.0.1:9000';
      const fetchUrl = `${s3BaseUrl}/${bucket}/${key}`;

      const s3Response = await fetch(fetchUrl, {
        headers: { 'Authorization': `Bearer ${s3Jwt}` },
      });

      if (!s3Response.ok) {
        console.error('[webui] Collab fula-fetch failed:', s3Response.status);
        return res.status(s3Response.status === 404 ? 404 : 500).json({ error: 'File not found' });
      }

      const buffer = Buffer.from(await s3Response.arrayBuffer());
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', buffer.length.toString());
      res.send(buffer);
    } catch (error) {
      console.error('[webui] Error in collab fula-fetch:', error);
      res.status(500).json({ error: 'Failed to fetch file' });
    }
  });

  // Update collaboration manifest (public - link-authorized)
  app.put('/api/collab/:groupId/manifest',
    requireSessionOrBearer,
    collabManifestLimiter,
    express.raw({ type: 'application/octet-stream', limit: '1mb' }),
    async (req: Request, res: Response) => {
      try {
        const { groupId } = req.params;

        // Validate groupId is UUID format
        const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidPattern.test(groupId)) {
          return res.status(400).json({ error: 'Invalid group ID format' });
        }

        const body = req.body as Buffer;
        if (!body || body.length === 0) {
          return res.status(400).json({ error: 'Empty manifest body' });
        }

        const s3Jwt = await getCollabS3Jwt(groupId, req);
        if (!s3Jwt) {
          console.error('[webui] No S3 JWT available for collab manifest update');
          return res.status(500).json({ error: 'Manifest update not configured' });
        }

        const s3BaseUrl = config.s3InternalUrl || 'http://127.0.0.1:9000';
        const bucket = 'fula-metadata';
        const storageKey = `.fula/collab/${groupId}/manifest.json`;
        const uploadUrl = `${s3BaseUrl}/${bucket}/${encodeURIComponent(storageKey)}`;

        console.log('[webui] Collab manifest update:', { groupId, size: body.length });

        const s3Response = await fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${s3Jwt}`,
            'Content-Type': 'application/json',
            'Content-Length': body.length.toString(),
          },
          body: body as unknown as BodyInit,
        });

        if (!s3Response.ok) {
          console.error('[webui] S3 manifest upload failed:', s3Response.status, await s3Response.text());
          return res.status(s3Response.status).json({ error: 'Failed to update manifest' });
        }

        return res.json({
          storageKey,
          bucket,
          groupId,
        });
      } catch (error) {
        console.error('[webui] Error in collab manifest update:', error);
        res.status(500).json({ error: 'Failed to update manifest' });
      }
    }
  );

  // Sync collaboration manifest JSON to DB (called by Flutter after manifest updates)
  app.put('/api/collab/:groupId/manifest-sync', requireSessionOrBearer, collabManifestLimiter, async (req: Request, res: Response) => {
    try {
      const { groupId } = req.params;
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidPattern.test(groupId)) {
        return res.status(400).json({ error: 'Invalid group ID format' });
      }

      // Extract creator identity from Bearer token or session
      let creatorId: string | null = null;
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        try {
          creatorId = await verifyApiKey(authHeader.substring(7));
        } catch {}
      }
      if (!creatorId && req.session.user?.userId) {
        creatorId = req.session.user.userId;
      }

      const { data, encryptedManifest } = req.body;

      if (encryptedManifest) {
        // Encrypted path: store opaque blob, clear plaintext
        // Keep original creator_id once set — all collab files are stored under creator's S3 namespace
        await query(
          `INSERT INTO collab_manifests (group_id, manifest_data, encrypted_manifest, creator_id, updated_at)
           VALUES ($1, NULL, $2, $3, NOW())
           ON CONFLICT (group_id) DO UPDATE SET
             encrypted_manifest = EXCLUDED.encrypted_manifest, manifest_data = NULL,
             creator_id = COALESCE(collab_manifests.creator_id, EXCLUDED.creator_id),
             updated_at = NOW()`,
          [groupId, encryptedManifest, creatorId]
        );
      } else if (data && typeof data === 'string') {
        // Legacy plaintext path
        await query(
          `INSERT INTO collab_manifests (group_id, manifest_data, creator_id, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (group_id) DO UPDATE SET
             manifest_data = EXCLUDED.manifest_data,
             creator_id = COALESCE(collab_manifests.creator_id, EXCLUDED.creator_id),
             updated_at = NOW()`,
          [groupId, data, creatorId]
        );
      } else {
        return res.status(400).json({ error: 'Missing manifest data' });
      }

      console.log('[webui] Collab manifest synced for group:', groupId);
      res.json({ ok: true });
    } catch (error) {
      console.error('[webui] Error syncing collab manifest:', error);
      res.status(500).json({ error: 'Failed to sync manifest' });
    }
  });

  // Fetch collaboration manifest JSON from DB (called by portal)
  app.get('/api/collab/:groupId/manifest-sync', collabManifestLimiter, async (req: Request, res: Response) => {
    try {
      const { groupId } = req.params;
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidPattern.test(groupId)) {
        return res.status(400).json({ error: 'Invalid group ID format' });
      }

      const result = await query('SELECT manifest_data, encrypted_manifest FROM collab_manifests WHERE group_id = $1', [groupId]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Not found' });
      }

      const row = result.rows[0];
      if (row.encrypted_manifest) {
        res.json({ encryptedManifest: row.encrypted_manifest });
      } else {
        res.json({ data: row.manifest_data });
      }
    } catch (error) {
      console.error('[webui] Error fetching collab manifest:', error);
      res.status(500).json({ error: 'Failed to fetch manifest' });
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
          COUNT(DISTINCT user_id) as total_users
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
      const status = await getUserCreditStatus(req.session.user!.userId);
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
      const history = await getCreditHistory(req.session.user!.userId, Math.min(limit, 100));
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

      // Fetch transaction receipt with retry logic
      let data: any = null;
      let retries = 3;
      while (retries > 0) {
        let response: globalThis.Response;
        if (chainId === 8453) {
          // Base: use direct RPC (Etherscan v2 dropped free Base support)
          const baseRpc = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
          response = await fetch(baseRpc, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] })
          });
        } else {
          let explorerUrl: string;
          switch (chainId) {
            case 1:
              explorerUrl = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${process.env.ETHERSCAN_API_KEY || ''}`;
              break;
            case 2046399126:
              explorerUrl = `https://elated-tan-skat.explorer.mainnet.skalenodes.com/api?module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}`;
              break;
            default:
              return res.status(400).json({ error: 'Unsupported chain' });
          }
          response = await fetch(explorerUrl);
        }
        data = await response.json();

        if (data.result && data.result !== null && data.result.logs) {
          break;
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
      const userId = req.session.user!.userId;
      const userEmail = req.session.user!.email;
      const fromAddressHash = hashWalletAddress(fromAddress);
      const walletResult = await query<{ count: string }>(
        `SELECT 1 FROM user_wallets
         WHERE user_id = $1 AND wallet_address_hash = $2 AND is_verified = 1`,
        [userId, fromAddressHash]
      );

      if (!walletResult.rows[0]) {
        return res.status(400).json({
          error: 'Wallet not linked to your account',
          message: `Please link wallet ${fromAddress} to your account first`,
        });
      }

      // Insert or update transaction — no plain-text email
      if (existing) {
        // Transaction exists but unclaimed - claim it
        await query(
          `UPDATE token_transactions
           SET user_id = $1, claimed_at = NOW(), ingestion_source = 'manual'
           WHERE tx_hash = $2 AND chain_id = $3`,
          [userId, txHash.toLowerCase(), chainId]
        );
      } else {
        // Insert new transaction
        await query(
          `INSERT INTO token_transactions
             (tx_hash, chain_id, from_address, to_address, amount_raw, amount_fula, block_number, block_timestamp, user_id, claimed_at, ingestion_source)
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
            userId
          ]
        );
      }

      // Credit the user
      await creditUser(userId, amountFula, `${chainId}:${txHash}`);

      console.log(`[webui] Manual claim: credited ${amountFula} FULA to ${maskEmail(userEmail)} from tx ${txHash}`);

      const newStatus = await getUserCreditStatus(userId);
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
      const wallets = await getUserWallets(req.session.user!.userId);
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
      const userId = req.session.user!.userId;

      // Verify the message contains user email or userId and wallet address (prevents replay attacks)
      if ((!message.includes(userEmail) && !message.includes(userId)) || !message.toLowerCase().includes(normalizedAddress)) {
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
        console.error('[webui] Signature verification error:', sigError);
        return res.status(400).json({ error: 'Invalid signature' });
      }

      // Check if this wallet is already linked to a DIFFERENT user
      const walletHash = hashWalletAddress(normalizedAddress);
      const existingLinkResult = await query<{ user_id: string }>(
        `SELECT user_id FROM user_wallets WHERE wallet_address_hash = $1 AND is_verified = 1`,
        [walletHash]
      );
      const existingLink = existingLinkResult.rows[0];

      if (existingLink && existingLink.user_id !== userId) {
        return res.status(400).json({
          error: 'Wallet linking failed',
          message: 'Wallet linking failed. Please try again or contact support.',
        });
      }

      // Check if chain is supported
      const chainResult = await query('SELECT 1 FROM chain_sync_state WHERE chain_id = $1 AND is_enabled = 1', [chainId]);
      if (chainResult.rows.length === 0) {
        return res.status(400).json({ error: 'Unsupported or disabled chain' });
      }

      // Link the wallet (verified) — server encrypts address for storage
      await linkWallet(userId, normalizedAddress, chainId, true);

      console.log(`[webui] Wallet linked to user ${userId.slice(0, 8)}... on chain ${chainId} (signature verified)`);

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

      const success = await unlinkWallet(req.session.user!.userId, address);

      if (!success) {
        return res.status(404).json({ error: 'Wallet not found' });
      }

      console.log(`[webui] Wallet ${address} unlinked from ${maskEmail(req.session.user!.email)}`);

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

  // Get user's referral info (codes + stats)
  app.get('/api/referral', requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = req.session.user!.userId;

      // Get all referral codes for user
      let codes = await getUserReferralCodes(userId);

      // If no codes exist, create a default one (for existing users)
      if (codes.length === 0) {
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
        await query(
          'INSERT INTO referral_codes (user_email, user_id, code, is_default) VALUES ($1, $2, $3, TRUE)',
          [userId, userId, code]
        );
        codes = [{
          code,
          name: null,
          inheritedName: null,
          isDefault: true,
          createdAt: new Date().toISOString(),
        }];
      }

      // Find the default code for legacy compatibility
      const defaultCode = codes.find(c => c.isDefault) || codes[0];

      // Get referral stats with 3-level breakdown using recursive CTE
      const levelStatsResult = await query<{ level: number; count: string; credits: string }>(`
        WITH RECURSIVE referral_chain AS (
          SELECT referred_id, 1 as level
          FROM referrals WHERE referrer_id = $1
          UNION ALL
          SELECT r.referred_id, rc.level + 1
          FROM referrals r
          JOIN referral_chain rc ON r.referrer_id = rc.referred_id
          WHERE rc.level < 3
        )
        SELECT
          rc.level,
          COUNT(*)::text as count,
          COALESCE(SUM(uc.total_deposited_fula), 0)::text as credits
        FROM referral_chain rc
        LEFT JOIN user_credits uc ON rc.referred_id = uc.user_id
        GROUP BY rc.level
        ORDER BY rc.level
      `, [userId]);
      const levelStats = levelStatsResult.rows;

      // Per-code direct-referral counts (Level 1 only, grouped by referral_code)
      const perCodeCountsResult = await query<{ code: string; total_referred: string }>(`
        SELECT rc.code, COUNT(r.id)::text AS total_referred
        FROM referral_codes rc
        LEFT JOIN referrals r
          ON r.referrer_id = rc.user_id AND r.referral_code = rc.code
        WHERE rc.user_id = $1
        GROUP BY rc.code
      `, [userId]);
      const perCodeCounts = new Map<string, number>();
      for (const row of perCodeCountsResult.rows) {
        perCodeCounts.set(row.code, parseInt(row.total_referred, 10));
      }

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
        // New: array of all codes with names
        codes: codes.map(c => ({
          code: c.code,
          name: c.name,
          displayName: c.name || c.inheritedName,
          inheritedName: c.inheritedName,
          isDefault: c.isDefault,
          createdAt: c.createdAt,
          totalReferred: perCodeCounts.get(c.code) ?? 0,
        })),
        // Legacy: single default code for backward compatibility
        code: defaultCode.code,
        createdAt: defaultCode.createdAt,
        stats,
        totalReferred: stats.level1.count,
        totalCreditsFromReferrals: stats.total.credits,
      });
    } catch (error) {
      console.error('[webui] Error getting referral info:', error);
      res.status(500).json({ error: 'Failed to get referral info' });
    }
  });

  // Create a new referral code
  app.post('/api/referral/codes', requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = req.session.user!.userId;
      const { name } = req.body;

      const result = await createUserReferralCode(userId, name || null);

      if (result.error) {
        return res.status(400).json({ error: result.error });
      }

      res.json({ code: result.code });
    } catch (error) {
      console.error('[webui] Error creating referral code:', error);
      res.status(500).json({ error: 'Failed to create referral code' });
    }
  });

  // Update a referral code's name
  app.put('/api/referral/codes/:code', requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = req.session.user!.userId;
      const { code } = req.params;
      const { name } = req.body;

      const result = await updateReferralCodeName(userId, code, name || null);

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('[webui] Error updating referral code:', error);
      res.status(500).json({ error: 'Failed to update referral code' });
    }
  });

  // Delete a referral code
  app.delete('/api/referral/codes/:code', requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = req.session.user!.userId;
      const { code } = req.params;

      const result = await deleteUserReferralCode(userId, code);

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('[webui] Error deleting referral code:', error);
      res.status(500).json({ error: 'Failed to delete referral code' });
    }
  });

  // Get list of users referred by current user (paginated)
  app.get('/api/referral/referred', requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = req.session.user!.userId;
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const offset = (page - 1) * limit;

      const referredResult = await query<{
        referred_id: string;
        joined_at: string;
        total_credits_purchased: number;
        app_downloaded: number;
        app_downloaded_at: string | null;
      }>(`
        SELECT
          r.referred_id,
          wu.created_at as joined_at,
          COALESCE(uc.total_deposited_fula, 0) as total_credits_purchased,
          COALESCE(wu.app_downloaded, 0) as app_downloaded,
          wu.app_downloaded_at
        FROM referrals r
        JOIN webui_users wu ON r.referred_id = wu.user_id
        LEFT JOIN user_credits uc ON r.referred_id = uc.user_id
        WHERE r.referrer_id = $1
        ORDER BY r.referred_at DESC
        LIMIT $2 OFFSET $3
      `, [userId, limit, offset]);
      const referred = referredResult.rows;

      const countResult = await query<{ total: string }>('SELECT COUNT(*)::text as total FROM referrals WHERE referrer_id = $1', [userId]);
      const total = parseInt(countResult.rows[0]?.total || '0', 10);

      res.json({
        items: referred.map(r => ({
          userId: r.referred_id,
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
      const userId = req.session.user!.userId;

      // Update the user's app_downloaded status
      await query(`
        UPDATE webui_users
        SET app_downloaded = 1, app_downloaded_at = NOW()
        WHERE user_id = $1 AND app_downloaded = 0
      `, [userId]);

      res.json({ success: true });
    } catch (error) {
      console.error('[webui] Error marking app as downloaded:', error);
      res.status(500).json({ error: 'Failed to mark app as downloaded' });
    }
  });

  // Get referrals for a specific user (for multi-level lazy loading)
  // User can only view their own referral chain
  // :email param accepts either an email (hashed to userId) or a userId hash directly
  app.get('/api/referral/chain/:email', requireAuth, async (req: Request, res: Response) => {
    try {
      const currentUserId = req.session.user!.userId;
      const param = decodeURIComponent(req.params.email);
      // If param looks like a 64-char hex hash, use directly; otherwise hash it
      const targetUserId = /^[a-f0-9]{64}$/.test(param) ? param : emailToUserId(param);
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const offset = (page - 1) * limit;

      // Optional per-code filter — only applied when the target is the current user
      // (filtering deeper levels by the requester's code is meaningless: child users have their own codes).
      const codeParamRaw = typeof req.query.code === 'string' ? req.query.code : '';
      let codeFilter: string | null = null;
      if (codeParamRaw) {
        if (!/^[A-Z0-9]{4,16}$/.test(codeParamRaw)) {
          return res.status(400).json({ error: 'Invalid code format' });
        }
        if (targetUserId === currentUserId) {
          const ownsCode = await query(
            'SELECT 1 FROM referral_codes WHERE user_id = $1 AND code = $2',
            [currentUserId, codeParamRaw]
          );
          if (ownsCode.rows.length === 0) {
            return res.status(403).json({ error: 'Code does not belong to user' });
          }
          codeFilter = codeParamRaw;
        }
        // For nested expansions (targetUserId !== currentUserId), silently ignore.
      }

      // Verify the target is in the current user's referral chain (up to 3 levels)
      const isInChainResult = await query(`
        WITH RECURSIVE referral_chain AS (
          SELECT referred_id, 1 as level
          FROM referrals WHERE referrer_id = $1
          UNION ALL
          SELECT r.referred_id, rc.level + 1
          FROM referrals r
          JOIN referral_chain rc ON r.referrer_id = rc.referred_id
          WHERE rc.level < 3
        )
        SELECT 1 FROM referral_chain WHERE referred_id = $2
        UNION
        SELECT 1 WHERE $3 = $4
      `, [currentUserId, targetUserId, currentUserId, targetUserId]);

      if (isInChainResult.rows.length === 0) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const codeSql = codeFilter ? ' AND r.referral_code = $4' : '';
      const dataParams: (string | number)[] = codeFilter
        ? [targetUserId, limit, offset, codeFilter]
        : [targetUserId, limit, offset];

      const referredResult = await query<{
        referred_id: string;
        joined_at: string;
        total_credits_purchased: number;
        app_downloaded: number;
        app_downloaded_at: string | null;
        referral_count: string;
      }>(`
        SELECT
          r.referred_id,
          wu.created_at as joined_at,
          COALESCE(uc.total_deposited_fula, 0) as total_credits_purchased,
          COALESCE(wu.app_downloaded, 0) as app_downloaded,
          wu.app_downloaded_at,
          (SELECT COUNT(*)::text FROM referrals WHERE referrer_id = r.referred_id) as referral_count
        FROM referrals r
        JOIN webui_users wu ON r.referred_id = wu.user_id
        LEFT JOIN user_credits uc ON r.referred_id = uc.user_id
        WHERE r.referrer_id = $1${codeSql}
        ORDER BY r.referred_at DESC
        LIMIT $2 OFFSET $3
      `, dataParams);
      const referred = referredResult.rows;

      const countSql = codeFilter
        ? 'SELECT COUNT(*)::text as total FROM referrals WHERE referrer_id = $1 AND referral_code = $2'
        : 'SELECT COUNT(*)::text as total FROM referrals WHERE referrer_id = $1';
      const countParams: string[] = codeFilter ? [targetUserId, codeFilter] : [targetUserId];
      const countResult = await query<{ total: string }>(countSql, countParams);
      const total = parseInt(countResult.rows[0]?.total || '0', 10);

      res.json({
        items: referred.map(r => ({
          userId: r.referred_id,
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
    if (!isAdminById(req.session.user.userId)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  }

  // Admin OR System Key middleware (for x402 gateway integration)
  function requireAdminOrSystemKey(req: Request, res: Response, next: NextFunction) {
    // Check for system key in header
    const systemKeyHeader = req.header('X-System-Key');
    if (systemKeyHeader && config.systemKey &&
        systemKeyHeader.length === config.systemKey.length &&
        crypto.timingSafeEqual(Buffer.from(systemKeyHeader), Buffer.from(config.systemKey))) {
      // System key authentication - mark as system caller
      (req as any).isSystemCall = true;
      return next();
    }

    // Fall back to admin session authentication
    if (!req.session.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!isAdminById(req.session.user.userId)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  }

  // Admin audit logging helper — no plain-text email stored
  async function logAdminAction(actor: string, action: string, targetEmail?: string, details?: Record<string, unknown>) {
    try {
      const actorId = actor.includes('@') ? emailToUserId(actor) : actor;
      const targetId = targetEmail ? (targetEmail.includes('@') ? emailToUserId(targetEmail) : targetEmail) : null;
      await query(
        `INSERT INTO admin_audit_log (action, details, actor_id, target_id) VALUES ($1, $2, $3, $4)`,
        [action, details ? JSON.stringify(details) : null, actorId, targetId]
      );
    } catch (err) {
      console.error('[audit] Failed to log admin action:', err);
    }
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
      const { userId: directUserId, email } = req.body;

      const targetUserId = directUserId || (email ? emailToUserId(email) : null);
      if (!targetUserId) {
        return res.status(400).json({ error: 'userId or email is required' });
      }
      const success = await unsuspendUser(targetUserId);

      if (!success) {
        return res.status(404).json({ error: 'User not found or not suspended' });
      }

      const adminUserId = req.session.user!.userId;
      console.log(`[webui] Admin ${adminUserId.slice(0, 8)} unsuspended ${targetUserId.slice(0, 8)}`);
      await logAdminAction(adminUserId, 'unsuspend', email);

      res.json({ success: true });
    } catch (error) {
      console.error('[webui] Error unsuspending user:', error);
      res.status(500).json({ error: 'Failed to unsuspend user' });
    }
  });

  // Manual credit adjustment (admin or system key for x402 gateway)
  // Accepts { userId, amount, reason } or { email, amount, reason } (backward compat)
  app.post('/api/admin/adjust', requireAdminOrSystemKey, async (req: Request, res: Response) => {
    try {
      const { userId: directUserId, email, amount, reason } = req.body;

      const targetUserId = directUserId || (email ? emailToUserId(email) : null);
      if (!targetUserId || amount === undefined || !reason) {
        return res.status(400).json({ error: 'userId (or email), amount, and reason are required' });
      }

      const numAmount = parseFloat(amount);
      if (isNaN(numAmount)) {
        return res.status(400).json({ error: 'Invalid amount' });
      }

      // Determine caller for audit log
      const isSystemCall = (req as any).isSystemCall;
      const caller = isSystemCall ? 'system:x402' : `admin:${req.session.user!.userId}`;

      await creditUser(targetUserId, numAmount, `${caller}:${reason}`, 'adjustment');

      console.log(`[webui] ${caller} adjusted ${targetUserId.slice(0, 8)}... by ${numAmount} FULA: ${reason}`);
      await logAdminAction(caller, 'adjust', targetUserId, { amount: numAmount, reason });

      const newStatus = await getUserCreditStatus(targetUserId);

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

  // Admin: scan specific blocks to pick up missed transactions
  app.post('/api/admin/scan-blocks', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { chainId, blocks } = req.body; // blocks: number[]
      if (!chainId || !Array.isArray(blocks) || blocks.length === 0) {
        return res.status(400).json({ error: 'chainId and blocks[] required' });
      }

      const chains = await getEnabledChains();
      const chain = chains.find(c => c.chainId === chainId);
      if (!chain) {
        return res.status(400).json({ error: `Chain ${chainId} not found or disabled` });
      }

      const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
      const vaultPadded = '0x' + chain.vaultAddress.slice(2).toLowerCase().padStart(64, '0');

      const results = [];
      for (const block of blocks) {
        const blockHex = '0x' + block.toString(16);
        const resp = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'eth_getLogs',
            params: [{
              address: chain.tokenAddress,
              topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', null, vaultPadded],
              fromBlock: blockHex, toBlock: blockHex
            }]
          })
        });
        const data = await resp.json();
        const logs = data.result || [];

        let credited = 0;
        for (const log of logs) {
          const isNew = await processTransfer(chainId, {
            hash: log.transactionHash,
            from: '0x' + log.topics[1].slice(26),
            to: '0x' + log.topics[2].slice(26),
            value: BigInt(log.data).toString(),
            blockNumber: parseInt(log.blockNumber, 16).toString(),
            timeStamp: log.blockTimestamp ? parseInt(log.blockTimestamp, 16).toString() : Math.floor(Date.now() / 1000).toString()
          });
          if (isNew) credited++;
        }
        results.push({ block, transfers: logs.length, credited });
      }

      console.log(`[admin] ${maskEmail(req.session.user!.email)} scanned ${blocks.length} blocks on chain ${chainId}:`, results);
      res.json({ results });
    } catch (error) {
      console.error('[admin] Error scanning blocks:', error);
      res.status(500).json({ error: 'Failed to scan blocks' });
    }
  });

  // Ensure user exists and get/create API key (for x402 gateway wallet users)
  // Creates user if doesn't exist, creates API key if user has none
  // Returns the API key for use in x402 requests
  // Accepts { userId } or { email } (backward compat — email is hashed to userId)
  app.post('/api/admin/ensure-user-key', requireAdminOrSystemKey, async (req: Request, res: Response) => {
    const { userId: directUserId, email } = req.body;

    const userId = directUserId || (email ? emailToUserId(email) : null);
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'userId or email required' });
    }

    try {
      // 1. Check if user exists in webui_users
      let user = await getWebuiUserById(userId);

      if (!user) {
        // 2. Create user in webui_users — no plain-text email
        const displayName = email ? email.split('@')[0] : `wallet-${userId.slice(0, 8)}`;
        await query(
          `INSERT INTO webui_users (user_id, name, picture) VALUES ($1, $2, $3)`,
          [userId, displayName, null]
        );

        // Also create in main users table for pinning service compatibility
        await query(
          `INSERT INTO users (user_id, password_hash, pool_id) VALUES ($1, $2, 1)
           ON CONFLICT (user_id) DO NOTHING`,
          [userId, 'x402-wallet-user-' + uuidv4()]
        );

        console.log(`[webui] Created x402 wallet user: ${userId.slice(0, 8)}...`);
      }

      // 3. Check if user has an API key
      const existingKeys = await dbOps.getApiKeys(userId);

      let apiKey: string;
      if (existingKeys.length > 0) {
        // User has a key, return the first one
        apiKey = existingKeys[0].key_id;
      } else {
        // Create new API key
        apiKey = await dbOps.createApiKey(userId);
        console.log(`[webui] Created API key for x402 user: ${userId.slice(0, 8)}...`);
      }

      const caller = (req as any).isSystemCall ? 'system:x402' : `admin:${req.session.user?.userId || 'unknown'}`;
      await logAdminAction(caller, 'ensure-user-key', userId);

      res.json({ success: true, userId, apiKey });

    } catch (error) {
      console.error('[webui] ensure-user-key error:', error);
      res.status(500).json({ error: 'Failed to ensure user/key' });
    }
  });

  // Check if current user is admin (for frontend)
  app.get('/api/admin/check', requireAuth, (req: Request, res: Response) => {
    if (isAdminById(req.session.user!.userId)) {
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
        user_id: string;
        code: string;
        codecreatedat: string;
        totalreferred: string;
        totalcreditsfromreferrals: string;
      }>(`
        SELECT
          rc.user_id,
          rc.code,
          rc.created_at as codeCreatedAt,
          COUNT(r.id)::text as totalReferred,
          COALESCE(SUM(uc.total_deposited_fula), 0)::text as totalCreditsFromReferrals
        FROM referral_codes rc
        LEFT JOIN referrals r ON rc.user_id = r.referrer_id AND rc.code = r.referral_code
        LEFT JOIN user_credits uc ON r.referred_id = uc.user_id
        GROUP BY rc.user_id, rc.code, rc.created_at
        ${includeZero ? '' : 'HAVING COUNT(r.id) > 0'}
        ORDER BY COUNT(r.id) DESC, rc.created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]);
      const referrers = referrersResult.rows.map(r => ({
        userId: r.user_id,
        code: r.code,
        codeCreatedAt: r.codecreatedat,
        totalReferred: parseInt(r.totalreferred, 10),
        totalCreditsFromReferrals: parseFloat(r.totalcreditsfromreferrals),
      }));

      // Get total count of (user_id, code) rows matching the same per-code filter as the data query
      const countResult = await query<{ total: string }>(`
        SELECT COUNT(*)::text as total FROM (
          SELECT rc.user_id, rc.code
          FROM referral_codes rc
          LEFT JOIN referrals r ON rc.user_id = r.referrer_id AND rc.code = r.referral_code
          GROUP BY rc.user_id, rc.code
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
        referrer_id: string;
        referral_code: string;
        referred_id: string | null;
        referred_user_joined_at: string | null;
        referred_at: string | null;
        credits_purchased: number;
      }>(`
        SELECT
          rc.user_id as referrer_id,
          rc.code as referral_code,
          r.referred_id,
          wu.created_at as referred_user_joined_at,
          r.referred_at,
          COALESCE(uc.total_deposited_fula, 0) as credits_purchased
        FROM referral_codes rc
        LEFT JOIN referrals r ON rc.user_id = r.referrer_id
        LEFT JOIN webui_users wu ON r.referred_id = wu.user_id
        LEFT JOIN user_credits uc ON r.referred_id = uc.user_id
        ORDER BY rc.user_id, r.referred_at
        LIMIT 100000
      `);
      const data = dataResult.rows;

      // Generate CSV
      const headers = ['Referrer User ID', 'Referral Code', 'Referred User ID', 'Referred User Joined At', 'Referred At', 'Credits Purchased'];
      const csvRows = [headers.join(',')];

      for (const row of data) {
        csvRows.push([
          row.referrer_id,
          row.referral_code,
          row.referred_id || '',
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
  // :email param accepts either an email (hashed to userId) or a userId hash directly
  app.get('/api/admin/referrals/chain/:email', requireAdmin, async (req: Request, res: Response) => {
    try {
      const param = decodeURIComponent(req.params.email);
      const targetUserId = /^[a-f0-9]{64}$/.test(param) ? param : emailToUserId(param);
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const offset = (page - 1) * limit;

      // Optional per-code filter — validates the code belongs to the target user
      const codeParamRaw = typeof req.query.code === 'string' ? req.query.code : '';
      let codeFilter: string | null = null;
      if (codeParamRaw) {
        if (!/^[A-Z0-9]{4,16}$/.test(codeParamRaw)) {
          return res.status(400).json({ error: 'Invalid code format' });
        }
        const ownsCode = await query(
          'SELECT 1 FROM referral_codes WHERE user_id = $1 AND code = $2',
          [targetUserId, codeParamRaw]
        );
        if (ownsCode.rows.length === 0) {
          return res.status(404).json({ error: 'Code not found for this user' });
        }
        codeFilter = codeParamRaw;
      }

      const codeSql = codeFilter ? ' AND r.referral_code = $4' : '';
      const dataParams: (string | number)[] = codeFilter
        ? [targetUserId, limit, offset, codeFilter]
        : [targetUserId, limit, offset];

      const referredResult = await query<{
        referred_id: string;
        joined_at: string;
        referred_at: string;
        total_credits_purchased: number;
        app_downloaded: number;
        app_downloaded_at: string | null;
        referral_count: string;
      }>(`
        SELECT
          r.referred_id,
          wu.created_at as joined_at,
          r.referred_at,
          COALESCE(uc.total_deposited_fula, 0) as total_credits_purchased,
          COALESCE(wu.app_downloaded, 0) as app_downloaded,
          wu.app_downloaded_at,
          (SELECT COUNT(*)::text FROM referrals WHERE referrer_id = r.referred_id) as referral_count
        FROM referrals r
        JOIN webui_users wu ON r.referred_id = wu.user_id
        LEFT JOIN user_credits uc ON r.referred_id = uc.user_id
        WHERE r.referrer_id = $1${codeSql}
        ORDER BY r.referred_at DESC
        LIMIT $2 OFFSET $3
      `, dataParams);
      const referred = referredResult.rows;

      const countSql = codeFilter
        ? 'SELECT COUNT(*)::text as total FROM referrals WHERE referrer_id = $1 AND referral_code = $2'
        : 'SELECT COUNT(*)::text as total FROM referrals WHERE referrer_id = $1';
      const countParams: string[] = codeFilter ? [targetUserId, codeFilter] : [targetUserId];
      const countResult = await query<{ total: string }>(countSql, countParams);
      const total = parseInt(countResult.rows[0]?.total || '0', 10);

      res.json({
        items: referred.map(r => ({
          userId: r.referred_id,
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
  // :email param accepts either an email (hashed to userId) or a userId hash directly
  app.get('/api/admin/referrals/:email', requireAdmin, async (req: Request, res: Response) => {
    try {
      const param = decodeURIComponent(req.params.email);
      const referrerUserId = /^[a-f0-9]{64}$/.test(param) ? param : emailToUserId(param);
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const offset = (page - 1) * limit;

      const referredResult = await query<{
        referred_id: string;
        joinedat: string;
        referredat: string;
        totalcreditspurchased: number;
        appdownloaded: number;
        appdownloadedat: string | null;
      }>(`
        SELECT
          r.referred_id,
          wu.created_at as joinedAt,
          r.referred_at as referredAt,
          COALESCE(uc.total_deposited_fula, 0) as totalCreditsPurchased,
          COALESCE(wu.app_downloaded, 0) as appDownloaded,
          wu.app_downloaded_at as appDownloadedAt
        FROM referrals r
        JOIN webui_users wu ON r.referred_id = wu.user_id
        LEFT JOIN user_credits uc ON r.referred_id = uc.user_id
        WHERE r.referrer_id = $1
        ORDER BY r.referred_at DESC
        LIMIT $2 OFFSET $3
      `, [referrerUserId, limit, offset]);
      const referred = referredResult.rows;

      const countResult = await query<{ total: string }>('SELECT COUNT(*)::text as total FROM referrals WHERE referrer_id = $1', [referrerUserId]);
      const total = parseInt(countResult.rows[0]?.total || '0', 10);

      // Get referrer info
      const referrerInfoResult = await query<{ code: string }>('SELECT code FROM referral_codes WHERE user_id = $1', [referrerUserId]);
      const referrerInfo = referrerInfoResult.rows[0];

      res.json({
        referrerUserId,
        referrerCode: referrerInfo?.code || null,
        items: referred.map(r => ({
          userId: r.referred_id,
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

  // ============ CID Policies (Admin) ============
  // Gateway (ipfs-server) reads blocked_cids to short-circuit responses:
  //   mode='block'    → HTTP 451
  //   mode='redirect' → HTTP 301 to https://{cid}.ipfs.dweb.link/
  // Table name stays `blocked_cids` for backward compat; admin path is /cid-policies.

  // Lazy CID loader — multiformats is ESM-only; its typings aren't reachable
  // through package `exports`, so the dynamic import is typed as any.
  let _CidPoliciesCIDCtor: any = null;
  async function normalizeCidOrThrow(input: string): Promise<string> {
    if (!_CidPoliciesCIDCtor) {
      // @ts-ignore — multiformats ships types at /types/src but not via `exports`
      const mod: any = await import('multiformats/cid');
      _CidPoliciesCIDCtor = mod.CID;
    }
    return _CidPoliciesCIDCtor.parse(String(input).trim()).toV1().toString();
  }

  type CidMode = 'block' | 'redirect';

  // List CID policies (admin only, paginated)
  app.get('/api/admin/cid-policies', requireAdmin, async (req: Request, res: Response) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
      const offset = (page - 1) * limit;

      const rowsResult = await query<{
        id: number;
        cid: string;
        reason: string | null;
        blocked_by: string | null;
        created_at: string;
        mode: CidMode;
      }>(
        `SELECT id, cid, reason, blocked_by, created_at, mode
           FROM blocked_cids
           ORDER BY created_at DESC
           LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      const countResult = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM blocked_cids`
      );

      res.json({
        items: rowsResult.rows,
        page,
        limit,
        total: parseInt(countResult.rows[0].count, 10),
      });
    } catch (error) {
      console.error('[webui] Error listing CID policies:', error);
      res.status(500).json({ error: 'Failed to list CID policies' });
    }
  });

  // Add a CID policy (admin only). Strict: any duplicate returns 409.
  app.post('/api/admin/cid-policies', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { cid, reason, mode } = req.body as {
        cid?: string;
        reason?: string;
        mode?: CidMode;
      };
      if (!cid || typeof cid !== 'string') {
        return res.status(400).json({ error: 'cid is required' });
      }
      const resolvedMode: CidMode = mode ?? 'block';
      if (resolvedMode !== 'block' && resolvedMode !== 'redirect') {
        return res.status(400).json({ error: "mode must be 'block' or 'redirect'" });
      }

      let normalized: string;
      try {
        normalized = await normalizeCidOrThrow(cid);
      } catch {
        return res.status(400).json({ error: 'Invalid CID' });
      }

      const adminUserId = req.session.user!.userId;

      let result;
      try {
        result = await query<{ id: number; cid: string; created_at: string; mode: CidMode }>(
          `INSERT INTO blocked_cids (cid, reason, blocked_by, mode)
             VALUES ($1, $2, $3, $4)
             RETURNING id, cid, created_at, mode`,
          [normalized, reason ?? null, adminUserId, resolvedMode]
        );
      } catch (e: any) {
        if (e?.code === '23505') {
          // unique_violation on cid — fetch existing mode for a useful error message
          const existing = await query<{ mode: CidMode }>(
            `SELECT mode FROM blocked_cids WHERE cid = $1`,
            [normalized]
          );
          const existingMode: CidMode = (existing.rows[0]?.mode as CidMode) ?? 'block';
          return res.status(409).json({
            error: `CID is already in the policy list (mode='${existingMode}'). Remove it first to change.`,
            existingMode,
          });
        }
        throw e;
      }

      await logAdminAction(adminUserId, 'add-cid-policy', undefined, {
        cid: normalized,
        reason: reason ?? null,
        mode: resolvedMode,
      });

      res.json({ success: true, entry: result.rows[0] });
    } catch (error) {
      console.error('[webui] Error adding CID policy:', error);
      res.status(500).json({ error: 'Failed to add CID policy' });
    }
  });

  // Remove a CID policy (admin only)
  app.delete('/api/admin/cid-policies/:cid', requireAdmin, async (req: Request, res: Response) => {
    try {
      const rawCid = req.params.cid;
      let normalized: string;
      try {
        normalized = await normalizeCidOrThrow(rawCid);
      } catch {
        return res.status(400).json({ error: 'Invalid CID' });
      }

      const result = await query<{ mode: CidMode }>(
        `DELETE FROM blocked_cids WHERE cid = $1 RETURNING mode`,
        [normalized]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'CID not in policy list' });
      }

      const adminUserId = req.session.user!.userId;
      await logAdminAction(adminUserId, 'remove-cid-policy', undefined, {
        cid: normalized,
        mode: result.rows[0].mode,
      });

      res.json({ success: true });
    } catch (error) {
      console.error('[webui] Error removing CID policy:', error);
      res.status(500).json({ error: 'Failed to remove CID policy' });
    }
  });

  // ============================================================
  // Phase 3.2 — Fula publisher / chain-anchor admin triggers.
  //
  // These routes proxy operator-initiated requests to two
  // master-side services so the runbook (deploy step 4 + step 6)
  // doesn't require waiting up to 5 min for the periodic publisher
  // tick OR up to 12h for the chain-anchor cron.
  //
  //   POST /api/admin/fula/publish-now   →  fula-cli /_internal/publish-now
  //   POST /api/admin/fula/anchor-now    →  mainnet-rewards /admin/users-index-anchor/trigger
  //
  // Auth: pinning-webui session cookie (`requireAdmin`). The
  // outbound call carries `Authorization: Bearer <FULA_USERS_INDEX_INTERNAL_TOKEN>`,
  // sourced from `config.fulaUsersIndexInternalToken`.
  //
  // The token is identical across the master operator's three .env
  // files (fula-cli + mainnet-rewards + pinning-webui). The
  // setup-users-index-publisher.sh script writes it to the first
  // two; the operator must replicate it into pinning-webui's .env
  // for these admin routes to work. If the token isn't configured
  // here, both routes return 503 (fail-closed parity with the
  // upstream services). Both routes pass through the upstream's
  // status code + body so the UI can render the same shape
  // (200 with structured outcome / 401 mismatch / 409 in-flight /
  // 503 disabled / 500 internal).

  app.post(
    '/api/admin/fula/publish-now',
    requireAdmin,
    async (_req: Request, res: Response) => {
      const token = config.fulaUsersIndexInternalToken;
      if (!token) {
        return res.status(503).json({
          error:
            'fula publisher admin trigger unavailable (FULA_USERS_INDEX_INTERNAL_TOKEN not set in pinning-webui env)',
        });
      }
      const baseUrl = config.fulaCliInternalUrl || 'http://127.0.0.1:9000';
      try {
        const upstream = await httpPost(
          `${baseUrl}/_internal/publish-now`,
          {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          '',
        );
        // Pass through upstream status + body. The body is a JSON
        // string when fula-cli succeeds (PublishNowResponse) or a
        // plain text error string when it fails. Try to parse JSON;
        // if that fails wrap the raw text into an `{error}` object.
        let parsed: unknown;
        try {
          parsed = JSON.parse(upstream.data);
        } catch {
          parsed = { error: upstream.data || 'unknown upstream response' };
        }
        return res.status(upstream.status).json(parsed);
      } catch (e) {
        console.error('[webui] /api/admin/fula/publish-now upstream call failed:', e);
        return res.status(502).json({
          error: `failed to reach fula-cli /_internal/publish-now: ${
            (e as Error).message
          }`,
        });
      }
    },
  );

  app.post(
    '/api/admin/fula/anchor-now',
    requireAdmin,
    async (_req: Request, res: Response) => {
      const token = config.fulaUsersIndexInternalToken;
      if (!token) {
        return res.status(503).json({
          error:
            'fula anchor admin trigger unavailable (FULA_USERS_INDEX_INTERNAL_TOKEN not set in pinning-webui env)',
        });
      }
      const baseUrl = config.mainnetRewardsUrl || 'http://127.0.0.1:5667';
      try {
        const upstream = await httpPost(
          `${baseUrl}/admin/users-index-anchor/trigger`,
          {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          '',
        );
        let parsed: unknown;
        try {
          parsed = JSON.parse(upstream.data);
        } catch {
          parsed = { error: upstream.data || 'unknown upstream response' };
        }
        return res.status(upstream.status).json(parsed);
      } catch (e) {
        console.error('[webui] /api/admin/fula/anchor-now upstream call failed:', e);
        return res.status(502).json({
          error: `failed to reach mainnet-rewards /admin/users-index-anchor/trigger: ${
            (e as Error).message
          }`,
        });
      }
    },
  );

  // ============ API v1 Endpoints (Bearer Token Auth for External Apps) ============
  // These endpoints use API key (JWT) authentication instead of browser sessions
  // Existing /api/* endpoints remain unchanged for web UI compatibility

  // GET /api/v1/userinfo - User information (company/organization)
  app.get('/api/v1/userinfo', requireApiAuth, async (req: Request, res: Response) => {
    try {
      const company = await getUserCompany(req.apiUser!.userId);
      res.json({ org: company || '' });
    } catch (error) {
      console.error('[webui] Error getting userinfo:', error);
      res.status(500).json({ error: 'Failed to get user info' });
    }
  });

  // GET /api/v1/storage - Storage usage and credit info
  app.get('/api/v1/storage', requireApiAuth, async (req: Request, res: Response) => {
    try {
      const status = await getUserCreditStatus(req.apiUser!.userId);

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
      const wallets = await getUserWallets(req.apiUser!.userId);
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
      const userId = req.apiUser!.userId;

      // Verify the message contains user email or userId and wallet address (prevents replay attacks)
      if ((!message.includes(userEmail) && !message.includes(userId)) || !message.toLowerCase().includes(normalizedAddress)) {
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
      const walletHash = hashWalletAddress(normalizedAddress);
      const existingLinkResult = await query<{ user_id: string }>(
        `SELECT user_id FROM user_wallets WHERE wallet_address_hash = $1 AND is_verified = 1`,
        [walletHash]
      );
      const existingLink = existingLinkResult.rows[0];

      if (existingLink && existingLink.user_id !== userId) {
        return res.status(400).json({
          error: 'Wallet linking failed',
          message: 'Wallet linking failed. Please try again or contact support.',
        });
      }

      // Check if chain is supported
      const chainCheckResult = await query('SELECT 1 FROM chain_sync_state WHERE chain_id = $1 AND is_enabled = 1', [chainId]);
      if (chainCheckResult.rows.length === 0) {
        return res.status(400).json({ error: 'Unsupported or disabled chain' });
      }

      // Link the wallet (verified) — server encrypts address for storage
      await linkWallet(userId, normalizedAddress, chainId, true);

      console.log(`[api/v1] Wallet linked to user ${userId.slice(0, 8)}... on chain ${chainId}`);

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

      // Fetch transaction receipt with retry logic
      let data: any = null;
      let retries = 3;
      while (retries > 0) {
        let response: globalThis.Response;
        if (chainId === 8453) {
          // Base: use direct RPC (Etherscan v2 dropped free Base support)
          const baseRpc = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
          response = await fetch(baseRpc, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] })
          });
        } else {
          let explorerUrl: string;
          switch (chainId) {
            case 1:
              explorerUrl = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${process.env.ETHERSCAN_API_KEY || ''}`;
              break;
            case 2046399126:
              explorerUrl = `https://elated-tan-skat.explorer.mainnet.skalenodes.com/api?module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}`;
              break;
            default:
              return res.status(400).json({ error: 'Unsupported chain' });
          }
          response = await fetch(explorerUrl);
        }
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
      const userId = req.apiUser!.userId;
      const fromAddressHash = hashWalletAddress(fromAddress);
      const walletResult = await query(
        `SELECT 1 FROM user_wallets WHERE user_id = $1 AND wallet_address_hash = $2 AND is_verified = 1`,
        [userId, fromAddressHash]
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
           SET user_email = $1, user_id = $2, claimed_at = NOW(), ingestion_source = 'manual'
           WHERE tx_hash = $3 AND chain_id = $4`,
          [userEmail, userId, txHash.toLowerCase(), chainId]
        );
      } else {
        await query(
          `INSERT INTO token_transactions
            (tx_hash, chain_id, from_address, to_address, amount_raw, amount_fula, block_number, block_timestamp, user_email, user_id, claimed_at, ingestion_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), 'manual')`,
          [
            txHash.toLowerCase(),
            chainId,
            fromAddress,
            vaultAddressLower,
            amountRaw,
            amountFula,
            parseInt(receipt.blockNumber, 16),
            Math.floor(Date.now() / 1000),
            userEmail,
            userId
          ]
        );
      }

      // Credit the user
      await creditUser(userId, amountFula, `${chainId}:${txHash}`);

      console.log(`[api/v1] Claim: credited ${amountFula} FULA to ${maskEmail(userEmail)} from tx ${txHash}`);

      const newStatus = await getUserCreditStatus(userId);
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

      const userId = req.apiUser!.userId;

      // Get total count
      const countResult = await query<{ total: string }>(
        `SELECT COUNT(*)::text as total FROM credit_history WHERE user_id = $1`,
        [userId]
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
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `, [userId, limit, offset]);
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

  // =========================================================================
  // NFT Meta-Tx Relay (gasless claims on Base)
  // =========================================================================

  app.post('/api/v1/nft/relay', async (req: Request, res: Response) => {
    try {
      const { action, chainId, secret, claimKey, signer, deadline, nonce, signature, tokenId, amount } = req.body;

      // Validate required fields
      if (!action || !chainId || !signer || deadline == null || nonce == null || !signature) {
        res.status(400).json({ error: 'Missing required fields: action, chainId, signer, deadline, nonce, signature' });
        return;
      }

      // Claim action requires secret; burn/transferBack require claimKey
      if (action === 'claimNFT' && !secret) {
        res.status(400).json({ error: 'claimNFT requires secret field' });
        return;
      }
      if ((action === 'burn' || action === 'transferBack') && !claimKey) {
        res.status(400).json({ error: `${action} requires claimKey field` });
        return;
      }

      // Supported relay chains: Base (8453) and Skale Europa (2046399126)
      const RELAY_CHAINS: Record<number, { rpcEnvVar: string; contractEnvVar: string; freeGas: boolean }> = {
        8453: { rpcEnvVar: 'BASE_RPC_URL', contractEnvVar: 'NFT_CONTRACT_ADDRESS', freeGas: false },
        2046399126: { rpcEnvVar: 'SKALE_RPC_URL', contractEnvVar: 'NFT_CONTRACT_ADDRESS_SKALE', freeGas: true },
      };
      const chainConfig = RELAY_CHAINS[chainId as number];
      if (!chainConfig) {
        res.status(400).json({ error: `Gasless relay not supported on chainId ${chainId}. Supported: ${Object.keys(RELAY_CHAINS).join(', ')}` });
        return;
      }

      // Validate action
      const validActions = ['claimNFT', 'burn', 'transferBack'];
      if (!validActions.includes(action)) {
        res.status(400).json({ error: `Invalid action. Must be one of: ${validActions.join(', ')}` });
        return;
      }

      // Validate burn/transferBack require tokenId
      if ((action === 'burn' || action === 'transferBack') && tokenId == null) {
        res.status(400).json({ error: `${action} requires tokenId` });
        return;
      }
      if (action === 'burn' && amount == null) {
        res.status(400).json({ error: 'burn requires amount' });
        return;
      }

      const relayPrivateKey = process.env.NFT_RELAY_PRIVATE_KEY?.trim();
      const nftContractAddress = process.env[chainConfig.contractEnvVar];
      const rpcUrl = process.env[chainConfig.rpcEnvVar]
        || (chainId === 8453 ? 'https://mainnet.base.org' : 'https://mainnet.skalenodes.com/v1/elated-tan-skat');

      if (!relayPrivateKey || !nftContractAddress) {
        res.status(500).json({ error: `Relay not configured for chainId ${chainId} (missing NFT_RELAY_PRIVATE_KEY or ${chainConfig.contractEnvVar})` });
        return;
      }

      // Dynamically import viem (already a project dependency)
      const { createPublicClient, createWalletClient, http: viemHttp, encodeFunctionData, parseAbi, defineChain } = await import('viem');
      const { privateKeyToAccount } = await import('viem/accounts');
      const { base } = await import('viem/chains');

      // Define Skale Europa chain for viem
      const skaleEuropa = defineChain({
        id: 2046399126,
        name: 'SKALE Europa',
        nativeCurrency: { name: 'sFUEL', symbol: 'sFUEL', decimals: 18 },
        rpcUrls: { default: { http: ['https://mainnet.skalenodes.com/v1/elated-tan-skat'] } },
        blockExplorers: { default: { name: 'Explorer', url: 'https://elated-tan-skat.explorer.mainnet.skalenodes.com' } },
      });

      const viemChain = chainId === 8453 ? base : skaleEuropa;
      const account = privateKeyToAccount(relayPrivateKey as `0x${string}`);

      const publicClient = createPublicClient({
        chain: viemChain,
        transport: viemHttp(rpcUrl),
      });

      const walletClient = createWalletClient({
        account,
        chain: viemChain,
        transport: viemHttp(rpcUrl),
      });

      // Check gas deposit (skip on free-gas chains like Skale)
      if (!chainConfig.freeGas) {
        // For claim: compute claimKey from secret for gas deposit lookup
        // For burn/transferBack: claimKey is provided directly
        const { keccak256: viemKeccak256 } = await import('viem');
        const gasDepositKey = action === 'claimNFT'
          ? (claimKey || viemKeccak256(secret as `0x${string}`))
          : claimKey;

        const gasDeposit = await publicClient.readContract({
          address: nftContractAddress as `0x${string}`,
          abi: parseAbi(['function claimGasDeposits(bytes32) view returns (uint256)']),
          functionName: 'claimGasDeposits',
          args: [gasDepositKey as `0x${string}`],
        });

        if (gasDeposit === BigInt(0)) {
          res.status(400).json({ error: 'No gas deposit for this claim link' });
          return;
        }
      }

      // Build the meta-tx call
      let functionName: string;
      let args: any[];
      let abi: any;

      if (action === 'claimNFT') {
        // claimNFTMeta takes secret (contract computes claimKey internally)
        abi = parseAbi(['function claimNFTMeta(bytes32,address,uint256,uint256,bytes)']);
        functionName = 'claimNFTMeta';
        args = [secret, signer, BigInt(deadline), BigInt(nonce), signature];
      } else if (action === 'burn') {
        // burnMeta takes claimKey directly
        abi = parseAbi(['function burnMeta(bytes32,uint256,uint256,address,uint256,uint256,bytes)']);
        functionName = 'burnMeta';
        args = [claimKey, BigInt(tokenId), BigInt(amount), signer, BigInt(deadline), BigInt(nonce), signature];
      } else {
        // transferBackMeta takes claimKey directly
        abi = parseAbi(['function transferBackMeta(bytes32,uint256,address,uint256,uint256,bytes)']);
        functionName = 'transferBackMeta';
        args = [claimKey, BigInt(tokenId), signer, BigInt(deadline), BigInt(nonce), signature];
      }

      const data = encodeFunctionData({ abi, functionName, args });

      // Submit transaction
      const txHash = await walletClient.sendTransaction({
        to: nftContractAddress as `0x${string}`,
        data,
      });

      console.log(`[nft-relay] ${action} tx submitted: ${txHash}`);
      res.json({ success: true, txHash });
    } catch (error: any) {
      console.error('[nft-relay] Error:', error);

      // Surface contract revert reasons
      const message = error?.shortMessage || error?.message || 'Relay transaction failed';
      res.status(500).json({ error: message });
    }
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[webui] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, dbOps };
}
