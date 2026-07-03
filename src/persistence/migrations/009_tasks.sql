-- Task snapshot persistence, keyed by composite (source_id, task_id) — never a
-- bare card id, so this generalizes to any future task source (D33). Links
-- executions to the task that originated them. No FOREIGN KEY: creation order
-- between an execution and its task snapshot sync is not guaranteed (issue #144).
CREATE TABLE IF NOT EXISTS tasks (
  source_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT,
  state TEXT NOT NULL,
  type TEXT NOT NULL,
  complexity TEXT,
  priority TEXT,
  labels JSONB NOT NULL DEFAULT '[]',
  assignees JSONB NOT NULL DEFAULT '[]',
  raw JSONB,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_id, task_id)
);

ALTER TABLE executions ADD COLUMN IF NOT EXISTS source_id TEXT;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS task_id TEXT;

CREATE INDEX IF NOT EXISTS idx_executions_source_task ON executions(source_id, task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source_id);
