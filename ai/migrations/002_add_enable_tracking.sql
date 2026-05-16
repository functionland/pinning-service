-- Add the per-generation opt-in click-tracking flag. Default OFF — sites
-- generated before this column existed must continue to ship without the
-- analytics script injected.

ALTER TABLE ai_generations
    ADD COLUMN IF NOT EXISTS enable_tracking BOOLEAN NOT NULL DEFAULT false;
