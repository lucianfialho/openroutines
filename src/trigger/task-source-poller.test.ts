import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import { TaskSourcePoller } from "./task-source-poller.js";
import { makeInMemoryPollStateRepository } from "../persistence/poll-state-in-memory.js";
import { TaskSourceError } from "../task-source/types.js";
import type { Task, TaskSource } from "../task-source/types.js";
import type { Job, JobQueue } from "../queue/types.js";

// Capture setInterval/clearInterval registrations so ticks can be invoked
// deterministically, mirroring how cron.test.ts mocks node-cron's `schedule`
// to grab the callback instead of waiting on real/fake timers.
let capturedIntervals: Array<{ fn: () => Promise<void>; ms: number }> = [];
let clearedHandles: unknown[] = [];

const stubTimers = () => {
  capturedIntervals = [];
  clearedHandles = [];
  let nextHandle = 0;
  vi.stubGlobal(
    "setInterval",
    vi.fn((fn: () => Promise<void>, ms: number) => {
      capturedIntervals.push({ fn, ms });
      return ++nextHandle;
    })
  );
  vi.stubGlobal(
    "clearInterval",
    vi.fn((handle: unknown) => {
      clearedHandles.push(handle);
    })
  );
};

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  sourceId: "trello-main",
  id: "card-1",
  title: "Do the thing",
  body: "",
  url: "https://trello.com/c/card-1",
  state: "queued",
  type: "implementation",
  labels: [],
  assignees: [],
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-02"),
  ...overrides,
});

type WatchNewResult = { tasks: Task[]; cursor: string } | TaskSourceError;

/** TaskSource fake: watchNew replays a fixed sequence of results (repeats the last one past the end). */
const makeFakeTaskSource = (results: WatchNewResult[]): TaskSource & { watchNewCalls: Array<string | null> } => {
  const watchNewCalls: Array<string | null> = [];
  let call = 0;
  const notImplemented = () => Effect.fail(new TaskSourceError("not implemented in fake"));
  return {
    watchNewCalls,
    listQueue: notImplemented,
    getTask: notImplemented,
    comment: notImplemented,
    attachArtifact: notImplemented,
    moveTo: notImplemented,
    setClassification: notImplemented,
    watchNew: (cursor) => {
      watchNewCalls.push(cursor);
      const result = results[Math.min(call, results.length - 1)];
      call++;
      return result instanceof TaskSourceError ? Effect.fail(result) : Effect.succeed(result);
    },
  };
};

const makeQueue = (): JobQueue & { jobs: Job[] } => {
  const jobs: Job[] = [];
  return { jobs, enqueue: vi.fn(async (job) => { jobs.push(job); }) };
};

describe("TaskSourcePoller", () => {
  beforeEach(() => {
    stubTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should schedule one interval per source, in ms from pollIntervalMinutes", () => {
    const poller = new TaskSourcePoller({
      sources: [
        { sourceId: "trello-main", taskSource: makeFakeTaskSource([]), pollIntervalMinutes: 5 },
        { sourceId: "github-main", taskSource: makeFakeTaskSource([]), pollIntervalMinutes: 1 },
      ],
      queue: makeQueue(),
      pollState: makeInMemoryPollStateRepository(),
    });

    poller.start();

    expect(poller.runningPolls).toBe(2);
    expect(capturedIntervals).toHaveLength(2);
    expect(capturedIntervals[0].ms).toBe(5 * 60_000);
    expect(capturedIntervals[1].ms).toBe(1 * 60_000);
  });

  it("should stop all intervals on stop()", () => {
    const poller = new TaskSourcePoller({
      sources: [{ sourceId: "trello-main", taskSource: makeFakeTaskSource([]), pollIntervalMinutes: 5 }],
      queue: makeQueue(),
      pollState: makeInMemoryPollStateRepository(),
    });

    poller.start();
    expect(poller.runningPolls).toBe(1);

    poller.stop();
    expect(poller.runningPolls).toBe(0);
    expect(clearedHandles).toHaveLength(1);
  });

  it("should reject double start", () => {
    const poller = new TaskSourcePoller({
      sources: [{ sourceId: "trello-main", taskSource: makeFakeTaskSource([]), pollIntervalMinutes: 5 }],
      queue: makeQueue(),
      pollState: makeInMemoryPollStateRepository(),
    });

    poller.start();
    expect(() => poller.start()).toThrow("already started");
  });

  it("should enqueue exactly one job for a new task and advance the cursor", async () => {
    const task = makeTask({ id: "card-1" });
    const source = makeFakeTaskSource([{ tasks: [task], cursor: "cursor-1" }]);
    const queue = makeQueue();
    const pollState = makeInMemoryPollStateRepository();
    const poller = new TaskSourcePoller({
      sources: [{ sourceId: "trello-main", taskSource: source, pollIntervalMinutes: 5 }],
      queue,
      pollState,
      generateId: () => "job-1",
    });

    poller.start();
    await capturedIntervals[0].fn();

    expect(queue.jobs).toEqual([
      { id: "job-1", trigger: { type: "task_source", payload: { sourceId: "trello-main", task } } },
    ]);
    expect(await pollState.getCursor("trello-main")).toBe("cursor-1");
    expect(source.watchNewCalls).toEqual([null]); // first call: no cursor persisted yet
  });

  it("should NOT re-enqueue a task the source resends (dedupe via claimUnseen)", async () => {
    const task = makeTask({ id: "card-1" });
    const source = makeFakeTaskSource([
      { tasks: [task], cursor: "cursor-1" },
      { tasks: [task], cursor: "cursor-1" }, // source resent the same task (imprecise cursor)
    ]);
    const queue = makeQueue();
    const poller = new TaskSourcePoller({
      sources: [{ sourceId: "trello-main", taskSource: source, pollIntervalMinutes: 5 }],
      queue,
      pollState: makeInMemoryPollStateRepository(),
    });

    poller.start();
    await capturedIntervals[0].fn();
    await capturedIntervals[0].fn();

    expect(queue.jobs).toHaveLength(1);
  });

  it("should keep the previous cursor on watchNew failure and retry with it, without crashing", async () => {
    const task1 = makeTask({ id: "card-1" });
    const task2 = makeTask({ id: "card-2" });
    const source = makeFakeTaskSource([
      { tasks: [task1], cursor: "cursor-1" },
      new TaskSourceError("boom", "watchNew"),
      { tasks: [task2], cursor: "cursor-2" },
    ]);
    const queue = makeQueue();
    const pollState = makeInMemoryPollStateRepository();
    const poller = new TaskSourcePoller({
      sources: [{ sourceId: "trello-main", taskSource: source, pollIntervalMinutes: 5 }],
      queue,
      pollState,
    });

    poller.start();

    await capturedIntervals[0].fn();
    expect(await pollState.getCursor("trello-main")).toBe("cursor-1");

    // tick 2 fails: must not throw, and must not advance the cursor.
    await expect(capturedIntervals[0].fn()).resolves.not.toThrow();
    expect(await pollState.getCursor("trello-main")).toBe("cursor-1");

    // tick 3 succeeds again, retried with the SAME cursor as before the failure.
    await capturedIntervals[0].fn();
    expect(source.watchNewCalls).toEqual([null, "cursor-1", "cursor-1"]);
    expect(await pollState.getCursor("trello-main")).toBe("cursor-2");
    expect(queue.jobs.map((j) => (j.trigger.payload as { task: Task }).task.id)).toEqual(["card-1", "card-2"]);
  });

  it("should track cursor and seen state independently per source", async () => {
    const taskA = makeTask({ sourceId: "trello-main", id: "card-1" });
    const taskB = makeTask({ sourceId: "github-main", id: "issue-1" });
    const sourceA = makeFakeTaskSource([{ tasks: [taskA], cursor: "cursor-a" }]);
    const sourceB = makeFakeTaskSource([{ tasks: [taskB], cursor: "cursor-b" }]);
    const queue = makeQueue();
    const pollState = makeInMemoryPollStateRepository();
    const poller = new TaskSourcePoller({
      sources: [
        { sourceId: "trello-main", taskSource: sourceA, pollIntervalMinutes: 5 },
        { sourceId: "github-main", taskSource: sourceB, pollIntervalMinutes: 5 },
      ],
      queue,
      pollState,
    });

    poller.start();
    await capturedIntervals[0].fn();
    await capturedIntervals[1].fn();

    expect(queue.jobs).toHaveLength(2);
    expect(await pollState.getCursor("trello-main")).toBe("cursor-a");
    expect(await pollState.getCursor("github-main")).toBe("cursor-b");
  });

  it("should use injected generateId", async () => {
    const source = makeFakeTaskSource([{ tasks: [makeTask()], cursor: "cursor-1" }]);
    const queue = makeQueue();
    const poller = new TaskSourcePoller({
      sources: [{ sourceId: "trello-main", taskSource: source, pollIntervalMinutes: 5 }],
      queue,
      pollState: makeInMemoryPollStateRepository(),
      generateId: () => "fixed-id-123",
    });

    poller.start();
    await capturedIntervals[0].fn();

    expect(queue.jobs[0].id).toBe("fixed-id-123");
  });
});
