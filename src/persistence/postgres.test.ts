import { describe, it, expect, vi, beforeEach } from "vitest";
import { makePostgresRepository } from "./postgres.js";
import type { ExecutionRecord } from "./types.js";

let mockRows: Array<Record<string, unknown>> = [];
let lastQuery = "";
let lastParams: unknown[] = [];
let allQueries: string[] = [];

vi.mock("pg", () => ({
  Pool: vi.fn(() => ({
    query: vi.fn(async (sql: string, params: unknown[]) => {
      lastQuery = sql;
      lastParams = params;
      allQueries.push(sql);
      return { rows: mockRows };
    }),
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string) => {
        lastQuery = sql;
        allQueries.push(sql);
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
    allQueries = [];
    vi.clearAllMocks();
  });

  it("should migrate executions table", async () => {
    const repo = makePostgresRepository({
      connectionString: "postgresql://test:test@localhost/test",
    });
    await repo.migrate();
    // Migrations run in lexicographic order; the executions table is 001, so it
    // must appear among the executed statements (not necessarily last).
    expect(allQueries.some((q) => q.includes("executions"))).toBe(true);
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

  it("H3: the upsert COALESCEs metadata against the existing row — a save() with no metadata (succeed()/fail()'s shape) must never null out a previously-persisted stateMachineContext", async () => {
    const repo = makePostgresRepository({
      connectionString: "postgresql://test:test@localhost/test",
    });
    const record: ExecutionRecord = {
      id: "exec-1",
      routineId: "routine-a",
      triggerType: "task_source",
      skillName: "solve-issue",
      status: "completed",
      // No metadata — exactly what state-machine.ts's succeed()/fail() persist.
      startedAt: new Date("2024-01-01T00:00:00Z"),
    };

    await repo.save(record);

    expect(lastQuery).toContain("metadata = COALESCE(EXCLUDED.metadata, executions.metadata)");
    expect(lastQuery).not.toContain("metadata = EXCLUDED.metadata,"); // the old, clobbering clause is gone
    expect(lastParams).toContain(null); // metadata VALUES param stays null when absent — COALESCE is what protects it
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

  it("H7: maps night_id -> nightId on read (set once by the night-coordinator's raw INSERT), but save() never writes it back", async () => {
    mockRows = [
      {
        id: "exec-1",
        routine_id: "routine-a",
        trigger_type: "card-execution",
        skill_name: "card-to-pr",
        status: "running",
        started_at: new Date("2024-01-01"),
        night_id: "night-42",
      },
    ];

    const repo = makePostgresRepository({
      connectionString: "postgresql://test:test@localhost/test",
    });
    const result = await repo.findById("exec-1");
    expect(result?.nightId).toBe("night-42");

    await repo.save({ ...result!, status: "completed" });
    expect(lastQuery).not.toContain("night_id"); // save()'s INSERT/UPDATE column lists omit it on purpose
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

  it("should save cost_usd and provider_breakdown", async () => {
    const repo = makePostgresRepository({
      connectionString: "postgresql://test:test@localhost/test",
    });
    const record: ExecutionRecord = {
      id: "exec-1",
      routineId: "routine-a",
      triggerType: "api",
      skillName: "echo",
      status: "completed",
      costUsd: 0.07,
      providerBreakdown: { "claude-cli": 0.07 },
      startedAt: new Date("2024-01-01T00:00:00Z"),
    };

    await repo.save(record);

    expect(lastQuery).toContain("cost_usd");
    expect(lastQuery).toContain("provider_breakdown");
    expect(lastParams).toContain(0.07);
    expect(lastParams).toContain(JSON.stringify({ "claude-cli": 0.07 }));
  });

  it("should round-trip cost_usd (numeric-as-string) and provider_breakdown", async () => {
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
        cost_usd: "0.07",
        provider_breakdown: { "claude-cli": 0.07 },
      },
    ];

    const repo = makePostgresRepository({
      connectionString: "postgresql://test:test@localhost/test",
    });
    const result = await repo.findById("exec-1");

    expect(result?.costUsd).toBe(0.07);
    expect(typeof result?.costUsd).toBe("number");
    expect(result?.providerBreakdown).toEqual({ "claude-cli": 0.07 });
  });

  it("should persist sourceId/taskId on save", async () => {
    const repo = makePostgresRepository({
      connectionString: "postgresql://test:test@localhost/test",
    });
    const record: ExecutionRecord = {
      id: "exec-1",
      routineId: "routine-a",
      triggerType: "task_source",
      skillName: "solve-issue",
      status: "completed",
      sourceId: "trello-main",
      taskId: "card-123",
      startedAt: new Date("2024-01-01T00:00:00Z"),
    };

    await repo.save(record);

    expect(lastQuery).toContain("source_id");
    expect(lastQuery).toContain("task_id");
    expect(lastParams).toContain("trello-main");
    expect(lastParams).toContain("card-123");
  });

  it("should find by task (source_id, task_id) and round-trip the keys", async () => {
    mockRows = [
      {
        id: "exec-1",
        routine_id: "routine-a",
        trigger_type: "task_source",
        skill_name: "solve-issue",
        status: "completed",
        output: null,
        error: null,
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        started_at: new Date("2024-01-01"),
        finished_at: null,
        source_id: "trello-main",
        task_id: "card-123",
      },
    ];

    const repo = makePostgresRepository({
      connectionString: "postgresql://test:test@localhost/test",
    });
    const results = await repo.findByTask("trello-main", "card-123");

    expect(results).toHaveLength(1);
    expect(results[0].sourceId).toBe("trello-main");
    expect(results[0].taskId).toBe("card-123");
    expect(lastQuery).toContain("source_id = $1");
    expect(lastQuery).toContain("task_id = $2");
    expect(lastParams).toEqual(["trello-main", "card-123"]);
  });

  it("keeps executions without sourceId/taskId working (NULL columns)", async () => {
    const repo = makePostgresRepository({
      connectionString: "postgresql://test:test@localhost/test",
    });
    const record: ExecutionRecord = {
      id: "exec-legacy",
      routineId: "routine-a",
      triggerType: "github",
      skillName: "review",
      status: "completed",
      startedAt: new Date("2024-01-01T00:00:00Z"),
    };

    await repo.save(record);

    // sourceId/taskId absent -> persisted as null, no throw.
    expect(lastParams).toContain(null);
    expect(lastParams[0]).toBe("exec-legacy");
  });

  it("F5 #167: saves realized_complexity/alta_impl_escalated and round-trips them on read", async () => {
    const repo = makePostgresRepository({
      connectionString: "postgresql://test:test@localhost/test",
    });
    const record: ExecutionRecord = {
      id: "exec-1",
      routineId: "routine-a",
      triggerType: "task_source",
      skillName: "solve-issue",
      status: "completed",
      realizedComplexity: "alta",
      altaImplEscalated: true,
      startedAt: new Date("2024-01-01T00:00:00Z"),
    };

    await repo.save(record);

    expect(lastQuery).toContain("realized_complexity");
    expect(lastQuery).toContain("alta_impl_escalated");
    expect(lastParams).toContain("alta");
    expect(lastParams).toContain(true);

    mockRows = [
      {
        id: "exec-1",
        routine_id: "routine-a",
        trigger_type: "task_source",
        skill_name: "solve-issue",
        status: "completed",
        started_at: new Date("2024-01-01"),
        realized_complexity: "alta",
        alta_impl_escalated: true,
      },
    ];
    const found = await repo.findById("exec-1");
    expect(found?.realizedComplexity).toBe("alta");
    expect(found?.altaImplEscalated).toBe(true);
  });

  it("F5 #167: a save() with neither field (succeed()/fail()'s shape) COALESCEs, never nulling out a previously-persisted value", async () => {
    const repo = makePostgresRepository({
      connectionString: "postgresql://test:test@localhost/test",
    });
    await repo.save({
      id: "exec-1",
      routineId: "routine-a",
      triggerType: "task_source",
      skillName: "solve-issue",
      status: "completed",
      startedAt: new Date("2024-01-01T00:00:00Z"),
    });

    expect(lastQuery).toContain("realized_complexity = COALESCE(EXCLUDED.realized_complexity, executions.realized_complexity)");
    expect(lastQuery).toContain("alta_impl_escalated = COALESCE(EXCLUDED.alta_impl_escalated, executions.alta_impl_escalated)");
  });
});
