-- Keep the model's RAW output files so a later "Recreate" can EDIT the
-- site instead of inventing a new one.
--
-- NOTE: every migration re-runs on every service boot (database/index.ts),
-- so every statement here MUST be IF NOT EXISTS-guarded / idempotent.
--
-- WHY A SEPARATE TABLE
-- --------------------
-- `getGeneration()` and `getGenerationsByUser()` are `SELECT *`, and the
-- client polls `GET /status/:id` every ~2s for up to 20 minutes. A files
-- column on `ai_generations` would drag the whole site's source (tens to
-- hundreds of KB, occasionally megabytes) through every one of those
-- polls and through every row of the history list. Revision is the only
-- reader, so the payload lives behind its own explicit accessor.
--
-- WHY RAW, PRE-PUBLISH FILES
-- --------------------------
-- What is pinned on IPFS is NOT what the model wrote: publishWebsite()
-- inlines local CSS/JS into the HTML, rewrites relative asset refs to
-- absolute gateway CID URLs, strips model-authored CSP meta tags and —
-- when tracking is on — appends an analytics <script>. Feeding that back
-- as an edit base compounds those transforms on every revision. The raw
-- files are the honest source of truth; the gateway copy is the
-- best-effort fallback for sites generated before this migration.
--
-- ON DELETE CASCADE: the source is worthless without its generation row,
-- and nothing else references it.
CREATE TABLE IF NOT EXISTS ai_generation_files (
    generation_id UUID PRIMARY KEY
        REFERENCES ai_generations(id) ON DELETE CASCADE,
    files JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Revision resolves the base by the CID the client holds (the client
-- discards the server's jobId on completion, so result_cid is the only
-- stable handle it still has). Partial on 'completed' because an
-- unfinished row has no CID worth matching.
CREATE INDEX IF NOT EXISTS idx_ai_generations_result_cid
    ON ai_generations(result_cid, completed_at DESC)
 WHERE status = 'completed';

-- What this job is revising, resolved and ownership-checked at request
-- time so the worker never re-derives it from client input. Both stay on
-- `ai_generations` (rather than the files table) because they are small
-- and the worker needs them alongside the rest of the job row; the files
-- blob is what had to be kept out of the polling path, not these.
--
-- A NULL base_generation_id is an ordinary from-scratch generation, which
-- is what every existing row is.
ALTER TABLE ai_generations
    ADD COLUMN IF NOT EXISTS base_generation_id UUID
        REFERENCES ai_generations(id) ON DELETE SET NULL;

ALTER TABLE ai_generations
    ADD COLUMN IF NOT EXISTS revision_request TEXT;
