import { describe, it, expect, vi, beforeEach } from "vitest";
import { Pool } from "pg";
import { makePostgresExecutionProcessRepository } from "./execution-process-repo.js";
import type { ExecutionProcess } from "./types.js";

let mockRows: Array<Record<string, unknown>> = [];
let lastQuery = "";
let lastParams: unknown[] = [];

vi.mock("pg", () => ({
  Pool: vi.fn(() => ({
    query: vi.fn(async (sql: string, params: unknown[]) => {
      lastQuery = sql;
      lastParams = params;
      return { rows: mockRows };
    }),
  })),
}));

describe("makePostgresExecutionProcessRepository", () => {
  beforeEach(() => {
    mockRows = [];
    lastQuery = "";
    lastParams = [];
    vi.clearAllMocks();
  });

  it("saves a process row with execution/pid/worktree", async () => {
    const repo = makePostgresExecutionProcessRepository(new Pool());
    const proc: ExecutionProcess = { id: "proc-1", executionId: "exec-1", pid: 4242, worktree: "/tmp/wt" };

    await repo.save(proc);

    expect(lastQuery).toContain("INSERT INTO execution_processes");
    expect(lastParams[0]).toBe("proc-1");
    expect(lastParams[1]).toBe("exec-1");
    expect(lastParams[2]).toBe(4242);
    expect(lastParams[3]).toBe("/tmp/wt");
  });

  it("generates an id when the row doesn't provide one", async () => {
    const repo = makePostgresExecutionProcessRepository(new Pool());
    await repo.save({ executionId: "exec-1", pid: 1 } as ExecutionProcess);
    expect(typeof lastParams[0]).toBe("string");
    expect((lastParams[0] as string).length).toBeGreaterThan(0);
  });

  it("marks a process finished by id", async () => {
    const repo = makePostgresExecutionProcessRepository(new Pool());
    const finishedAt = new Date("2024-01-01T00:00:00Z");

    await repo.markFinished("proc-1", finishedAt);

    expect(lastQuery).toContain("UPDATE execution_processes");
    expect(lastQuery).toContain("finished_at");
    expect(lastParams).toEqual(["proc-1", finishedAt]);
  });

  it("finds running processes (finished_at IS NULL)", async () => {
    mockRows = [
      { id: "proc-1", execution_id: "exec-1", pid: 111, worktree: "/tmp/a", started_at: new Date(), finished_at: null },
    ];
    const repo = makePostgresExecutionProcessRepository(new Pool());

    const result = await repo.findRunning();

    expect(lastQuery).toContain("finished_at IS NULL");
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(111);
    expect(result[0].executionId).toBe("exec-1");
  });
});
