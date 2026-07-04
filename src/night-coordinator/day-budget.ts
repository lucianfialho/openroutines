/**
 * Daytime research path (F5 #170).
 *
 * Two pieces of the recurring daytime triage: (1) `reserveDayBudget`, the
 * daytime twin of night-coordinator/budget.ts's `reserveBudget`, and (2)
 * `dispatchResearchIfEligible`, the per-card decision the triage handler runs at
 * the end of classifying EACH card to fire same-day research.
 *
 * Budget isolation: a daytime reservation carries `night_id = NULL` (migration
 * 020 relaxed the NOT NULL) and is capped against DAY_BUDGET_USD, aggregated
 * over the CURRENT DAY instead of a night_id. The night's anti-TOCTOU
 * serialization point is a `FOR UPDATE` lock on the night_runs row; the day has
 * no such row (and the day's first reservation has nothing to lock), so a
 * transaction-scoped advisory lock is the daytime serialization point — same
 * guarantee, no per-day row required.
 */
import type { Pool } from "pg";
import type { BudgetTier } from "./budget.js";
import type { TaskComplexity, TaskType } from "../task-source/types.js";

/**
 * Arbitrary fixed key for the day-budget advisory-lock domain. All daytime
 * reservations serialize on this one key — there is a single shared daytime
 * budget at a time, so a per-date key would add nothing (contention is trivial:
 * daytime research runs one-at-a-time by design, D15/#170 YAGNI).
 */
const DAY_BUDGET_ADVISORY_LOCK = 228782294;

/**
 * Atomic daytime budget reservation, anti-TOCTOU — the daytime twin of
 * reserveBudget (budget.ts). Holds a transaction-scoped advisory lock so
 * concurrent reservers serialize: each reads the running total AFTER every
 * previously-committed daytime reservation, and DAY_BUDGET_USD can never be
 * over-committed even under parallel starts. Aggregates by CURRENT_DATE over
 * `night_id IS NULL` rows, fully isolated from any night's per-night sum.
 */
export const reserveDayBudget = async (
  pool: Pool,
  args: {
    executionId: string;
    phase: string;
    tier: BudgetTier;
    estimatedUnits: number;
    /** Daytime cap, DAY_BUDGET_USD (effort units, not dollars — see budget.ts). */
    dayBudgetUsd: number;
  }
): Promise<{ granted: boolean; reservationId?: string }> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The daytime serialization point. A second reserver blocks here until the
    // first commits/rolls back (xact-scoped locks release at tx end), then sees
    // the first's committed reservation in the SUM below — anti-TOCTOU without a
    // per-day row to FOR UPDATE.
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [DAY_BUDGET_ADVISORY_LOCK]);
    // ponytail: day boundary follows the DB session timezone (CURRENT_DATE /
    // created_at::date), matching how the app pins TZ=America/Sao_Paulo at boot.
    // Upgrade path if the server clock ever diverges: `created_at AT TIME ZONE $tz`.
    const sumRes = await client.query(
      `SELECT COALESCE(SUM(COALESCE(actual_usd, reserved_usd)), 0) AS used
       FROM budget_reservations
       WHERE night_id IS NULL AND created_at::date = CURRENT_DATE`
    );
    const used = Number(sumRes.rows[0].used);
    if (used + args.estimatedUnits > args.dayBudgetUsd) {
      await client.query("ROLLBACK");
      return { granted: false };
    }
    const insRes = await client.query(
      `INSERT INTO budget_reservations (night_id, execution_id, phase, tier, reserved_usd)
       VALUES (NULL, $1, $2, $3, $4) RETURNING id`,
      [args.executionId, args.phase, args.tier, args.estimatedUnits]
    );
    await client.query("COMMIT");
    return { granted: true, reservationId: insRes.rows[0].id as string };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

/**
 * ≤ Medium — the daytime-eligible research complexities (#170). Above this
 * (high/highest/not_sure) waits for the night, which orders the Fable judge
 * against the night cap (inherited F2 behavior, unchanged).
 */
export const DAYTIME_RESEARCH_COMPLEXITIES: readonly TaskComplexity[] = ["lowest", "low", "medium"];

export type DayDispatchOutcome = "skipped" | "dispatched" | "budget-exhausted";

export interface DayDispatchCard {
  executionId: string;
  type: TaskType;
  complexity?: TaskComplexity;
}

export interface DayDispatchDeps {
  /** Atomic day-budget reservation for this card's research run (binds reserveDayBudget). */
  reserve: (card: DayDispatchCard) => Promise<{ granted: boolean }>;
  /** Runs the card-research state machine for this card in the SAME cycle (wired in app.ts). */
  dispatchPesquisa: (card: DayDispatchCard) => Promise<void>;
}

/**
 * Same-day research dispatch (#170). The triage handler calls this at the END
 * of classifying EACH card. Only `research` cards ≤ Medium run in the daytime;
 * every other type/complexity is a no-op here (left marked for the night, the
 * inherited F2 behavior). On a denied day budget the card is simply left
 * pending — NO error, NO Blocked, no new blockReason: the next 30-min triage
 * retries, or it accumulates for the night cycle.
 */
export const dispatchResearchIfEligible = async (
  card: DayDispatchCard,
  deps: DayDispatchDeps
): Promise<DayDispatchOutcome> => {
  if (card.type !== "research") return "skipped";
  if (!card.complexity || !DAYTIME_RESEARCH_COMPLEXITIES.includes(card.complexity)) return "skipped";
  const { granted } = await deps.reserve(card);
  if (!granted) return "budget-exhausted";
  await deps.dispatchPesquisa(card);
  return "dispatched";
};
