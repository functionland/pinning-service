-- Fula hosted MCP Worker — D1 (SQLite) schema for the CUSTODY layer (H2).
--
-- SECURITY INVARIANT (the bar this whole phase must hit): this database stores
-- NOTHING in plaintext except non-secret metadata. The per-user capability is
-- held ONLY as `capability_ciphertext` (a DEK-encrypted blob) plus `wrapped_dek`
-- (that DEK, wrapped by OpenBao `transit` under a KEK that lives in a DIFFERENT
-- trust domain and NEVER reaches the Worker). A full dump of this DB — even with
-- the Worker's own config/secrets — decrypts to nothing without a live OpenBao to
-- unwrap the DEK. See cloudflare/src/custody.ts and the guarantee test in
-- cloudflare/test/custody.test.ts.
--
-- Apply locally:  wrangler d1 execute fula_mcp_custody --local  --file ./schema.sql
-- Apply (deploy): wrangler d1 execute fula_mcp_custody --remote --file ./schema.sql
-- (deploy is USER-GATED — see wrangler.toml).

-- ── Per-user custodied capability (envelope-encrypted) ───────────────────────
-- One row per user. The capability is { workspace_secret, mcp_secret,
-- refresh_token, refresh_url, endpoint } — see src/custody.ts Capability.
--   user_id               : SHA-256(lowercased email) hex — the stable Fula id
--                           (the OAuth grant subject; never the raw email).
--   record_id             : a FRESH per-record UUID, distinct from user_id. It is
--                           bound into the AEAD as Associated Data (AAD), so a row
--                           lifted into another user_id's PK slot FAILS to decrypt
--                           (blocks cross-row swap). Re-rolled on every re-seal.
--   capability_ciphertext : nonce(24) || XChaCha20-Poly1305(ciphertext||tag) of
--                           the capability JSON. Opaque without the DEK.
--   wrapped_dek           : the per-record DEK wrapped by OpenBao transit — an
--                           opaque "vault:v<n>:..." string. UN-unwrappable without
--                           the OpenBao KEK (different trust domain). The ONLY
--                           thing that gates at-rest decryption.
--   dek_version           : envelope-format version (1) — lets us migrate the
--                           wrapping scheme without ambiguity. Bound into AAD too.
--   alg                   : the AEAD identifier ("xchacha20poly1305") — bound into
--                           AAD so a downgrade to a weaker alg can't be forged.
--   endpoint              : non-secret storage endpoint (operational metadata).
--   created_at/last_used_at: epoch seconds; operational, non-secret.
CREATE TABLE IF NOT EXISTS mcp_capabilities (
  user_id               TEXT PRIMARY KEY NOT NULL,
  record_id             TEXT NOT NULL,
  capability_ciphertext BLOB NOT NULL,
  wrapped_dek           TEXT NOT NULL,
  dek_version           INTEGER NOT NULL DEFAULT 1,
  alg                   TEXT NOT NULL,
  endpoint              TEXT,
  created_at            INTEGER NOT NULL,
  last_used_at          INTEGER
);

-- ── Append-only audit log ────────────────────────────────────────────────────
-- Records custody-relevant actions (delegation, seal, open, open-failure). It is
-- APPEND-ONLY by convention (the Worker only ever INSERTs; never UPDATE/DELETE).
-- `detail` is a small JSON string of NON-SECRET context (e.g. record_id, error
-- class) — never the capability, the DEK, or any plaintext secret.
CREATE TABLE IF NOT EXISTS mcp_audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  action  TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  detail  TEXT
);

CREATE INDEX IF NOT EXISTS idx_mcp_audit_user_ts ON mcp_audit (user_id, ts);
