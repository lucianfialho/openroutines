/**
 * Per-night circuit breaker by tier (F4 #159).
 *
 * A tier (kimi/sonnet/opus) that fails more than FAILURE_RATE_THRESHOLD of its
 * attempted cards THIS NIGHT (once at least MIN_SAMPLE_SIZE cards have gone
 * through it) stops receiving new cards until the next night — `night_id` is
 * the whole scope, so a fresh night_runs row always starts every tier closed
 * again. Bookkeeping lives in tier_circuit_state (migration 016); this module
 * is a thin, pure-SQL wrapper over it, mirroring night-coordinator/budget.ts's
 * shape (pool-first functions, no class/singleton state).
 *
 * TIMING LIMITATION (accepted, F4 review follow-up): isTierOpen is only
 * consulted during the 01:00 drain — a single synchronous pass that finishes
 * in seconds — while recordTierOutcome lands only after each card's whole
 * pipeline ends, minutes/hours later. tier_circuit_state therefore starts
 * empty for the current night_id and the breaker effectively protects the
 * FOLLOWING nights, never the one in flight. Re-evaluating isTierOpen in
 * successive drain batches within the window is the known upgrade path.
 */
import type { Pool } from "pg";
import type { TaskComplexity } from "../task-source/types.js";

export type Tier = "kimi" | "sonnet" | "opus";

/** Minimum attempted cards this night before a tier's failure rate is trusted. */
export const MIN_SAMPLE_SIZE = 3;
/** Failure rate strictly above this trips the breaker. */
export const FAILURE_RATE_THRESHOLD = 0.6;

/** D9 routing table: lowest/low -> kimi, medium/high/not_sure -> sonnet, highest -> opus. */
const COMPLEXITY_TO_TIER: Record<TaskComplexity, Tier> = {
  lowest: "kimi",
  low: "kimi",
  medium: "sonnet",
  high: "sonnet",
  not_sure: "sonnet",
  highest: "opus",
};

/** Unclassified cards (no complexity set) default to sonnet, same bucket as "not_sure". */
export const tierForComplexity = (complexity: TaskComplexity | undefined): Tier =>
  complexity ? COMPLEXITY_TO_TIER[complexity] : "sonnet";

/**
 * Atomic UPSERT: +1 cards_attempted always, +1 cards_failed iff outcome is
 * "failure". ON CONFLICT DO UPDATE increments in place so concurrent
 * recordings for the same (night_id, tier) never lose an update.
 *
 * ponytail: `opened_at` (migration 016) is left NULL — nothing reads it yet
 * (isTierOpen derives openness from the counters, not the timestamp). Add a
 * CASE-based first-trip stamp here if the report ever needs "since when".
 */
export const recordTierOutcome = async (
  pool: Pool,
  nightId: string,
  tier: Tier,
  outcome: "success" | "failure"
): Promise<void> => {
  const failedIncrement = outcome === "failure" ? 1 : 0;
  await pool.query(
    `INSERT INTO tier_circuit_state (night_id, tier, cards_attempted, cards_failed)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (night_id, tier) DO UPDATE SET
       cards_attempted = tier_circuit_state.cards_attempted + 1,
       cards_failed = tier_circuit_state.cards_failed + $3`,
    [nightId, tier, failedIncrement]
  );
};

/** true = tier is OUT of rotation for this night_id (>=MIN_SAMPLE_SIZE attempts, failure rate > FAILURE_RATE_THRESHOLD). */
export const isTierOpen = async (
  pool: Pool,
  nightId: string,
  tier: Tier,
  // F5 #168: policy.yaml's night.circuit_breaker_failure_rate overrides the
  // default when the coordinator threads it through; omitted = the compiled
  // default, so every existing caller/test keeps its behavior.
  failureRateThreshold: number = FAILURE_RATE_THRESHOLD
): Promise<boolean> => {
  const { rows } = await pool.query(
    `SELECT cards_attempted, cards_failed FROM tier_circuit_state WHERE night_id = $1 AND tier = $2`,
    [nightId, tier]
  );
  if (rows.length === 0) return false;
  const attempted = Number(rows[0].cards_attempted);
  const failed = Number(rows[0].cards_failed);
  if (attempted < MIN_SAMPLE_SIZE) return false;
  return failed / attempted > failureRateThreshold;
};
