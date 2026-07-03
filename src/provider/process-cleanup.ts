/**
 * Zombie Process Cleanup
 *
 * Run once at boot: any execution_processes row still open (finished_at IS
 * NULL) belongs to a process from a previous, now-dead orchestrator run —
 * kill its group if still alive and mark the row finished either way
 * (F1 #137).
 */

import type { ExecutionProcessRepository } from "../persistence/types.js";

/** `process.kill(pid, 0)` sends no signal, only checks liveness/permission. ESRCH means "no such process". */
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code !== "ESRCH";
  }
};

/**
 * Kill a live process group by pid. Guard pid > 1: never signal group 0 (whole
 * session) or init. A stored pid from a dead run can also be recycled onto an
 * unrelated process — a full fix needs a start-time/boot-id identity check
 * (tracked for F6 hardening); until then this bounds the worst case. Returns
 * true if a signal was actually sent.
 */
const killGroupIfAlive = (pid: number): boolean => {
  if (pid > 1 && isProcessAlive(pid)) {
    try {
      process.kill(-pid, "SIGKILL"); // negative pid == whole process group
      return true;
    } catch {
      // already gone between the liveness check and the kill — fine (ESRCH)
    }
  }
  return false;
};

export const cleanupZombieProcesses = async (
  repo: ExecutionProcessRepository
): Promise<{ checked: number; killed: number; cleaned: number }> => {
  const running = await repo.findRunning();
  let killed = 0;
  for (const proc of running) {
    if (killGroupIfAlive(proc.pid)) killed++;
    await repo.markFinished(proc.id!, new Date());
  }
  return { checked: running.length, killed, cleaned: running.length };
};

/**
 * Kill the process group(s) of ONE execution and mark their rows finished.
 * Used by boot reconciliation (F3 #149) and the night-run hard stop (F3 #147),
 * where the target is a specific orphaned/timed-out execution, not a global sweep.
 * Swallows ESRCH (process already gone).
 */
export const killExecutionProcessGroup = async (
  executionId: string,
  repo: ExecutionProcessRepository
): Promise<void> => {
  const procs = (await repo.findRunning()).filter((p) => p.executionId === executionId);
  for (const proc of procs) {
    killGroupIfAlive(proc.pid);
    await repo.markFinished(proc.id!, new Date());
  }
};
