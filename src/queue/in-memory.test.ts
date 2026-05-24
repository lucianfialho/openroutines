import { describe, it, expect } from "vitest";
import { makeInMemoryQueue } from "./in-memory.js";
import type { Job } from "./types.js";

describe("makeInMemoryQueue", () => {
  it("should call handler when job is enqueued", async () => {
    const handled: Job[] = [];
    const queue = makeInMemoryQueue(async (job) => {
      handled.push(job);
    });

    const job: Job = {
      id: "job-1",
      routineId: "routine-a",
      trigger: { type: "schedule", payload: {} },
    };

    await queue.enqueue(job);
    expect(handled).toHaveLength(1);
    expect(handled[0]).toEqual(job);
  });

  it("should support sync handler", async () => {
    const handled: Job[] = [];
    const queue = makeInMemoryQueue((job) => {
      handled.push(job);
    });

    const job: Job = {
      id: "job-2",
      routineId: "routine-b",
      trigger: { type: "api", payload: {} },
    };

    await queue.enqueue(job);
    expect(handled).toHaveLength(1);
  });
});
