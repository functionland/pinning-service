import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Runs the test suite INSIDE the workerd runtime (via @cloudflare/vitest-pool-workers,
// the current 0.16.x Vite-plugin API) so the OAuth provider, KV (miniflare-simulated),
// and compatibility flags behave exactly as under `wrangler dev`. Bindings + compat
// flags are read from wrangler.toml; the test-only secrets/vars are injected via
// miniflare.bindings below (no real upstream calls are made in tests).
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          CANONICAL_ORIGIN: "https://fula-mcp.example.workers.dev",
          GOOGLE_CLIENT_ID: "test-google-client-id.apps.googleusercontent.com",
          GOOGLE_AUTH_URL: "https://accounts.google.com/o/oauth2/v2/auth",
          GOOGLE_TOKEN_URL: "https://oauth2.googleapis.com/token",
          GOOGLE_JWKS_URL: "https://www.googleapis.com/oauth2/v3/certs",
          GOOGLE_CLIENT_SECRET: "test-google-client-secret",
          COOKIE_ENCRYPTION_KEY:
            "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
        },
      },
    }),
  ],
});
