/**
 * F5 #170: budget_reservations.night_id is now nullable (020_day_budget.sql)
 * so a day-budget reservation can exist without a night_run. This is a
 * schema-only change (no new repository) — the check is that the ALTER
 * actually took effect and that existing night-scoped aggregation
 * (budget.ts's `WHERE night_id = $1`) still ignores day-only rows.
 */
import { describe, it, expect, afterAll } from "vitest";
import { hasTestDb, makeTestPool, ensureSchema, uniqueDate, insertExecution } from "./db.test-helpers.js";
import type { Pool } from "pg";

describe.skipIf(!hasTestDb())("budget_reservations.night_id nullable (020)", () => {
  let pool: Pool;
  const created: string[] = [];

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM budget_reservations WHERE night_id IS NULL AND phase = 'day-budget-test'`);
      for (const nightId of created) {
        await pool.query(`DELETE FROM budget_reservations WHERE night_id = $1`, [nightId]);
        await pool.query(`DELETE FROM executions WHERE night_id = $1`, [nightId]);
        await pool.query(`DELETE FROM night_runs WHERE id = $1`, [nightId]);
      }
      await pool.end();
    }
  });

  it("accepts a reservation with a NULL night_id", async () => {
    pool = makeTestPool();
    await ensureSchema(pool);
    const executionId = crypto.randomUUID();
    await insertExecution(pool, executionId);

    const { rows } = await pool.query(
      `INSERT INTO budget_reservations (night_id, execution_id, phase, tier, reserved_usd)
       VALUES (NULL, $1, 'day-budget-test', 'claude-sonnet-5', 1) RETURNING id`,
      [executionId]
    );
    expect(rows).toHaveLength(1);

    await pool.query(`DELETE FROM budget_reservations WHERE id = $1`, [rows[0].id]);
    await pool.query(`DELETE FROM executions WHERE id = $1`, [executionId]);
  });

  it("a NULL-night_id row is invisible to the existing night_id = $1 aggregation (no regression)", async () => {
    const { rows: nightRows } = await pool.query(
      `INSERT INTO night_runs (date, budget_cap_usd, pr_cap) VALUES ($1, 10, 6) RETURNING id`,
      [uniqueDate()]
    );
    const nightId = nightRows[0].id as string;
    created.push(nightId);
    const executionId = crypto.randomUUID();
    await insertExecution(pool, executionId, { nightId });

    await pool.query(
      `INSERT INTO budget_reservations (night_id, execution_id, phase, tier, reserved_usd)
       VALUES ($1, $2, 'plano', 'claude-sonnet-5', 2)`,
      [nightId, executionId]
    );
    await pool.query(
      `INSERT INTO budget_reservations (night_id, execution_id, phase, tier, reserved_usd)
       VALUES (NULL, $1, 'day-budget-test', 'claude-sonnet-5', 999)`,
      [executionId]
    );

    // Mirrors budget.ts's reserveBudget running-total query exactly.
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(COALESCE(actual_usd, reserved_usd)), 0) AS used
       FROM budget_reservations WHERE night_id = $1`,
      [nightId]
    );
    expect(Number(rows[0].used)).toBe(2); // the 999 day-only row is excluded
  });
});
