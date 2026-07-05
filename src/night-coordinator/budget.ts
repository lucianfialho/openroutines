/**
 * Atomic budget reservation, anti-TOCTOU (F3 #147).
 *
 * Under subscription login (D3) there is no per-token billing, so the "budget"
 * is counted in units of effort per tier — the scarce resource is the weekly
 * rate-limit window, and Opus calls cost more of it. The _usd column names
 * are historical; the values are effort units, not dollars.
 *
 * The reservation runs inside a transaction that holds `FOR UPDATE` on the
 * night_runs row, so concurrent reservers serialize: each one reads the running
 * total AFTER every previously-committed reservation, and the cap can never be
 * over-committed even under a thundering herd of parallel phase starts.
 */
import type { Pool } from "pg";

export const BUDGET_UNIT_WEIGHTS = {
  kimi: 0.1,
  "claude-sonnet-5": 1,
  "claude-opus-4.8": 4,
} as const;
// Only 'claude-sonnet-5' is exercised in F3; the others prepare F4 routing.

export type BudgetTier = keyof typeof BUDGET_UNIT_WEIGHTS;

/**
 * The runner passes `tier = routedModel ?? routedProvider ?? "default"`
 * (state-machine.ts) as the budget-gate lookup key. Since F4 #185, a
 * dynamically-routed `implementation` state passes the actual MODEL ID
 * (e.g. "claude-opus-4-8", "kimi-k2.6"), which doesn't match
 * BUDGET_UNIT_WEIGHTS' keys verbatim (dots vs. hyphens, "kimi-k2.6" vs.
 * "kimi") — this is the one normalization point, so a routed Opus call is
 * weighed 4, not silently miscounted as the sonnet default.
 */
const MODEL_ID_TO_BUDGET_TIER: Record<string, BudgetTier> = {
  "claude-opus-4-8": "claude-opus-4.8",
  "kimi-k2.6": "kimi",
  "claude-sonnet-5": "claude-sonnet-5",
};

/**
 * Normalizes a routed model/provider/tier string into a BUDGET_UNIT_WEIGHTS
 * key. An unrecognized value (a static state's own `provider:` name, e.g.
 * "claude-cli", or anything else unmapped) defaults to "claude-sonnet-5" —
 * documented fallback, never denies budget outright for an unknown tier.
 */
export const normalizeBudgetTier = (tier: string): BudgetTier =>
  MODEL_ID_TO_BUDGET_TIER[tier] ?? (tier in BUDGET_UNIT_WEIGHTS ? (tier as BudgetTier) : "claude-sonnet-5");

export const reserveBudget = async (
  pool: Pool,
  args: {
    nightId: string;
    executionId: string;
    phase: string;
    tier: BudgetTier;
    estimatedUnits: number;
  }
): Promise<{ granted: boolean; reservationId?: string }> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Row lock on the night — the anti-TOCTOU serialization point. A second
    // reserver blocks here until the first commits, then sees its reservation.
    const capRes = await client.query(
      `SELECT budget_cap_usd FROM night_runs WHERE id = $1 FOR UPDATE`,
      [args.nightId]
    );
    if (capRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return { granted: false };
    }
    const cap = Number(capRes.rows[0].budget_cap_usd);
    const sumRes = await client.query(
      `SELECT COALESCE(SUM(COALESCE(actual_usd, reserved_usd)), 0) AS used
       FROM budget_reservations WHERE night_id = $1`,
      [args.nightId]
    );
    const used = Number(sumRes.rows[0].used);
    if (used + args.estimatedUnits > cap) {
      await client.query("ROLLBACK");
      return { granted: false };
    }
    const insRes = await client.query(
      `INSERT INTO budget_reservations (night_id, execution_id, phase, tier, reserved_usd)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [args.nightId, args.executionId, args.phase, args.tier, args.estimatedUnits]
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
 * Reconcile a reservation with real consumption. UNUSED in F3: under the D3
 * subscription/effort-unit model a reservation is the permanent charge and there
 * is nothing to reconcile (settling with the ~0 real USD would defeat the cap).
 * Kept for a future per-token-billing tier where reserved != actual.
 */
export const settleBudget = async (
  pool: Pool,
  reservationId: string,
  actualUsd: number
): Promise<void> => {
  await pool.query(
    `UPDATE budget_reservations SET actual_usd = $1, settled_at = NOW() WHERE id = $2`,
    [actualUsd, reservationId]
  );
};
