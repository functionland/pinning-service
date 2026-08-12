-- Migration 019: allow NULL user_wallets.wallet_address (fresh-install fix)
--
-- Post-PII-migration code stores wallets hash-only: linkWallet
-- (pinning-webui/server/services/creditService.ts) INSERTs
-- wallet_address = NULL and relies on wallet_address_hash +
-- encrypted_wallet_address. Migration 012 dropped NOT NULL on the legacy
-- user_email column but missed wallet_address, so a database built from the
-- migration set alone (any FRESH federated master) rejects every wallet link
-- with: null value in column "wallet_address" violates not-null constraint.
-- Production survived only because its column was relaxed out-of-band.
-- Found by the Phase 1.5 e2e (fm2-billing-integration on a fresh stack DB).
--
-- Idempotent: DROP NOT NULL on an already-nullable column is a no-op.
-- Revert: migrations/postgres/019_user_wallets_nullable_address.down.sql

BEGIN;
ALTER TABLE user_wallets ALTER COLUMN wallet_address DROP NOT NULL;
COMMIT;
