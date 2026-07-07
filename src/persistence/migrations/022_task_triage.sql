-- F5 #170: daytime triage stamps each card so a re-triage only re-runs the LLM
-- when the card actually changed. `triaged_at` is the last successful triage
-- time; `triage_fingerprint` is a sha256 of (title, body, sorted labels) — an
-- identical fingerprint on the next 30-min tick is skipped with no LLM call.
-- Both nullable (a never-triaged card has neither), and TaskRepository.save()
-- (task-postgres.ts) touches neither column, so re-syncing a queued card
-- preserves the stamp.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS triaged_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS triage_fingerprint TEXT;
