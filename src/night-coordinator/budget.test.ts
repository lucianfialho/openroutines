import { describe, it, expect, afterAll } from "vitest";
import { reserveBudget, settleBudget, BUDGET_UNIT_WEIGHTS, normalizeBudgetTier } from "./budget.js";
import { acquireNightLock } from "./lock.js";
import { hasTestDb, makeTestPool, ensureSchema, uniqueDate, insertExecution, cleanupNight } from "../persistence/db.test-helpers.js";

describe("BUDGET_UNIT_WEIGHTS", () => {
  it("orders effort by tier (kimi cheapest, opus apex)", () => {
    expect(BUDGET_UNIT_WEIGHTS.kimi).toBeLessThan(BUDGET_UNIT_WEIGHTS["claude-sonnet-5"]);
    expect(BUDGET_UNIT_WEIGHTS["claude-sonnet-5"]).toBeLessThan(BUDGET_UNIT_WEIGHTS["claude-opus-4.8"]);
  });
});

describe("normalizeBudgetTier (F4 #185: dynamically-routed model id -> budget key)", () => {
  it("maps a routed opus model id to the claude-opus-4.8 key — weighed 4, not the sonnet default of 1", () => {
    const tier = normalizeBudgetTier("claude-opus-4-8");
    expect(tier).toBe("claude-opus-4.8");
    expect(BUDGET_UNIT_WEIGHTS[tier]).toBe(4);
  });

  it("maps a routed kimi model id to the kimi key", () => {
    expect(normalizeBudgetTier("kimi-k2.6")).toBe("kimi");
  });

  it("passes an already-valid BUDGET_UNIT_WEIGHTS key straight through", () => {
    expect(normalizeBudgetTier("claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("falls back to claude-sonnet-5 for an unrecognized tier (e.g. a static state's provider name)", () => {
    expect(normalizeBudgetTier("claude-cli")).toBe("claude-sonnet-5");
    expect(normalizeBudgetTier("default")).toBe("claude-sonnet-5");
  });
});

describe.skipIf(!hasTestDb())("reserveBudget (real DB, anti-TOCTOU)", () => {
  const pool = makeTestPool();
  const created: string[] = [];

  afterAll(async () => {
    for (const id of created) await cleanupNight(pool, id);
    await pool.end();
  });

  it("10 parallel reservations against a cap that fits 6 grant EXACTLY 6 (AC2)", async () => {
    await ensureSchema(pool);
    const lock = await acquireNightLock(pool, uniqueDate(), { budgetCapUsd: 6, prCap: 6 });
    expect(lock).not.toBeNull();
    const nightId = lock!.nightId;
    created.push(nightId);
    const executionId = crypto.randomUUID();
    await insertExecution(pool, executionId, { nightId });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        reserveBudget(pool, {
          nightId,
          executionId,
          phase: `p${i}`,
          tier: "claude-sonnet-5",
          estimatedUnits: 1,
        })
      )
    );

    const granted = results.filter((r) => r.granted);
    expect(granted).toHaveLength(6);
    expect(results.filter((r) => !r.granted)).toHaveLength(4);

    // The persisted total never exceeds the cap.
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(COALESCE(actual_usd, reserved_usd)), 0) AS used FROM budget_reservations WHERE night_id = $1`,
      [nightId]
    );
    expect(Number(rows[0].used)).toBeLessThanOrEqual(6);
  });

  it("denies a reservation that would exceed the cap, then admits a smaller one that fits", async () => {
    const lock = await acquireNightLock(pool, uniqueDate(), { budgetCapUsd: 5, prCap: 6 });
    const nightId = lock!.nightId;
    created.push(nightId);
    const executionId = crypto.randomUUID();
    await insertExecution(pool, executionId, { nightId });

    const big = await reserveBudget(pool, { nightId, executionId, phase: "plan", tier: "claude-opus-4.8", estimatedUnits: 4 });
    expect(big.granted).toBe(true);
    const tooBig = await reserveBudget(pool, { nightId, executionId, phase: "impl", tier: "claude-opus-4.8", estimatedUnits: 4 });
    expect(tooBig.granted).toBe(false); // 4 + 4 > 5
    const fits = await reserveBudget(pool, { nightId, executionId, phase: "impl", tier: "claude-sonnet-5", estimatedUnits: 1 });
    expect(fits.granted).toBe(true); // 4 + 1 == 5
  });

  it("settleBudget replaces the reservation with actual usage", async () => {
    const lock = await acquireNightLock(pool, uniqueDate(), { budgetCapUsd: 30, prCap: 6 });
    const nightId = lock!.nightId;
    created.push(nightId);
    const executionId = crypto.randomUUID();
    await insertExecution(pool, executionId, { nightId });

    const r = await reserveBudget(pool, { nightId, executionId, phase: "plan", tier: "claude-sonnet-5", estimatedUnits: 1 });
    expect(r.granted).toBe(true);
    await settleBudget(pool, r.reservationId!, 0.4);

    const { rows } = await pool.query(`SELECT actual_usd, settled_at FROM budget_reservations WHERE id = $1`, [r.reservationId]);
    expect(Number(rows[0].actual_usd)).toBe(0.4);
    expect(rows[0].settled_at).not.toBeNull();
  });
});
