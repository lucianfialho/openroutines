import { describe, it, expect, vi, beforeEach } from "vitest";
import { makePostgresRunRepository } from "./run-repository.js";
import type { RunState } from "./types.js";

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

describe("makePostgresRunRepository", () => {
  beforeEach(() => {
    mockRows = [];
    lastQuery = "";
    lastParams = [];
    vi.clearAllMocks();
  });

  it("should save run state with cost_usd", async () => {
    const { Pool } = await import("pg");
    const repo = makePostgresRunRepository(new Pool());
    const state: RunState = {
      id: "run-1",
      executionId: "exec-1",
      stateId: "state-1",
      skillId: "skill-1",
      status: "completed",
      startedAt: new Date("2024-01-01T00:00:00Z"),
      costUsd: 0.05,
    };

    await repo.save(state);

    expect(lastQuery).toContain("INSERT INTO run_states");
    expect(lastQuery).toContain("cost_usd");
    expect(lastQuery).toContain("ON CONFLICT (id) DO UPDATE");
    expect(lastParams).toContain(0.05);
  });

  it("should save run state with null cost_usd when absent", async () => {
    const { Pool } = await import("pg");
    const repo = makePostgresRunRepository(new Pool());
    const state: RunState = {
      id: "run-1",
      executionId: "exec-1",
      stateId: "state-1",
      skillId: "skill-1",
      status: "running",
      startedAt: new Date(),
    };

    await repo.save(state);

    expect(lastParams[lastParams.length - 1]).toBeNull();
  });

  it("should round-trip cost_usd (numeric-as-string) via findByExecution", async () => {
    mockRows = [
      {
        id: "run-1",
        execution_id: "exec-1",
        state_id: "state-1",
        skill_id: "skill-1",
        agent_prompt: null,
        output: null,
        output_validated: false,
        gate_id: null,
        status: "completed",
        started_at: new Date("2024-01-01"),
        finished_at: new Date("2024-01-01"),
        duration_ms: 100,
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        cost_usd: "0.05",
      },
    ];

    const { Pool } = await import("pg");
    const repo = makePostgresRunRepository(new Pool());
    const results = await repo.findByExecution("exec-1");

    expect(results).toHaveLength(1);
    expect(results[0].costUsd).toBe(0.05);
    expect(typeof results[0].costUsd).toBe("number");
  });

  it("should leave costUsd undefined when row has no cost_usd", async () => {
    mockRows = [
      {
        id: "run-1",
        execution_id: "exec-1",
        state_id: "state-1",
        skill_id: "skill-1",
        status: "completed",
        started_at: new Date("2024-01-01"),
        cost_usd: null,
      },
    ];

    const { Pool } = await import("pg");
    const repo = makePostgresRunRepository(new Pool());
    const results = await repo.findByExecution("exec-1");

    expect(results[0].costUsd).toBeUndefined();
  });
});
