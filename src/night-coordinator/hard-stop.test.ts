import { describe, it, expect, afterAll, vi } from "vitest";
import type { Pool } from "pg";
import { isWithinWindow, enforceHardStop } from "./hard-stop.js";
import { acquireNightLock } from "./lock.js";
import { makePostgresRepository } from "../persistence/postgres.js";
import {
  hasTestDb,
  makeTestPool,
  ensureSchema,
  uniqueDate,
  insertExecution,
  cleanupNight,
  TEST_DB_URL,
} from "../persistence/db.test-helpers.js";
import type { ExecutionProcess, ExecutionProcessRepository, ExecutionRepository } from "../persistence/types.js";

describe("isWithinWindow", () => {
  const at = (hh: number, mm: number) => new Date(Date.UTC(2026, 0, 1, hh, mm));

  it("same-day window: half-open [start, end)", () => {
    expect(isWithinWindow(at(3, 0), "01:00", "06:30", "UTC")).toBe(true);
    expect(isWithinWindow(at(0, 30), "01:00", "06:30", "UTC")).toBe(false);
    expect(isWithinWindow(at(1, 0), "01:00", "06:30", "UTC")).toBe(true); // start inclusive
    expect(isWithinWindow(at(6, 30), "01:00", "06:30", "UTC")).toBe(false); // end exclusive
  });

  it("AC5: midnight-wrap window (22:00-06:00) covers both sides of midnight", () => {
    expect(isWithinWindow(at(23, 30), "22:00", "06:00", "UTC")).toBe(true); // late-night side
    expect(isWithinWindow(at(2, 0), "22:00", "06:00", "UTC")).toBe(true); // early-morning side
    expect(isWithinWindow(at(12, 0), "22:00", "06:00", "UTC")).toBe(false); // midday, outside
    expect(isWithinWindow(at(22, 0), "22:00", "06:00", "UTC")).toBe(true); // start inclusive
    expect(isWithinWindow(at(6, 0), "22:00", "06:00", "UTC")).toBe(false); // end exclusive
  });

  it("reads the wall-clock time in the given IANA tz, not the Date's UTC components", () => {
    // America/Sao_Paulo has been a fixed UTC-3 (no DST) since 2019.
    // 08:00 UTC == 05:00 in Sao Paulo: inside the window locally, outside in UTC.
    const utcNow = new Date("2026-01-01T08:00:00Z");
    expect(isWithinWindow(utcNow, "01:00", "06:30", "America/Sao_Paulo")).toBe(true);
    expect(isWithinWindow(utcNow, "01:00", "06:30", "UTC")).toBe(false);
  });
});

const makeFakeProcessRepo = (rows: ExecutionProcess[]): ExecutionProcessRepository & { finishedIds: string[] } => {
  const finishedIds: string[] = [];
  return {
    save: async () => {},
    markFinished: async (id: string) => {
      finishedIds.push(id);
    },
    findRunning: async () => rows,
    finishedIds,
  };
};

describe.skipIf(!hasTestDb())("enforceHardStop (real DB)", () => {
  const pool = makeTestPool();
  const executionRepo = makePostgresRepository({ connectionString: TEST_DB_URL! });
  const nights: string[] = [];

  afterAll(async () => {
    for (const id of nights) await cleanupNight(pool, id);
    await pool.end();
    await executionRepo.pool.end();
  });

  it("AC6: kills the process group and marks a still-running execution failed/blockReason=timeout, without a worktree call", async () => {
    await ensureSchema(pool);
    const lock = await acquireNightLock(pool, uniqueDate(), { budgetCapUsd: 30, prCap: 6 });
    const nightId = lock!.nightId;
    nights.push(nightId);

    const executionId = crypto.randomUUID();
    await insertExecution(pool, executionId, { nightId, repo: "acme-widgets", status: "running" });
    const processRepo = makeFakeProcessRepo([{ id: "proc-1", executionId, pid: 999999 }]);
    const sendAlert = vi.fn(async () => {});

    await enforceHardStop({ executionRepo, executionProcessRepo: processRepo, pool, nightId, sendAlert });

    // Process-group handling is delegated entirely to killExecutionProcessGroup
    // (already unit-tested) — this just proves enforceHardStop drives it, with
    // no separate call to any worktree-removal tool (none is injected here at all).
    expect(processRepo.finishedIds).toEqual(["proc-1"]);
    // D22/F4 #186: 1 execution actually interrupted -> exactly 1 aggregated alert.
    expect(sendAlert).toHaveBeenCalledTimes(1);

    const { rows } = await pool.query(
      `SELECT status, night_id, repo, metadata FROM executions WHERE id = $1`,
      [executionId]
    );
    expect(rows[0].status).toBe("failed");
    expect(rows[0].metadata.blockReason).toBe("timeout");
    // Columns repository.save() never mentions must survive the round-trip.
    expect(rows[0].night_id).toBe(nightId);
    expect(rows[0].repo).toBe("acme-widgets");
  });

  it("leaves other executions (different night, or not running) untouched", async () => {
    const lockA = await acquireNightLock(pool, uniqueDate(), { budgetCapUsd: 30, prCap: 6 });
    const nightA = lockA!.nightId;
    nights.push(nightA);
    const lockB = await acquireNightLock(pool, uniqueDate(), { budgetCapUsd: 30, prCap: 6 });
    const nightB = lockB!.nightId;
    nights.push(nightB);

    const otherNightExec = crypto.randomUUID();
    await insertExecution(pool, otherNightExec, { nightId: nightB, status: "running" });
    const completedExec = crypto.randomUUID();
    await insertExecution(pool, completedExec, { nightId: nightA, status: "completed" });
    const sendAlert = vi.fn(async () => {});

    await enforceHardStop({
      executionRepo,
      executionProcessRepo: makeFakeProcessRepo([]),
      pool,
      nightId: nightA,
      sendAlert,
    });

    // nightA has 0 `running` executions (only a `completed` one) -> 0 alerts.
    expect(sendAlert).not.toHaveBeenCalled();

    const { rows } = await pool.query(
      `SELECT id, status FROM executions WHERE id = ANY($1) ORDER BY id`,
      [[otherNightExec, completedExec]]
    );
    expect(rows.find((r) => r.id === otherNightExec)?.status).toBe("running");
    expect(rows.find((r) => r.id === completedExec)?.status).toBe("completed");
  });
});

// Mock-pool coverage (no real DB required) for the D22/F4 #186 aggregated
// alert — the counting/gating logic doesn't need real transactional
// guarantees, just the row count `enforceHardStop` already reads.
describe("enforceHardStop — aggregated Telegram alert (D22, F4 #186)", () => {
  const makeMockPool = (runningIds: string[]): Pool =>
    ({
      query: vi.fn(async () => ({ rows: runningIds.map((id) => ({ id })) })),
    }) as unknown as Pool;

  const noopExecutionRepo: ExecutionRepository = {
    save: async () => {},
    findById: async () => undefined,
    findByRoutine: async () => [],
    findByTask: async () => [],
    findAll: async () => [],
  };

  it("AC: fires exactly ONE alert (aggregated, not one per execution) when N>=1 running executions were killed", async () => {
    const sendAlert = vi.fn(async () => {});
    const pool = makeMockPool(["exec-1", "exec-2"]);

    await enforceHardStop({
      executionRepo: noopExecutionRepo,
      executionProcessRepo: makeFakeProcessRepo([]),
      pool,
      nightId: "night-1",
      sendAlert,
    });

    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert.mock.calls[0][0]).toContain("2 execução");
  });

  it("AC: fires zero alerts when zero executions were running at window close", async () => {
    const sendAlert = vi.fn(async () => {});
    const pool = makeMockPool([]);

    await enforceHardStop({
      executionRepo: noopExecutionRepo,
      executionProcessRepo: makeFakeProcessRepo([]),
      pool,
      nightId: "night-1",
      sendAlert,
    });

    expect(sendAlert).not.toHaveBeenCalled();
  });
});
