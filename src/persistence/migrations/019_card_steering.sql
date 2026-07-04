-- Human steering signal on a card mid-pipeline (F5 #169, D33): a Trello
-- comment captured as a directive the agent should act on. `applied` +
-- `effect_type` let the pipeline record what it did in response, so the
-- same comment is never re-applied. FK to tasks is safe here (unlike
-- pr_links' deliberate no-FK, 013): steering only ever arrives on a card
-- the poller has already synced into `tasks`, so the row always pre-exists.
CREATE TABLE IF NOT EXISTS card_steering (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  author_trello_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied BOOLEAN NOT NULL DEFAULT FALSE,
  effect_type TEXT,
  FOREIGN KEY (source_id, task_id) REFERENCES tasks(source_id, task_id)
);
-- Matches findUnapplied's WHERE exactly (with or without the extra source/task filter).
CREATE INDEX IF NOT EXISTS idx_card_steering_unapplied ON card_steering(source_id, task_id) WHERE applied = FALSE;
