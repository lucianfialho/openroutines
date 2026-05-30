CREATE TABLE IF NOT EXISTS gates (
  id UUID PRIMARY KEY,
  execution_id UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  type VARCHAR(32) NOT NULL CHECK (type IN ('manual_approval', 'security_review', 'test_pass')),
  status VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_gates_execution ON gates(execution_id);
CREATE INDEX IF NOT EXISTS idx_gates_status ON gates(status);
