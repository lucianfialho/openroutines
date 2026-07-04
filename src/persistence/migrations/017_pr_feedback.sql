-- Raw PR-feedback mining corpus (F5 #165): every signal about how a human
-- reacted to an agent's PR — a manual code delta after the fact, a GitHub
-- review comment, or a Trello steering comment — captured as one row so a
-- later mining pass (-> repo_learnings, 018) can look for repeated patterns.
-- pr_number is nullable: a 'steering' comment can land before any PR exists.
-- No FOREIGN KEY to tasks: same reasoning as pr_links (013) — sync order
-- between a task snapshot and its PR activity isn't guaranteed.
CREATE TABLE IF NOT EXISTS pr_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo TEXT NOT NULL,
  pr_number INTEGER,
  source_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('human-delta', 'review-comment', 'steering')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pr_feedback_repo ON pr_feedback(repo);
CREATE INDEX IF NOT EXISTS idx_pr_feedback_created_at ON pr_feedback(created_at);
