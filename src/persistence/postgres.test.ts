import { describe, it, expect, vi, beforeEach } from "vitest";
import { makePostgresRepository } from "./postgres.js";
import type { ExecutionRecord } from "./types.js";

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
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string) => {
        lastQuery = sql;
        return { rows: [] };
      }),
      release: vi.fn(),
    })),
  })),
}));

describe("makePostgresRepository", () => {
  beforeEach(() => {
    mockRows = [];
    lastQuery = "";
    lastParams = [];
    vi.clearAllMocks();
  });

  it("should migrate executions table", async () => {
    const repo = makePostgresRepository({
      connectionString: "postgresql://test:test@localhost/test",
    });
    await repo.migrate();
    expect(lastQuery).toContain("executions");
  });

  it("should save execution record", async () => {
    const repo = makePostgresRepository({
      connectionString: "postgresql://test:test@localhost/test",
    });
    const record: ExecutionRecord = {
      id: "exec-1",
      routineId: "routine-a",
      triggerType: "api",
      skillName: "echo",
      status: "completed",
      output: "Hello",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      startedAt: new Date("2024-01-01T00:00:00Z"),
      finishedAt: new Date("2024-01-01T00:00:01Z"),
    };

    await repo.save(record);

    expect(lastQuery).toContain("INSERT INTO executions");
    expect(lastParams[0]).toBe("exec-1");
    expect(lastParams[4]).toBe("completed");
    expect(lastParams[5]).toBe("Hello");
  });

  it("should upsert on conflict", async () => {
    const repo = makePostgresRepository({
      connectionString: "postgresql://test:test@localhost/test",
    });
    const record: ExecutionRecord = {
      id: "exec-1",
      routineId: "routine-a",
      triggerType: "api",
      skillName: "echo",
      status: "running",
      startedAt: new Date(),
    };

    await repo.save(record);
    expect(lastQuery).toContain("ON CONFLICT (id) DO UPDATE");
  });

  it("should find by id", async () => {
    mockRows = [
      {
        id: "exec-1",
        routine_id: "routine-a",
        trigger_type: "api",
        skill_name: "echo",
        status: "completed",
        output: "Done",
        error: null,
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        started_at: new Date("2024-01-01"),
        finished_at: new Date("2024-01-01"),
      },
    ];

    const repo = makePostgresRepository({
      connectionString: "postgresql://test:test@localhost/test",
    });
    const result = await repo.findById("exec-1");

    expect(result).toBeDefined();
    expect(result?.id).toBe("exec-1");
    expect(result?.status).toBe("completed");
    expect(lastQuery).toContain("WHERE id = $1");
  });

  it("should return undefined for unknown id", async () => {
    mockRows = [];
    const repo = makePostgresRepository({
      connectionString: "postgresql://test:test@localhost/test",
    });
    const result = await repo.findById("nope");
    expect(result).toBeUndefined();
  });

  it("should find by routine", async () => {
    mockRows = [
      {
        id: "exec-1",
        routine_id: "routine-a",
        trigger_type: "api",
        skill_name: "echo",
        status: "completed",
        output: null,
        error: null,
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        started_at: new Date("2024-01-01"),
        finished_at: null,
      },
    ];

    const repo = makePostgresRepository({
      connectionString: "postgresql://test:test@localhost/test",
    });
    const results = await repo.findByRoutine("routine-a");

    expect(results).toHaveLength(1);
    expect(results[0].routineId).toBe("routine-a");
    expect(lastQuery).toContain("routine_id = $1");
  });
});
