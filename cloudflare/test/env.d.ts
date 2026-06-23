// Makes the `cloudflare:test` module (env, createExecutionContext, …) and the
// injected `ProvidedEnv` visible to TypeScript in the test suite. The module
// declarations ship at @cloudflare/vitest-pool-workers/types.
/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare module "cloudflare:test" {
  // The bindings our tests touch (OAUTH_KV + the injected vars from
  // vitest.config.ts). `ProvidedEnv` is what `import { env } from "cloudflare:test"`
  // resolves to.
  interface ProvidedEnv {
    OAUTH_KV: KVNamespace;
    CANONICAL_ORIGIN: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    GOOGLE_AUTH_URL: string;
    GOOGLE_TOKEN_URL: string;
    GOOGLE_JWKS_URL: string;
    COOKIE_ENCRYPTION_KEY: string;
  }
}
