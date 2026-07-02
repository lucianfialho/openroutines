/**
 * PostgreSQL Execution Process Repository
 *
 * Tracks OS processes spawned by CLI-based providers (claude-cli) so a
 * per-call timeout can kill the whole process group and a boot-time sweep
 * can reap zombies left by a crashed orchestrator (F1 #137).
 */

import { Pool } from "pg";
import type { ExecutionProcess, ExecutionProcessRepository } from "./types.js";

export const makePostgresExecutionProcessRepository = (pool: Pool): ExecutionProcessRepository => {
  const save = async (proc: ExecutionProcess): Promise<void> => {
    await pool.query(
      `INSERT INTO execution_processes (
        id, execution_id, pid, worktree, started_at, finished_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        pid = EXCLUDED.pid,
        worktree = EXCLUDED.worktree,
        finished_at = EXCLUDED.finished_at`,
      [
        proc.id ?? crypto.randomUUID(),
        proc.executionId,
        proc.pid,
        proc.worktree ?? null,
        proc.startedAt ?? new Date(),
        proc.finishedAt ?? null,
      ]
    );
  };

  const markFinished = async (id: string, finishedAt: Date): Promise<void> => {
    await pool.query(`UPDATE execution_processes SET finished_at = $2 WHERE id = $1`, [id, finishedAt]);
  };

  const findRunning = async (): Promise<ExecutionProcess[]> => {
    const result = await pool.query(`SELECT * FROM execution_processes WHERE finished_at IS NULL`);
    return result.rows.map(rowToExecutionProcess);
  };

  return { save, markFinished, findRunning };
};

const rowToExecutionProcess = (row: Record<string, unknown>): ExecutionProcess => ({
  id: row.id as string,
  executionId: row.execution_id as string,
  pid: row.pid as number,
  worktree: (row.worktree as string) ?? undefined,
  startedAt: (row.started_at as Date) ?? undefined,
  finishedAt: (row.finished_at as Date) ?? undefined,
});
