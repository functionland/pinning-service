// Makes the `cloudflare:test` module (env, createExecutionContext, …) and the
// injected env visible to TypeScript in the test suite. The module declarations
// ship at @cloudflare/vitest-pool-workers/types, where `env` is typed as
// `Cloudflare.Env`.
/// <reference types="@cloudflare/vitest-pool-workers/types" />

// The bindings declared in wrangler.toml (OAUTH_KV, CUSTODY_DB, CANONICAL_ORIGIN,
// GOOGLE_*, …) are generated into `Cloudflare.Env` by `wrangler types` (see
// worker-configuration.d.ts). The vars below are injected ONLY by the vitest
// miniflare config (vitest.config.ts) — they are NOT in wrangler.toml, so we
// augment `Cloudflare.Env` here so the test suite sees them with types.
declare namespace Cloudflare {
  interface Env {
    /** OpenBao transit config (test-injected; live creds from .bao-bin in dev). */
    OPENBAO_ADDR: string;
    OPENBAO_ROLE_ID: string;
    OPENBAO_SECRET_ID: string;
    OPENBAO_TRANSIT_KEY: string;
    /** "1" when a live local OpenBao is wired in (round-trip tests run). */
    OPENBAO_LIVE: string;
    /** A non-routable OpenBao address the guarantee test points its client at. */
    OPENBAO_DEAD_ADDR: string;
  }
}
