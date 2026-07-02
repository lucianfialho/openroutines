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
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

export const cleanupZombieProcesses = async (
  repo: ExecutionProcessRepository
): Promise<{ checked: number; killed: number; cleaned: number }> => {
  const running = await repo.findRunning();
  let killed = 0;
  for (const proc of running) {
    if (isProcessAlive(proc.pid)) {
      try {
        process.kill(-proc.pid, "SIGKILL"); // negative pid == whole process group
        killed++;
      } catch {
        // already gone between the liveness check and the kill — fine
      }
    }
    await repo.markFinished(proc.id!, new Date());
  }
  return { checked: running.length, killed, cleaned: running.length };
};
