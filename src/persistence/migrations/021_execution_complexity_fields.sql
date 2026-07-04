-- F5 #167: D9 complexity routing needs to record what complexity an
-- implementation actually turned out to need (vs the card's declared
-- complexity) and whether an 'alta' implementation escalated tier mid-run.
-- Both are written by the app going forward (unlike night_id, which only
-- night-coordinator's raw INSERT sets — see postgres.ts's save() comment),
-- so they join the normal save() column list.
ALTER TABLE executions ADD COLUMN IF NOT EXISTS realized_complexity TEXT;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS alta_impl_escalated BOOLEAN;
