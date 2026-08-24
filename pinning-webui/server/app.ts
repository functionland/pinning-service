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
import { verifyServiceAuth, SERVICE_AUTH_HEADER } from './serviceAuth.js';
import {
  getUserCreditStatus,
  getUserWallets,
  linkWallet,
  unlinkWallet,
  getCreditHistoryPage,
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
  createMcpRevocationTable,
  revokeMcpJti,
  isMcpJtiRevoked,
  listRevokedMcpJtis,
  createMcpGrantsTable,
  insertMcpGrants,
  listActiveGrantsForConnection,
  revokeMcpGrant,
  createMcpConnectionsTable,
  insertMcpConnection,
  findMcpConnectionByRefreshHash,
  touchMcpConnectionRefreshed,
  revokeMcpConnection,
  listMcpConnectionsForUser,
  listRevokedConnectionPubkeys,
  findMcpConnectionById,
  findNewestMcpConnectionByPubkey,
  findMcpConnectionWithBundleByPubkey,
  setMcpConnectionBundleById,
  authorizeCollabGroupsForConnection,
  deauthorizeCollabGroupsForConnection,
  createCollabManifestsTable,
  createCollabWriteAuthSchema,
  isCollabGroupWritesRevoked,
  setCollabWritesRevoked,
  syncCollabManifest,
  insertCollabAuditLog,
  collabGroupsExist,
} from './database/postgres.js';
import {
  mintMcpToken,
  verifyMcpToken,
  resolveRevocationTarget,
  resolveMcpTtlSeconds,
  normalizeMcpPubB64,
  getCnfMcpPubB64,
  MCP_TOKEN_USE,
} from './mcpTokens.js';
import { validateGrantsPayload } from './mcpGrants.js';
import { validateBundlePayload } from './mcpBundle.js';
import { newRefreshToken, hashRefreshToken, mintFromConnection, mintCollabFromConnection } from './mcpConnections.js';
import {
  verifyCollabWriteToken,
  isGroupAuthorizedByToken,
  normalizeGroupIds,
  COLLAB_MAX_GROUP_IDS,
  COLLAB_TOKEN_USE,
} from './collabTokens.js';
import { getEnabledChains, processTransfer } from './services/blockScanner.js';
import {
  buildSignedTranscript,
  type ChallengeStore,
  createInMemoryChallengeStore,
  decodeChallenge,
  decodePublicKey,
  decodeSignature,
  getSeedUser,
  insertOrAssertSeedUser,
  issueChallenge,
  PublicKeyMismatchError,
  touchSeedUserLastUsed,
  validateEffectiveUserIdHex,
  validateProvider,
  ValidationError,
  verifyEd25519,
} from './services/seedAuth.js';
import { getClient } from './database/postgres.js';

// Session user type
export interface SessionUser {
  id: string; // OAuth sub for Mode A/B; effective_user_id_hex for Mode C
  userId: string; // Mode A: SHA-256(email); Mode B/C: effective_user_id_hex
  email: string; // Mode A/B: from OAuth; Mode C: <uid>@seed.fxfiles.local synthetic
  name: string;
  picture: string;
  // 'seed' = Mode C (passphrase-only, no OAuth identity bound). Mode B
  // users keep `'google'` / `'apple'` so existing UI conditioning on
  // the provider field continues to work for them.
  provider: 'google' | 'apple' | 'seed';
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
      // Set by requireCollabWriteAuth on the collab WRITE routes. Identifies the
      // authorized principal (a human user OR a bound AI connection) for audit
      // logging + CAS. `type: 'connection'` ⇒ an AI collab-write token.
      collabPrincipal?: {
        type: 'user' | 'connection';
        userId: string;
        connectionId?: string;
        mcpPubB64?: string;
      };
      // Set by requireCollabWriteAuth for AUDIT — populated as soon as a
      // principal can be attributed, INCLUDING on a denied collab-token request
      // (so revoked/unauthorized attempts are logged, not just successes). For a
      // collab token it carries the connection id + jti even when the request is
      // ultimately rejected.
      collabAuditCtx?: {
        principalId: string;
        principalType: 'user' | 'connection';
        jti?: string;
      };
    }
  }
}

// App configuration type
export interface AppConfig {
  port: number;
  googleClientId: string;
  // Additional Google OAuth client IDs accepted on the /auth/register-mode-b
  // path. Mode B clients send their own ID token (e.g. FxFiles ships its
  // own Google Web client ID as serverClientId), so the `aud` claim on
  // that token is NOT the pinning-webui's googleClientId. Operators add
  // the FxFiles client ID (and any other downstream Mode B clients)
  // here. Mode A (`/auth/google`) is unaffected — it's webui-only.
  // Comma-separated env: GOOGLE_ADDITIONAL_AUDIENCES.
  googleAdditionalAudiences?: string[];
  sessionSecret: string;
  jwtSecret: string;
  nodeEnv: string;
  pinningServiceUrl: string;
  systemKey?: string;  // For x402 gateway integration
  pinServiceSecret?: string;  // HMAC secret for gateway service-auth (MCP/AI pins + quota)
  s3AdminJwt?: string;  // For internal S3 fetch (share links)
  s3InternalUrl?: string;  // Internal S3 endpoint (default: http://127.0.0.1:9000)
  // v8 migration: bucket the collab manifest + collab files are WRITTEN to.
  // Default 'fula-metadata' (legacy ⇒ behaviour-preserving no-op). Set
  // COLLAB_METADATA_WRITE_BUCKET=fula-metadata-v8 to route writes to the fresh
  // sibling once the legacy forest is gc-damaged (matches the FxFiles app's v8
  // routing). Reads try the write bucket then fall back to legacy.
  collabMetadataWriteBucket?: string;
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
  // Same idea as googleAdditionalAudiences but for Apple. FxFiles ships
  // its own Apple Services ID (bundle/web client) as the `aud` it asks
  // Apple to sign tokens for. Comma-separated env: APPLE_ADDITIONAL_AUDIENCES.
  appleAdditionalAudiences?: string[];
  appleTeamId?: string;
  appleKeyId?: string;
  applePrivateKey?: string;
  // DAG import (CAR upload) vendor extension. Off by default; when enabled the
  // webui exposes POST /api/pins/import-dag (streamed through to the Go
  // pinning service's POST /pins/import/car) and advertises the feature via
  // GET /api/features so the UI shows the Import DAG button.
  // Envs: DAG_IMPORT_ENABLED, DAG_IMPORT_MAX_CAR_BYTES (default 800 MB —
  // matches the nginx client_max_body_size on the webui vhost).
  dagImportEnabled?: boolean;
  dagImportMaxCarBytes?: number;
  // Phase 11 — scoped MCP-JWT issuer. Lifetime (seconds) of the short-lived
  // scoped token minted at POST /api/mcp/tokens for a user's paired MCP agent.
  // Default 3600 (1h); clamped to [60, 86400] by resolveMcpTtlSeconds.
  // Env: MCP_TOKEN_TTL_SECONDS.
  mcpTokenTtlSeconds?: number;
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
    await createCollabManifestsTable();
    // Collab-write auth (additive): per-group AI-write kill switch + manifest
    // version (opt-in CAS) columns + the audit table. ALTERs collab_manifests,
    // so it MUST run after the CREATE/ALTERs above.
    await createCollabWriteAuthSchema();
    console.log('[webui] collab_manifests table ready');
  } catch (error) {
    console.error('[webui] Failed to create collab_manifests table:', error);
  }

  // Phase 11 — MCP scoped-token revocation list. Stateless MCP JWTs carry the
  // only authorization state here; a revoked jti is rejected by the gateway
  // until its short exp.
  try {
    await createMcpRevocationTable();
    console.log('[webui] mcp_revoked_tokens table ready');
  } catch (error) {
    console.error('[webui] Failed to create mcp_revoked_tokens table:', error);
  }

  // Phase 15a — MCP grant store. Holds per-file ShareTokens a user grants to a
  // paired MCP connection (sealed to the MCP pubkey); the stateless MCP fetches
  // its grants scoped by the verified token's cnf binding.
  try {
    await createMcpGrantsTable();
    console.log('[webui] mcp_grants table ready');
  } catch (error) {
    console.error('[webui] Failed to create mcp_grants table:', error);
  }

  // MCP connection registry. A paired connection stores a long-lived refresh
  // token (hash only) + its frozen scope so the client can re-mint its
  // short-lived workspace JWT without re-pairing; revocation flips a flag the
  // gateway polls. See server/database/postgres.ts for the security invariant.
  try {
    await createMcpConnectionsTable();
    console.log('[webui] mcp_connections table ready');
  } catch (error) {
    console.error('[webui] Failed to create mcp_connections table:', error);
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

  // Audit F-A1 / F-A3 redesign — `seed_users` public-key registry.
  //
  // Stores `(effective_user_id, mode, public_key, oauth_sub, provider)`
  // for clients authenticating via seed-derived Ed25519 keys
  // (Mode B = OAuth + seed; Mode C = seed only). Used by the
  // `/auth/register-mode-*` and `/auth/sign-in` endpoints in
  // server/services/seedAuth.ts. See:
  //  - https://github.com/functionland/fula-api/commit/7fa2f32
  //  - https://github.com/functionland/fula-api/issues/14
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS seed_users (
        effective_user_id VARCHAR(32) PRIMARY KEY,
        mode CHAR(1) NOT NULL CHECK (mode IN ('B','C')),
        public_key BYTEA NOT NULL,
        oauth_sub VARCHAR(255),
        provider VARCHAR(16),
        registered_at TIMESTAMPTZ DEFAULT NOW(),
        last_used_at TIMESTAMPTZ
      )
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_seed_users_oauth_sub
        ON seed_users(oauth_sub) WHERE oauth_sub IS NOT NULL
    `).catch(ignoreMigrationError);
    console.log('[webui] seed_users table ready');
  } catch (error) {
    console.error('[webui] Failed to create seed_users table:', error);
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

// httpPostStream POSTs a readable stream as the request body (no buffering —
// used to pipe CAR uploads through to the pinning service). The response body
// is small JSON, so it is collected as text like the other helpers.
export function httpPostStream(
  url: string,
  headers: Record<string, string>,
  source: NodeJS.ReadableStream,
  timeoutMs: number = 15 * 60 * 1000
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: parseInt(urlObj.port) || 80,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: headers
    };

    const req = http.request(options, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode || 500, data }));
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Upstream request timed out'));
    });
    req.on('error', reject);
    source.on('error', (err) => {
      // Client aborted mid-upload — tear down the upstream request too.
      req.destroy(err as Error);
      reject(err);
    });
    source.pipe(req);
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

  /**
   * Return the user's active stored API key — mirrors `/api/keys/active`.
   *
   * Used by every auth endpoint (`/auth/google`, `/auth/apple`,
   * `/auth/register-mode-{b,c}`) so the JWT returned to native clients
   * matches what the dashboard's API Key page shows and stays stable
   * across sign-ins. Minting a fresh JWT per call (via
   * `generateJwtApiKey` alone) is wrong here — it produces a token the
   * `api_keys` table doesn't know about, so the user's portal-visible
   * key and their in-app token diverge.
   *
   * First-time signup: no `api_keys` rows exist → create one (which
   * also persists it). Subsequent sign-ins: return the first stored key.
   */
  async function getOrCreateActiveApiKey(userId: string): Promise<string> {
    const keys = await dbOps.getApiKeys(userId);
    if (keys && keys.length > 0) {
      return keys[0].key_id;
    }
    return dbOps.createApiKey(userId);
  }
  const googleClient = new OAuth2Client(config.googleClientId);

  // Audit F-A1 / F-A3 redesign — in-memory challenge store for the
  // seed-auth flow. Single-process server (BIND_HOST=127.0.0.1); if
  // ever scaled horizontally, swap for Redis.
  const challengeStore: ChallengeStore = createInMemoryChallengeStore();
  // Periodically sweep expired challenge entries to bound memory under
  // a sustained spam load. Lazy expiry on lookup keeps correctness, the
  // sweep keeps map size honest.
  const challengeSweepHandle = setInterval(() => {
    const removed = challengeStore.clearExpired();
    if (removed > 0) {
      console.log(`[webui] seed-auth challenge sweep: removed ${removed} expired`);
    }
  }, 60_000);
  // Don't keep the process alive just for the sweeper.
  challengeSweepHandle.unref?.();

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
          // Pinning API (public /api/v1/public-stats endpoint) + IPFS/S3
          "https://api.cloud.fx.land",
          "https://ipfs.cloud.fx.land",
          "https://s3.cloud.fx.land",
          // AI service — the public yellow-pages directory reads
          // /api/v1/directory + /directory/categories from here, the same
          // way /stats reads public-stats from api.cloud.fx.land. Without
          // this the directory page is blocked by CSP before it sends a
          // single request.
          "https://ai.cloud.fx.land",
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
          // MetaMask SDK relay (mobile browser -> MetaMask app handshake, socket.io
          // over https polling + wss upgrade) + SDK analytics. RainbowKit >=2.2 routes
          // its MetaMask entry through this, so blocking it hangs mobile connects.
          "https://*.api.cx.metamask.io",
          "wss://*.api.cx.metamask.io",
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

  // Derive a short audit verb from the collab WRITE route being hit.
  function collabVerbFromReq(req: Request): string {
    const p = req.path;
    if (p.endsWith('/manifest-sync')) return 'manifest-sync';
    if (p.endsWith('/manifest')) return 'manifest';
    if (p.endsWith('/upload')) return 'upload';
    return req.method.toLowerCase();
  }

  // Best-effort audit of a collab write, fired on response 'finish' so it
  // captures the OUTCOME (status code). Driven by `collabAuditCtx`, which is set
  // as soon as a principal can be attributed — so it records BOTH authorized
  // writes (2xx) AND attributable DENIALS (a revoked/unauthorized collab token →
  // 403, a fail-closed 503): the forensic value of the kill switch + revocation.
  // Garbage/unverifiable tokens (no attribution) are not DB-audited (console
  // only). Cannot be forgotten on a new route because it is wired inside
  // requireCollabWriteAuth (the shared gate). Never throws.
  function attachCollabAudit(req: Request, res: Response) {
    res.on('finish', () => {
      const ctx = req.collabAuditCtx;
      if (!ctx) return;
      const fileId =
        (typeof req.headers['x-collab-file-id'] === 'string' ? (req.headers['x-collab-file-id'] as string) : undefined) ??
        (typeof req.params?.fileId === 'string' ? req.params.fileId : undefined);
      insertCollabAuditLog({
        principalId: ctx.principalId,
        principalType: ctx.principalType,
        groupId: req.params?.groupId ?? 'unknown',
        verb: collabVerbFromReq(req),
        fileId: fileId ?? null,
        srcIp: req.ip ?? null,
        statusCode: res.statusCode,
      }).catch((err) => console.error('[webui] collab audit insert failed (non-fatal):', err));
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Collab WRITE auth — session OR human api-key OR an AI `collab_write` token.
  //
  // Replaces requireSessionOrBearer on the THREE collab WRITE routes (upload,
  // manifest, manifest-sync). It is a SUPERSET: the human paths (a)+(b) are
  // byte-for-byte the old behaviour; (c) adds the AI `collab_write` token. The
  // DELETE route deliberately KEEPS requireSessionOrBearer — an AI may NOT
  // delete (it removes via manifest tombstone).
  //
  // SINGLE accepted aud per route: the JWT branch ONLY accepts
  // aud="pinning-webui-collab" + token_use="collab_write" (verifyCollabWriteToken,
  // signed with the DOMAIN-SEPARATED collab key). An mcp_s3 gateway token (aud
  // "fula-s3-gateway", signed with the RAW secret) fails BOTH the signature
  // (wrong derived key) AND the aud/token_use checks → 401. No "either token is
  // fine" fallback.
  //
  // For a verified collab token, ALL of these must hold (else 403), checked
  // SYNCHRONOUSLY against the DB on every write (server source of truth, never
  // the manifest blob):
  //   1. req.params.groupId ∈ the VERIFIED token's collab.groupIds          (token scope)
  //   2. the connection row (by collab.cid) exists AND is NOT revoked        (server truth)
  //   3. row.user_id === token.sub                                          (owner binding)
  //   4. req.params.groupId ∈ the LIVE row's scope.collab.groupIds          (DB truth — makes
  //                                                                          de-authorization immediate)
  //   5. the group's collab_writes_revoked kill switch is NOT set           (server truth)
  // A DB error on (2) or (5) FAILS CLOSED (503) — never falls through to allow.
  async function requireCollabWriteAuth(req: Request, res: Response, next: NextFunction) {
    attachCollabAudit(req, res);

    // (a) Session (webui human).
    if (req.session.user) {
      req.collabPrincipal = { type: 'user', userId: req.session.user.userId };
      req.collabAuditCtx = { principalId: req.session.user.userId, principalType: 'user' };
      return next();
    }

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);

      // (b) Human api-key (existing path — preserved exactly).
      try {
        const userEmail = await verifyApiKey(token);
        if (userEmail) {
          const userId = getUserId(userEmail);
          req.apiUser = { email: userEmail, userId };
          req.collabPrincipal = { type: 'user', userId };
          req.collabAuditCtx = { principalId: userId, principalType: 'user' };
          return next();
        }
      } catch (_) { /* fall through to collab-write attempt */ }

      // (c) AI collab-write token.
      let claims;
      try {
        claims = verifyCollabWriteToken(token, config.jwtSecret);
      } catch {
        return res.status(401).json({ error: 'Authentication required. Sign in or provide a valid API key.' });
      }

      // Attribute for audit as soon as the token VERIFIES — so a subsequent
      // DENIAL (revoked / unauthorized group / kill switch / binding mismatch)
      // is still recorded with the connection id + jti, not just successes.
      req.collabAuditCtx = { principalId: claims.collab.cid, principalType: 'connection', jti: claims.jti };

      const groupId = req.params.groupId;

      // 1. groupId ∈ the token's authorized groups (from the VERIFIED token).
      if (!isGroupAuthorizedByToken(claims, groupId)) {
        return res.status(403).json({ error: 'collab_write token not authorized for this group' });
      }

      // 2. Connection not revoked (synchronous server truth, precise by cid).
      let conn;
      try {
        conn = await findMcpConnectionById(claims.collab.cid);
      } catch (err) {
        console.error('[webui] collab-write: connection lookup failed, denying:', err);
        return res.status(503).json({ error: 'Authorization check unavailable' });
      }
      if (!conn || conn.revoked) {
        return res.status(403).json({ error: 'collab_write connection revoked or not found' });
      }

      // 3. The token's subject must own the connection row.
      if (conn.user_id !== claims.sub) {
        return res.status(403).json({ error: 'collab_write connection/token owner mismatch' });
      }

      // 3b. The token's cnf binding must match the LIVE row's pubkey (bind to the
      //     server's source of truth, not just the signed claim — defense in
      //     depth against a stale/rotated binding).
      if (conn.mcp_pub_b64 !== claims.cnf.mcp_pub_b64) {
        return res.status(403).json({ error: 'collab_write connection binding mismatch' });
      }

      // 4. groupId ∈ the LIVE row's authorized groups (DB truth → immediate
      //    de-auth). EXACT match — the group's identity is its exact id.
      const liveGroups = Array.isArray(conn.scope?.collab?.groupIds) ? conn.scope.collab!.groupIds : [];
      if (!liveGroups.includes(groupId)) {
        return res.status(403).json({ error: 'collab_write authorization for this group was removed' });
      }

      // 5. Group-level AI-write kill switch (synchronous server truth).
      let groupRevoked;
      try {
        groupRevoked = await isCollabGroupWritesRevoked(groupId);
      } catch (err) {
        console.error('[webui] collab-write: group revocation check failed, denying:', err);
        return res.status(503).json({ error: 'Authorization check unavailable' });
      }
      if (groupRevoked) {
        return res.status(403).json({ error: 'collab writes revoked for this group' });
      }

      req.collabPrincipal = {
        type: 'connection',
        userId: claims.sub,
        connectionId: conn.id,
        mcpPubB64: claims.cnf.mcp_pub_b64,
      };
      console.log(
        `[webui] collab-write ALLOW conn=${conn.id.slice(0, 8)}… user=${claims.sub.slice(0, 8)}… ` +
          `group=${groupId.slice(0, 8)}… verb=${collabVerbFromReq(req)}`,
      );
      return next();
    }

    return res.status(401).json({ error: 'Authentication required. Sign in or provide a valid API key.' });
  }

  // API token auth middleware (Bearer token for external apps)
  // Looks up token in api_keys table - same approach as Go pinning service
  async function requireApiAuth(req: Request, res: Response, next: NextFunction) {
    // Service-auth (MCP/AI writes via the co-located Fula S3 gateway): assert the
    // user via an HMAC over (user_id, exp) in X-Fula-Service-Auth, not an API key
    // (the gateway's bearer is a gateway-scoped JWT, not a session). FAIL-CLOSED:
    // a present-but-invalid header is rejected, never falls through to API-key auth.
    // SCOPED to ONLY /api/v1/storage — the only endpoint the gateway needs — so a
    // captured header can't reach the broader API (wallets, credit claiming, etc.).
    const svcAuth = req.headers[SERVICE_AUTH_HEADER];
    if (typeof svcAuth === 'string' && svcAuth.length > 0 && req.path === '/api/v1/storage') {
      const uid = verifyServiceAuth(svcAuth, config.pinServiceSecret ?? '');
      if (!uid) {
        return res.status(401).json({ error: 'Invalid service authentication' });
      }
      req.apiUser = { email: uid, userId: uid };
      return next();
    }

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

      // Accept tokens issued for the pinning-webui's own Google client
      // ID AND any additional client IDs in GOOGLE_ADDITIONAL_AUDIENCES.
      // The FxFiles app ships its own Google Web client ID as
      // `serverClientId`, so the `aud` claim on tokens it forwards here
      // is theirs, not ours. Same multi-audience trick we use on
      // /auth/register-mode-b — google-auth-library accepts string[].
      const acceptedGoogleAudiences = [
        config.googleClientId,
        ...(config.googleAdditionalAudiences ?? []),
      ].filter(Boolean);
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: acceptedGoogleAudiences,
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

      // Return the user's ACTIVE stored API key — the same JWT
      // `/api/keys/active` returns and what shows in the portal. First
      // sign-in creates+stores one; subsequent sign-ins return the
      // existing row so the in-app token and the portal-visible token
      // stay in sync and remain stable across sign-out / sign-in cycles.
      const jwtToken = await getOrCreateActiveApiKey(userId);

      res.json({
        success: true,
        jwt: jwtToken,
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

      // Accept tokens issued for the pinning-webui's own Apple client
      // ID AND any additional Services IDs in APPLE_ADDITIONAL_AUDIENCES.
      // FxFiles ships its own Apple bundle ID; tokens it forwards here
      // carry that `aud`. apple-signin-auth's `audience` parameter
      // is passed through to jsonwebtoken which accepts string[].
      const acceptedAppleAudiences = [
        config.appleClientId,
        ...(config.appleAdditionalAudiences ?? []),
      ].filter(Boolean);
      // Verify the identity token with Apple
      const applePayload = await AppleSignIn.default.verifyIdToken(identityToken, {
        audience: acceptedAppleAudiences,
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

      // Return the user's ACTIVE stored API key (same logic as
      // /auth/google above). Matches what /api/keys/active and the
      // portal's API Key page show, stable across sign-ins.
      const jwtToken = await getOrCreateActiveApiKey(userId);

      res.json({
        success: true,
        jwt: jwtToken,
        user: req.session.user,
        isNew: user.isNew,
      });
    } catch (error) {
      console.error('[webui] Apple auth error:', error);
      res.status(401).json({ error: 'Authentication failed' });
    }
  });

  // ============================================================
  // Seed-derived authentication (audit F-A1 / F-A3 redesign).
  //
  // Mode B (OAuth + seed) and Mode C (seed-only) clients authenticate
  // by proving they hold the Ed25519 private key derived from their
  // seed. The seed never leaves the client. See
  // server/services/seedAuth.ts and
  // https://github.com/functionland/fula-api/issues/14.
  //
  // Endpoints:
  //   POST /auth/register-mode-b   — first sign-up (Google/Apple + seed)
  //   POST /auth/register-mode-c   — first sign-up (seed only)
  //   POST /auth/challenge         — issue a nonce for an existing user
  //   POST /auth/sign-in           — verify signed nonce, mint JWT
  //
  // The minted JWTs use `sub = effective_user_id_hex` (32 hex chars).
  // The fula-cli gateway treats `sub` opaquely, so no gateway change
  // is needed. Because Mode B/C `sub` values are seed-derived
  // (128-bit hashes of high-entropy input), the gateway's published
  // users-index CBOR becomes non-enumerable for these users —
  // closing audit F-A3 naturally without a separate dual-publish.
  //
  // Tighter rate limit on the four seed-auth endpoints than the
  // generic /api/auth/ limiter — registration spam could fill the
  // challenge map + seed_users table.
  const seedAuthLimiter = options?.skipRateLimit
    ? (_req: Request, _res: Response, next: NextFunction) => next()
    : rateLimit({
        windowMs: 60 * 60 * 1000,
        max: 30,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many seed-auth attempts, please try again later' },
      });

  app.post('/auth/register-mode-b', seedAuthLimiter, async (req: Request, res: Response) => {
    let txClient = null as Awaited<ReturnType<typeof getClient>> | null;
    try {
      const body = req.body ?? {};
      const provider = validateProvider(body.provider);
      const effectiveUserIdHex = validateEffectiveUserIdHex(body.effective_user_id_hex);
      const publicKey = decodePublicKey(body.public_key_b64);
      const challenge = decodeChallenge(body.challenge_b64);
      const signature = decodeSignature(body.signature_b64);

      const oauthToken = typeof body.oauth_token === 'string' ? body.oauth_token : '';
      if (!oauthToken) {
        return res.status(400).json({ error: 'oauth_token required' });
      }

      // Audit finding #1: consume a single-use, server-issued challenge.
      // Without this, an attacker could replay a captured registration
      // body to mint perpetually-valid JWTs (DT-1 — no exp claim).
      // Match the existing /auth/sign-in pattern: consume first, then
      // compare bytes constant-time, then verify the signature.
      const entry = challengeStore.takeIfValid(effectiveUserIdHex, 'register-mode-b');
      if (!entry) {
        return res.status(401).json({
          error: 'Challenge missing, expired, or for a different purpose',
          code: 'CHALLENGE_INVALID',
        });
      }
      if (
        entry.challenge.length !== challenge.length ||
        !crypto.timingSafeEqual(entry.challenge, challenge)
      ) {
        return res.status(401).json({
          error: 'Challenge mismatch',
          code: 'CHALLENGE_INVALID',
        });
      }

      // Verify proof-of-seed-knowledge BEFORE touching the database.
      // Domain-separated transcript prevents cross-purpose / cross-user
      // signature replay (Codex advisor 2026-05-18).
      const transcript = buildSignedTranscript(
        'register-mode-b',
        effectiveUserIdHex,
        challenge
      );
      if (!verifyEd25519(publicKey, transcript, signature)) {
        return res.status(401).json({
          error: 'Invalid signature',
          code: 'SIGNATURE_INVALID',
        });
      }

      // Verify OAuth identity via the existing provider clients. The
      // OAuth `sub` we store is whatever the verifier returned — NOT
      // anything the client supplied — so a client cannot forge an
      // OAuth binding to another user.
      let oauthSub: string;
      // Capture the OAuth-verified email so we can detect an existing
      // Mode A account for the same identity (audit fix #4). Email is
      // NOT persisted to seed_users / webui_users — used only for the
      // server-side `has_mode_a` check on this request and for the
      // session.user echo so AuthContext sees a populated profile.
      let oauthEmail: string | undefined;
      // Display name and picture URL from the OAuth verifier. Echoed
      // into req.session.user so the dashboard / profile pages can
      // show a friendly identifier for the Mode B user. NOT persisted.
      let oauthName: string | undefined;
      let oauthPicture: string | undefined;
      if (provider === 'google') {
        // Accept tokens issued for the pinning-webui's own Google
        // client ID AND any additional client IDs configured via
        // GOOGLE_ADDITIONAL_AUDIENCES — FxFiles (and other Mode B
        // clients) ship their own Google Web client ID as
        // `serverClientId`, so the `aud` claim on their token is
        // theirs, not ours. google-auth-library accepts a string or
        // string[] for the `audience` parameter and checks any match.
        const acceptedGoogleAudiences = [
          config.googleClientId,
          ...(config.googleAdditionalAudiences ?? []),
        ].filter(Boolean);
        const ticket = await googleClient.verifyIdToken({
          idToken: oauthToken,
          audience: acceptedGoogleAudiences,
        });
        const payload = ticket.getPayload();
        if (!payload?.sub) {
          return res.status(401).json({ error: 'Invalid OAuth token' });
        }
        oauthSub = payload.sub;
        oauthEmail = payload.email ?? undefined;
        oauthName = typeof payload.name === 'string' ? payload.name : undefined;
        oauthPicture = typeof payload.picture === 'string' ? payload.picture : undefined;
      } else {
        // Apple
        if (!config.appleClientId) {
          return res.status(500).json({ error: 'Apple Sign-In not configured' });
        }
        const AppleSignIn = await import('apple-signin-auth');
        // Same multi-audience trick as Google above — apple-signin-auth
        // accepts string | string[] for `audience` and validates any
        // match.
        const acceptedAppleAudiences = [
          config.appleClientId,
          ...(config.appleAdditionalAudiences ?? []),
        ].filter(Boolean);
        const applePayload = await AppleSignIn.default.verifyIdToken(oauthToken, {
          audience: acceptedAppleAudiences,
          ignoreExpiration: false,
        });
        if (!applePayload?.sub) {
          return res.status(401).json({ error: 'Invalid OAuth token' });
        }
        oauthSub = applePayload.sub;
        // Apple returns email only on first sign-in; absent later → cannot
        // detect Mode A in that branch. Acceptable false-negative.
        oauthEmail = typeof applePayload.email === 'string' ? applePayload.email : undefined;
        // Apple supplies the display name only on first sign-in, via the
        // client-supplied user object — accept it if present, otherwise
        // leave name empty.
        const appleUser = typeof body.user === 'object' && body.user !== null
          ? body.user as { name?: { firstName?: string; lastName?: string }; email?: string }
          : undefined;
        if (appleUser?.name) {
          const fn = appleUser.name.firstName ?? '';
          const ln = appleUser.name.lastName ?? '';
          const composed = `${fn} ${ln}`.trim();
          oauthName = composed.length > 0 ? composed : undefined;
        }
        if (!oauthEmail && typeof appleUser?.email === 'string') {
          oauthEmail = appleUser.email;
        }
      }

      // Transactional INSERT: seed_users + webui_users together.
      // Squatting check is inside insertOrAssertSeedUser.
      txClient = await getClient();
      await txClient.query('BEGIN');
      const { created } = await insertOrAssertSeedUser(txClient, {
        effectiveUserIdHex,
        mode: 'B',
        publicKey,
        oauthSub,
        provider,
      });
      // Auto-create a corresponding `webui_users` row so credits /
      // wallets / pins queries can find the user. Mode B is a SEPARATE
      // namespace from any pre-existing Mode A account for the same
      // OAuth identity — fresh credit balance, fresh wallet bindings
      // (consistent with the maintainer's "treat as different users"
      // decision, 2026-05-18).
      //
      // Audit fix #5: store the encrypted `effective_user_id_hex` in
      // `encrypted_email` instead of NULL. Email is treated as an
      // opaque user-id across the system; storing the canonical id
      // gives downstream code (admin tools, backup, future joins) a
      // non-null value that decrypts to a known opaque token, rather
      // than NULL which several call sites currently don't guard.
      // Mode A's OAuth binding still lives in seed_users.oauth_sub.
      const encryptedSyntheticEmailB =
        encryptApiKey(effectiveUserIdHex) ?? effectiveUserIdHex;
      await txClient.query(
        `INSERT INTO webui_users (user_id, encrypted_email, name, picture, last_login_at)
         VALUES ($1, $2, '', '', NOW())
         ON CONFLICT (user_id) DO UPDATE SET last_login_at = NOW()`,
        [effectiveUserIdHex, encryptedSyntheticEmailB]
      );
      await txClient.query('COMMIT');

      // Return the user's ACTIVE stored API key — same logic as
      // /auth/google + /api/keys/active. Minting a fresh JWT here
      // produces a token that doesn't match what the portal shows
      // and changes on every sign-in. The Mode B JWT is signed with
      // `sub=effectiveUserIdHex`, which is the webui_users.user_id
      // for this Mode B user, so the api_keys lookup keys on the
      // same value as Mode A.
      const jwtToken = await getOrCreateActiveApiKey(effectiveUserIdHex);
      // Audit fix #4: actually check for a Mode A user (`webui_users`
      // keyed by SHA-256(lowercase(email))). The previous logic
      // counted other `seed_users` rows for the same oauth_sub, which
      // detects "another seed-based vault" — NOT "a Mode A account".
      const hasModeA = oauthEmail
        ? await checkModeAExistsForEmail(oauthEmail).catch(() => false)
        : false;
      // Also issue a session cookie alongside the JWT so the existing
      // AuthContext / `/auth/me` flow on pinning-webui sees Mode B users
      // as signed in without needing a JWT-bearer refactor of every API
      // route. The JWT is still returned for SDK callers (FxFiles) that
      // don't carry the session cookie.
      req.session.user = {
        id: oauthSub,
        userId: effectiveUserIdHex,
        email: oauthEmail ?? `${effectiveUserIdHex}@seed.fxfiles.local`,
        name: oauthName ?? '',
        picture: oauthPicture ?? '',
        provider,
      };
      return res.json({
        success: true,
        jwt: jwtToken,
        user: req.session.user,
        effective_user_id_hex: effectiveUserIdHex,
        mode: 'B',
        created,
        has_mode_a: hasModeA,
      });
    } catch (err) {
      if (txClient) {
        try { await txClient.query('ROLLBACK'); } catch { /* ignore */ }
      }
      if (err instanceof ValidationError) {
        return res.status(400).json({ error: err.message, code: 'VALIDATION_ERROR' });
      }
      if (err instanceof PublicKeyMismatchError) {
        return res.status(409).json({
          error: err.message,
          code: 'PUBLIC_KEY_MISMATCH',
        });
      }
      console.error('[webui] register-mode-b error:', err);
      return res.status(500).json({ error: 'Registration failed' });
    } finally {
      txClient?.release();
    }
  });

  app.post('/auth/register-mode-c', seedAuthLimiter, async (req: Request, res: Response) => {
    let txClient = null as Awaited<ReturnType<typeof getClient>> | null;
    try {
      const body = req.body ?? {};
      const effectiveUserIdHex = validateEffectiveUserIdHex(body.effective_user_id_hex);
      const publicKey = decodePublicKey(body.public_key_b64);
      const challenge = decodeChallenge(body.challenge_b64);
      const signature = decodeSignature(body.signature_b64);

      // Audit finding #1: consume a single-use, server-issued challenge
      // before doing any state-changing work. See the matching
      // register-mode-b block above for rationale.
      const entry = challengeStore.takeIfValid(effectiveUserIdHex, 'register-mode-c');
      if (!entry) {
        return res.status(401).json({
          error: 'Challenge missing, expired, or for a different purpose',
          code: 'CHALLENGE_INVALID',
        });
      }
      if (
        entry.challenge.length !== challenge.length ||
        !crypto.timingSafeEqual(entry.challenge, challenge)
      ) {
        return res.status(401).json({
          error: 'Challenge mismatch',
          code: 'CHALLENGE_INVALID',
        });
      }

      const transcript = buildSignedTranscript(
        'register-mode-c',
        effectiveUserIdHex,
        challenge
      );
      if (!verifyEd25519(publicKey, transcript, signature)) {
        return res.status(401).json({
          error: 'Invalid signature',
          code: 'SIGNATURE_INVALID',
        });
      }

      txClient = await getClient();
      await txClient.query('BEGIN');
      const { created } = await insertOrAssertSeedUser(txClient, {
        effectiveUserIdHex,
        mode: 'C',
        publicKey,
        oauthSub: null,
        provider: null,
      });
      // Audit fix #5: store the encrypted `effective_user_id_hex` in
      // `encrypted_email` (matching the Mode B path above) so the
      // column is non-null for all seed-auth users.
      const encryptedSyntheticEmailC =
        encryptApiKey(effectiveUserIdHex) ?? effectiveUserIdHex;
      await txClient.query(
        `INSERT INTO webui_users (user_id, encrypted_email, name, picture, last_login_at)
         VALUES ($1, $2, '', '', NOW())
         ON CONFLICT (user_id) DO UPDATE SET last_login_at = NOW()`,
        [effectiveUserIdHex, encryptedSyntheticEmailC]
      );
      await txClient.query('COMMIT');

      // Return the user's ACTIVE stored API key — same pattern as
      // /auth/google, /auth/apple, /auth/register-mode-b. Stable
      // across sign-ins, matches what the portal shows.
      const jwtToken = await getOrCreateActiveApiKey(effectiveUserIdHex);
      // Mirror the register-mode-b session-cookie issuance so Mode C
      // users land in the existing AuthContext / `/auth/me` flow. Mode C
      // has no OAuth identity, so we synthesize the email and name from
      // the effective_user_id (matches FxFiles auth_service.dart pattern).
      req.session.user = {
        id: effectiveUserIdHex,
        userId: effectiveUserIdHex,
        email: `${effectiveUserIdHex}@seed.fxfiles.local`,
        name: 'Passphrase Vault',
        picture: '',
        provider: 'seed',
      };
      return res.json({
        success: true,
        jwt: jwtToken,
        user: req.session.user,
        effective_user_id_hex: effectiveUserIdHex,
        mode: 'C',
        created,
      });
    } catch (err) {
      if (txClient) {
        try { await txClient.query('ROLLBACK'); } catch { /* ignore */ }
      }
      if (err instanceof ValidationError) {
        return res.status(400).json({ error: err.message, code: 'VALIDATION_ERROR' });
      }
      if (err instanceof PublicKeyMismatchError) {
        return res.status(409).json({
          error: err.message,
          code: 'PUBLIC_KEY_MISMATCH',
        });
      }
      console.error('[webui] register-mode-c error:', err);
      return res.status(500).json({ error: 'Registration failed' });
    } finally {
      txClient?.release();
    }
  });

  app.post('/auth/challenge', seedAuthLimiter, async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const effectiveUserIdHex = validateEffectiveUserIdHex(body.effective_user_id_hex);

      // Audit finding #1: register-mode-{b,c} previously accepted
      // client-generated challenges with no single-use tracking, allowing
      // body-capture-and-replay to mint perpetually-valid JWTs (DT-1 says
      // JWTs intentionally have no exp). Fix: extend /auth/challenge to
      // issue purpose-tagged nonces for register flows too. `purpose`
      // defaults to `sign-in` for back-compat with the original API.
      const purposeRaw = typeof body.purpose === 'string' ? body.purpose : 'sign-in';
      if (
        purposeRaw !== 'sign-in' &&
        purposeRaw !== 'register-mode-b' &&
        purposeRaw !== 'register-mode-c'
      ) {
        return res.status(400).json({
          error: "purpose must be one of: 'sign-in', 'register-mode-b', 'register-mode-c'",
          code: 'VALIDATION_ERROR',
        });
      }
      const purpose = purposeRaw as 'sign-in' | 'register-mode-b' | 'register-mode-c';

      // Sign-in MUST target an existing user — otherwise the caller
      // would happily collect a nonce for a non-existent uid and
      // confuse itself. Register flows are creating the user; existence
      // is not required (and would be a chicken-and-egg block).
      if (purpose === 'sign-in') {
        // 404 on unknown user — see Gemini advisor 2026-05-18 (the
        // effective_user_id is already published via the gateway's
        // global CBOR for Mode B users; hiding existence at the issuer
        // adds no security and confuses the UX).
        const user = await getSeedUser({ query }, effectiveUserIdHex);
        if (!user) {
          return res.status(404).json({
            error: 'No account for this effective_user_id',
            code: 'USER_NOT_FOUND',
          });
        }
      }

      const challenge = issueChallenge(challengeStore, effectiveUserIdHex, purpose);
      return res.json({
        challenge_b64: challenge.toString('base64'),
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ error: err.message, code: 'VALIDATION_ERROR' });
      }
      console.error('[webui] /auth/challenge error:', err);
      return res.status(500).json({ error: 'Challenge issuance failed' });
    }
  });

  app.post('/auth/sign-in', seedAuthLimiter, async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const effectiveUserIdHex = validateEffectiveUserIdHex(body.effective_user_id_hex);
      const challenge = decodeChallenge(body.challenge_b64);
      const signature = decodeSignature(body.signature_b64);

      // 1. Single-use challenge lookup (consumed on take).
      const entry = challengeStore.takeIfValid(effectiveUserIdHex, 'sign-in');
      if (!entry) {
        return res.status(401).json({
          error: 'Challenge missing, expired, or for a different purpose',
          code: 'CHALLENGE_INVALID',
        });
      }
      // The client's `challenge_b64` MUST match the stored bytes —
      // defends against a confused-deputy attack where the client
      // signs something other than what we issued.
      if (entry.challenge.length !== challenge.length ||
          !crypto.timingSafeEqual(entry.challenge, challenge)) {
        return res.status(401).json({
          error: 'Challenge mismatch',
          code: 'CHALLENGE_INVALID',
        });
      }

      // 2. Look up the stored public key for this user.
      const user = await getSeedUser({ query }, effectiveUserIdHex);
      if (!user) {
        return res.status(404).json({
          error: 'No account for this effective_user_id',
          code: 'USER_NOT_FOUND',
        });
      }

      // 3. Verify the signed transcript with the stored public key.
      const transcript = buildSignedTranscript(
        'sign-in',
        effectiveUserIdHex,
        challenge
      );
      if (!verifyEd25519(user.public_key, transcript, signature)) {
        return res.status(401).json({
          error: 'Invalid signature',
          code: 'SIGNATURE_INVALID',
        });
      }

      // 4. Mint a fresh JWT and refresh last_used_at.
      const jwtToken = generateJwtApiKey(effectiveUserIdHex, config.jwtSecret);
      await touchSeedUserLastUsed({ query }, effectiveUserIdHex);
      // Also refresh webui_users.last_login_at so the rest of the app
      // sees this as an active user.
      await query(
        `UPDATE webui_users SET last_login_at = NOW() WHERE user_id = $1`,
        [effectiveUserIdHex]
      ).catch(() => { /* best-effort */ });

      return res.json({
        success: true,
        jwt: jwtToken,
        effective_user_id_hex: effectiveUserIdHex,
        mode: user.mode,
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ error: err.message, code: 'VALIDATION_ERROR' });
      }
      console.error('[webui] /auth/sign-in error:', err);
      return res.status(500).json({ error: 'Sign-in failed' });
    }
  });

  // Audit fix #4 (2026-05-18) — actually check for a Mode A account.
  // Mode A users live in `webui_users` keyed by `SHA-256(lowercase(email))`
  // (64 hex chars). Mode B/C users live in `webui_users` keyed by
  // `effective_user_id_hex` (32 hex chars). The two PK spaces never
  // collide, so an exact-match on the email-derived id is unambiguous.
  //
  // Used by register-mode-b to set the `has_mode_a` response flag so
  // the FxFiles UI can warn a user about creating a fresh-and-separate
  // Mode B vault when their OAuth identity already has a Mode A
  // account (Gemini advisor 2026-05-18).
  async function checkModeAExistsForEmail(email: string): Promise<boolean> {
    try {
      const userId = emailToUserId(email);
      const result = await query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM webui_users WHERE user_id = $1) AS exists`,
        [userId]
      );
      return result.rows[0]?.exists === true;
    } catch {
      return false;
    }
  }


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

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 11 — Scoped MCP-JWT issuer
  //
  // Mints a SHORT-LIVED, bucket/prefix-SCOPED JWT for the authenticated user's
  // paired MCP agent. The agent presents this token to the Fula S3 gateway,
  // which parses + enforces the `mcp` scope claim (see server/mcpTokens.ts for
  // the full contract). Auth is session (webui) OR Bearer API-key (FxFiles
  // native, P13) — `requireSessionOrBearer`. The minted token is STATELESS:
  // it is NOT stored in api_keys; the only server state is the revocation list.
  //
  // Helper: resolve the caller's user_id from either auth path.
  function mcpResolveUserId(req: Request): string | undefined {
    // `requireSessionOrBearer` sets req.apiUser for Bearer; session for webui.
    return req.session.user?.userId ?? req.apiUser?.userId;
  }

  // Shared mint+respond used by both POST /api/mcp/tokens and .../refresh.
  // (Refresh is a fresh mint — revocation == stop refreshing + short exp; the
  // prior jti is intentionally left to expire, see the revoke route docs.)
  //
  // `registerConnection` is true ONLY from the real-mint route (POST
  // /api/mcp/tokens). When true AND the request binds a connection (a valid
  // `mcp_pub_b64`), we ALSO register an `mcp_connections` row + issue a
  // long-lived REFRESH TOKEN (returned once). The legacy session-authed refresh
  // route passes false so it can NEVER spawn connection rows / refresh tokens —
  // it stays a pure re-mint of the caller's (session/bearer) identity.
  async function mcpIssueAndRespond(
    req: Request,
    res: Response,
    registerConnection = false,
  ): Promise<void> {
    const userId = mcpResolveUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    // Allow a per-request ttl override only DOWNWARD via body.ttlSeconds; it is
    // clamped to [60, 86400] regardless. Default comes from config.
    const requestedTtl =
      typeof req.body?.ttlSeconds === 'number' ? req.body.ttlSeconds : config.mcpTokenTtlSeconds;
    const ttlSeconds = resolveMcpTtlSeconds(requestedTtl);

    // OPTIONAL connection binding (P15a): base64 of the MCP's 32-byte X25519
    // pubkey. When present, mintMcpToken embeds a top-level `cnf` claim that the
    // grant store reads to scope GET /api/mcp/grants to this connection. Absent
    // ⇒ unbound token (P11 behaviour, can mint/refresh/revoke but not fetch
    // grants). FAIL-CLOSED: a present-but-malformed key is a 400 — we never
    // issue an unbound token the caller believes is bound.
    const rawPub = req.body?.mcp_pub_b64;
    if (rawPub !== undefined && typeof rawPub !== 'string') {
      res.status(400).json({ error: 'mcp_pub_b64 must be a base64 string' });
      return;
    }
    const mcpPubB64 = typeof rawPub === 'string' && rawPub.length > 0 ? rawPub : undefined;
    if (mcpPubB64 !== undefined && normalizeMcpPubB64(mcpPubB64) === null) {
      res.status(400).json({ error: 'mcp_pub_b64 must be base64 of a 32-byte X25519 public key' });
      return;
    }

    const { token, claims } = mintMcpToken(userId, config.jwtSecret, { ttlSeconds, mcpPubB64 });

    // Connection registration (real-mint route only, and only for a bound
    // request). We persist the connection's FROZEN scope (claims.mcp — the
    // resolved scope, NOT anything else from the request) so a later refresh can
    // re-mint EXACTLY this scope. The refresh token's plaintext is returned ONCE
    // here; only its sha256 hash is stored.
    let refreshToken: string | undefined;
    let connectionId: string | undefined;
    if (registerConnection && mcpPubB64) {
      const rt = newRefreshToken();
      connectionId = uuidv4();
      const label = typeof req.body?.label === 'string' && req.body.label.length > 0
        ? req.body.label.slice(0, 200)
        : null;
      await insertMcpConnection({
        id: connectionId,
        userId,
        // Persist the NORMALIZED (canonical) pubkey so the gateway-revoked feed
        // and the cnf in the JWT compare byte-for-byte regardless of b64 form.
        mcpPubB64: claims.cnf!.mcp_pub_b64,
        label,
        refreshTokenHash: rt.hash,
        scope: claims.mcp, // the resolved scope claim — frozen for refresh
      });
      refreshToken = rt.token;
    }

    console.log(
      `[webui] MCP token issued for ${userId.slice(0, 8)}… jti=${claims.jti.slice(0, 8)}… exp=${claims.exp}` +
        (claims.cnf ? ` cnf=${claims.cnf.mcp_pub_b64.slice(0, 8)}…` : '') +
        (connectionId ? ` conn=${connectionId.slice(0, 8)}…` : ''),
    );

    res.json({
      token,
      jti: claims.jti,
      expiresAt: claims.exp, // unix seconds
      tokenType: MCP_TOKEN_USE,
      scope: claims.mcp, // structured scope claim, mirrored for the client
      // Echo the bound connection so the client can confirm the binding.
      ...(claims.cnf ? { cnf: claims.cnf } : {}),
      // Connection refresh credential — present ONLY on the real-mint route for
      // a bound request. FxFiles stores this in the connection bundle and uses
      // it to re-mint without re-pairing. Shown ONCE; never re-derivable.
      ...(refreshToken ? { refreshToken, connectionId } : {}),
    });
  }

  // Mint a new scoped MCP token. `registerConnection=true`: a bound request
  // (with mcp_pub_b64) also registers a connection + returns a refresh token.
  app.post('/api/mcp/tokens', requireSessionOrBearer, async (req: Request, res: Response) => {
    try {
      await mcpIssueAndRespond(req, res, true);
    } catch (error) {
      console.error('[webui] Error issuing MCP token:', error);
      res.status(500).json({ error: 'Failed to issue MCP token' });
    }
  });

  // Refresh == mint a fresh short-lived token (same scope). The client calls
  // this before its current token expires. The previous token is NOT revoked
  // here; it simply expires on its own short exp. Use the revoke route to kill
  // a token immediately. registerConnection=false: this NEVER creates a
  // connection row / refresh token (that is the dedicated refresh-connection
  // route's job). It re-mints against the caller's session/bearer identity.
  app.post('/api/mcp/tokens/refresh', requireSessionOrBearer, async (req: Request, res: Response) => {
    try {
      await mcpIssueAndRespond(req, res, false);
    } catch (error) {
      console.error('[webui] Error refreshing MCP token:', error);
      res.status(500).json({ error: 'Failed to refresh MCP token' });
    }
  });

  // Revoke a scoped MCP token. The caller MUST present the still-valid raw
  // `token` they want killed — the signature is cryptographically verified and
  // its `sub` must match the caller (see resolveRevocationTarget). There is no
  // revoke-by-bare-jti path: tokens are stateless/unstored, so bare-jti
  // ownership can't be proven, and an already-expired token needs no revocation
  // (it's dead by exp). Revocation == add jti to the list; the gateway rejects
  // it until its short exp.
  app.post('/api/mcp/tokens/revoke', requireSessionOrBearer, async (req: Request, res: Response) => {
    try {
      const userId = mcpResolveUserId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      if (typeof req.body?.token !== 'string' || req.body.token.length === 0) {
        return res.status(400).json({ error: 'Provide the token to revoke' });
      }

      const target = resolveRevocationTarget(req.body.token, config.jwtSecret, userId);
      if (!target.ok) {
        return res.status(target.status).json({ error: target.error });
      }

      const inserted = await revokeMcpJti(target.jti, userId, target.exp, 'user_revoke');
      console.log(`[webui] MCP token revoke by ${userId.slice(0, 8)}… jti=${target.jti.slice(0, 8)}… new=${inserted}`);

      res.json({ revoked: true, jti: target.jti, alreadyRevoked: !inserted });
    } catch (error) {
      console.error('[webui] Error revoking MCP token:', error);
      res.status(500).json({ error: 'Failed to revoke MCP token' });
    }
  });

  // Revocation lookup for the gateway (P12). Returns the set of currently
  // revoked, still-unexpired jtis. The gateway SHOULD cache this briefly (5–30s
  // recommended) and treat the short token exp as the backstop. Authenticated
  // with the system key (server-to-server) — same gate as other internal
  // endpoints — OR an admin session. A single-jti probe is supported via
  // ?jti=… for a cheap point check.
  app.get('/api/mcp/tokens/revocations', requireAdminOrSystemKey, async (req: Request, res: Response) => {
    try {
      const probe = typeof req.query.jti === 'string' ? req.query.jti : undefined;
      if (probe) {
        const revoked = await isMcpJtiRevoked(probe);
        return res.json({ jti: probe, revoked });
      }
      const jtis = await listRevokedMcpJtis();
      res.json({ revoked: jtis, count: jtis.length });
    } catch (error) {
      console.error('[webui] Error listing MCP revocations:', error);
      res.status(500).json({ error: 'Failed to list revocations' });
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // MCP connection lifecycle — scoped refresh + enforced revocation
  // ────────────────────────────────────────────────────────────────────────
  //
  // A paired connection (registered at mint time, see mcpIssueAndRespond) holds
  // a long-lived REFRESH TOKEN that re-mints THIS connection's short-lived
  // workspace JWT without re-pairing. The user can list/revoke their
  // connections; the gateway polls a revoked-pubkey feed to deny a revoked
  // connection's JWT by its `cnf` binding.

  // Per-connection rate limit for the unauthenticated refresh endpoint: a simple
  // in-memory token bucket keyed by the CONNECTION id (NOT the request-supplied
  // token hash — so an attacker spraying unknown tokens cannot grow this Map; we
  // only ever bucket a successfully-resolved connection). Generous — a
  // well-behaved client refreshes at most ~hourly. Honors skipRateLimit so the
  // pg-gated tests (which refresh repeatedly) don't self-trip. In-memory is
  // acceptable: a single webui process owns refresh, the global /api/ IP limiter
  // backstops spray, and the floor is the short JWT exp + revocation anyway.
  const REFRESH_BUCKET_CAPACITY = 30; // burst
  const REFRESH_BUCKET_REFILL_PER_SEC = 30 / 60; // ~30/min sustained
  const refreshBuckets = new Map<string, { tokens: number; last: number }>();
  function refreshRateLimitOk(connId: string): boolean {
    if (options?.skipRateLimit) return true;
    const now = Date.now();
    const b = refreshBuckets.get(connId) ?? { tokens: REFRESH_BUCKET_CAPACITY, last: now };
    // Refill since last seen.
    const elapsedSec = (now - b.last) / 1000;
    b.tokens = Math.min(REFRESH_BUCKET_CAPACITY, b.tokens + elapsedSec * REFRESH_BUCKET_REFILL_PER_SEC);
    b.last = now;
    if (b.tokens < 1) {
      refreshBuckets.set(connId, b);
      return false;
    }
    b.tokens -= 1;
    refreshBuckets.set(connId, b);
    return true;
  }

  // Refresh-by-token — the connection's refresh token IS the credential, so this
  // endpoint is DELIBERATELY UNAUTHENTICATED (no session / no Bearer). The flow:
  // sha256(refresh_token) → find the connection → if missing/revoked → 401 →
  // else re-mint a fresh JWT from the connection's STORED scope (NEVER from the
  // request) with a new jti, and bump last_refreshed_at.
  //
  // SECURITY INVARIANT: mintFromConnection reads scope ONLY off the stored row,
  // so a tampered/widened request body cannot widen the issued token, and the
  // refresh token can never yield a broader-scoped token or the account
  // credential. The endpoint accepts ONLY { refresh_token } — nothing in the
  // body influences scope, ttl, perms, bucket, or the bound pubkey.
  app.post('/api/mcp/tokens/refresh-connection', async (req: Request, res: Response) => {
    try {
      const refreshTokenRaw = req.body?.refresh_token;
      if (typeof refreshTokenRaw !== 'string' || refreshTokenRaw.length === 0) {
        return res.status(400).json({ error: 'Provide refresh_token' });
      }

      const hash = hashRefreshToken(refreshTokenRaw);

      const conn = await findMcpConnectionByRefreshHash(hash);
      // Same 401 for "no such token" and "revoked" — don't disclose which. (We
      // look up BEFORE rate-limiting so unknown tokens can't grow the limiter
      // Map; the global /api/ IP limiter caps spray volume.)
      if (!conn || conn.revoked) {
        return res.status(401).json({ error: 'Invalid or revoked refresh token.' });
      }

      // Per-connection throttle, keyed by the resolved connection id.
      if (!refreshRateLimitOk(conn.id)) {
        return res.status(429).json({ error: 'Too many refreshes; slow down.' });
      }

      // Re-mint PINNED to the stored scope (perms/bucket extracted explicitly;
      // the cnf binding re-applied). A fresh jti each time. TTL parity with the
      // real-mint path (config default; clamped inside mint).
      const { token, claims } = mintFromConnection(
        { user_id: conn.user_id, mcp_pub_b64: conn.mcp_pub_b64, scope: conn.scope },
        config.jwtSecret,
        undefined,
        config.mcpTokenTtlSeconds,
      );

      // Best-effort bookkeeping — never fail an already-minted token over it.
      try {
        await touchMcpConnectionRefreshed(conn.id);
      } catch (err) {
        console.error('[webui] refresh-connection: last_refreshed_at bump failed (non-fatal):', err);
      }

      // ADDITIVE: if this connection has authorized collab groups, ALSO re-mint a
      // short-lived `collab_write` token from the STORED scope (groupIds come
      // ONLY off the row — never the request). Absent groups ⇒ no collab token
      // (older clients see exactly the previous response shape). The collab TTL
      // is the collab token's own short default (<=10 min), independent of the
      // mcp_s3 TTL.
      const collab = mintCollabFromConnection(
        { id: conn.id, user_id: conn.user_id, mcp_pub_b64: conn.mcp_pub_b64, scope: conn.scope },
        config.jwtSecret,
      );

      console.log(
        `[webui] MCP connection refresh conn=${conn.id.slice(0, 8)}… ` +
          `user=${conn.user_id.slice(0, 8)}… jti=${claims.jti.slice(0, 8)}… exp=${claims.exp}` +
          (collab ? ` +collab(groups=${collab.claims.collab.groupIds.length})` : ''),
      );

      res.json({
        token,
        jti: claims.jti,
        expiresAt: claims.exp,
        ...(collab
          ? {
              collabToken: collab.token,
              collabJti: collab.claims.jti,
              collabExpiresAt: collab.claims.exp,
              collabGroupIds: collab.claims.collab.groupIds,
            }
          : {}),
      });
    } catch (error) {
      console.error('[webui] Error refreshing MCP connection:', error);
      res.status(500).json({ error: 'Failed to refresh connection' });
    }
  });

  // List the caller's connections (management UI). User-scoped (session or
  // Bearer). NEVER returns the refresh token or its hash.
  app.get('/api/mcp/connections', requireSessionOrBearer, async (req: Request, res: Response) => {
    try {
      const userId = mcpResolveUserId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      const connections = await listMcpConnectionsForUser(userId);
      res.json({ connections });
    } catch (error) {
      console.error('[webui] Error listing MCP connections:', error);
      res.status(500).json({ error: 'Failed to list connections' });
    }
  });

  // Revoke one of the caller's connections by id. User-scoped: a user can only
  // revoke THEIR OWN connection (revokeMcpConnection filters by user_id). After
  // this, the connection's refresh token is dead (refresh → 401) and the gateway
  // will deny its in-flight JWT once it polls the revoked-pubkey feed.
  app.post('/api/mcp/connections/:id/revoke', requireSessionOrBearer, async (req: Request, res: Response) => {
    try {
      const userId = mcpResolveUserId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      const id = req.params.id;
      if (typeof id !== 'string' || id.length === 0) {
        return res.status(400).json({ error: 'Provide a connection id' });
      }
      const revoked = await revokeMcpConnection(userId, id);
      console.log(
        `[webui] MCP connection revoke by ${userId.slice(0, 8)}… id=${id.slice(0, 8)}… new=${revoked}`,
      );
      res.json({ revoked: true, alreadyRevoked: !revoked });
    } catch (error) {
      console.error('[webui] Error revoking MCP connection:', error);
      res.status(500).json({ error: 'Failed to revoke connection' });
    }
  });

  // Gateway-pollable revoked-connections feed. Same internal/system-key auth as
  // /api/mcp/tokens/revocations (server-to-server, OR admin session). Returns the
  // pubkeys of revoked connections; the gateway denies any MCP JWT whose
  // `cnf.mcp_pub_b64` is in this set (until the JWT's own short exp). The gateway
  // SHOULD cache this briefly (5–30s) and treat the short exp as the backstop.
  app.get('/api/mcp/connections/revoked', requireAdminOrSystemKey, async (_req: Request, res: Response) => {
    try {
      const revoked_pubkeys = await listRevokedConnectionPubkeys();
      res.json({ revoked_pubkeys, count: revoked_pubkeys.length });
    } catch (error) {
      console.error('[webui] Error listing revoked MCP connections:', error);
      res.status(500).json({ error: 'Failed to list revoked connections' });
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Collab-write authorization — delegate an AI connection write access to
  // specific collab groups (the "mint path" a logged-in pairing owner calls).
  // ────────────────────────────────────────────────────────────────────────
  //
  // TRUST MODEL: collab groups are LINK-AUTHORIZED — the groupId UUID is itself
  // the bearer capability (the existing human write routes use only
  // session/api-key + knowledge of the groupId; there is no creator/membership
  // gate). So a user who can NAME a group can already write to it (as the group
  // creator's S3 identity). Authorizing their bound AI connection for that group
  // delegates STRICTLY LESS than they already hold: scoped to named groups,
  // short-TTL, revocable (connection OR group), audited, and NO delete. We
  // therefore gate on (1) the caller OWNING the connection row and (2) every
  // groupId EXISTING (you can't authorize a group you can't name) — NOT on being
  // the creator, which would wrongly lock out non-creator collaborators.
  app.post('/api/mcp/connections/:id/collab-groups', requireSessionOrBearer, async (req: Request, res: Response) => {
    try {
      const userId = mcpResolveUserId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      const id = req.params.id;
      if (typeof id !== 'string' || id.length === 0) {
        return res.status(400).json({ error: 'Provide a connection id' });
      }

      // Validate + canonicalize groupIds (UUIDs, lowercased, deduped, capped).
      let groupIds: string[];
      try {
        groupIds = normalizeGroupIds(req.body?.groupIds);
      } catch (e) {
        return res.status(400).json({ error: (e as Error).message });
      }
      if (groupIds.length === 0) {
        return res.status(400).json({ error: 'Provide at least one groupId' });
      }

      // Every requested group must EXIST (link-capability check) — reject the
      // WHOLE request if any is unknown (no partial authorization).
      const existing = await collabGroupsExist(groupIds);
      const missing = groupIds.filter((g) => !existing.has(g));
      if (missing.length > 0) {
        return res.status(404).json({ error: 'Unknown collab group(s)', missing });
      }

      // Merge into the connection's STORED scope. User-scoped + not-revoked
      // ('not_found' → 404). The cumulative cap is enforced BEFORE persisting
      // ('over_cap' → 409, row left unchanged).
      const result = await authorizeCollabGroupsForConnection(userId, id, groupIds, COLLAB_MAX_GROUP_IDS);
      if (result === 'not_found') {
        return res.status(404).json({ error: 'Connection not found, not yours, or revoked' });
      }
      if (result === 'over_cap') {
        return res.status(409).json({ error: `Too many authorized groups (max ${COLLAB_MAX_GROUP_IDS})` });
      }
      const row = result;
      const storedGroups = row.scope?.collab?.groupIds ?? [];

      // Mint a fresh collab-write token from the UPDATED row (so it matches what
      // is stored). Re-mintable later via the connection refresh-token flow.
      const collab = mintCollabFromConnection(
        { id: row.id, user_id: row.user_id, mcp_pub_b64: row.mcp_pub_b64, scope: row.scope },
        config.jwtSecret,
      );
      if (!collab) {
        // Should not happen (we just merged a non-empty set), but fail closed.
        return res.status(500).json({ error: 'Failed to mint collab token' });
      }

      console.log(
        `[webui] collab authorize by ${userId.slice(0, 8)}… conn=${id.slice(0, 8)}… ` +
          `groups=${storedGroups.length}`,
      );

      res.json({
        connectionId: row.id,
        groupIds: storedGroups,
        collabToken: collab.token,
        jti: collab.claims.jti,
        expiresAt: collab.claims.exp,
        tokenType: COLLAB_TOKEN_USE,
      });
    } catch (error) {
      console.error('[webui] Error authorizing collab groups:', error);
      res.status(500).json({ error: 'Failed to authorize collab groups' });
    }
  });

  // De-authorize (remove) specific collab groups from a connection. User-scoped.
  // Combined with the synchronous DB-truth check on the write path, removal is
  // effective IMMEDIATELY (not after the token's short TTL).
  app.delete('/api/mcp/connections/:id/collab-groups', requireSessionOrBearer, async (req: Request, res: Response) => {
    try {
      const userId = mcpResolveUserId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      const id = req.params.id;
      if (typeof id !== 'string' || id.length === 0) {
        return res.status(400).json({ error: 'Provide a connection id' });
      }
      let groupIds: string[];
      try {
        groupIds = normalizeGroupIds(req.body?.groupIds);
      } catch (e) {
        return res.status(400).json({ error: (e as Error).message });
      }
      if (groupIds.length === 0) {
        return res.status(400).json({ error: 'Provide at least one groupId' });
      }

      const row = await deauthorizeCollabGroupsForConnection(userId, id, groupIds);
      if (!row) {
        return res.status(404).json({ error: 'Connection not found or not yours' });
      }
      const storedGroups = row.scope?.collab?.groupIds ?? [];
      console.log(
        `[webui] collab de-authorize by ${userId.slice(0, 8)}… conn=${id.slice(0, 8)}… ` +
          `remaining=${storedGroups.length}`,
      );
      res.json({ connectionId: row.id, groupIds: storedGroups });
    } catch (error) {
      console.error('[webui] Error de-authorizing collab groups:', error);
      res.status(500).json({ error: 'Failed to de-authorize collab groups' });
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Hosted-MCP collab bundle — producer (C1) + by-pubkey consumer (C2)
  // ────────────────────────────────────────────────────────────────────────
  //
  // A paired AI (hosted on a Cloudflare Worker) holds an X25519 keypair per
  // (user, oauth client). To let it act on ONE collaboration group, the FxFiles
  // app (authed AS THE USER) stores a "bundle" for the AI's pubkey (C1): the
  // group pointers + the group link secret WRAPPED (sealed) to that pubkey. The
  // Worker later fetches the bundle BY PUBKEY (C2, service-auth'd) and unwraps it
  // with its keypair to build a CollabSession.
  //
  // ISOLATION: a bundle is keyed to (user_id, pubkey). C1 attaches it to the
  // caller's OWN connection; C2 returns it ONLY to a service-auth caller that
  // asserts the SAME user_id (the (user_id, pubkey) filter is in SQL).
  // `wrapped_link_secret` is ciphertext — safe at rest, and even a hypothetical
  // isolation slip leaks only ciphertext, never a usable key.

  // C1 — the user (session or Bearer api-key) publishes the bundle for an AI
  // pubkey. `connection_id` (optional) pins the exact row the pairing just minted;
  // otherwise the newest non-revoked connection for (user, pubkey). The bundle's
  // group_id MUST already be authorized on that connection (POST .../collab-groups)
  // so C2 can always mint a collab token that covers it → 409 otherwise.
  app.post('/api/mcp/connections/bundle', requireSessionOrBearer, async (req: Request, res: Response) => {
    try {
      const userId = mcpResolveUserId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required.' });
      }

      const validated = validateBundlePayload(req.body);
      if (!validated.ok) {
        return res.status(validated.status).json({ error: validated.error });
      }
      const { mcpPubB64, connectionId, bundle } = validated.value;

      // Resolve the target connection row.
      let conn;
      if (connectionId) {
        conn = await findMcpConnectionById(connectionId);
        // Must exist, be the caller's, live, and bound to the SAME pubkey the
        // secret was wrapped to (else the Worker could never unwrap it).
        if (!conn || conn.user_id !== userId || conn.revoked || conn.mcp_pub_b64 !== mcpPubB64) {
          return res.status(404).json({ error: 'Connection not found, not yours, revoked, or pubkey mismatch' });
        }
      } else {
        conn = await findNewestMcpConnectionByPubkey(userId, mcpPubB64);
        if (!conn) {
          return res.status(404).json({ error: 'No connection for this pubkey — pair the AI first' });
        }
      }

      // The bundle's group MUST be authorized on this connection: C2 mints the
      // collab-write token from the row's scope.collab.groupIds (server truth), so
      // a group_id outside that set could never be written by the AI. Reject at
      // store time with a clear signal (authorize the group first).
      const authorizedGroups = Array.isArray(conn.scope?.collab?.groupIds) ? conn.scope.collab!.groupIds : [];
      if (!authorizedGroups.includes(bundle.group_id)) {
        return res.status(409).json({ error: 'bundle group_id is not authorized on this connection — authorize the group first' });
      }

      const storedId = await setMcpConnectionBundleById(conn.id, userId, bundle);
      if (!storedId) {
        // Row revoked/removed between resolve and write — fail closed.
        return res.status(409).json({ error: 'Connection no longer available' });
      }

      console.log(
        `[webui] MCP bundle stored by ${userId.slice(0, 8)}… conn=${storedId.slice(0, 8)}… ` +
          `pub=${mcpPubB64.slice(0, 8)}… group=${bundle.group_id.slice(0, 8)}…`,
      );

      res.json({ ok: true, connectionId: storedId, groupId: bundle.group_id });
    } catch (error) {
      console.error('[webui] Error storing MCP bundle:', error);
      res.status(500).json({ error: 'Failed to store bundle' });
    }
  });

  // C2 — the Worker fetches the bundle BY PUBKEY. Auth is the HMAC service-auth
  // header ONLY (asserts the Worker's authenticated user_id); NEVER session/Bearer.
  // Returns the stored bundle + a FRESH short-lived collab-write token minted from
  // the connection's stored scope. `webui_base` is derived from THIS request's Host
  // (the service-authed caller), NOT a stored C1 body value — a narrowing, since
  // only a service-auth holder can influence it, and the Worker re-validates it
  // (https/loopback). A configured canonical origin would be strictly more robust
  // (see S3/S5).
  //
  // `:pubkey` MUST be base64url — a standard-base64 pubkey contains '/' and '+',
  // which don't survive a path segment. normalizeMcpPubB64 re-canonicalizes it to
  // the stored standard-base64 form for the lookup.
  //
  // This endpoint is under the global /api/ IP rate limiter, so the Worker MUST
  // cache the (static) bundle + reuse the collab token until near its <=10-min
  // expiry — reads need no C2 call at all.
  app.get('/api/mcp/connections/by-pubkey/:pubkey/bundle', async (req: Request, res: Response) => {
    try {
      // Service-auth ONLY (fail-closed): a present-but-invalid header is a 401,
      // never a fall-through to session/Bearer. `?? ''` is SAFE — verifyServiceAuth
      // rejects an empty/'disabled' secret (returns null → 401), so a missing
      // FULA_PIN_SERVICE_SECRET DISABLES the endpoint (fail-closed), never fail-open.
      // (Same call shape as the existing /api/v1/storage service-auth path.)
      const svcAuth = req.headers[SERVICE_AUTH_HEADER];
      const userId = typeof svcAuth === 'string' ? verifyServiceAuth(svcAuth, config.pinServiceSecret ?? '') : null;
      if (!userId) {
        return res.status(401).json({ error: 'Invalid service authentication' });
      }

      const pubkey = normalizeMcpPubB64(req.params.pubkey);
      if (!pubkey) {
        return res.status(400).json({ error: 'pubkey must be base64url of a 32-byte X25519 public key' });
      }

      // The (user_id, pubkey) filter is in SQL — the cross-user isolation boundary.
      const conn = await findMcpConnectionWithBundleByPubkey(userId, pubkey);
      if (!conn || !conn.bundle) {
        return res.status(404).json({ error: 'No bundle for this connection' });
      }

      // The bundle's group must STILL be authorized on the connection. A group
      // de-authorized AFTER the bundle was stored (DELETE .../collab-groups) makes
      // the bundle stale — withhold it (revokes the AI's READ access to that group
      // on the next fetch, not just its writes), mirroring C1's store-time check.
      // Same 404 as "no bundle" — no oracle for the distinction.
      const liveGroups = Array.isArray(conn.scope?.collab?.groupIds) ? conn.scope.collab!.groupIds : [];
      if (!liveGroups.includes(conn.bundle.group_id)) {
        return res.status(404).json({ error: 'No bundle for this connection' });
      }

      // Mint a fresh short-lived collab-write token from the STORED scope (groups
      // come ONLY off the row). The group_id-authorized check above guarantees a
      // non-empty scope, so a token is minted; the `collab ?` guard stays as
      // fail-closed defense. The write path re-checks revocation synchronously, so
      // a token minted here for a just-revoked connection is still denied on use.
      const collab = mintCollabFromConnection(
        { id: conn.id, user_id: conn.user_id, mcp_pub_b64: conn.mcp_pub_b64, scope: conn.scope },
        config.jwtSecret,
      );

      // Derived from THIS request's Host (respecting the trusted proxy), NOT a
      // stored C1 body value. Host is itself client-supplied, so this NARROWS —
      // rather than eliminates — the SSRF surface: only a service-auth caller can
      // set it, and the Worker independently re-validates https/loopback before it
      // fetches. A configured canonical origin would be strictly more robust.
      const webuiBase = `${req.protocol}://${req.get('host')}`;

      // GET returns a bearer token — no caching by intermediaries / the browser.
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.set('Pragma', 'no-cache');

      console.log(
        `[webui] MCP bundle fetch user=${userId.slice(0, 8)}… conn=${conn.id.slice(0, 8)}… ` +
          `pub=${pubkey.slice(0, 8)}… group=${conn.bundle.group_id.slice(0, 8)}…` +
          (collab ? ` +collab(groups=${collab.claims.collab.groupIds.length})` : ' (no collab token)'),
      );

      res.json({
        group_id: conn.bundle.group_id,
        manifest_bucket: conn.bundle.manifest_bucket,
        manifest_key: conn.bundle.manifest_key,
        webui_base: webuiBase,
        wrapped_link_secret: conn.bundle.wrapped_link_secret,
        ...(collab
          ? {
              collab_write_token: collab.token,
              collab_expires_at: collab.claims.exp,
              collab_group_ids: collab.claims.collab.groupIds,
            }
          : {}),
      });
    } catch (error) {
      console.error('[webui] Error fetching MCP bundle:', error);
      res.status(500).json({ error: 'Failed to fetch bundle' });
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Phase 15a — MCP grant store
  // ────────────────────────────────────────────────────────────────────────
  //
  // A user GRANTS a paired MCP connection scoped access to their REAL files by
  // publishing per-file ShareTokens (sealed to the MCP pubkey) here; the
  // stateless MCP later FETCHES its grants. Publish/revoke are authed as the
  // USER (session or Bearer API-key — FxFiles publishes via Bearer). The fetch
  // is authed with the MCP's own scoped JWT, and is scoped to the connection
  // identity (`cnf`) baked into that verified JWT — the SECURITY BOUNDARY that
  // stops agent A reading agent B's granted paths.

  // POST /api/mcp/grants — the user publishes grants for a connection pubkey.
  app.post('/api/mcp/grants', requireSessionOrBearer, async (req: Request, res: Response) => {
    try {
      const userId = mcpResolveUserId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required.' });
      }

      const validated = validateGrantsPayload(req.body);
      if (!validated.ok) {
        return res.status(validated.status).json({ error: validated.error });
      }
      const { mcpPubB64, grants } = validated.value;

      const ids = await insertMcpGrants(userId, mcpPubB64, grants);

      // Audit: counts + a pubkey PREFIX only — never token_json (carries the
      // sealed DEK) and never the full key.
      console.log(
        `[webui] MCP grants published by ${userId.slice(0, 8)}… conn=${mcpPubB64.slice(0, 8)}… count=${ids.length}`,
      );

      res.status(201).json({ inserted: ids.length, ids });
    } catch (error) {
      console.error('[webui] Error publishing MCP grants:', error);
      res.status(500).json({ error: 'Failed to publish grants' });
    }
  });

  // GET /api/mcp/grants — the MCP fetches ITS grants. Auth is the MCP's own
  // scoped JWT (NOT a user session / API-key): verify it, then return ONLY the
  // grants for (sub, cnf.mcp_pub_b64), both read off the VERIFIED claims. This
  // is a distinct auth path from requireSessionOrBearer (which checks api_keys).
  app.get('/api/mcp/grants', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'MCP scoped JWT required (Bearer).' });
      }
      const raw = authHeader.substring(7);

      let claims;
      try {
        claims = verifyMcpToken(raw, config.jwtSecret);
      } catch {
        return res.status(401).json({ error: 'Invalid or expired MCP token.' });
      }

      // SECURITY BOUNDARY: the connection identity comes ONLY from the verified
      // `cnf` claim. An unbound token (no cnf) has no connection identity, so it
      // gets ZERO grants — NEVER all the user's grants. Checked FIRST (cheap,
      // no DB): an unbound token returns nothing regardless of revocation state,
      // so short-circuiting here is strictly safe AND keeps this boundary
      // assertion runnable without Postgres.
      const mcpPubB64 = getCnfMcpPubB64(claims);
      if (!mcpPubB64) {
        return res.json({ grants: [] });
      }

      // Revocation check — verifyMcpToken does NOT consult the revoked-jti list,
      // so a revoked token could otherwise still enumerate granted paths until
      // its short exp. Fail closed (treat a revocation-store error as denied).
      try {
        if (await isMcpJtiRevoked(claims.jti)) {
          return res.status(401).json({ error: 'Token revoked.' });
        }
      } catch (err) {
        console.error('[webui] MCP grants: revocation check failed, denying:', err);
        return res.status(503).json({ error: 'Revocation check unavailable.' });
      }

      const rows = await listActiveGrantsForConnection(claims.sub, mcpPubB64);
      res.json({
        grants: rows.map((r) => ({
          id: r.id,
          scope: r.scope,
          permissions: r.permissions,
          token_json: r.token_json,
          expires_at: r.expires_at,
        })),
      });
    } catch (error) {
      console.error('[webui] Error fetching MCP grants:', error);
      res.status(500).json({ error: 'Failed to fetch grants' });
    }
  });

  // POST /api/mcp/grants/revoke — the user revokes grants. Either a single row
  // by `{ id }`, or all rows for `{ mcp_pub_b64, scope }`. User-scoped (a user
  // can only revoke their own grants).
  app.post('/api/mcp/grants/revoke', requireSessionOrBearer, async (req: Request, res: Response) => {
    try {
      const userId = mcpResolveUserId(req);
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required.' });
      }

      const body = req.body ?? {};
      let target: { id: string } | { mcpPubB64: string; scope: string };
      if (typeof body.id === 'string' && body.id.length > 0) {
        target = { id: body.id };
      } else if (typeof body.mcp_pub_b64 === 'string' && typeof body.scope === 'string' && body.scope.length > 0) {
        const norm = normalizeMcpPubB64(body.mcp_pub_b64);
        if (!norm) {
          return res.status(400).json({ error: 'mcp_pub_b64 must be base64 of a 32-byte X25519 public key' });
        }
        target = { mcpPubB64: norm, scope: body.scope };
      } else {
        return res.status(400).json({ error: 'Provide { id } or { mcp_pub_b64, scope } to revoke' });
      }

      const revokedCount = await revokeMcpGrant(userId, target);
      console.log(
        `[webui] MCP grants revoked by ${userId.slice(0, 8)}… ` +
          ('id' in target ? `id=${target.id.slice(0, 8)}…` : `conn=${target.mcpPubB64.slice(0, 8)}… scope=${target.scope}`) +
          ` count=${revokedCount}`,
      );

      res.json({ revoked: revokedCount });
    } catch (error) {
      console.error('[webui] Error revoking MCP grants:', error);
      res.status(500).json({ error: 'Failed to revoke grants' });
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

  // DAG import (CAR upload) — vendor extension, env-gated. The multipart body
  // is piped through to the Go pinning service untouched (express.json
  // ignores multipart, so the raw stream is still available here); the
  // feature-flag check runs BEFORE requireAuth so a disabled deployment
  // 404s without revealing the route.
  app.post(
    '/api/pins/import-dag',
    (_req: Request, res: Response, next: NextFunction) => {
      if (!config.dagImportEnabled) {
        return res.status(404).json({ error: 'Not found' });
      }
      next();
    },
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const maxBytes = config.dagImportMaxCarBytes ?? 838860800;
        const contentLength = parseInt((req.headers['content-length'] as string) || '0', 10);
        if (contentLength && contentLength > maxBytes + 1048576) {
          return res.status(413).json({ error: 'CAR file too large' });
        }

        const keys = await dbOps.getApiKeys(req.session.user!.userId);
        if (!keys || keys.length === 0) {
          return res.status(400).json({ error: 'No API key found. Please create an API key first.' });
        }

        const headers: Record<string, string> = {
          'Authorization': `Bearer ${keys[0].key_id}`,
          'Content-Type': (req.headers['content-type'] as string) || 'multipart/form-data',
        };
        if (contentLength) {
          headers['Content-Length'] = String(contentLength);
        }

        console.log(`[webui] Importing DAG (CAR upload, ${contentLength || 'unknown'} bytes) via pinning service`);
        const response = await httpPostStream('http://127.0.0.1:6000/pins/import/car', headers, req);

        if (response.status === 200 || response.status === 202) {
          const pinData = JSON.parse(response.data);
          return res.status(response.status).json({
            requestId: pinData.requestid,
            cid: pinData.pin?.cid,
            status: pinData.status || 'queued',
            info: pinData.info || {},
          });
        }

        // Propagate upstream errors (400 invalid CAR / 402 quota / 413 / 429)
        // with the pinning service's failure details when available.
        let message = 'Failed to import DAG';
        try {
          const failure = JSON.parse(response.data);
          message = failure?.error?.details || failure?.error?.reason || message;
        } catch { /* non-JSON upstream error body */ }
        console.error('[webui] DAG import failed:', response.status, message);
        return res.status(response.status).json({ error: message });
      } catch (error) {
        console.error('[webui] Error importing DAG:', error);
        res.status(502).json({ error: 'Failed to reach pinning service' });
      }
    }
  );

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

  // Upload encrypted file for collaboration (public - link-authorized).
  // Auth: session OR human api-key OR an AI `collab_write` token (see
  // requireCollabWriteAuth). The audit row is written by that middleware.
  app.post('/api/collab/:groupId/upload',
    requireCollabWriteAuth,
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
        const bucket = config.collabMetadataWriteBucket || 'fula-metadata';
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
      // MERGE-read: a file lives in exactly one bucket — try the (v8) write
      // bucket first, then fall back to legacy (covers files uploaded before
      // the v8 cutover). Single read when both names are the same.
      const writeBucket = config.collabMetadataWriteBucket || 'fula-metadata';
      const readBuckets = writeBucket === 'fula-metadata'
        ? ['fula-metadata']
        : [writeBucket, 'fula-metadata'];

      let buffer: Buffer | null = null;
      let lastStatus = 500;
      for (const b of readBuckets) {
        const r = await fetch(`${s3BaseUrl}/${b}/${storageKey}`, {
          headers: { 'Authorization': `Bearer ${s3Jwt}` },
        });
        if (r.ok) { buffer = Buffer.from(await r.arrayBuffer()); break; }
        lastStatus = r.status;
      }

      if (!buffer) {
        console.error('[webui] Collab file fetch failed:', lastStatus);
        return res.status(lastStatus === 404 ? 404 : 500).json({ error: 'File not found' });
      }

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
        const bucket = config.collabMetadataWriteBucket || 'fula-metadata';
        const storageKey = `.fula/collab/${groupId}/files/${fileId}`;
        const deleteUrl = `${s3BaseUrl}/${bucket}/${storageKey}`;

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

  // Update collaboration manifest (public - link-authorized). Auth: session OR
  // human api-key OR an AI `collab_write` token (requireCollabWriteAuth).
  app.put('/api/collab/:groupId/manifest',
    requireCollabWriteAuth,
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
        const bucket = config.collabMetadataWriteBucket || 'fula-metadata';
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

  // Parse the OPTIONAL CAS precondition for manifest-sync: an `If-Match` header
  // (HTTP-canonical, takes precedence) OR a body `baseVersion`. Returns the base
  // version to guard against, or null for NO CAS (legacy behaviour). A present
  // but non-integer precondition is a client error. `If-Match: *` is unsupported
  // here (we use numeric versions, not entity-tags-as-existence).
  function parseCollabBaseVersion(req: Request): { ok: true; base: number | null } | { ok: false } {
    // Upper bound = MAX_SAFE_INTEGER: keeps the value safely within Postgres
    // BIGINT range, so an absurd precondition is a 400 (client error) rather
    // than a `$::bigint` cast 500.
    const inRange = (n: number) => Number.isInteger(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
    const ifMatch = req.headers['if-match'];
    if (typeof ifMatch === 'string' && ifMatch.trim().length > 0) {
      const cleaned = ifMatch.trim().replace(/^W\//i, '').replace(/^"(.*)"$/, '$1').trim();
      const n = Number(cleaned);
      if (!inRange(n)) return { ok: false };
      return { ok: true, base: n };
    }
    const bodyBase = (req.body as { baseVersion?: unknown } | undefined)?.baseVersion;
    if (bodyBase !== undefined && bodyBase !== null) {
      if (typeof bodyBase !== 'number' || !inRange(bodyBase)) return { ok: false };
      return { ok: true, base: bodyBase };
    }
    return { ok: true, base: null };
  }

  // Sync collaboration manifest JSON to DB (called by Flutter after manifest
  // updates). Auth: session OR human api-key OR an AI `collab_write` token.
  app.put('/api/collab/:groupId/manifest-sync', requireCollabWriteAuth, collabManifestLimiter, async (req: Request, res: Response) => {
    try {
      const { groupId } = req.params;
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidPattern.test(groupId)) {
        return res.status(400).json({ error: 'Invalid group ID format' });
      }

      // Creator identity: a HUMAN principal becomes/keeps the creator (the
      // collab S3 namespace owner). An AI `collab_write` principal NEVER sets
      // creator_id — COALESCE in the upsert preserves the existing creator (the
      // AI writes under the human creator's S3 key, see getCollabS3Jwt).
      const creatorId = req.collabPrincipal?.type === 'user' ? req.collabPrincipal.userId : null;

      const body = (req.body ?? {}) as { data?: unknown; encryptedManifest?: unknown };
      const hasEncrypted = typeof body.encryptedManifest === 'string' && body.encryptedManifest.length > 0;
      const hasData = typeof body.data === 'string' && body.data.length > 0;
      if (!hasEncrypted && !hasData) {
        return res.status(400).json({ error: 'Missing manifest data' });
      }

      // OPT-IN conditional write. Absent ⇒ identical to legacy (always writes,
      // now also bumping manifest_version). Present ⇒ 409 if the stored version
      // moved since the client's base.
      const parsed = parseCollabBaseVersion(req);
      if (!parsed.ok) {
        return res.status(400).json({ error: 'Invalid If-Match / baseVersion (expected a non-negative integer)' });
      }

      const result = await syncCollabManifest(groupId, {
        encryptedManifest: hasEncrypted ? (body.encryptedManifest as string) : null,
        data: hasData ? (body.data as string) : null,
        creatorId,
        baseVersion: parsed.base,
      });

      if (!result.ok) {
        // CAS conflict — the stored version moved. The client should re-read
        // (GET manifest-sync), re-merge, and retry with the new baseVersion.
        res.setHeader('ETag', `"${result.version}"`);
        return res.status(409).json({ error: 'Manifest version conflict', currentVersion: result.version });
      }

      console.log('[webui] Collab manifest synced for group:', groupId, `v${result.version}`);
      res.setHeader('ETag', `"${result.version}"`);
      res.json({ ok: true, version: result.version });
    } catch (error) {
      console.error('[webui] Error syncing collab manifest:', error);
      res.status(500).json({ error: 'Failed to sync manifest' });
    }
  });

  // Fetch collaboration manifest JSON from DB (called by portal). Also returns
  // the current `version` (+ ETag) so a client can drive opt-in CAS.
  app.get('/api/collab/:groupId/manifest-sync', collabManifestLimiter, async (req: Request, res: Response) => {
    try {
      const { groupId } = req.params;
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidPattern.test(groupId)) {
        return res.status(400).json({ error: 'Invalid group ID format' });
      }

      const result = await query<{ manifest_data: string | null; encrypted_manifest: string | null; manifest_version: string | number | null }>(
        'SELECT manifest_data, encrypted_manifest, manifest_version FROM collab_manifests WHERE group_id = $1',
        [groupId],
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Not found' });
      }

      const row = result.rows[0];
      const version = Number(row.manifest_version ?? 0);
      res.setHeader('ETag', `"${version}"`);
      if (row.encrypted_manifest) {
        res.json({ encryptedManifest: row.encrypted_manifest, version });
      } else {
        res.json({ data: row.manifest_data, version });
      }
    } catch (error) {
      console.error('[webui] Error fetching collab manifest:', error);
      res.status(500).json({ error: 'Failed to fetch manifest' });
    }
  });

  // Per-group AI-write KILL SWITCH (the "group is revoked" server source of
  // truth checked synchronously on every collab write — collab_manifests flag,
  // NOT the manifest blob). CREATOR-GATED: only the group's creator_id may flip
  // it (the collab files live in the creator's S3 namespace, so the creator is
  // the authority for whether AI agents may write at all). This deliberately
  // lives OUTSIDE the `/collab/` CSRF-exempt path so a session caller still gets
  // the Origin check on this state change (Bearer callers are CSRF-immune).
  app.post('/api/collab-groups/:groupId/ai-writes', requireSessionOrBearer, async (req: Request, res: Response) => {
    try {
      const { groupId } = req.params;
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidPattern.test(groupId)) {
        return res.status(400).json({ error: 'Invalid group ID format' });
      }
      const callerId = mcpResolveUserId(req);
      if (!callerId) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      const revoked = req.body?.revoked;
      if (typeof revoked !== 'boolean') {
        return res.status(400).json({ error: 'Provide { revoked: boolean }' });
      }

      const result = await setCollabWritesRevoked(groupId, callerId, revoked);
      if (result === 'not_found') {
        return res.status(404).json({ error: 'Group not found' });
      }
      if (result === 'forbidden') {
        return res.status(403).json({ error: 'Only the group creator can change AI-write access' });
      }
      console.log(
        `[webui] collab ai-writes ${revoked ? 'REVOKED' : 'restored'} group=${groupId.slice(0, 8)}… by ${callerId.slice(0, 8)}…`,
      );
      res.json({ groupId, collabWritesRevoked: revoked });
    } catch (error) {
      console.error('[webui] Error toggling collab ai-writes:', error);
      res.status(500).json({ error: 'Failed to toggle collab ai-writes' });
    }
  });

  // Health check
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Feature flags for the frontend (no auth — same exposure as /api/health).
  // The UI uses this to decide whether to render the Import DAG button.
  app.get('/api/features', (_req: Request, res: Response) => {
    res.json({
      dagImport: !!config.dagImportEnabled,
      dagImportMaxCarBytes: config.dagImportMaxCarBytes ?? 838860800,
    });
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
      // Paginated so the billing page can walk back through older
      // transactions instead of only ever showing the latest slice.
      // `page` is clamped at both ends; `limit` is capped so one request
      // cannot pull an entire history.
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const offset = (page - 1) * limit;

      const { history, total } = await getCreditHistoryPage(
        req.session.user!.userId,
        limit,
        offset
      );

      // `history` stays top-level so older clients that read only that
      // field keep working unchanged.
      res.json({
        history,
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      });
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
          SELECT referred_id, 1 as level, ARRAY[referred_id]::varchar[] as path
          FROM referrals WHERE referrer_id = $1
          UNION ALL
          SELECT r.referred_id, rc.level + 1, rc.path || r.referred_id
          FROM referrals r
          JOIN referral_chain rc ON r.referrer_id = rc.referred_id
          WHERE rc.level < 3 AND r.referred_id <> $1 AND NOT r.referred_id = ANY(rc.path)
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

      // Per-code rollup: direct-referral counts (Level 1) AND total bonus
      // earned by the recipient via this specific code (attributed to the
      // recipient's chain-entry code, i.e. the leftmost code in each bonus's
      // description chain). Scalar subqueries avoid cardinality blow-up
      // that a single JOIN of referrals × referral_bonuses would produce.
      const perCodeResult = await query<{ code: string; total_referred: string; total_bonus: string }>(`
        SELECT
          rc.code,
          (SELECT COUNT(*) FROM referrals r
            WHERE r.referrer_id = rc.user_id AND r.referral_code = rc.code)::text AS total_referred,
          (SELECT COALESCE(SUM(rb.bonus_amount_fula), 0) FROM referral_bonuses rb
            WHERE rb.recipient_user_id = rc.user_id AND rb.recipient_referral_code = rc.code)::text AS total_bonus
        FROM referral_codes rc
        WHERE rc.user_id = $1
      `, [userId]);
      const perCodeData = new Map<string, { referred: number; bonus: number }>();
      for (const row of perCodeResult.rows) {
        perCodeData.set(row.code, {
          referred: parseInt(row.total_referred, 10),
          bonus: parseFloat(row.total_bonus),
        });
      }

      // Total bonuses earned by this user across all their codes (for the
      // stats tile). Cross-checks against user_credits.total_bonus_received_fula.
      const totalBonusResult = await query<{ total: string }>(
        `SELECT COALESCE(SUM(bonus_amount_fula), 0)::text AS total
         FROM referral_bonuses
         WHERE recipient_user_id = $1`,
        [userId]
      );
      const totalBonusReceived = parseFloat(totalBonusResult.rows[0]?.total || '0');

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
          totalReferred: perCodeData.get(c.code)?.referred ?? 0,
          totalBonus: perCodeData.get(c.code)?.bonus ?? 0,
        })),
        // Legacy: single default code for backward compatibility
        code: defaultCode.code,
        createdAt: defaultCode.createdAt,
        stats,
        totalReferred: stats.level1.count,
        totalCreditsFromReferrals: stats.total.credits,
        totalBonusReceived,
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
          SELECT referred_id, 1 as level, ARRAY[referred_id]::varchar[] as path
          FROM referrals WHERE referrer_id = $1
          UNION ALL
          SELECT r.referred_id, rc.level + 1, rc.path || r.referred_id
          FROM referrals r
          JOIN referral_chain rc ON r.referrer_id = rc.referred_id
          WHERE rc.level < 3 AND r.referred_id <> $1 AND NOT r.referred_id = ANY(rc.path)
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

    // L1b: also accept the system key presented as `Authorization: Bearer <key>`.
    // The Rust gateway's connection-revocation poller authenticates this feed via
    // bearer_auth(FULA_MCP_REVOCATION_INTERNAL_TOKEN), not the X-System-Key header.
    // A normal user JWT api-key never equals config.systemKey, so the length-guard
    // + timingSafeEqual leaves user bearers rejected (the auth-boundary test holds).
    const authHeader = req.header('Authorization') || req.header('authorization');
    if (authHeader && config.systemKey) {
      const m = /^Bearer\s+(.+)$/i.exec(authHeader);
      const bearerKey = m ? m[1] : undefined;
      if (bearerKey &&
          bearerKey.length === config.systemKey.length &&
          crypto.timingSafeEqual(Buffer.from(bearerKey), Buffer.from(config.systemKey))) {
        (req as any).isSystemCall = true;
        return next();
      }
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
  // ============================================
  // Public directory (yellow pages) moderation
  // ============================================
  //
  // Queries the SAME Postgres the AI service owns, rather than proxying
  // to its SYSTEM_KEY-guarded admin routes: the webui already reads that
  // database directly (see /api/public/stats), and a proxy would mean
  // shipping the system key into this process for no gain.
  //
  // Delisting removes the DIRECTORY ENTRY only — the site is
  // content-addressed on IPFS and stays reachable to anyone holding its
  // link. The page says so; do not let the wording here imply otherwise.

  /** Everything currently listed, newest first, with its report count. */
  app.get('/api/admin/directory/listings', requireAdmin, async (_req: Request, res: Response) => {
    try {
      // One row per WEBSITE, not per generation.
      //
      // Every regeneration is another `ai_generations` row sharing the
      // site's `listing_group`, and the public page shows one entry per
      // group. Listing them per row showed one site several times and —
      // worse — let an admin "Restore" a build that was never the one
      // removed, leaving the site hidden while this page claimed it was
      // back. Both flags are folded across the group exactly as the
      // public query folds them, so what an admin sees here is what
      // visitors see.
      const result = await query(`
        WITH base AS (
          SELECT *, COALESCE(listing_group, id::text) AS grp
            FROM ai_generations
           WHERE status = 'completed'
             AND (listed = TRUE OR delisted_by_admin = TRUE)
        ),
        state AS (
          SELECT grp,
                 bool_or(listed)            AS grp_listed,
                 bool_or(delisted_by_admin) AS grp_delisted
            FROM base
           GROUP BY grp
        ),
        rep AS (
          -- The newest still-listed build; fall back to a removed one so
          -- a fully removed site stays visible here to be restored.
          SELECT DISTINCT ON (grp) *
            FROM base
           ORDER BY grp, listed DESC, completed_at DESC NULLS LAST
        )
        SELECT rep.id, rep.listing_name, rep.listing_category, rep.listing_description,
               COALESCE(rep.listing_url, rep.gateway_url) AS url,
               state.grp_listed   AS listed,
               state.grp_delisted AS delisted_by_admin,
               rep.completed_at,
               (SELECT COUNT(*)::int
                  FROM directory_reports r
                  JOIN ai_generations g2 ON g2.id = r.generation_id
                 WHERE COALESCE(g2.listing_group, g2.id::text) = rep.grp
                   AND r.resolved = FALSE) AS open_reports
          FROM rep
          JOIN state ON state.grp = rep.grp
         ORDER BY rep.completed_at DESC NULLS LAST
         LIMIT 200
      `);
      res.json({ listings: result.rows });
    } catch (error) {
      console.error('[webui] Error listing directory entries:', error);
      res.status(500).json({ error: 'Failed to list directory entries' });
    }
  });

  /** Open abuse reports, newest first. */
  app.get('/api/admin/directory/reports', requireAdmin, async (req: Request, res: Response) => {
    try {
      const onlyOpen = req.query.all !== 'true';
      const result = await query(`
        SELECT r.id, r.generation_id, r.reason, r.details, r.resolved, r.created_at,
               g.listing_name, COALESCE(g.listing_url, g.gateway_url) AS url,
               g.delisted_by_admin
          FROM directory_reports r
          LEFT JOIN ai_generations g ON g.id = r.generation_id
         ${onlyOpen ? 'WHERE r.resolved = FALSE' : ''}
         ORDER BY r.created_at DESC
         LIMIT 200
      `);
      res.json({ reports: result.rows });
    } catch (error) {
      console.error('[webui] Error getting directory reports:', error);
      res.status(500).json({ error: 'Failed to get directory reports' });
    }
  });

  /** Remove a listing from the directory, or restore one. */
  app.post('/api/admin/directory/:id/delist', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      // ai_generations.id is a UUID column: a malformed id must answer
      // 404 rather than raising invalid-input-syntax as a 500.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return res.status(404).json({ error: 'Not found' });
      }
      const restore = req.body?.restore === true;

      // Act on the whole WEBSITE, not the one build this id names.
      //
      // Marking a single row left the site in the directory through its
      // other builds: the public query simply fell through to the
      // next-newest listed one and the site REAPPEARED, with the report
      // that prompted the removal already closed. A takedown that can be
      // undone by regenerating is not a takedown.
      const result = await query(
        `UPDATE ai_generations
            SET delisted_by_admin = $1, updated_at = CURRENT_TIMESTAMP
          WHERE status = 'completed'
            AND COALESCE(listing_group, id::text) = (
                  SELECT COALESCE(listing_group, id::text)
                    FROM ai_generations WHERE id = $2
                )`,
        [!restore, id]
      );
      if ((result.rowCount || 0) === 0) {
        return res.status(404).json({ error: 'Not found' });
      }
      // Delisting closes the reports that prompted it; restoring does not
      // reopen them — a human already looked. Reports filed against any
      // build of the site all refer to the same site.
      if (!restore) {
        await query(
          `UPDATE directory_reports
              SET resolved = TRUE
            WHERE generation_id IN (
                    SELECT id FROM ai_generations
                     WHERE COALESCE(listing_group, id::text) = (
                             SELECT COALESCE(listing_group, id::text)
                               FROM ai_generations WHERE id = $1
                           )
                  )`,
          [id]
        );
      }
      res.json({ ok: true, delisted: !restore });
    } catch (error) {
      console.error('[webui] Error delisting directory entry:', error);
      res.status(500).json({ error: 'Failed to update listing' });
    }
  });

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

      // Get referrers with stats. The totalBonus subquery is correlated to
      // (rc.user_id, rc.code) and computed once per grouped row, so it does
      // not multiply with the LEFT JOINs on referrals × user_credits.
      const referrersResult = await query<{
        user_id: string;
        code: string;
        codecreatedat: string;
        totalreferred: string;
        totalcreditsfromreferrals: string;
        totalbonus: string;
      }>(`
        SELECT
          rc.user_id,
          rc.code,
          rc.created_at as codeCreatedAt,
          COUNT(r.id)::text as totalReferred,
          COALESCE(SUM(uc.total_deposited_fula), 0)::text as totalCreditsFromReferrals,
          (SELECT COALESCE(SUM(rb.bonus_amount_fula), 0) FROM referral_bonuses rb
            WHERE rb.recipient_user_id = rc.user_id
              AND rb.recipient_referral_code = rc.code)::text as totalBonus
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
        totalBonus: parseFloat(r.totalbonus),
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
