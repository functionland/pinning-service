/**
 * Fula AI Service Entry Point
 *
 * Starts the HTTP server and initializes all services.
 */

import { serve } from '@hono/node-server';
import { app } from './app.js';
import { config, logConfig } from './config/index.js';
import { initializeDatabase, closeDatabase } from './database/index.js';
import { stopAllJobs } from './services/generationService.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ASCII art banner
const banner = `
╔═══════════════════════════════════════════════════╗
║           Fula AI Website Generator               ║
║         AI-Powered Static Site Builder            ║
╚═══════════════════════════════════════════════════╝
`;

async function main() {
  console.log(banner);

  // Log configuration
  logConfig();
  
  // Cleanup stale ask temp files
  try {
    const tmpDir = os.tmpdir();
    const files = fs.readdirSync(tmpDir);
    let deletedCount = 0;
    
    for (const file of files) {
      if (file.startsWith('ask-')) {
        const fullPath = path.join(tmpDir, file);
        if (fs.statSync(fullPath).isDirectory()) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          deletedCount++;
        }
      }
    }
    if (deletedCount > 0) {
      console.log(`[janitor] Cleaned up ${deletedCount} stale 'ask-*' temp directories.`);
    }
  } catch (err) {
    console.error('[janitor] Error cleaning up stale temp files:', err);
  }

  // Initialize database
  console.log('\n[startup] Initializing database...');
  await initializeDatabase();

  // Start HTTP server
  console.log('[startup] Starting HTTP server...');

  const server = serve(
    {
      fetch: app.fetch,
      port: config.port,
    },
    (info) => {
      console.log(`
[startup] Server ready!

  Local:    http://localhost:${info.port}
  Health:   http://localhost:${info.port}/health

  Model:    ${config.claudeModel}
  Cost:     ${config.generationCostFula} FULA/generation (tracking off)
            ${config.generationCostFulaWithTracking} FULA/generation (tracking on)
  Max Jobs: ${config.maxConcurrentJobs} concurrent
  Timeout:  ${config.jobTimeoutMs / 1000}s

  IPFS:     ${config.ipfsApiUrl}
  Pinning:  ${config.pinningWebuiUrl}
`);
    }
  );

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[shutdown] Shutting down...');

    stopAllJobs();

    await new Promise<void>((resolve) => {
      server.close(() => {
        console.log('[shutdown] HTTP server closed');
        resolve();
      });
    });

    await closeDatabase();

    console.log('[shutdown] Goodbye!');
    process.exit(0);
  };

  const startShutdown = () => {
    // Force exit after 30s if graceful shutdown hangs
    setTimeout(() => {
      console.error('[shutdown] Forced exit after timeout');
      process.exit(1);
    }, 30_000).unref();

    shutdown();
  };

  process.on('SIGINT', startShutdown);
  process.on('SIGTERM', startShutdown);
}

// Run
main().catch((err) => {
  console.error('[fatal] Startup failed:', err);
  process.exit(1);
});
