-- File metadata: per-directory audit trail (atomic-gates .metadata/summary.yaml in PostgreSQL)
CREATE TABLE IF NOT EXISTS file_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  path TEXT NOT NULL,
  execution_id UUID REFERENCES executions(id) ON DELETE CASCADE,
  issue_number INTEGER,
  status TEXT NOT NULL CHECK (status IN ('stub', 'complete')),
  summary TEXT,
  changes JSONB DEFAULT '[]',
  specialist TEXT,
  decisions JSONB DEFAULT '[]',
  alternatives_rejected JSONB DEFAULT '[]',
  verified_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_metadata_path ON file_metadata(path);
CREATE INDEX IF NOT EXISTS idx_file_metadata_execution ON file_metadata(execution_id);
CREATE INDEX IF NOT EXISTS idx_file_metadata_issue ON file_metadata(issue_number);
