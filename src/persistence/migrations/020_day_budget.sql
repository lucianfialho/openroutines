-- F5 #170: day-budget reservations aren't tied to a night_run — relax the
-- NOT NULL so a reservation can exist without one. budget.ts's queries
-- (reserveBudget/settleBudget) always filter by an explicit night_id value,
-- never IS NULL/IS NOT NULL, so existing per-night sums are unaffected.
ALTER TABLE budget_reservations ALTER COLUMN night_id DROP NOT NULL;
