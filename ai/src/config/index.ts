/**
 * Configuration Loader with Zod Validation
 *
 * Loads and validates environment variables for the AI service.
 */

import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env file
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

/**
 * Configuration Schema
 */
const configSchema = z.object({
  // Server
  port: z.coerce.number().default(3002),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),

  // Claude API
  claudeApiKey: z.string().min(1, 'CLAUDE_API_KEY is required'),
  claudeModel: z.string().default('claude-sonnet-4-20250514'),

  // Generation
  generationCostFula: z.coerce.number().default(1000),
  maxConcurrentJobs: z.coerce.number().default(3),
  jobTimeoutMs: z.coerce.number().default(300000),
  maxJobsPerUserPerHour: z.coerce.number().default(10),

  // IPFS
  ipfsApiUrl: z.string().default('http://127.0.0.1:5001'),
  ipfsGatewayUrl: z.string().min(1, 'IPFS_GATEWAY_URL is required'),

  // S3 Gateway (fula-api)
  s3GatewayUrl: z.string().default('http://127.0.0.1:9000'),
  s3GatewayJwt: z.string().min(1, 'S3_GATEWAY_JWT is required'),
  s3BucketName: z.string().default('ai-websites'),

  // Pinning Service Integration
  pinningWebuiUrl: z.string().default('http://127.0.0.1:3001'),
  pinningSystemKey: z.string().min(1, 'PINNING_SYSTEM_KEY is required'),

  // JWT
  jwtSecret: z.string().optional(),

  // PostgreSQL
  postgresHost: z.string().default('localhost'),
  postgresPort: z.coerce.number().default(5432),
  postgresDb: z.string().default('pinning_service'),
  postgresUser: z.string().default('pinning_user'),
  postgresPassword: z.string().min(1, 'POSTGRES_PASSWORD is required'),
  postgresSsl: z.coerce.boolean().default(false),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Parse and validate configuration
 */
function loadConfig(): Config {
  const rawConfig = {
    port: process.env.PORT,
    nodeEnv: process.env.NODE_ENV,
    claudeApiKey: process.env.CLAUDE_API_KEY,
    claudeModel: process.env.CLAUDE_MODEL,
    generationCostFula: process.env.GENERATION_COST_FULA,
    maxConcurrentJobs: process.env.MAX_CONCURRENT_JOBS,
    jobTimeoutMs: process.env.JOB_TIMEOUT_MS,
    maxJobsPerUserPerHour: process.env.MAX_JOBS_PER_USER_PER_HOUR,
    ipfsApiUrl: process.env.IPFS_API_URL,
    ipfsGatewayUrl: process.env.IPFS_GATEWAY_URL,
    s3GatewayUrl: process.env.S3_GATEWAY_URL,
    s3GatewayJwt: process.env.S3_GATEWAY_JWT,
    s3BucketName: process.env.S3_BUCKET_NAME,
    pinningWebuiUrl: process.env.PINNING_WEBUI_URL,
    pinningSystemKey: process.env.PINNING_SYSTEM_KEY,
    jwtSecret: process.env.JWT_SECRET,
    postgresHost: process.env.POSTGRES_HOST,
    postgresPort: process.env.POSTGRES_PORT,
    postgresDb: process.env.POSTGRES_DB,
    postgresUser: process.env.POSTGRES_USER,
    postgresPassword: process.env.POSTGRES_PASSWORD,
    postgresSsl: process.env.POSTGRES_SSL,
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
  console.log(`  claudeApiKey: ${config.claudeApiKey ? '****' : '(not set)'}`);
  console.log(`  claudeModel: ${config.claudeModel}`);
  console.log(`  generationCostFula: ${config.generationCostFula}`);
  console.log(`  maxConcurrentJobs: ${config.maxConcurrentJobs}`);
  console.log(`  jobTimeoutMs: ${config.jobTimeoutMs}`);
  console.log(`  maxJobsPerUserPerHour: ${config.maxJobsPerUserPerHour}`);
  console.log(`  ipfsApiUrl: ${config.ipfsApiUrl}`);
  console.log(`  ipfsGatewayUrl: ${config.ipfsGatewayUrl}`);
  console.log(`  s3GatewayUrl: ${config.s3GatewayUrl}`);
  console.log(`  s3GatewayJwt: ${config.s3GatewayJwt ? '****' : '(not set)'}`);
  console.log(`  s3BucketName: ${config.s3BucketName}`);
  console.log(`  pinningWebuiUrl: ${config.pinningWebuiUrl}`);
  console.log(`  pinningSystemKey: ${config.pinningSystemKey ? '****' : '(not set)'}`);
  console.log(`  jwtSecret: ${config.jwtSecret ? '****' : '(not set)'}`);
  console.log(`  postgres: ${config.postgresHost}:${config.postgresPort}/${config.postgresDb}`);
}

export default config;
