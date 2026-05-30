-- Run states: each state execution in a state-machine run
CREATE TABLE IF NOT EXISTS run_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  state_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  agent_prompt TEXT,
  output JSONB,
  output_validated BOOLEAN DEFAULT FALSE,
  gate_id UUID REFERENCES gates(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'paused')),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER
);

CREATE INDEX IF NOT EXISTS idx_run_states_execution ON run_states(execution_id);
CREATE INDEX IF NOT EXISTS idx_run_states_state ON run_states(execution_id, state_id);

-- Sub-runs: parent/child linking for delegation
CREATE TABLE IF NOT EXISTS sub_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_execution_id UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  parent_state_id TEXT NOT NULL,
  child_execution_id UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  child_skill_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_runs_child ON sub_runs(child_execution_id);
CREATE INDEX IF NOT EXISTS idx_sub_runs_parent ON sub_runs(parent_execution_id);
