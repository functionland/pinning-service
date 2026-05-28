-- Migration 017: Automatic multi-level referral bonuses
--
-- Wires the existing referral graph (referrals table, 3-level chain via
-- recursive CTE) into the existing credit system (creditUser → user_credits
-- + credit_history). On any positive credit to user X, the L1 referrer of X
-- earns 10%, L2 and L3 each earn 1%, all credited automatically.
--
-- This migration prepares the schema; the application logic lives in
-- pinning-webui/server/services/creditService.ts (applyReferralBonuses).
--
-- Changes:
--   (a) credit_history.tx_type CHECK extended to include 'referral_bonus'
--   (b) user_credits.total_bonus_received_fula added (bonuses do NOT inflate
--       total_deposited_fula, which keeps its meaning of wallet/blockchain
--       origin and is referenced by existing referral stats UI)
--   (c) referrals.referred_id made UNIQUE — codifies the de-facto invariant
--       that one user is referred only once, so the chain walker SELECT can
--       return a single deterministic row per level
--   (d) referral_bonuses table created — analytics + per-code attribution
--       + idempotency (UNIQUE source_credit_history_id, level)
--
-- Safety:
--   1. Single transaction (BEGIN/COMMIT) — rolls back on any error.
--   2. Pre-checks for duplicate referred_id rows and dedupes (keeps earliest)
--      so the UNIQUE index build does not fail. Reports the count via NOTICE.
--   3. Idempotent guards (IF NOT EXISTS / DROP IF EXISTS) on every step —
--      safe to re-run.
--   4. Non-CONCURRENT index creation so it fits inside the transaction.
--      Affected tables are small (low row count); brief ACCESS EXCLUSIVE
--      lock is acceptable.
--
-- Revert: migrations/postgres/017_referral_bonuses.down.sql

BEGIN;

-- ============================================
-- (a) Extend credit_history.tx_type CHECK to include 'referral_bonus'.
--     The original constraint was created inline in 001_initial_schema.sql
--     without an explicit name, so its actual name depends on Postgres's
--     auto-generation (typically `credit_history_tx_type_check`, but a prior
--     migration may have renamed it). Drop by introspection to be safe.
-- ============================================
DO $$
DECLARE
    cname text;
BEGIN
    SELECT conname INTO cname
    FROM pg_constraint
    WHERE conrelid = 'credit_history'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%tx_type%';
    IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE credit_history DROP CONSTRAINT %I', cname);
    END IF;
END $$;

ALTER TABLE credit_history ADD CONSTRAINT credit_history_tx_type_check
    CHECK (tx_type IN ('deposit', 'hourly_deduction', 'adjustment', 'referral_bonus'));

-- ============================================
-- (b) New accumulator column on user_credits for bonus earnings.
--     PG >= 11 makes ADD COLUMN with a constant default a metadata-only
--     change (no row rewrite).
-- ============================================
ALTER TABLE user_credits
    ADD COLUMN IF NOT EXISTS total_bonus_received_fula REAL DEFAULT 0;

-- ============================================
-- (c) Dedupe + UNIQUE on referrals.referred_id
--     The application has always inserted a single referrals row per
--     newly-signed-up user (see getOrCreateWebuiUser in postgres.ts), but
--     no constraint enforced it. The chain walker SELECT in
--     applyReferralBonuses depends on this being a single row.
-- ============================================
DO $$
DECLARE
    dup_count integer;
    deleted_count integer;
BEGIN
    SELECT COUNT(*) INTO dup_count
    FROM (
        SELECT referred_id
        FROM referrals
        WHERE referred_id IS NOT NULL
        GROUP BY referred_id
        HAVING COUNT(*) > 1
    ) t;

    IF dup_count > 0 THEN
        RAISE NOTICE
            'Migration 017: % duplicate referred_id value(s) found in referrals; '
            'keeping the earliest row (lowest id) for each duplicate group.',
            dup_count;

        WITH deleted AS (
            DELETE FROM referrals a
            USING referrals b
            WHERE a.id > b.id
              AND a.referred_id IS NOT NULL
              AND a.referred_id = b.referred_id
            RETURNING a.id
        )
        SELECT COUNT(*) INTO deleted_count FROM deleted;

        RAISE NOTICE 'Migration 017: deleted % duplicate referrals row(s).', deleted_count;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_referred_id_unique
    ON referrals(referred_id);

-- ============================================
-- (d) referral_bonuses table: per-event attribution + idempotency.
--     credit_history_id → the bonus credit's ledger row (FK with CASCADE)
--     source_credit_history_id → the originating credit (FK with CASCADE)
--     UNIQUE(source_credit_history_id, level) → idempotency guard so a
--       retry of the bonus calculation for the same source row is a no-op
--     recipient_referral_code → the recipient's OWN code at chain entry
--       (used for per-code rollup in /api/referral)
--     source_referral_code → the source's signup code (rightmost in the
--       description's code chain; preserved for audit even if the code is
--       later deleted, though deleteUserReferralCode refuses deletion when
--       referrals exist so this is currently belt-and-suspenders)
-- ============================================
--     NUMERIC vs REAL: bonus_amount_fula and source_amount_fula are stored as
--     NUMERIC(30, 8) for audit precision, even though user_credits.balance_fula
--     and credit_history.amount_fula remain REAL repo-wide (a wider migration
--     is deferred). The audit table thus preserves the exact intended bonus
--     while the running balance may drift slightly at large magnitudes.
CREATE TABLE IF NOT EXISTS referral_bonuses (
    id SERIAL PRIMARY KEY,
    credit_history_id INTEGER NOT NULL REFERENCES credit_history(id) ON DELETE CASCADE,
    recipient_user_id VARCHAR(64) NOT NULL,
    recipient_referral_code TEXT NOT NULL,
    source_credit_history_id INTEGER NOT NULL REFERENCES credit_history(id) ON DELETE CASCADE,
    source_user_id VARCHAR(64) NOT NULL,
    source_referral_code TEXT NOT NULL,
    level INTEGER NOT NULL CHECK (level IN (1, 2, 3)),
    bonus_amount_fula NUMERIC(30, 8) NOT NULL,
    source_amount_fula NUMERIC(30, 8) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (source_credit_history_id, level)
);

CREATE INDEX IF NOT EXISTS idx_referral_bonuses_recipient_code
    ON referral_bonuses(recipient_user_id, recipient_referral_code);

CREATE INDEX IF NOT EXISTS idx_referral_bonuses_source
    ON referral_bonuses(source_user_id);

COMMIT;
