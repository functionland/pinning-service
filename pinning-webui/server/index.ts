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
  sessionSecret: process.env.SESSION_SECRET || 'change-this-in-production-' + uuidv4(),
  jwtSecret: process.env.JWT_SECRET || process.env.SESSION_SECRET || 'change-this-jwt-secret-in-production',
  nodeEnv: process.env.NODE_ENV || 'development',
  pinningServiceUrl: process.env.PINNING_SERVICE_URL || 'http://localhost:8080',
  systemKey: process.env.PINNING_SYSTEM_KEY,  // For x402 gateway integration
  s3AdminJwt: process.env.S3_ADMIN_JWT,  // For internal S3 fetch (share links)
  s3InternalUrl: process.env.S3_INTERNAL_URL || 'http://127.0.0.1:9000',
  // Apple Sign-In configuration
  appleClientId: process.env.APPLE_CLIENT_ID,
  appleTeamId: process.env.APPLE_TEAM_ID,
  appleKeyId: process.env.APPLE_KEY_ID,
  applePrivateKey: process.env.APPLE_PRIVATE_KEY_PATH
    ? fs.readFileSync(process.env.APPLE_PRIVATE_KEY_PATH, 'utf8')
    : undefined,
};

// Debug .env loading
console.log('[webui] Configuration loaded:');
console.log(`[webui]   JWT_SECRET: ${config.jwtSecret.substring(0, 10)}...`);
console.log(`[webui]   SESSION_SECRET: ${config.sessionSecret.substring(0, 10)}...`);
console.log(`[webui]   POSTGRES_HOST: ${process.env.POSTGRES_HOST || '(not set)'}`);
console.log(`[webui]   NODE_ENV: ${config.nodeEnv}`);
console.log(`[webui]   PINNING_SYSTEM_KEY: ${config.systemKey ? '****' : '(not set)'}`);
console.log(`[webui]   APPLE_CLIENT_ID: ${config.appleClientId || '(not set)'}`);
console.log(`[webui]   APPLE_PRIVATE_KEY: ${config.applePrivateKey ? 'loaded from file' : '(not set)'}`);

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

    // Start server
    app.listen(config.port, () => {
      console.log(`[webui] FULA Pinning WebUI running on port ${config.port}`);
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
