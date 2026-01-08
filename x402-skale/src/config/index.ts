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
  facilitatorUrl: z.string().url().default('https://facilitator.dirtroad.dev'),
  receivingAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  networkChainId: z.coerce.number().default(324705682),
  paymentTokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid token address'),
  paymentTokenName: z.string().default('Bridged USDC (SKALE Bridge)'),

  // S3 Backend
  s3BackendUrl: z.string().url().default('http://127.0.0.1:9000'),

  // Pinning Service
  pinningWebuiUrl: z.string().url().default('http://127.0.0.1:3001'),
  pinningSystemKey: z.string().min(1, 'PINNING_SYSTEM_KEY is required'),

  // Database
  databasePath: z.string().default('./data/x402.db'),

  // Pricing (in microUSDC - 6 decimals)
  basePriceMicroUsdc: z.coerce.number().default(10000),   // $0.01
  minPaymentMicroUsdc: z.coerce.number().default(1000),   // $0.001
  fulaExchangeRate: z.coerce.number().default(1.0),

  // JWT
  jwtSecret: z.string().optional(),
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
    paymentTokenAddress: process.env.PAYMENT_TOKEN_ADDRESS,
    paymentTokenName: process.env.PAYMENT_TOKEN_NAME,
    s3BackendUrl: process.env.S3_BACKEND_URL,
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
  console.log(`  receivingAddress: ${config.receivingAddress}`);
  console.log(`  networkChainId: ${config.networkChainId}`);
  console.log(`  paymentTokenAddress: ${config.paymentTokenAddress}`);
  console.log(`  s3BackendUrl: ${config.s3BackendUrl}`);
  console.log(`  pinningWebuiUrl: ${config.pinningWebuiUrl}`);
  console.log(`  pinningSystemKey: ${config.pinningSystemKey ? '****' : '(not set)'}`);
  console.log(`  databasePath: ${config.databasePath}`);
  console.log(`  basePriceMicroUsdc: ${config.basePriceMicroUsdc}`);
  console.log(`  minPaymentMicroUsdc: ${config.minPaymentMicroUsdc}`);
  console.log(`  fulaExchangeRate: ${config.fulaExchangeRate}`);
}

/**
 * Get network identifier in CAIP-2 format
 */
export function getNetworkIdentifier(): string {
  return `eip155:${config.networkChainId}`;
}

/**
 * Get asset identifier in CAIP-19 format
 */
export function getAssetIdentifier(): string {
  return `eip155:${config.networkChainId}/erc20:${config.paymentTokenAddress}`;
}

export default config;
