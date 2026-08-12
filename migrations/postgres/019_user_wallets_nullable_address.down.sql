-- Revert migration 019. Guarded: restoring NOT NULL is only possible while no
-- NULL wallet_address rows exist (post-PII rows are hash-only, so in practice
-- this revert applies only to databases that never linked a wallet after 019).
DO $$
DECLARE
    null_count integer;
BEGIN
    SELECT COUNT(*) INTO null_count FROM user_wallets WHERE wallet_address IS NULL;
    IF null_count > 0 THEN
        RAISE EXCEPTION
            'Revert 019 aborted: % row(s) with NULL wallet_address exist (hash-only wallets). '
            'Removing them would break linked wallets — do not revert.', null_count;
    END IF;
END $$;

ALTER TABLE user_wallets ALTER COLUMN wallet_address SET NOT NULL;
