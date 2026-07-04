-- F4 #159: per-night circuit breaker by tier. A tier with >60% failures over
-- >=3 attempted cards stops receiving new cards until the next night.
CREATE TABLE IF NOT EXISTS tier_circuit_state (
  night_id UUID NOT NULL REFERENCES night_runs(id) ON DELETE CASCADE,
  tier TEXT NOT NULL,
  cards_attempted INTEGER NOT NULL DEFAULT 0,
  cards_failed INTEGER NOT NULL DEFAULT 0,
  opened_at TIMESTAMPTZ,
  PRIMARY KEY (night_id, tier)
);
