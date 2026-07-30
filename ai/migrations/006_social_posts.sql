-- Social post generation jobs (captions via Claude + 4:5 image via Gemini).
-- NOTE: every migration re-runs on every service boot (database/index.ts),
-- so every statement here MUST be IF NOT EXISTS-guarded / idempotent.

CREATE TABLE IF NOT EXISTS ai_social_posts (
    id UUID PRIMARY KEY,
    user_id TEXT NOT NULL,
    -- Client-side website-generation id this post belongs to (reference only;
    -- the client keys its UI on it).
    generation_id TEXT,
    prompt TEXT NOT NULL,
    website_url TEXT NOT NULL,
    -- Bare sanitized group name; upload key = {asset_prefix}/social/{id}.jpg
    asset_prefix TEXT NOT NULL,
    assets JSONB DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','generating','publishing','completed','error')),
    status_message TEXT,
    image_cid TEXT,
    image_url TEXT,
    -- {"long": "...", "short": "..."}
    captions JSONB,
    error_message TEXT,
    credits_charged INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_social_posts_user
    ON ai_social_posts(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_social_posts_status
    ON ai_social_posts(status);
CREATE INDEX IF NOT EXISTS idx_ai_social_posts_created
    ON ai_social_posts(created_at DESC);

-- Idempotency replay: one row per (user, key). Concurrent identical POSTs
-- resolve via unique-violation (23505) -> refund + re-select existing row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_social_posts_idem
    ON ai_social_posts(user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
