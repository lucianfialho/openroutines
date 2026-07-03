-- Idempotency ledger for external side effects (git push, PR create, Trello
-- move/comment). Checked BEFORE the effect fires, not after — a crash between
-- the effect and its record must never double-fire on resume (F3 #149).
-- UNIQUE (execution_id, action_key) is the idempotency key: one row per
-- (execution, logical action), so a retried phase short-circuits on status='done'.
CREATE TABLE IF NOT EXISTS action_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  state_id TEXT NOT NULL,
  action_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  external_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (execution_id, action_key)
);
