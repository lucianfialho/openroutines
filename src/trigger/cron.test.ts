import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CronScheduler, InvalidCronError } from "./cron.js";
import type { Routine } from "../routine/types.js";
import type { Job, JobQueue } from "../queue/types.js";

let mockTasks: Array<{ cron: string; fn: () => void; options: unknown }> = [];
let mockValidate = vi.fn(() => true);

vi.mock("node-cron", () => ({
  schedule: vi.fn((cron: string, fn: () => void, options: unknown) => {
    mockTasks.push({ cron, fn, options });
    return {
      start: vi.fn(),
      stop: vi.fn(),
      destroy: vi.fn(),
    };
  }),
  validate: vi.fn((cron: string) => mockValidate(cron)),
}));

const makeQueue = (): JobQueue & { jobs: Job[] } => {
  const jobs: Job[] = [];
  return {
    jobs,
    enqueue: vi.fn(async (job) => {
      jobs.push(job);
    }),
  };
};

const makeFailingQueue = (error: Error): JobQueue => ({
  enqueue: vi.fn(() => Promise.reject(error)),
});

const makeRoutine = (id: string, cron: string): Routine => ({
  id,
  triggers: [{ type: "schedule", cron }],
  pipeline: { skill: "echo" },
});

describe("CronScheduler", () => {
  beforeEach(() => {
    mockTasks = [];
    mockValidate = vi.fn(() => true);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should schedule tasks for cron triggers", () => {
    const queue = makeQueue();
    const scheduler = new CronScheduler({
      routines: [
        makeRoutine("daily", "0 9 * * 1-5"),
        makeRoutine("weekly", "0 10 * * 1"),
      ],
      queue,
    });

    scheduler.start();

    expect(scheduler.runningTasks).toBe(2);
    expect(mockTasks).toHaveLength(2);
    expect(mockTasks[0].cron).toBe("0 9 * * 1-5");
    expect(mockTasks[1].cron).toBe("0 10 * * 1");
  });

  it("should skip non-cron triggers", () => {
    const queue = makeQueue();
    const scheduler = new CronScheduler({
      routines: [
        {
          id: "api-only",
          triggers: [{ type: "api" }],
          pipeline: { skill: "echo" },
        },
        makeRoutine("daily", "0 9 * * *"),
      ],
      queue,
    });

    scheduler.start();

    expect(scheduler.runningTasks).toBe(1);
    expect(mockTasks[0].cron).toBe("0 9 * * *");
  });

  it("should enqueue job when cron fires", async () => {
    const queue = makeQueue();
    const scheduler = new CronScheduler({
      routines: [makeRoutine("daily", "0 9 * * *")],
      queue,
    });

    scheduler.start();
    expect(mockTasks).toHaveLength(1);

    // Simulate cron firing
    await mockTasks[0].fn();

    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0].routineId).toBe("daily");
    expect(queue.jobs[0].trigger.type).toBe("schedule");
    expect(queue.jobs[0].trigger.payload).toEqual({
      cron: "0 9 * * *",
      routineId: "daily",
    });
  });

  it("should pass timezone to node-cron", () => {
    const queue = makeQueue();
    const scheduler = new CronScheduler({
      routines: [makeRoutine("daily", "0 9 * * *")],
      queue,
      timezone: "America/Sao_Paulo",
    });

    scheduler.start();

    expect(mockTasks[0].options).toEqual(
      expect.objectContaining({ timezone: "America/Sao_Paulo" })
    );
  });

  it("should stop all tasks on stop()", () => {
    const queue = makeQueue();
    const scheduler = new CronScheduler({
      routines: [
        makeRoutine("a", "0 9 * * *"),
        makeRoutine("b", "0 10 * * *"),
      ],
      queue,
    });

    scheduler.start();
    expect(scheduler.runningTasks).toBe(2);

    scheduler.stop();
    expect(scheduler.runningTasks).toBe(0);
  });

  it("should handle multiple cron triggers on same routine", () => {
    const queue = makeQueue();
    const scheduler = new CronScheduler({
      routines: [
        {
          id: "multi",
          triggers: [
            { type: "schedule", cron: "0 9 * * *" },
            { type: "schedule", cron: "0 18 * * *" },
          ],
          pipeline: { skill: "echo" },
        },
      ],
      queue,
    });

    scheduler.start();

    expect(scheduler.runningTasks).toBe(2);
    expect(mockTasks[0].cron).toBe("0 9 * * *");
    expect(mockTasks[1].cron).toBe("0 18 * * *");
  });

  it("should reject invalid cron expressions", () => {
    mockValidate = vi.fn(() => false);
    const queue = makeQueue();
    const scheduler = new CronScheduler({
      routines: [makeRoutine("bad", "not-a-cron")],
      queue,
    });

    expect(() => scheduler.start()).toThrow(InvalidCronError);
  });

  it("should reject double start", () => {
    const queue = makeQueue();
    const scheduler = new CronScheduler({
      routines: [makeRoutine("daily", "0 9 * * *")],
      queue,
    });

    scheduler.start();
    expect(() => scheduler.start()).toThrow("already started");
  });

  it("should survive enqueue errors without crashing", async () => {
    const queue = makeFailingQueue(new Error("Queue full"));
    const scheduler = new CronScheduler({
      routines: [makeRoutine("daily", "0 9 * * *")],
      queue,
    });

    scheduler.start();
    expect(mockTasks).toHaveLength(1);

    // Should not throw
    await expect(mockTasks[0].fn()).resolves.not.toThrow();
  });

  it("should use injected generateId", async () => {
    const queue = makeQueue();
    const scheduler = new CronScheduler({
      routines: [makeRoutine("daily", "0 9 * * *")],
      queue,
      generateId: () => "fixed-id-123",
    });

    scheduler.start();
    await mockTasks[0].fn();

    expect(queue.jobs[0].id).toBe("fixed-id-123");
  });
});
