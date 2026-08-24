-- Group-level directory visibility needs to see EVERY build of a site.
--
-- NOTE: every migration re-runs on every service boot (database/index.ts),
-- so every statement here MUST be IF NOT EXISTS-guarded / idempotent.
--
-- WHY
-- ---
-- Migration 007's directory indexes are PARTIAL:
--
--   WHERE listed = TRUE AND delisted_by_admin = FALSE AND status = 'completed'
--
-- which is precisely the set the new queries must NOT restrict themselves
-- to. Visibility is decided per website, by folding both flags across all
-- of its builds (`bool_or`), because:
--
--   * an admin-removed build must veto its whole group — otherwise the
--     public query falls through to the next-newest listed build and a
--     removed site REAPPEARS, and
--   * switching listing off must clear every build — otherwise an older
--     one keeps the site listed and the owner cannot withdraw it.
--
-- A build that is unlisted, or removed, is exactly the row the partial
-- indexes exclude, so those scans now need a non-partial group index.
CREATE INDEX IF NOT EXISTS idx_ai_generations_group_all
    ON ai_generations(listing_group, completed_at DESC)
 WHERE status = 'completed';
