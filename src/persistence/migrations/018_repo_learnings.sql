-- Mined repo-level facts (F5 #166), deduped per repo by a NORMALIZED
-- (lowercase+trim) key — no embeddings. fato_normalized is a generated
-- column so the normalization lives in one place (the DB); the app's
-- ON CONFLICT target is then a plain unique column, not a fragile
-- expression index. freq counts sightings; freq >= 3 makes a fact a
-- candidate for promotion into the repo's persistent profile
-- (promoted_to_profile, flipped by markPromoted).
CREATE TABLE IF NOT EXISTS repo_learnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo TEXT NOT NULL,
  fato TEXT NOT NULL,
  fato_normalized TEXT GENERATED ALWAYS AS (lower(btrim(fato))) STORED,
  evidencia TEXT,
  escopo TEXT,
  visto_em TIMESTAMPTZ[] NOT NULL DEFAULT ARRAY[]::TIMESTAMPTZ[],
  freq INTEGER NOT NULL DEFAULT 1,
  promoted_to_profile BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (repo, fato_normalized)
);
CREATE INDEX IF NOT EXISTS idx_repo_learnings_repo ON repo_learnings(repo);
