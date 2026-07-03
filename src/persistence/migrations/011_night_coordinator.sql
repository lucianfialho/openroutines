-- Night-coordinator: cycle lock + atomic budget reservation (F3 #147).
-- night_runs.date UNIQUE IS the cycle lock — two orchestrators can never run
-- the same night (INSERT ... ON CONFLICT DO NOTHING RETURNING id).
CREATE TABLE IF NOT EXISTS night_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL UNIQUE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  budget_cap_usd NUMERIC NOT NULL,
  pr_cap INTEGER NOT NULL,
  cards_planned INTEGER,
  report_card_id TEXT
);

-- Anti-TOCTOU budget: each pre-invocation reservation is committed inside a
-- transaction that holds FOR UPDATE on the night_runs row, so concurrent
-- reservers serialize and the cap can never be over-committed. actual_usd
-- replaces the reservation on settle; the running total sums COALESCE(actual, reserved).
CREATE TABLE IF NOT EXISTS budget_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  night_id UUID NOT NULL REFERENCES night_runs(id) ON DELETE CASCADE,
  execution_id UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('kimi','claude-sonnet-5','claude-opus-4.8','fable-5')),
  reserved_usd NUMERIC NOT NULL,
  actual_usd NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_budget_reservations_night ON budget_reservations(night_id);

-- night_id/repo are new for the coordinator; cost_usd was added in 007_cost_usd.sql
-- (re-stated with IF NOT EXISTS so this migration is self-contained and idempotent).
ALTER TABLE executions ADD COLUMN IF NOT EXISTS night_id UUID REFERENCES night_runs(id);
ALTER TABLE executions ADD COLUMN IF NOT EXISTS repo TEXT;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS cost_usd NUMERIC;
CREATE INDEX IF NOT EXISTS idx_executions_night_running ON executions(night_id, repo) WHERE status = 'running';

-- Atomic card claim: a card is claimed by exactly one night_run via
-- UPDATE ... WHERE claimed_by_night_id IS NULL RETURNING (F3 #147).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS claimed_by_night_id UUID REFERENCES night_runs(id);
