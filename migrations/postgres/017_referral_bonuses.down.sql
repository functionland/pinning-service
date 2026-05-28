-- Revert Migration 017: drop referral_bonuses table, column, UNIQUE index,
-- and restore the original credit_history.tx_type CHECK.
--
-- After this runs:
--   - All historical bonus rows are deleted (CASCADE from credit_history is
--     not what removes them — they are direct table contents that get dropped
--     with the table).
--   - The bonus accumulator on user_credits is gone; per-user totals computed
--     from credit_history will need re-aggregation if needed elsewhere.
--   - referrals.referred_id loses its UNIQUE guarantee; the application code
--     that depended on it should be reverted alongside.
--
-- Remove the filename from .migration_state on the host so deploy.sh re-applies
-- on next run:
--   sed -i '/^017_referral_bonuses\.sql/d' /home/root/pinning-service/.migration_state

BEGIN;

-- (d) referral_bonuses table (drops both indexes implicitly)
DROP TABLE IF EXISTS referral_bonuses;

-- (c) UNIQUE index on referrals.referred_id. The non-unique index
--     idx_referrals_referred_id (migration 010) is left in place.
DROP INDEX IF EXISTS idx_referrals_referred_id_unique;

-- (b) user_credits.total_bonus_received_fula column
ALTER TABLE user_credits DROP COLUMN IF EXISTS total_bonus_received_fula;

-- (a) Restore original credit_history.tx_type CHECK (without 'referral_bonus').
--     Convert any existing 'referral_bonus' rows to 'adjustment' so the new
--     CHECK constraint accepts them. The human-readable description is
--     preserved in reference_id, and balance_fula values are unchanged, so
--     the ledger remains consistent.
DO $$
DECLARE
    bonus_count integer;
BEGIN
    UPDATE credit_history
    SET tx_type = 'adjustment'
    WHERE tx_type = 'referral_bonus';

    GET DIAGNOSTICS bonus_count = ROW_COUNT;
    IF bonus_count > 0 THEN
        RAISE NOTICE
            'Migration 017 revert: reclassified % credit_history row(s) from '
            'referral_bonus to adjustment so the restored CHECK accepts them. '
            'The reference_id description ("''10%%'' bonus referral code …") '
            'is preserved for audit.', bonus_count;
    END IF;
END $$;

-- Drop the CHECK by introspection (mirrors the forward migration's approach).
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
    CHECK (tx_type IN ('deposit', 'hourly_deduction', 'adjustment'));

COMMIT;
