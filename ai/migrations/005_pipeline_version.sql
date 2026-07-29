-- Client capability declaration for the generation pipeline: >=2 opts into
-- the multi-pass (brief → build → polish) pipeline. NULL = legacy client
-- (no declaration) → single-pass, sized to the old 5-minute poll deadline.

ALTER TABLE ai_generations
    ADD COLUMN IF NOT EXISTS pipeline_version INTEGER;
