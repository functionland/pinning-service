/**
 * Configuration Loader with Zod Validation
 *
 * Loads and validates environment variables.
 */

import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env file
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Also try loading from parent directory (for when running from src)
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

/**
 * Configuration Schema
 */
const configSchema = z.object({
  // Server
  port: z.coerce.number().default(4002),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),

  // x402 Payment
  facilitatorUrl: z.string().url().default('https://facilitator.corbits.dev'),
  receivingAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  networkChainId: z.coerce.number().default(324705682),
  // Network name for facilitator (e.g., "skale-base", "base-sepolia")
  // See https://docs.x402.fi for supported networks
  networkName: z.string().default('skale-base'),
  paymentTokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid token address'),
  paymentTokenName: z.string().default('USD Coin'),
  // Token version for EIP-712 domain (USDC is typically "2")
  paymentTokenVersion: z.string().default('2'),
  // x402 protocol version (1 = Corbits, 2 = RelAI)
  x402Version: z.coerce.number().default(1),
  // Asset transfer method: eip3009 (TransferWithAuthorization) or permit2 (EIP-2612)
  assetTransferMethod: z.enum(['eip3009', 'permit2']).default('eip3009'),

  // S3 Backend
  s3BackendUrl: z.string().url().default('http://127.0.0.1:9000'),
  s3AdminToken: z.string().min(1, 'S3_ADMIN_TOKEN is required for cleanup'),

  // Pinning Service
  pinningWebuiUrl: z.string().url().default('http://127.0.0.1:3001'),
  pinningSystemKey: z.string().min(1, 'PINNING_SYSTEM_KEY is required'),

  // Database (shared with pinning service)
  databasePath: z.string().default('../data/pinning.db'),

  // Pricing (in microUSDC - 6 decimals)
  basePriceMicroUsdc: z.coerce.number().default(10000),   // $0.01
  minPaymentMicroUsdc: z.coerce.number().default(1000),   // $0.001
  fulaExchangeRate: z.coerce.number().default(1.0),

  // JWT
  jwtSecret: z.string().optional(),

  // Cleanup thresholds
  cleanupUnpaidThresholdMinutes: z.coerce.number().default(30),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Parse and validate configuration
 */
function loadConfig(): Config {
  const rawConfig = {
    port: process.env.PORT,
    nodeEnv: process.env.NODE_ENV,
    facilitatorUrl: process.env.FACILITATOR_URL,
    receivingAddress: process.env.RECEIVING_ADDRESS,
    networkChainId: process.env.NETWORK_CHAIN_ID,
    networkName: process.env.NETWORK_NAME,
    paymentTokenAddress: process.env.PAYMENT_TOKEN_ADDRESS,
    paymentTokenName: process.env.PAYMENT_TOKEN_NAME,
    paymentTokenVersion: process.env.PAYMENT_TOKEN_VERSION,
    x402Version: process.env.X402_VERSION,
    assetTransferMethod: process.env.ASSET_TRANSFER_METHOD,
    s3BackendUrl: process.env.S3_BACKEND_URL,
    s3AdminToken: process.env.S3_ADMIN_TOKEN,
    pinningWebuiUrl: process.env.PINNING_WEBUI_URL,
    pinningSystemKey: process.env.PINNING_SYSTEM_KEY,
    databasePath: process.env.DATABASE_PATH,
    basePriceMicroUsdc: process.env.BASE_PRICE_MICRO_USDC,
    minPaymentMicroUsdc: process.env.MIN_PAYMENT_MICRO_USDC,
    fulaExchangeRate: process.env.FULA_EXCHANGE_RATE,
    jwtSecret: process.env.JWT_SECRET,
  };

  const result = configSchema.safeParse(rawConfig);

  if (!result.success) {
    console.error('[config] Validation errors:');
    for (const error of result.error.errors) {
      console.error(`  - ${error.path.join('.')}: ${error.message}`);
    }
    throw new Error('Invalid configuration. Check environment variables.');
  }

  return result.data;
}

// Export singleton config
export const config = loadConfig();

// Log config on startup (redact sensitive values)
export function logConfig(): void {
  console.log('[config] Loaded configuration:');
  console.log(`  port: ${config.port}`);
  console.log(`  nodeEnv: ${config.nodeEnv}`);
  console.log(`  facilitatorUrl: ${config.facilitatorUrl}`);
  console.log(`  x402Version: ${config.x402Version}`);
  console.log(`  assetTransferMethod: ${config.assetTransferMethod}`);
  console.log(`  receivingAddress: ${config.receivingAddress}`);
  console.log(`  networkChainId: ${config.networkChainId}`);
  console.log(`  networkName: ${config.networkName}`);
  console.log(`  paymentTokenAddress: ${config.paymentTokenAddress}`);
  console.log(`  s3BackendUrl: ${config.s3BackendUrl}`);
  console.log(`  s3AdminToken: ${config.s3AdminToken ? '****' : '(not set)'}`);
  console.log(`  pinningWebuiUrl: ${config.pinningWebuiUrl}`);
  console.log(`  pinningSystemKey: ${config.pinningSystemKey ? '****' : '(not set)'}`);
  console.log(`  databasePath: ${config.databasePath}`);
  console.log(`  basePriceMicroUsdc: ${config.basePriceMicroUsdc}`);
  console.log(`  minPaymentMicroUsdc: ${config.minPaymentMicroUsdc}`);
  console.log(`  fulaExchangeRate: ${config.fulaExchangeRate}`);
}

/**
 * Get network identifier for facilitator API
 * Returns the network name string (e.g., "skale-base", "base-sepolia")
 */
export function getNetworkIdentifier(): string {
  return config.networkName;
}

/**
 * Get asset identifier (token contract address)
 */
export function getAssetIdentifier(): string {
  return config.paymentTokenAddress;
}

export default config;
