-- Real USD cost tracking: per-invocation (run_states) and per-execution total + provider breakdown
ALTER TABLE executions ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(12,6);
ALTER TABLE executions ADD COLUMN IF NOT EXISTS provider_breakdown JSONB;
ALTER TABLE run_states ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(12,6);
