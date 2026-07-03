import { describe, it, expect } from "vitest";
import { makeInMemoryRepository } from "./in-memory.js";
import type { ExecutionRecord } from "./types.js";

describe("makeInMemoryRepository", () => {
  it("should save and find by id", async () => {
    const repo = makeInMemoryRepository();
    const record: ExecutionRecord = {
      id: "exec-1",
      routineId: "routine-a",
      triggerType: "api",
      skillName: "echo",
      status: "completed",
      startedAt: new Date("2024-01-01"),
    };

    await repo.save(record);
    const found = await repo.findById("exec-1");
    expect(found).toEqual(record);
  });

  it("should find by routine", async () => {
    const repo = makeInMemoryRepository();
    const r1: ExecutionRecord = {
      id: "exec-1",
      routineId: "routine-a",
      triggerType: "api",
      skillName: "echo",
      status: "completed",
      startedAt: new Date(),
    };
    const r2: ExecutionRecord = {
      id: "exec-2",
      routineId: "routine-a",
      triggerType: "api",
      skillName: "echo",
      status: "failed",
      startedAt: new Date(),
    };
    const r3: ExecutionRecord = {
      id: "exec-3",
      routineId: "routine-b",
      triggerType: "github",
      skillName: "review",
      status: "completed",
      startedAt: new Date(),
    };

    await repo.save(r1);
    await repo.save(r2);
    await repo.save(r3);

    const found = await repo.findByRoutine("routine-a");
    expect(found).toHaveLength(2);
    expect(found.map((r) => r.id)).toContain("exec-1");
    expect(found.map((r) => r.id)).toContain("exec-2");
  });

  it("should return undefined for unknown id", async () => {
    const repo = makeInMemoryRepository();
    const found = await repo.findById("nope");
    expect(found).toBeUndefined();
  });

  it("should find by task (sourceId, taskId) and round-trip the keys", async () => {
    const repo = makeInMemoryRepository();
    const tracked: ExecutionRecord = {
      id: "exec-1",
      routineId: "routine-a",
      triggerType: "task_source",
      skillName: "solve-issue",
      status: "completed",
      sourceId: "trello-main",
      taskId: "card-123",
      startedAt: new Date(),
    };
    const other: ExecutionRecord = {
      id: "exec-2",
      routineId: "routine-a",
      triggerType: "task_source",
      skillName: "solve-issue",
      status: "completed",
      sourceId: "trello-main",
      taskId: "card-999",
      startedAt: new Date(),
    };
    const legacy: ExecutionRecord = {
      id: "exec-3",
      routineId: "routine-b",
      triggerType: "github",
      skillName: "review",
      status: "completed",
      startedAt: new Date(),
    };

    await repo.save(tracked);
    await repo.save(other);
    await repo.save(legacy);

    const found = await repo.findByTask("trello-main", "card-123");
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe("exec-1");
    expect(found[0].sourceId).toBe("trello-main");
    expect(found[0].taskId).toBe("card-123");

    // Execution without sourceId/taskId is simply not matched, not a crash.
    expect(await repo.findByTask("trello-main", "missing")).toHaveLength(0);
    expect(await repo.findById("exec-3")).toEqual(legacy);
  });
});
