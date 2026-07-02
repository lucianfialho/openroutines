-- OS processes spawned by CLI-based providers, tracked for group-kill on
-- timeout and zombie cleanup on boot (F1 #137).
CREATE TABLE IF NOT EXISTS execution_processes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  pid INTEGER NOT NULL,
  worktree TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_execution_processes_execution ON execution_processes(execution_id);
CREATE INDEX IF NOT EXISTS idx_execution_processes_running ON execution_processes(finished_at) WHERE finished_at IS NULL;
