CREATE TABLE IF NOT EXISTS executions (
  id UUID PRIMARY KEY,
  routine_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  output TEXT,
  error TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_executions_routine ON executions(routine_id);
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);
CREATE INDEX IF NOT EXISTS idx_executions_started_at ON executions(started_at DESC);
