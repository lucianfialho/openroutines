-- F4 #158 (risk radar + green lane, D29): computed once at PR creation.
ALTER TABLE pr_links ADD COLUMN IF NOT EXISTS risk_score NUMERIC;
ALTER TABLE pr_links ADD COLUMN IF NOT EXISTS green_lane BOOLEAN NOT NULL DEFAULT FALSE;
