import { describe, it, expect, vi, beforeEach } from "vitest";
import { Queue, Worker } from "bullmq";
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
  Worker: vi.fn(function (name: string, processor: (job: unknown) => Promise<unknown>, opts: unknown) {
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

  it("AC1 (#149): configures defaultJobOptions.attempts = 1 — retries are the orchestrator's decision, never BullMQ's", async () => {
    const handler = vi.fn();
    makeBullMqQueue({
      redisUrl: "redis://localhost:6379",
      handler,
    });

    expect(Queue).toHaveBeenCalledTimes(1);
    const opts = (Queue as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      defaultJobOptions: { attempts: number };
    };
    expect(opts.defaultJobOptions.attempts).toBe(1);
  });

  it("stalled-job fix (prod incident 07/jul): worker lockDuration outlasts a long card-execution run", async () => {
    const handler = vi.fn();
    makeBullMqQueue({
      redisUrl: "redis://localhost:6379",
      handler,
    });

    expect(Worker).toHaveBeenCalledTimes(1);
    const opts = (Worker as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2] as {
      lockDuration: number;
    };
    // Must clear the longest single provider call (claude-cli.ts DEFAULT_TIMEOUT_MS = 25min)
    // with room for a full state machine run, not just one call.
    expect(opts.lockDuration).toBeGreaterThan(25 * 60 * 1000);
  });

  it("stalled-job fix (prod incident 07/jul): maxStalledCount 0 fails a stalled job instead of letting BullMQ re-run it", async () => {
    const handler = vi.fn();
    makeBullMqQueue({
      redisUrl: "redis://localhost:6379",
      handler,
    });

    const opts = (Worker as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2] as {
      maxStalledCount: number;
    };
    expect(opts.maxStalledCount).toBe(0);
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
