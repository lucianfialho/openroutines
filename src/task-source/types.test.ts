import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import {
  TASK_STATES,
  TASK_TYPES,
  TASK_COMPLEXITIES,
  TASK_SOURCE_METHODS,
  TaskSourceError,
} from "./types.js";
import type { Task, TaskSource } from "./types.js";

describe("TaskSourceError", () => {
  it("sets name, message and operation", () => {
    const err = new TaskSourceError("boom", "getTask");
    expect(err.name).toBe("TaskSourceError");
    expect(err.message).toBe("boom");
    expect(err.operation).toBe("getTask");
    expect(err).toBeInstanceOf(Error);
  });

  it("accepts the \"auth\" operation and an optional cause", () => {
    const cause = new Error("token expired");
    const err = new TaskSourceError("auth failed", "auth", cause);
    expect(err.operation).toBe("auth");
    expect(err.cause).toBe(cause);
  });

  it("allows operation and cause to be omitted", () => {
    const err = new TaskSourceError("generic failure");
    expect(err.operation).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });
});

describe("enum constants", () => {
  it("has the sizes the Zod schema (issue #2) derives its enums from", () => {
    expect(TASK_STATES.length).toBe(6);
    expect(TASK_TYPES.length).toBe(4);
    expect(TASK_COMPLEXITIES.length).toBe(6);
    expect(TASK_SOURCE_METHODS.length).toBe(7);
  });
});

// Type-only conformance check: this literal must implement all 7 TaskSource
// methods with the exact signatures declared in types.ts, or the file fails
// to compile. Bodies are fake — they only need to type-check.
const fakeSource: TaskSource = {
  listQueue: (_state) => Effect.fail(new TaskSourceError("not implemented", "listQueue")),
  getTask: (_id) => Effect.fail(new TaskSourceError("not implemented", "getTask")),
  comment: (_id, _body) => Effect.fail(new TaskSourceError("not implemented", "comment")),
  attachArtifact: (_id, _artifact) => Effect.fail(new TaskSourceError("not implemented", "attachArtifact")),
  moveTo: (_id, _state) => Effect.fail(new TaskSourceError("not implemented", "moveTo")),
  setClassification: (_id, _classification) =>
    Effect.fail(new TaskSourceError("not implemented", "setClassification")),
  watchNew: (_cursor) => Effect.fail(new TaskSourceError("not implemented", "watchNew")),
};

describe("TaskSource interface conformance", () => {
  it("runs a method from the typed literal and fails with TaskSourceError", async () => {
    const exit = await Effect.runPromiseExit(fakeSource.getTask("card-1"));
    expect(exit._tag).toBe("Failure");
  });

  it("keeps a Task literal assignable to the Task interface", () => {
    const task: Task = {
      sourceId: "trello-main",
      id: "card-1",
      title: "Fix bug",
      body: "details",
      url: "https://trello.com/c/card-1",
      state: "backlog",
      type: "implementation",
      labels: [],
      assignees: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(task.id).toBe("card-1");
  });
});
