import { describe, it, expect, vi, beforeEach } from "vitest";
import { Pool } from "pg";
import { makePostgresPollStateRepository } from "./poll-state-postgres.js";

// Stateful fake tables (not just a canned mockRows swap) so setCursor→getCursor
// and markSeen→hasSeen genuinely round-trip through the repository's own SQL.
let cursors: Map<string, string> = new Map();
let seen: Set<string> = new Set();
let lastQuery = "";
let lastParams: unknown[] = [];

vi.mock("pg", () => ({
  Pool: vi.fn(() => ({
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      lastQuery = sql;
      lastParams = params;

      if (sql.includes("INSERT INTO task_source_cursors")) {
        const [sourceId, cursor] = params as [string, string];
        cursors.set(sourceId, cursor);
        return { rows: [] };
      }
      if (sql.includes("SELECT cursor FROM task_source_cursors")) {
        const [sourceId] = params as [string];
        const cursor = cursors.get(sourceId);
        return { rows: cursor !== undefined ? [{ cursor }] : [] };
      }
      if (sql.includes("INSERT INTO task_source_seen")) {
        const [sourceId, taskId] = params as [string, string];
        seen.add(`${sourceId}|${taskId}`);
        return { rows: [] };
      }
      if (sql.includes("SELECT 1 FROM task_source_seen")) {
        const [sourceId, taskId] = params as [string, string];
        return { rows: seen.has(`${sourceId}|${taskId}`) ? [{ "?column?": 1 }] : [] };
      }
      throw new Error(`Unexpected query in test: ${sql}`);
    }),
  })),
}));

describe("makePostgresPollStateRepository", () => {
  beforeEach(() => {
    cursors = new Map();
    seen = new Set();
    lastQuery = "";
    lastParams = [];
    vi.clearAllMocks();
  });

  it("should return undefined cursor before it is ever set", async () => {
    const repo = makePostgresPollStateRepository(new Pool());
    expect(await repo.getCursor("trello-main")).toBeUndefined();
  });

  it("should round-trip setCursor/getCursor via ON CONFLICT upsert", async () => {
    const repo = makePostgresPollStateRepository(new Pool());

    await repo.setCursor("trello-main", "cursor-1");
    expect(lastQuery).toContain("INSERT INTO task_source_cursors");
    expect(lastQuery).toContain("ON CONFLICT (source_id) DO UPDATE");
    expect(lastParams).toEqual(["trello-main", "cursor-1"]);

    expect(await repo.getCursor("trello-main")).toBe("cursor-1");

    await repo.setCursor("trello-main", "cursor-2");
    expect(await repo.getCursor("trello-main")).toBe("cursor-2");
  });

  it("should round-trip markSeen/hasSeen via ON CONFLICT DO NOTHING", async () => {
    const repo = makePostgresPollStateRepository(new Pool());

    expect(await repo.hasSeen("trello-main", "card-1")).toBe(false);

    await repo.markSeen("trello-main", "card-1");
    expect(lastQuery).toContain("INSERT INTO task_source_seen");
    expect(lastQuery).toContain("ON CONFLICT (source_id, task_id) DO NOTHING");

    expect(await repo.hasSeen("trello-main", "card-1")).toBe(true);
    expect(await repo.hasSeen("trello-main", "card-2")).toBe(false);
  });

  it("should keep cursors isolated per sourceId", async () => {
    const repo = makePostgresPollStateRepository(new Pool());

    await repo.setCursor("trello-main", "cursor-a");
    await repo.setCursor("github-main", "cursor-b");

    expect(await repo.getCursor("trello-main")).toBe("cursor-a");
    expect(await repo.getCursor("github-main")).toBe("cursor-b");
  });
});
