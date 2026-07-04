import { describe, it, expect, afterAll, vi } from "vitest";
import { parseExpression } from "cron-parser";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  reserveDayBudget,
  dispatchResearchIfEligible,
  DAYTIME_RESEARCH_COMPLEXITIES,
  type DayDispatchCard,
  type DayDispatchDeps,
} from "./day-budget.js";
import { reserveBudget } from "./budget.js";
import { acquireNightLock } from "./lock.js";
import { parseRoutine } from "../routine/parser.js";
import { hasTestDb, makeTestPool, ensureSchema, uniqueDate, insertExecution, cleanupNight } from "../persistence/db.test-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTINE_PATH = join(__dirname, "../../routines/card-triage.yaml");

describe("card-triage.yaml routine (#170)", () => {
  const routine = parseRoutine(readFileSync(ROUTINE_PATH, "utf-8"));

  it("parses as a valid schedule routine dispatching the card-triage skill", () => {
    expect(routine.id).toBe("card-triage");
    expect(routine.pipeline.skill).toBe("card-triage");
    expect(routine.triggers).toContainEqual({ type: "schedule", cron: "*/30 8-23 * * *" });
  });

  it("fires every 30 min inside 08h-23h and NEVER outside it (full-day sweep, America/Sao_Paulo)", () => {
    const trigger = routine.triggers.find((t) => t.type === "schedule") as { type: "schedule"; cron: string };
    const tz = "America/Sao_Paulo";
    const iter = parseExpression(trigger.cron, {
      currentDate: new Date("2026-07-04T00:00:00-03:00"),
      endDate: new Date("2026-07-04T23:59:59-03:00"),
      tz,
    });
    const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
    const fires: string[] = [];
    // cron-parser throws once next() steps past endDate — bounds the sweep to one day.
    for (;;) {
      try {
        fires.push(fmt.format(iter.next().toDate()));
      } catch {
        break;
      }
    }
    // 16 hours (08..23) x 2 (:00, :30) = 32 fires, every one in-window.
    expect(fires).toHaveLength(32);
    expect(fires[0]).toBe("08:00");
    expect(fires[fires.length - 1]).toBe("23:30");
    for (const t of fires) {
      const [h, m] = t.split(":").map(Number);
      expect(h).toBeGreaterThanOrEqual(8);
      expect(h).toBeLessThanOrEqual(23);
      expect([0, 30]).toContain(m);
    }
    // Explicit "not outside the window": nothing just-before (07:30) or at midnight.
    expect(fires).not.toContain("07:30");
    expect(fires).not.toContain("00:00");
  });
});

describe("dispatchResearchIfEligible (#170 same-day research dispatch)", () => {
  const makeDeps = (granted: boolean): DayDispatchDeps & { reserve: ReturnType<typeof vi.fn>; dispatchPesquisa: ReturnType<typeof vi.fn> } => ({
    reserve: vi.fn(async () => ({ granted })),
    dispatchPesquisa: vi.fn(async () => {}),
  });

  it("dispatches a research card <= Medium in the SAME cycle when the day budget grants", async () => {
    const deps = makeDeps(true);
    const card: DayDispatchCard = { executionId: "e1", type: "research", complexity: "medium" };
    expect(await dispatchResearchIfEligible(card, deps)).toBe("dispatched");
    expect(deps.reserve).toHaveBeenCalledOnce();
    expect(deps.dispatchPesquisa).toHaveBeenCalledWith(card);
  });

  it.each(DAYTIME_RESEARCH_COMPLEXITIES)("dispatches research at eligible complexity '%s'", async (complexity) => {
    const deps = makeDeps(true);
    expect(await dispatchResearchIfEligible({ executionId: "e", type: "research", complexity }, deps)).toBe("dispatched");
    expect(deps.dispatchPesquisa).toHaveBeenCalledOnce();
  });

  it("does NOT dispatch research > Medium (High) — marked only, waits for the night", async () => {
    const deps = makeDeps(true);
    expect(await dispatchResearchIfEligible({ executionId: "e2", type: "research", complexity: "high" }, deps)).toBe("skipped");
    expect(deps.reserve).not.toHaveBeenCalled();
    expect(deps.dispatchPesquisa).not.toHaveBeenCalled();
  });

  it.each(["highest", "not_sure"] as const)("does NOT dispatch research at complexity '%s'", async (complexity) => {
    const deps = makeDeps(true);
    expect(await dispatchResearchIfEligible({ executionId: "e", type: "research", complexity }, deps)).toBe("skipped");
    expect(deps.dispatchPesquisa).not.toHaveBeenCalled();
  });

  it("does NOT dispatch a non-research card, even at Low complexity", async () => {
    const deps = makeDeps(true);
    expect(await dispatchResearchIfEligible({ executionId: "e3", type: "implementation", complexity: "low" }, deps)).toBe("skipped");
    expect(deps.dispatchPesquisa).not.toHaveBeenCalled();
  });

  it("leaves an eligible card pending (no throw, no dispatch, no Blocked) when the day budget is exhausted", async () => {
    const deps = makeDeps(false);
    expect(await dispatchResearchIfEligible({ executionId: "e4", type: "research", complexity: "medium" }, deps)).toBe("budget-exhausted");
    expect(deps.reserve).toHaveBeenCalledOnce();
    expect(deps.dispatchPesquisa).not.toHaveBeenCalled();
  });

  it("skips a research card with no complexity classified yet", async () => {
    const deps = makeDeps(true);
    expect(await dispatchResearchIfEligible({ executionId: "e5", type: "research" }, deps)).toBe("skipped");
  });
});

describe.skipIf(!hasTestDb())("reserveDayBudget (real DB, anti-TOCTOU, night-isolated)", () => {
  const pool = makeTestPool();
  const execIds: string[] = [];
  const nightIds: string[] = [];

  // NULL-today reservations are created ONLY by reserveDayBudget (i.e. this file),
  // and vitest runs a file's tests sequentially — so clearing all of today's day
  // reservations is a deterministic slate, not cross-file interference.
  const clearDayReservations = () =>
    pool.query(`DELETE FROM budget_reservations WHERE night_id IS NULL AND created_at::date = CURRENT_DATE`);

  const newDayExec = async (): Promise<string> => {
    await ensureSchema(pool);
    const id = crypto.randomUUID();
    await insertExecution(pool, id); // night_id NULL — a daytime execution
    execIds.push(id);
    return id;
  };

  afterAll(async () => {
    await clearDayReservations();
    for (const id of nightIds) await cleanupNight(pool, id);
    if (execIds.length) await pool.query(`DELETE FROM executions WHERE id = ANY($1)`, [execIds]);
    await pool.end();
  });

  it("10 parallel reservations against a DAY_BUDGET_USD that fits 6 grant EXACTLY 6", async () => {
    await ensureSchema(pool);
    await clearDayReservations();
    const execId = await newDayExec();

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        reserveDayBudget(pool, { executionId: execId, phase: `p${i}`, tier: "claude-sonnet-5", estimatedUnits: 1, dayBudgetUsd: 6 })
      )
    );
    expect(results.filter((r) => r.granted)).toHaveLength(6);
    expect(results.filter((r) => !r.granted)).toHaveLength(4);

    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(reserved_usd), 0) AS used FROM budget_reservations WHERE night_id IS NULL AND created_at::date = CURRENT_DATE`
    );
    expect(Number(rows[0].used)).toBeLessThanOrEqual(6);
  });

  it("writes night_id = NULL and its cap is isolated from a same-day night reservation", async () => {
    await clearDayReservations();
    // Fill the whole daytime budget (cap 4, one 4-unit reservation).
    const dayExec = await newDayExec();
    const day = await reserveDayBudget(pool, { executionId: dayExec, phase: "card-pesquisa", tier: "claude-opus-4.8", estimatedUnits: 4, dayBudgetUsd: 4 });
    expect(day.granted).toBe(true);
    const { rows: dayRows } = await pool.query(`SELECT night_id FROM budget_reservations WHERE id = $1`, [day.reservationId]);
    expect(dayRows[0].night_id).toBeNull();
    // A further daytime reservation is denied — the day budget is spent.
    expect((await reserveDayBudget(pool, { executionId: dayExec, phase: "x", tier: "kimi", estimatedUnits: 1, dayBudgetUsd: 4 })).granted).toBe(false);

    // A NIGHT reservation the SAME calendar day is unaffected: separate cap, separate sum.
    const lock = await acquireNightLock(pool, uniqueDate(), { budgetCapUsd: 6, prCap: 6 });
    const nightId = lock!.nightId;
    nightIds.push(nightId);
    const nightExec = crypto.randomUUID();
    await insertExecution(pool, nightExec, { nightId });
    execIds.push(nightExec);
    expect((await reserveBudget(pool, { nightId, executionId: nightExec, phase: "plano", tier: "claude-opus-4.8", estimatedUnits: 4 })).granted).toBe(true);

    // ...and that night reservation did not inflate the day sum.
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(reserved_usd), 0) AS used FROM budget_reservations WHERE night_id IS NULL AND created_at::date = CURRENT_DATE`
    );
    expect(Number(rows[0].used)).toBe(4);
  });
});
