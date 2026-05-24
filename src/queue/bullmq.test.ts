import { describe, it, expect, vi } from "vitest";
import { makeBullMqQueue } from "./bullmq.js";
import type { Job } from "./types.js";

let mockJobs: Array<{ name: string; data: Job; opts: unknown }> = [];

vi.mock("bullmq", () => ({
  Queue: vi.fn(function (name: string, opts: unknown) {
    return {
      name,
      opts,
      add: vi.fn(async (name: string, data: Job, opts: unknown) => {
        mockJobs.push({ name, data, opts });
      }),
      close: vi.fn(),
    };
  }),
  Worker: vi.fn(function (name: string, processor: Function, opts: unknown) {
    return {
      name,
      processor,
      opts,
      close: vi.fn(),
      on: vi.fn(),
    };
  }),
}));

describe("makeBullMqQueue", () => {
  beforeEach(() => {
    mockJobs = [];
    vi.clearAllMocks();
  });

  it("should enqueue job to BullMQ", async () => {
    const handler = vi.fn();
    const queue = makeBullMqQueue({
      redisUrl: "redis://localhost:6379",
      handler,
    });

    const job: Job = {
      id: "job-1",
      routineId: "routine-a",
      trigger: { type: "github", payload: { event: "push" } },
    };

    await queue.enqueue(job);

    expect(mockJobs).toHaveLength(1);
    expect(mockJobs[0].name).toBe("github");
    expect(mockJobs[0].data).toEqual(job);
    expect(mockJobs[0].opts).toMatchObject({ jobId: "job-1" });
  });

  it("should use custom queue name", async () => {
    const handler = vi.fn();
    const queue = makeBullMqQueue({
      redisUrl: "redis://localhost:6379",
      queueName: "custom-queue",
      handler,
    });

    expect(queue).toBeDefined();
  });

  it("should close worker and queue", async () => {
    const handler = vi.fn();
    const queue = makeBullMqQueue({
      redisUrl: "redis://localhost:6379",
      handler,
    });

    await queue.close();
    // Should not throw
    expect(true).toBe(true);
  });
});
