import 'dotenv/config';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createApp, initializeDatabase, seedChainSyncState, type AppConfig } from './app.js';
import { startBlockScanner, stopBlockScanner } from './services/blockScanner.js';
import { startDeductionJob, stopDeductionJob } from './services/deductionJob.js';
import { closePool } from './database/postgres.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const config: AppConfig = {
  port: parseInt(process.env.WEBUI_PORT || '3001'),
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleAdditionalAudiences: (process.env.GOOGLE_ADDITIONAL_AUDIENCES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  sessionSecret: process.env.SESSION_SECRET || 'change-this-in-production-' + uuidv4(),
  jwtSecret: process.env.JWT_SECRET || process.env.SESSION_SECRET || 'change-this-jwt-secret-in-production',
  nodeEnv: process.env.NODE_ENV || 'development',
  pinningServiceUrl: process.env.PINNING_SERVICE_URL || 'http://localhost:8080',
  systemKey: process.env.PINNING_SYSTEM_KEY,  // For x402 gateway integration
  pinServiceSecret: process.env.FULA_PIN_SERVICE_SECRET,  // HMAC secret for gateway service-auth
  s3AdminJwt: process.env.S3_ADMIN_JWT,  // For internal S3 fetch (share links)
  s3InternalUrl: process.env.S3_INTERNAL_URL || 'http://127.0.0.1:9000',
  // v8 migration (see Config.collabMetadataWriteBucket). Default = legacy no-op.
  collabMetadataWriteBucket:
    process.env.COLLAB_METADATA_WRITE_BUCKET || 'fula-metadata',
  // Phase 3.2 admin trigger endpoints. fula-cli defaults to the
  // same host as the S3 endpoint (same process); mainnet-rewards
  // is a separate service at :5667 by default.
  fulaCliInternalUrl: process.env.FULA_CLI_INTERNAL_URL ||
    process.env.S3_INTERNAL_URL ||
    'http://127.0.0.1:9000',
  mainnetRewardsUrl: process.env.MAINNET_REWARDS_URL || 'http://127.0.0.1:5667',
  fulaUsersIndexInternalToken: process.env.FULA_USERS_INDEX_INTERNAL_TOKEN,
  // Apple Sign-In configuration
  appleClientId: process.env.APPLE_CLIENT_ID,
  appleAdditionalAudiences: (process.env.APPLE_ADDITIONAL_AUDIENCES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  appleTeamId: process.env.APPLE_TEAM_ID,
  appleKeyId: process.env.APPLE_KEY_ID,
  applePrivateKey: process.env.APPLE_PRIVATE_KEY_PATH
    ? fs.readFileSync(process.env.APPLE_PRIVATE_KEY_PATH, 'utf8')
    : undefined,
  // DAG import (CAR upload) vendor extension — must match the Go pinning
  // service's DAG_IMPORT_ENABLED so the UI button and the upstream endpoint
  // appear/disappear together.
  dagImportEnabled: ['true', '1'].includes((process.env.DAG_IMPORT_ENABLED || '').toLowerCase()),
  dagImportMaxCarBytes: parseInt(process.env.DAG_IMPORT_MAX_CAR_BYTES || '838860800', 10),
  // Phase 11 — scoped MCP-JWT lifetime (seconds); default 1h, clamped [60,86400].
  mcpTokenTtlSeconds: parseInt(process.env.MCP_TOKEN_TTL_SECONDS || '3600', 10),
};

// Refuse to start with default secrets in production
if (config.nodeEnv === 'production') {
  if (!process.env.JWT_SECRET) {
    console.error('[webui] FATAL: JWT_SECRET must be set in production');
    process.exit(1);
  }
  if (!process.env.SESSION_SECRET) {
    console.error('[webui] FATAL: SESSION_SECRET must be set in production');
    process.exit(1);
  }
  if (!process.env.ENCRYPTION_KEY) {
    console.warn('[webui] WARNING: ENCRYPTION_KEY not set — API keys will not be encrypted at rest');
    console.warn('[webui]   Generate one with: openssl rand -hex 32');
  }
}

// Debug .env loading
console.log('[webui] Configuration loaded:');
console.log(`[webui]   JWT_SECRET: ${process.env.JWT_SECRET ? '(set)' : '(default - INSECURE)'}`);
console.log(`[webui]   SESSION_SECRET: ${process.env.SESSION_SECRET ? '(set)' : '(default - INSECURE)'}`);

console.log(`[webui]   POSTGRES_HOST: ${process.env.POSTGRES_HOST || '(not set)'}`);
console.log(`[webui]   NODE_ENV: ${config.nodeEnv}`);
console.log(`[webui]   PINNING_SYSTEM_KEY: ${config.systemKey ? '****' : '(not set)'}`);
console.log(`[webui]   APPLE_CLIENT_ID: ${config.appleClientId || '(not set)'}`);
console.log(`[webui]   APPLE_PRIVATE_KEY: ${config.applePrivateKey ? 'loaded from file' : '(not set)'}`);
console.log(`[webui]   DAG_IMPORT_ENABLED: ${config.dagImportEnabled ? 'true' : 'false'}`);

async function main() {
  try {
    // Initialize PostgreSQL database connection
    await initializeDatabase();
    console.log('[webui] PostgreSQL database connected');

    // Seed chain_sync_state if needed
    await seedChainSyncState();

    // Create app
    const { app } = createApp(config);

    // Serve static files in production
    if (config.nodeEnv === 'production') {
      const publicPath = path.join(__dirname, 'public');
      app.use(express.static(publicPath));

      // SPA fallback - Express 5 requires named parameter for catch-all
      app.get('/{*splat}', (_req, res) => {
        res.sendFile(path.join(publicPath, 'index.html'));
      });
    }

    // Start server. Bind to 127.0.0.1 by default so nginx is the only thing
    // that can reach this port — never expose the raw HTTP server (without TLS,
    // without rate limiting, without HSTS) directly to the public internet.
    // Set BIND_HOST=0.0.0.0 only for local/dev when there is no fronting proxy.
    const bindHost = process.env.BIND_HOST || '127.0.0.1';
    app.listen(config.port, bindHost, () => {
      console.log(`[webui] FULA Pinning WebUI running on ${bindHost}:${config.port}`);
      console.log(`[webui] Environment: ${config.nodeEnv}`);
      if (!config.googleClientId) {
        console.warn('[webui] WARNING: GOOGLE_CLIENT_ID not set - authentication will not work');
      }

      // Start cron services in production
      if (config.nodeEnv === 'production') {
        const vaultAddress = process.env.VAULT_ADDRESS || '';
        if (vaultAddress && vaultAddress !== '0x0000000000000000000000000000000000000000') {
          console.log(`[webui] VAULT_ADDRESS configured: ${vaultAddress}`);
          console.log('[webui] Starting block scanner cron (every 10 minutes)...');
          startBlockScanner(10 * 60 * 1000); // 10 minutes

          console.log('[webui] Starting deduction job cron (every hour)...');
          startDeductionJob(60 * 60 * 1000); // 1 hour
        } else {
          console.log('[webui] VAULT_ADDRESS not configured - payment crons disabled');
        }
      }
    });
  } catch (error) {
    console.error('[webui] Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[webui] Shutting down...');
  stopBlockScanner();
  stopDeductionJob();
  await closePool();
  process.exit(0);
});

// Start the server
main();
