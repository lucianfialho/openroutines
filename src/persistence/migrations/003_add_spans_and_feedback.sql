-- Execution spans: trace each step of the ReAct loop
CREATE TABLE IF NOT EXISTS execution_spans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES execution_spans(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('llm_call', 'tool_call', 'gate_check', 'prompt_build', 'execution_start', 'execution_end')),
  name TEXT,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  input JSONB,
  output JSONB,
  error TEXT,
  duration_ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  model TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_spans_execution ON execution_spans(execution_id);
CREATE INDEX IF NOT EXISTS idx_spans_type ON execution_spans(type);
CREATE INDEX IF NOT EXISTS idx_spans_started_at ON execution_spans(started_at DESC);

-- Execution feedback: human annotations and ratings
CREATE TABLE IF NOT EXISTS execution_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  tags TEXT[],
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_execution ON execution_feedback(execution_id);

-- Add metadata column to executions for arbitrary JSON data
ALTER TABLE executions ADD COLUMN IF NOT EXISTS metadata JSONB;
