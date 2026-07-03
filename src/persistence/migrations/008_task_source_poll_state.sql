-- Poller cursor + seen-task dedupe state, per TaskSource (F2 #143). Cursor
-- persists watchNew's resume point; seen tracks (source_id, task_id) already
-- enqueued so a source resending the same task (imprecise cursor) doesn't
-- double-enqueue. Intentionally separate from the `tasks` snapshot table
-- (issue #144) — independent by design, not to be unified.
CREATE TABLE IF NOT EXISTS task_source_cursors (
  source_id TEXT PRIMARY KEY,
  cursor TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_source_seen (
  source_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_id, task_id)
);
