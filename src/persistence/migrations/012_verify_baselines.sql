-- Verify baseline: the base branch's build/typecheck/lint/test result captured
-- once per repo per night, so a card's verify only fails on a NEW failure — a
-- failure already present in the base (known flaky) doesn't block the card (F3 #150).
-- UNIQUE (repo, night_id) tolerates a race between two cards of the same repo
-- asking for the baseline at once (ON CONFLICT DO NOTHING → reread the winner's row).
CREATE TABLE IF NOT EXISTS verify_baselines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo TEXT NOT NULL,
  night_id UUID NOT NULL REFERENCES night_runs(id) ON DELETE CASCADE,
  base_sha TEXT NOT NULL,
  results JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (repo, night_id)
);
