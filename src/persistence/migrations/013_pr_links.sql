-- card ↔ PR linkage. First table to record a real PR, so the card-to-pr skill
-- creates it (F3 #146). Key aligned to tasks (source_id, task_id) — the F2
-- composite, never a bare card id. No FOREIGN KEY to tasks: creation order
-- between a task snapshot sync and its PR is not guaranteed (same as executions↔tasks).
-- F4 extends this (rework, aging, review feedback) via ALTER TABLE, not a recreate.
CREATE TABLE IF NOT EXISTS pr_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER,
  branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  review_state TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pr_links_task ON pr_links(source_id, task_id);
