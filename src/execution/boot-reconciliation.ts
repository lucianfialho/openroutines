/**
 * Boot reconciliation (F3 #149).
 *
 * Executions left `running` by a crashed orchestrator are recovered at boot:
 * kill any surviving process group, reset the worktree to discard the
 * interrupted phase's partial edits, and re-enqueue with the SAME executionId so
 * runStateMachine resumes from the persisted phase frontier
 * (metadata.stateMachineContext.currentState). The action_ledger keeps the
 * external effects already fired (PR/comment/card move) from repeating.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative, isAbsolute } from "node:path";
import type {
  ExecutionRepository,
  ExecutionProcessRepository,
  ExecutionRecord,
} from "../persistence/types.js";
import type { Job } from "../queue/types.js";
import { killExecutionProcessGroup } from "../provider/process-cleanup.js";

const execFileAsync = promisify(execFile);

/** True iff `target` resolves to a path strictly inside `base` (no `..` escape). */
export const isUnderBase = (target: string, base: string): boolean => {
  const rel = relative(resolve(base), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * The system's ONLY `git reset --hard` / `git clean`. It runs strictly inside a
 * disposable worktree — scoped with `git -C <worktreePath>` and fenced to
 * WORKTREE_BASE so a misconfigured path can never wipe a real clone.
 */
export const resetWorktreeHard = async (
  worktreePath: string,
  worktreeBase?: string
): Promise<void> => {
  // Fail CLOSED: with no base configured the fence cannot be evaluated, so we
  // refuse rather than run reset --hard unfenced (a missing WORKTREE_BASE in the
  // env must never silently disable the one guard protecting real clones).
  if (!worktreeBase || !isUnderBase(worktreePath, worktreeBase)) {
    throw new Error(
      `refuse to reset ${worktreePath}: not inside worktree base ${worktreeBase ?? "(unset)"}`
    );
  }
  await execFileAsync("git", ["-C", worktreePath, "reset", "--hard", "HEAD"]);
  await execFileAsync("git", ["-C", worktreePath, "clean", "-fd"]);
};

export interface ReconcileDeps {
  executionRepo: ExecutionRepository;
  queue: { enqueue: (job: Job) => Promise<void> };
  executionProcessRepo?: ExecutionProcessRepository;
  /** Injectable for tests; defaults to resetWorktreeHard fenced by worktreeBase. */
  resetWorktree?: (worktreePath: string) => Promise<void>;
  worktreeBase?: string;
}

const worktreePathOf = (exec: ExecutionRecord): string | undefined => {
  const ctx = exec.metadata?.stateMachineContext as
    | { outputs?: { preparacao?: { worktree?: { path?: string } } } }
    | undefined;
  const p = ctx?.outputs?.preparacao?.worktree?.path;
  return typeof p === "string" && p.length > 0 ? p : undefined;
};

export const reconcileOrphanedExecutions = async (
  deps: ReconcileDeps
): Promise<{ resumed: string[]; failed: string[] }> => {
  const orphaned = await deps.executionRepo.findAll({ status: "running", limit: 1000 });
  const reset = deps.resetWorktree ?? ((p: string) => resetWorktreeHard(p, deps.worktreeBase));
  const resumed: string[] = [];
  const failed: string[] = [];

  for (const exec of orphaned) {
    try {
      if (deps.executionProcessRepo) {
        await killExecutionProcessGroup(exec.id, deps.executionProcessRepo);
      }
      const wt = worktreePathOf(exec);
      // No worktree yet (crashed before preparacao created one) → nothing to reset.
      if (wt) await reset(wt);

      // Same shape as the /executions/:id/resume path — trigger.executionId makes
      // the queue handler rehydrate stateMachineContext and resume mid-pipeline.
      await deps.queue.enqueue({
        id: exec.id,
        routineId: exec.routineId,
        trigger: { type: exec.triggerType, payload: {}, executionId: exec.id },
      });
      resumed.push(exec.id);
    } catch (err) {
      console.error(`[Reconcile] Failed to recover execution ${exec.id}:`, err);
      failed.push(exec.id);
    }
  }

  return { resumed, failed };
};
