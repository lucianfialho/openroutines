import { describe, it, expect, vi, beforeEach } from "vitest";
import { Pool } from "pg";
import { makePostgresTaskRepository } from "./task-postgres.js";
import type { Task } from "../task-source/types.js";

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

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  sourceId: "trello-main",
  id: "card-1",
  title: "Do the thing",
  body: "details",
  url: "https://trello.com/c/card-1",
  state: "backlog",
  type: "implementation",
  labels: ["bug"],
  assignees: ["henrik"],
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-02"),
  ...overrides,
});

describe("makePostgresTaskRepository", () => {
  beforeEach(() => {
    mockRows = [];
    lastQuery = "";
    lastParams = [];
    vi.clearAllMocks();
  });

  it("should upsert by (source_id, task_id) on save", async () => {
    const repo = makePostgresTaskRepository(new Pool());
    await repo.save(makeTask());

    expect(lastQuery).toContain("INSERT INTO tasks");
    expect(lastQuery).toContain("ON CONFLICT (source_id, task_id) DO UPDATE");
    expect(lastParams[0]).toBe("trello-main");
    expect(lastParams[1]).toBe("card-1");
    expect(lastParams).toContain(JSON.stringify(["bug"]));
    expect(lastParams).toContain(JSON.stringify(["henrik"]));
  });

  it("should round-trip labels/assignees as arrays via findByKey", async () => {
    mockRows = [
      {
        source_id: "trello-main",
        task_id: "card-1",
        title: "Do the thing",
        body: "details",
        url: "https://trello.com/c/card-1",
        state: "backlog",
        type: "implementation",
        complexity: null,
        priority: null,
        labels: ["bug"],
        assignees: ["henrik"],
        raw: null,
        created_at: new Date("2024-01-01"),
        updated_at: new Date("2024-01-02"),
      },
    ];

    const repo = makePostgresTaskRepository(new Pool());
    const found = await repo.findByKey("trello-main", "card-1");

    expect(found?.labels).toEqual(["bug"]);
    expect(found?.assignees).toEqual(["henrik"]);
    expect(Array.isArray(found?.labels)).toBe(true);
    expect(lastQuery).toContain("WHERE source_id = $1 AND task_id = $2");
  });

  it("should return undefined for unknown key", async () => {
    mockRows = [];
    const repo = makePostgresTaskRepository(new Pool());
    expect(await repo.findByKey("nope", "nope")).toBeUndefined();
  });

  it("should find by source", async () => {
    mockRows = [
      {
        source_id: "trello-main",
        task_id: "card-1",
        title: "Do the thing",
        body: "details",
        url: "https://trello.com/c/card-1",
        state: "backlog",
        type: "implementation",
        complexity: null,
        priority: null,
        labels: [],
        assignees: [],
        raw: null,
        created_at: new Date("2024-01-01"),
        updated_at: new Date("2024-01-02"),
      },
    ];

    const repo = makePostgresTaskRepository(new Pool());
    const found = await repo.findBySource("trello-main");

    expect(found).toHaveLength(1);
    expect(lastQuery).toContain("WHERE source_id = $1");
    expect(lastParams).toEqual(["trello-main"]);
  });
});
