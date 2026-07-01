-- Prevent duplicate gates for the same execution/state combination
CREATE UNIQUE INDEX IF NOT EXISTS idx_gates_execution_state
ON gates (execution_id, COALESCE(state_id, ''));
