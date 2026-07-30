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
  // claude-opus-5: drop-in successor to claude-opus-4-6 at the same price,
  // substantially stronger on design/coding. The multipass pipeline requires
  // a 4.6+ model (adaptive thinking); override via CLAUDE_MODEL.
  claudeModel: z.string().default('claude-opus-5'),
  claudeDesignSkillEnabled: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  // Multi-pass website generation (brief → build → polish). Kill-switch:
  // CLAUDE_MULTIPASS_ENABLED=false reverts every request to single-pass.
  claudeMultipassEnabled: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  // Thinking tokens count against max_tokens — at effort=high the model can
  // spend thousands thinking before writing the brief, so this needs real
  // headroom or the pass yields no text and gets skipped.
  claudeBriefMaxTokens: z.coerce.number().int().positive().default(16000),
  claudeBuildMaxTokens: z.coerce.number().int().positive().default(96000),
  claudePolishMaxTokens: z.coerce.number().int().positive().default(64000),

  // Generation
  generationCostFula: z.coerce.number().int().nonnegative().default(1000),
  // Surcharged price when the request opts into click-tracking
  // (`enable_tracking: true`). Set higher than `generationCostFula` to
  // reflect the cost of the analytics infrastructure that serves the
  // injected ping script.
  generationCostFulaWithTracking: z.coerce.number().int().nonnegative().default(1500),
  freeGenerationsPerUser: z.coerce.number().default(1),
  maxConcurrentJobs: z.coerce.number().default(3),
  // Multi-pass generation (thinking + 3 passes) can legitimately run well
  // past the old 5-minute ceiling; new clients poll for up to 20 minutes.
  jobTimeoutMs: z.coerce.number().default(900000),
  maxJobsPerUserPerHour: z.coerce.number().default(10),

  // Social posts (captions via Claude + 4:5 image via Gemini).
  // GEMINI_API_KEY is deliberately OPTIONAL — empty disables the feature
  // (503 SOCIAL_DISABLED) instead of bricking existing deployments on boot.
  geminiApiKey: z.string().default(''),
  geminiImageModel: z.string().default('gemini-3.1-flash-image'),
  geminiImageSize: z.enum(['1K', '2K']).default('1K'),
  // Cost lever: captions don't need the flagship model — point this at a
  // cheaper Claude model; empty falls back to CLAUDE_MODEL.
  claudeSocialModel: z.string().default(''),
  socialPostPriceFula: z.coerce.number().int().nonnegative().default(300),
  maxConcurrentSocialJobs: z.coerce.number().default(2),
  socialJobTimeoutMs: z.coerce.number().default(300000),
  maxSocialJobsPerUserPerHour: z.coerce.number().default(10),
  socialMaxReferenceImages: z.coerce.number().int().positive().max(14).default(8),
  // Bucket the finished social JPEG lands in — the client-owned public
  // website-assets bucket, mirroring how imported website assets are hosted.
  socialAssetsBucket: z.string().default('website-assets'),
  // When set (e.g. https://ai.cloud.fx.land), status/buffer responses use
  // the MIME passthrough URL {base}/api/v1/social/image/{cid} instead of the
  // raw gateway URL (bare-CID gateway responses are text/plain + nosniff).
  socialPublicBaseUrl: z.string().default(''),
  bufferApiUrl: z.string().default('https://api.buffer.com'),

  // IPFS
  ipfsApiUrl: z.string().default('http://127.0.0.1:5001'),
  ipfsGatewayUrl: z.string().min(1, 'IPFS_GATEWAY_URL is required'),

  // S3 Gateway (fula-api)
  s3GatewayUrl: z.string().default('http://127.0.0.1:9000'),
  s3BucketName: z.string().default('ai-websites'),

  // Click-tracking analytics endpoint (fxfiles-analytics). Used only when
  // the generate request opts in via `enableTracking: true` — the injected
  // <script> POSTs pageview pings here.
  analyticsEndpointUrl: z.string().default('https://analytics.cloud.fx.land'),

  // Pinning Service Integration
  pinningWebuiUrl: z.string().default('http://127.0.0.1:3001'),
  pinningSystemKey: z.string().min(1, 'PINNING_SYSTEM_KEY is required'),

  // JWT
  jwtSecret: z.string().min(1, 'JWT_SECRET is required'),

  // PostgreSQL
  postgresHost: z.string().default('localhost'),
  postgresPort: z.coerce.number().default(5432),
  postgresDb: z.string().default('pinning_service'),
  postgresUser: z.string().default('pinning_user'),
  postgresPassword: z.string().min(1, 'POSTGRES_PASSWORD is required'),
  postgresSsl: z.string().default('false').transform((v) => v === 'true'),
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
    claudeDesignSkillEnabled: process.env.CLAUDE_DESIGN_SKILL_ENABLED,
    claudeMultipassEnabled: process.env.CLAUDE_MULTIPASS_ENABLED,
    claudeBriefMaxTokens: process.env.CLAUDE_BRIEF_MAX_TOKENS,
    claudeBuildMaxTokens: process.env.CLAUDE_BUILD_MAX_TOKENS,
    claudePolishMaxTokens: process.env.CLAUDE_POLISH_MAX_TOKENS,
    generationCostFula: process.env.GENERATION_COST_FULA,
    generationCostFulaWithTracking: process.env.GENERATION_COST_FULA_WITH_TRACKING,
    freeGenerationsPerUser: process.env.FREE_GENERATIONS_PER_USER,
    maxConcurrentJobs: process.env.MAX_CONCURRENT_JOBS,
    jobTimeoutMs: process.env.JOB_TIMEOUT_MS,
    maxJobsPerUserPerHour: process.env.MAX_JOBS_PER_USER_PER_HOUR,
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiImageModel: process.env.GEMINI_IMAGE_MODEL,
    geminiImageSize: process.env.GEMINI_IMAGE_SIZE,
    claudeSocialModel: process.env.CLAUDE_SOCIAL_MODEL,
    socialPostPriceFula: process.env.SOCIAL_POST_PRICE_FULA,
    maxConcurrentSocialJobs: process.env.MAX_CONCURRENT_SOCIAL_JOBS,
    socialJobTimeoutMs: process.env.SOCIAL_JOB_TIMEOUT_MS,
    maxSocialJobsPerUserPerHour: process.env.MAX_SOCIAL_JOBS_PER_USER_PER_HOUR,
    socialMaxReferenceImages: process.env.SOCIAL_MAX_REFERENCE_IMAGES,
    socialAssetsBucket: process.env.SOCIAL_ASSETS_BUCKET,
    socialPublicBaseUrl: process.env.SOCIAL_PUBLIC_BASE_URL,
    bufferApiUrl: process.env.BUFFER_API_URL,
    ipfsApiUrl: process.env.IPFS_API_URL,
    ipfsGatewayUrl: process.env.IPFS_GATEWAY_URL,
    s3GatewayUrl: process.env.S3_GATEWAY_URL,
    s3BucketName: process.env.S3_BUCKET_NAME,
    analyticsEndpointUrl: process.env.ANALYTICS_ENDPOINT_URL,
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
  console.log(`  claudeDesignSkillEnabled: ${config.claudeDesignSkillEnabled}`);
  console.log(`  claudeMultipassEnabled: ${config.claudeMultipassEnabled}`);
  console.log(`  claudeBriefMaxTokens: ${config.claudeBriefMaxTokens}`);
  console.log(`  claudeBuildMaxTokens: ${config.claudeBuildMaxTokens}`);
  console.log(`  claudePolishMaxTokens: ${config.claudePolishMaxTokens}`);
  console.log(`  generationCostFula: ${config.generationCostFula}`);
  console.log(`  generationCostFulaWithTracking: ${config.generationCostFulaWithTracking}`);
  console.log(`  freeGenerationsPerUser: ${config.freeGenerationsPerUser}`);
  console.log(`  maxConcurrentJobs: ${config.maxConcurrentJobs}`);
  console.log(`  jobTimeoutMs: ${config.jobTimeoutMs}`);
  console.log(`  maxJobsPerUserPerHour: ${config.maxJobsPerUserPerHour}`);
  console.log(`  geminiApiKey: ${config.geminiApiKey ? '****' : '(not set — social posts disabled)'}`);
  console.log(`  geminiImageModel: ${config.geminiImageModel}`);
  console.log(`  geminiImageSize: ${config.geminiImageSize}`);
  console.log(`  claudeSocialModel: ${config.claudeSocialModel || '(falls back to claudeModel)'}`);
  console.log(`  socialPostPriceFula: ${config.socialPostPriceFula}`);
  console.log(`  maxConcurrentSocialJobs: ${config.maxConcurrentSocialJobs}`);
  console.log(`  socialJobTimeoutMs: ${config.socialJobTimeoutMs}`);
  console.log(`  maxSocialJobsPerUserPerHour: ${config.maxSocialJobsPerUserPerHour}`);
  console.log(`  socialMaxReferenceImages: ${config.socialMaxReferenceImages}`);
  console.log(`  socialAssetsBucket: ${config.socialAssetsBucket}`);
  console.log(`  socialPublicBaseUrl: ${config.socialPublicBaseUrl || '(raw gateway URLs)'}`);
  console.log(`  bufferApiUrl: ${config.bufferApiUrl}`);
  console.log(`  ipfsApiUrl: ${config.ipfsApiUrl}`);
  console.log(`  ipfsGatewayUrl: ${config.ipfsGatewayUrl}`);
  console.log(`  s3GatewayUrl: ${config.s3GatewayUrl}`);
  console.log(`  s3BucketName: ${config.s3BucketName}`);
  console.log(`  analyticsEndpointUrl: ${config.analyticsEndpointUrl}`);
  console.log(`  pinningWebuiUrl: ${config.pinningWebuiUrl}`);
  console.log(`  pinningSystemKey: ${config.pinningSystemKey ? '****' : '(not set)'}`);
  console.log(`  jwtSecret: ${config.jwtSecret ? '****' : '(not set)'}`);
  console.log(`  postgres: ${config.postgresHost}:${config.postgresPort}/${config.postgresDb}`);
}

export default config;
