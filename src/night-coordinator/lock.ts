/**
 * Night cycle lock (F3 #147).
 *
 * night_runs.date is UNIQUE, so `INSERT ... ON CONFLICT DO NOTHING RETURNING id`
 * is an atomic mutual-exclusion primitive: exactly one process per calendar date
 * gets a nightId; every other caller for the same date gets null and must abort.
 */
import type { Pool } from "pg";

export const acquireNightLock = async (
  pool: Pool,
  date: string, // YYYY-MM-DD (local night date)
  opts: { budgetCapUsd: number; prCap: number }
): Promise<{ nightId: string } | null> => {
  const { rows } = await pool.query(
    `INSERT INTO night_runs (date, budget_cap_usd, pr_cap)
     VALUES ($1, $2, $3)
     ON CONFLICT (date) DO NOTHING
     RETURNING id`,
    [date, opts.budgetCapUsd, opts.prCap]
  );
  return rows[0] ? { nightId: rows[0].id as string } : null;
};
