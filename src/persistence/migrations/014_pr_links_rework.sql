-- F4 #157 (rework loop, D24): rework accounting on pr_links.
-- rework_count: completed (non-aborted) rework rounds; 2 => blockReason retrabalho-esgotado.
-- last_agent_commit_sha: HEAD after the agent's last push — human commits after it abort rework.
-- last_rework_night_id: enforces max 1 rework per card per night.
ALTER TABLE pr_links ADD COLUMN IF NOT EXISTS rework_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pr_links ADD COLUMN IF NOT EXISTS last_agent_commit_sha TEXT;
ALTER TABLE pr_links ADD COLUMN IF NOT EXISTS last_rework_night_id UUID;
