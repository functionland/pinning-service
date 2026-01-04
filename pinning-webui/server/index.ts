import 'dotenv/config';
import { fileURLToPath } from 'url';
import path from 'path';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createApp, initializeDatabase, type AppConfig } from './app.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const config: AppConfig = {
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

// Initialize database
const db = initializeDatabase(config.databasePath);
console.log(`[webui] Database connected: ${config.databasePath}`);

// Create app
const { app } = createApp(config, db);

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
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[webui] Shutting down...');
  db.close();
  process.exit(0);
});
