/**
 * run.ts orchestration tests (F3 #147): lock/claim/budget already have real-DB
 * tests of their own (Wave A) — this focuses on runNightCycle's OWN wiring
 * (lock-null abort, caps respected, card -> enqueue shape) against a mocked
 * pool/registry/queue, per the Wave D spec.
 */
import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { runNightCycle, type RunNightCycleDeps } from "./run.js";
import { makeInMemoryPrLinkRepository } from "../persistence/pr-links-in-memory.js";
import type { RepoRegistry } from "../repo-registry/schema.js";
import type { JobQueue, Job } from "../queue/types.js";
import type { ExecutionProcessRepository, ExecutionRepository } from "../persistence/types.js";

const registry: RepoRegistry = {
  repos: {
    "acme-widgets": {
      clonePath: "/tmp/acme-widgets",
      githubRepo: "acme/widgets",
      baseBranch: "development",
      verify: { build: "true", test: "true" },
    },
    "beta-app": {
      clonePath: "/tmp/beta-app",
      githubRepo: "acme/beta",
      baseBranch: "development",
      verify: { build: "true", test: "true" },
    },
  },
};

const cardBody = (repo: string) => `# Conceito\nAlgo a fazer\n\n## Repositório\n${repo}\n\n## Objetivo\nFazer\n`;

interface MockTask {
  source_id: string;
  task_id: string;
  body: string;
  labels: string[];
}

const makeMockPool = (opts: {
  lockGranted?: boolean;
  queuedTasks?: MockTask[];
  busyRepos?: string[];
  taskContent?: Record<string, { title: string; body: string }>;
}) => {
  const queuedTasks = opts.queuedTasks ?? [];
  const claimedKeys = new Set<string>();
  const insertedExecutions: unknown[][] = [];
  let hardStopQueried = false;

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, " ").trim();
    if (text.startsWith("INSERT INTO night_runs")) {
      return opts.lockGranted === false ? { rows: [] } : { rows: [{ id: "night-1" }] };
    }
    if (text.startsWith("SELECT source_id, task_id, body, labels")) {
      return { rows: queuedTasks.filter((t) => !claimedKeys.has(`${t.source_id}:${t.task_id}`)) };
    }
    if (text.startsWith("UPDATE tasks SET claimed_by_night_id")) {
      const [, sourceId, taskId] = params as [string, string, string];
      const key = `${sourceId}:${taskId}`;
      if (claimedKeys.has(key)) return { rows: [] };
      claimedKeys.add(key);
      return { rows: [{ source_id: sourceId, task_id: taskId }] };
    }
    if (text.startsWith("SELECT DISTINCT repo FROM executions")) {
      return { rows: (opts.busyRepos ?? []).map((r) => ({ repo: r })) };
    }
    if (text.startsWith("SELECT title, body FROM tasks")) {
      const [sourceId, taskId] = params as [string, string];
      const content = opts.taskContent?.[`${sourceId}:${taskId}`];
      return { rows: content ? [content] : [{ title: "", body: "" }] };
    }
    if (text.startsWith("INSERT INTO executions")) {
      insertedExecutions.push(params);
      return { rows: [] };
    }
    if (text.startsWith("SELECT id FROM executions WHERE status")) {
      hardStopQueried = true;
      return { rows: [] };
    }
    return { rows: [] };
  });

  return {
    query,
    insertedExecutions,
    claimedKeys,
    hardStopQueried: () => hardStopQueried,
  };
};

const makeFakeQueue = (): JobQueue & { jobs: Job[] } => {
  const jobs: Job[] = [];
  return { enqueue: async (job) => { jobs.push(job); }, jobs };
};

const makeFakeProcessRepo = (): ExecutionProcessRepository => ({
  save: async () => {},
  markFinished: async () => {},
  findRunning: async () => [],
});

const makeFakeExecutionRepo = (): ExecutionRepository => ({
  save: async () => {},
  findById: async () => undefined,
  findByRoutine: async () => [],
  findByTask: async () => [],
  findAll: async () => [],
});

const noopGithub = vi.fn(() => ({ listPullRequests: () => Effect.succeed([]) })) as unknown as RunNightCycleDeps["makeGithub"];

const baseDeps = (pool: ReturnType<typeof makeMockPool>, overrides: Partial<RunNightCycleDeps> = {}): RunNightCycleDeps => ({
  pool: pool as unknown as RunNightCycleDeps["pool"],
  registry,
  queue: makeFakeQueue(),
  executionRepo: makeFakeExecutionRepo(),
  executionProcessRepo: makeFakeProcessRepo(),
  prLinks: makeInMemoryPrLinkRepository(),
  githubToken: "gh_test",
  nightWindowStart: "01:00",
  nightWindowEnd: "06:30",
  nightBudgetUsd: 30,
  nightPrCap: 6,
  nightParallelism: 2,
  tz: "UTC",
  runGit: vi.fn(async () => ({ stdout: "", stderr: "" })),
  makeGithub: noopGithub,
  now: () => new Date("2026-01-01T03:00:00Z"), // inside the default 01:00-06:30 window
  ...overrides,
});

describe("runNightCycle", () => {
  it("aborts when the night is already locked by another run", async () => {
    const pool = makeMockPool({ lockGranted: false });
    const queue = makeFakeQueue();
    const deps = baseDeps(pool, { queue });

    const summary = await runNightCycle(deps);

    expect(summary).toEqual({ started: false, reason: "locked" });
    expect(queue.jobs).toHaveLength(0);
    expect(deps.runGit).not.toHaveBeenCalled(); // abort happens before any other side effect
  });

  it("claims and enqueues a card, creating a card-execution job with the expected payload shape", async () => {
    const pool = makeMockPool({
      lockGranted: true,
      queuedTasks: [{ source_id: "trello-main", task_id: "card1", body: cardBody("acme-widgets"), labels: [] }],
      taskContent: { "trello-main:card1": { title: "Fix the bug", body: cardBody("acme-widgets") } },
    });
    const queue = makeFakeQueue();
    const deps = baseDeps(pool, { queue });

    const summary = await runNightCycle(deps);

    expect(summary.started).toBe(true);
    expect(summary.nightId).toBe("night-1");
    expect(summary.cardsClaimed).toBe(1);
    expect(summary.cardsEnqueued).toBe(1);

    expect(queue.jobs).toHaveLength(1);
    const job = queue.jobs[0];
    expect(job.trigger.type).toBe("card-execution");
    expect(job.trigger.executionId).toBe(job.id);
    expect(job.trigger.payload).toMatchObject({
      source_id: "trello-main",
      task_id: "card1",
      repo: "acme-widgets",
      title: "Fix the bug",
      night_id: "night-1",
      skill: "card-to-pr",
    });
    expect(pool.insertedExecutions).toHaveLength(1);
  });

  it("respects the global PR cap: stops claiming once pr_links already has nightPrCap open", async () => {
    const prLinks = makeInMemoryPrLinkRepository();
    for (let i = 0; i < 6; i++) {
      await prLinks.create({ sourceId: "s", taskId: `t${i}`, repo: "acme-widgets", branch: `b${i}`, status: "open" });
    }
    const pool = makeMockPool({
      lockGranted: true,
      queuedTasks: [{ source_id: "trello-main", task_id: "card1", body: cardBody("acme-widgets"), labels: [] }],
    });
    const queue = makeFakeQueue();
    const deps = baseDeps(pool, { queue, prLinks, nightPrCap: 6 });

    const summary = await runNightCycle(deps);

    expect(summary.cardsClaimed).toBe(0);
    expect(summary.cardsEnqueued).toBe(0);
    expect(queue.jobs).toHaveLength(0);
  });

  it("claims a card but skips enqueueing it when per-repo backpressure denies (leaves it claimed, notes it)", async () => {
    const openPrs = [
      { number: 1, title: "a", url: "u1", state: "OPEN", headRefName: "openroutines/card-a" },
      { number: 2, title: "b", url: "u2", state: "OPEN", headRefName: "openroutines/card-b" },
      { number: 3, title: "c", url: "u3", state: "OPEN", headRefName: "openroutines/card-c" },
    ];
    const makeGithub = vi.fn(() => ({ listPullRequests: () => Effect.succeed(openPrs) })) as unknown as RunNightCycleDeps["makeGithub"];
    const pool = makeMockPool({
      lockGranted: true,
      queuedTasks: [{ source_id: "trello-main", task_id: "card1", body: cardBody("acme-widgets"), labels: [] }],
    });
    const queue = makeFakeQueue();
    const deps = baseDeps(pool, { queue, makeGithub });

    const summary = await runNightCycle(deps);

    expect(summary.cardsClaimed).toBe(1); // the atomic claim happened...
    expect(summary.cardsEnqueued).toBe(0); // ...but backpressure blocked enqueue
    expect(queue.jobs).toHaveLength(0);
    expect(pool.claimedKeys.has("trello-main:card1")).toBe(true);
  });

  it("skips a card whose repo cannot be resolved from labels or body", async () => {
    const pool = makeMockPool({
      lockGranted: true,
      queuedTasks: [{ source_id: "trello-main", task_id: "card1", body: "no repo field here", labels: ["bug"] }],
    });
    const queue = makeFakeQueue();
    const deps = baseDeps(pool, { queue });

    const summary = await runNightCycle(deps);

    expect(summary.cardsClaimed).toBe(0);
    expect(summary.cardsEnqueued).toBe(0);
  });

  it("resolves the repo from a label when it names a registry key", async () => {
    const pool = makeMockPool({
      lockGranted: true,
      queuedTasks: [{ source_id: "trello-main", task_id: "card1", body: "no field", labels: ["beta-app"] }],
      taskContent: { "trello-main:card1": { title: "t", body: "no field" } },
    });
    const queue = makeFakeQueue();
    const deps = baseDeps(pool, { queue });

    const summary = await runNightCycle(deps);

    expect(summary.cardsEnqueued).toBe(1);
    expect((queue.jobs[0].trigger.payload as { repo: string }).repo).toBe("beta-app");
  });

  it("never claims two cards of the same repo in one batch (same-repo-in-series)", async () => {
    const pool = makeMockPool({
      lockGranted: true,
      queuedTasks: [
        { source_id: "trello-main", task_id: "card1", body: cardBody("acme-widgets"), labels: [] },
        { source_id: "trello-main", task_id: "card2", body: cardBody("acme-widgets"), labels: [] },
      ],
    });
    const queue = makeFakeQueue();
    const deps = baseDeps(pool, { queue, nightParallelism: 2 });

    const summary = await runNightCycle(deps);

    // Batch 1 claims card1 only (card2 shares the repo); batch 2 then claims card2.
    expect(summary.cardsClaimed).toBe(2);
    expect(summary.cardsEnqueued).toBe(2);
  });

  it("skips repos already running this night (busyRepos)", async () => {
    const pool = makeMockPool({
      lockGranted: true,
      queuedTasks: [{ source_id: "trello-main", task_id: "card1", body: cardBody("acme-widgets"), labels: [] }],
      busyRepos: ["acme-widgets"],
    });
    const queue = makeFakeQueue();
    const deps = baseDeps(pool, { queue });

    const summary = await runNightCycle(deps);

    expect(summary.cardsClaimed).toBe(0);
    expect(queue.jobs).toHaveLength(0);
  });

  it("hard-stops when the window has already closed, without ever attempting to claim", async () => {
    const pool = makeMockPool({ lockGranted: true, queuedTasks: [] });
    const queue = makeFakeQueue();
    const deps = baseDeps(pool, {
      queue,
      now: () => new Date("2026-01-01T07:00:00Z"), // past 06:30
    });

    const summary = await runNightCycle(deps);

    expect(summary.started).toBe(true);
    expect(summary.cardsClaimed).toBe(0);
    expect(pool.hardStopQueried()).toBe(true);
  });

  it("does NOT hard-stop when the backlog simply drains inside the window", async () => {
    const pool = makeMockPool({ lockGranted: true, queuedTasks: [] });
    const queue = makeFakeQueue();
    const deps = baseDeps(pool, { queue }); // now() is 03:00, well inside 01:00-06:30

    await runNightCycle(deps);

    expect(pool.hardStopQueried()).toBe(false);
  });
});
