/**
 * x402-skale Gateway Entry Point
 *
 * Starts the HTTP server and initializes all services.
 */

import { serve } from '@hono/node-server';
import { app } from './app.js';
import { config, logConfig } from './config/index.js';
import { initializeDatabase, closeDatabase } from './database/index.js';
import { startCleanupCron, stopCleanupCron } from './services/cleanup.js';
import { initPricingCache, stopPricingCache } from './services/pricingCache.js';

// ASCII art banner
const banner = `
╔═══════════════════════════════════════════════════╗
║           x402-skale Payment Gateway              ║
║         SKALE Network • USDC Payments             ║
╚═══════════════════════════════════════════════════╝
`;

async function main() {
  console.log(banner);

  // Log configuration
  logConfig();

  // Initialize database (async)
  console.log('\n[startup] Initializing database...');
  await initializeDatabase();

  // Fetch dynamic pricing from pinning-webui (cached, refreshes every 5 min)
  console.log('[startup] Initializing pricing cache...');
  await initPricingCache();

  // Start cleanup cron
  console.log('[startup] Starting cleanup cron...');
  startCleanupCron();

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
  Pricing:  http://localhost:${info.port}/health/pricing

  Mode:     x402 Pay-Per-Upload
  Network:  SKALE (${config.networkChainId})
  Token:    ${config.paymentTokenName}

  S3 Backend:      ${config.s3BackendUrl}
  Pinning Service: ${config.pinningWebuiUrl}
  Facilitator:     ${config.facilitatorUrl}
`);
    }
  );

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[shutdown] Shutting down...');

    stopCleanupCron();
    stopPricingCache();

    // Close server
    server.close(() => {
      console.log('[shutdown] HTTP server closed');
    });

    // Force exit after 10s if connections don't close
    setTimeout(() => process.exit(1), 10000);

    // Close database (async)
    await closeDatabase();

    console.log('[shutdown] Goodbye!');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run
main().catch((err) => {
  console.error('[fatal] Startup failed:', err);
  process.exit(1);
});
