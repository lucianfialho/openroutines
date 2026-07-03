import { describe, it, expect, vi } from "vitest";
import { reconcileOrphanedExecutions, resetWorktreeHard, isUnderBase } from "./boot-reconciliation.js";
import { makeInMemoryRepository } from "../persistence/in-memory.js";
import type { ExecutionRecord } from "../persistence/types.js";

const runningExec = (id: string, currentState: string, worktreePath?: string): ExecutionRecord => ({
  id,
  routineId: "night-run",
  triggerType: "card-execution",
  skillName: "card-to-pr",
  status: "running",
  startedAt: new Date(),
  metadata: {
    stateMachineContext: {
      currentState,
      inputs: {},
      outputs: worktreePath ? { preparacao: { worktree: { path: worktreePath } } } : {},
    },
  },
});

type Job = { id: string; trigger: { executionId: string } };

describe("reconcileOrphanedExecutions", () => {
  it("recovers a running execution: resets its worktree and re-enqueues with the same executionId (AC4)", async () => {
    const repo = makeInMemoryRepository();
    await repo.save(runningExec("e1", "verify", "/tmp/or-worktrees/card-x"));
    await repo.save({ ...runningExec("e2", "plano"), status: "completed" }); // not running → untouched
    const enqueued: Job[] = [];
    const reset = vi.fn(async () => {});

    const res = await reconcileOrphanedExecutions({
      executionRepo: repo,
      queue: { enqueue: async (j) => void enqueued.push(j as Job) },
      resetWorktree: reset,
    });

    expect(res.resumed).toEqual(["e1"]);
    expect(reset).toHaveBeenCalledWith("/tmp/or-worktrees/card-x");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].id).toBe("e1");
    expect(enqueued[0].trigger.executionId).toBe("e1"); // resume keys off this
  });

  it("re-enqueues an execution that crashed before a worktree existed, without resetting", async () => {
    const repo = makeInMemoryRepository();
    await repo.save(runningExec("e3", "preparacao")); // no worktree path in context
    const reset = vi.fn(async () => {});
    const enqueued: Job[] = [];

    const res = await reconcileOrphanedExecutions({
      executionRepo: repo,
      queue: { enqueue: async (j) => void enqueued.push(j as Job) },
      resetWorktree: reset,
    });

    expect(res.resumed).toEqual(["e3"]);
    expect(reset).not.toHaveBeenCalled();
    expect(enqueued).toHaveLength(1);
  });

  it("marks an execution `failed` (not resumed) and does not enqueue when its reset throws", async () => {
    const repo = makeInMemoryRepository();
    await repo.save(runningExec("e4", "implementacao", "/tmp/or-worktrees/card-y"));
    const enqueued: Job[] = [];

    const res = await reconcileOrphanedExecutions({
      executionRepo: repo,
      queue: { enqueue: async (j) => void enqueued.push(j as Job) },
      resetWorktree: async () => {
        throw new Error("dirty");
      },
    });

    expect(res.failed).toEqual(["e4"]);
    expect(res.resumed).toEqual([]);
    expect(enqueued).toHaveLength(0);
  });
});

describe("resetWorktreeHard safety fence", () => {
  it("isUnderBase accepts a child path and rejects escapes / the base itself", () => {
    expect(isUnderBase("/tmp/or-worktrees/card-x", "/tmp/or-worktrees")).toBe(true);
    expect(isUnderBase("/tmp/or-worktrees", "/tmp/or-worktrees")).toBe(false); // not strictly inside
    expect(isUnderBase("/etc/passwd", "/tmp/or-worktrees")).toBe(false);
    expect(isUnderBase("/tmp/or-worktrees/../../etc", "/tmp/or-worktrees")).toBe(false);
  });

  it("refuses to reset a path outside the worktree base — never touches a real clone", async () => {
    await expect(
      resetWorktreeHard("/home/openroutines/repos/openroutines", "/tmp/or-worktrees")
    ).rejects.toThrow(/outside worktree base/);
  });
});
