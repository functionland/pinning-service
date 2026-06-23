import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Runs the test suite INSIDE the workerd runtime (via @cloudflare/vitest-pool-workers,
// the current 0.16.x Vite-plugin API) so the OAuth provider, KV + D1 (miniflare-
// simulated), and compatibility flags behave exactly as under `wrangler dev`.
// Bindings + compat flags are read from wrangler.toml; the test-only secrets/vars
// are injected via miniflare.bindings below.
//
// ── OpenBao for the custody tests ────────────────────────────────────────────
// The custody round-trip tests PREFER a REAL local OpenBao (the task's stated
// preference over a mock). To wire one up locally (matches scripts/openbao-setup.sh
// conventions — key "fula-mcp-workspace-kek", AppRole "fula-mcp-worker"):
//   1. Launch a dev server (in-memory, single node):
//        bao server -dev -dev-root-token-id=<tok> -dev-listen-address=127.0.0.1:8200
//   2. With BAO_ADDR=http://127.0.0.1:8200 + BAO_TOKEN=<tok>:
//        bao secrets enable transit
//        bao write -f transit/keys/fula-mcp-workspace-kek type=aes256-gcm96 exportable=false
//        bao policy write fula-mcp-worker <hcl: update on transit/{encrypt,decrypt}/<key>>
//        bao auth enable approle
//        bao write auth/approle/role/fula-mcp-worker token_policies=fula-mcp-worker token_ttl=20m
//   3. Write the AppRole role-id + secret-id to `.bao-bin/test-openbao.env`
//      (gitignored) as OPENBAO_ADDR / OPENBAO_ROLE_ID / OPENBAO_SECRET_ID /
//      OPENBAO_TRANSIT_KEY. We read that file HERE, at Node config-load time, and
//      inject the LIVE creds as the production-named `OPENBAO_*` bindings — so the
//      seal→open round-trip + the delegation happy path exercise the genuine
//      transit wrap/unwrap. (Absent file → fail-closed tests still run; see below.)
//
// `OPENBAO_LIVE` tells the tests whether a live OpenBao is present. When the file
// is ABSENT (e.g. CI with no OpenBao), we fall back to a NON-ROUTABLE address and
// OPENBAO_LIVE="0"; the live round-trip tests then skip, but the fail-closed /
// "DB-dump-yields-nothing" assertions (which WANT a dead OpenBao) still run.
function loadOpenBao(): Record<string, string> {
  const dead = {
    OPENBAO_ADDR: "https://127.0.0.1:1/__no_openbao__",
    OPENBAO_ROLE_ID: "test-role-id",
    OPENBAO_SECRET_ID: "test-secret-id",
    OPENBAO_TRANSIT_KEY: "fula-mcp-workspace-kek",
    OPENBAO_LIVE: "0",
    // A deliberately-dead address the guarantee test points its OWN client at to
    // model "attacker has the D1 row + wrapped_dek but cannot reach OpenBao".
    OPENBAO_DEAD_ADDR: "https://127.0.0.1:1/__no_openbao__",
  };
  try {
    const raw = readFileSync(
      new URL("./.bao-bin/test-openbao.env", import.meta.url),
      "utf8",
    );
    const kv: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) kv[m[1]] = m[2];
    }
    if (kv.OPENBAO_ADDR && kv.OPENBAO_ROLE_ID && kv.OPENBAO_SECRET_ID) {
      return { ...dead, ...kv, OPENBAO_LIVE: "1" };
    }
  } catch {
    // no file → CI / no local OpenBao; fall through to the dead defaults.
  }
  return dead;
}

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
          ...loadOpenBao(),
        },
      },
    }),
  ],
});
