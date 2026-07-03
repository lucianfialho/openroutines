import { describe, it, expect } from "vitest";
import { makeInMemoryTaskRepository } from "./task-in-memory.js";
import type { Task } from "../task-source/types.js";

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

describe("makeInMemoryTaskRepository", () => {
  it("should save and find by key", async () => {
    const repo = makeInMemoryTaskRepository();
    const task = makeTask();

    await repo.save(task);
    const found = await repo.findByKey("trello-main", "card-1");
    expect(found).toEqual(task);
  });

  it("should upsert by (sourceId, id) instead of duplicating", async () => {
    const repo = makeInMemoryTaskRepository();

    await repo.save(makeTask({ title: "Original" }));
    await repo.save(makeTask({ title: "Updated" }));

    const found = await repo.findByKey("trello-main", "card-1");
    expect(found?.title).toBe("Updated");
    expect(await repo.findBySource("trello-main")).toHaveLength(1);
  });

  it("should find by source", async () => {
    const repo = makeInMemoryTaskRepository();

    await repo.save(makeTask({ sourceId: "trello-main", id: "card-1" }));
    await repo.save(makeTask({ sourceId: "trello-main", id: "card-2" }));
    await repo.save(makeTask({ sourceId: "github-main", id: "issue-1" }));

    const found = await repo.findBySource("trello-main");
    expect(found).toHaveLength(2);
    expect(found.map((t) => t.id).sort()).toEqual(["card-1", "card-2"]);
  });

  it("should return undefined for unknown key", async () => {
    const repo = makeInMemoryTaskRepository();
    expect(await repo.findByKey("nope", "nope")).toBeUndefined();
  });
});
