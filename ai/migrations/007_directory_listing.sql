-- Public directory ("yellow pages") of AI-generated websites.
--
-- NOTE: every migration re-runs on every service boot (database/index.ts),
-- so every statement here MUST be IF NOT EXISTS-guarded / idempotent.
--
-- WHY THIS LIVES HERE AND NOT IN THE PINS TABLE
-- --------------------------------------------
-- `ai_generations` already holds, in plaintext, everything a directory
-- entry needs: result_cid, gateway_url, owner (user_id) and timestamps.
-- The client never calls POST /pins for a generated website, and the
-- `pins.name` for an AI-generated CID is written by the out-of-repo S3
-- gateway, so `pins` is not a reliable source for this. No client-side
-- encryption is involved either way.
--
-- The column default is FALSE on purpose. "Listed by default" is a
-- CLIENT decision expressed by sending listed=true on new generations —
-- so every row that already exists stays unlisted, and no user is
-- retroactively published by shipping this migration.

ALTER TABLE ai_generations
    ADD COLUMN IF NOT EXISTS listed BOOLEAN NOT NULL DEFAULT FALSE;

-- Human-readable site name, supplied by the client (the website group's
-- tag name). Deliberately NOT scraped out of `prompt`: the prompt is
-- free text the user wrote and may contain personal detail.
ALTER TABLE ai_generations
    ADD COLUMN IF NOT EXISTS listing_name TEXT;

ALTER TABLE ai_generations
    ADD COLUMN IF NOT EXISTS listing_description TEXT;

ALTER TABLE ai_generations
    ADD COLUMN IF NOT EXISTS listing_category TEXT;

-- Set once, the first time the description/category pass runs. Its
-- presence is what stops a listed -> unlisted -> listed toggle from
-- re-billing an AI call.
ALTER TABLE ai_generations
    ADD COLUMN IF NOT EXISTS listing_generated_at TIMESTAMPTZ;

-- Moderation: an admin can remove a listing from the directory. This
-- DELISTS only — the site's content stays reachable at its CID, which
-- the directory page states explicitly.
ALTER TABLE ai_generations
    ADD COLUMN IF NOT EXISTS delisted_by_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- The directory's only read pattern: newest listed+completed first,
-- optionally filtered by category.
CREATE INDEX IF NOT EXISTS idx_ai_generations_directory
    ON ai_generations(completed_at DESC)
    WHERE listed = TRUE AND delisted_by_admin = FALSE AND status = 'completed';

-- ------------------------------------------------------------------
-- Categories the AI must choose from. Admin-editable: adding a row
-- makes it selectable on the next generation, and `active = FALSE`
-- retires one without breaking rows that already reference it.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS directory_categories (
    slug TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 100,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Seed set. ON CONFLICT DO NOTHING so an admin's later edits/removals
-- are never undone by the next service boot re-running this migration.
INSERT INTO directory_categories (slug, label, sort_order) VALUES
    ('business',       'Business & Services',   10),
    ('portfolio',      'Portfolio & Resume',    20),
    ('ecommerce',      'Shop & Products',       30),
    ('education',      'Education & Learning',  40),
    ('community',      'Community & Nonprofit', 50),
    ('events',         'Events',                60),
    ('food',           'Food & Hospitality',    70),
    ('health',         'Health & Wellness',     80),
    ('travel',         'Travel & Places',       90),
    ('arts',           'Arts & Entertainment',  100),
    ('technology',     'Technology',            110),
    ('personal',       'Personal & Blog',       120),
    ('other',          'Other',                 999)
ON CONFLICT (slug) DO NOTHING;

-- ------------------------------------------------------------------
-- Abuse reports from directory visitors. Unauthenticated and
-- rate-limited at the route; storing a report NEVER auto-delists.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS directory_reports (
    id UUID PRIMARY KEY,
    generation_id UUID NOT NULL,
    reason TEXT NOT NULL,
    details TEXT,
    -- Salted hash, never a raw IP: enough to rate-limit and to spot a
    -- brigading pattern, not enough to identify a reporter.
    reporter_ip_hash TEXT,
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_directory_reports_generation
    ON directory_reports(generation_id);
CREATE INDEX IF NOT EXISTS idx_directory_reports_open
    ON directory_reports(created_at DESC)
    WHERE resolved = FALSE;
