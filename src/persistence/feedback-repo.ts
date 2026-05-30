/**
 * Feedback Repository — PostgreSQL
 *
 * Stores human feedback and annotations on executions.
 */

import { Pool } from "pg";
import type { ExecutionFeedback, FeedbackRepository } from "./types.js";

export const makePostgresFeedbackRepository = (pool: Pool): FeedbackRepository => {
  const save = async (feedback: ExecutionFeedback): Promise<void> => {
    await pool.query(
      `INSERT INTO execution_feedback (
        id, execution_id, rating, tags, notes, created_by, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (execution_id) DO UPDATE SET
        rating = EXCLUDED.rating,
        tags = EXCLUDED.tags,
        notes = EXCLUDED.notes,
        created_by = EXCLUDED.created_by,
        created_at = EXCLUDED.created_at`,
      [
        feedback.id ?? crypto.randomUUID(),
        feedback.executionId,
        feedback.rating ?? null,
        feedback.tags ?? null,
        feedback.notes ?? null,
        feedback.createdBy ?? null,
        feedback.createdAt ?? new Date(),
      ]
    );
  };

  const findByExecution = async (executionId: string): Promise<ExecutionFeedback | undefined> => {
    const result = await pool.query(
      `SELECT * FROM execution_feedback WHERE execution_id = $1`,
      [executionId]
    );
    if (result.rows.length === 0) return undefined;
    return rowToFeedback(result.rows[0]);
  };

  const findAll = async (opts?: { limit?: number; offset?: number }): Promise<ExecutionFeedback[]> => {
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const result = await pool.query(
      `SELECT * FROM execution_feedback ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return result.rows.map(rowToFeedback);
  };

  return { save, findByExecution, findAll };
};

const rowToFeedback = (row: Record<string, unknown>): ExecutionFeedback => ({
  id: row.id as string,
  executionId: row.execution_id as string,
  rating: (row.rating as number) ?? undefined,
  tags: (row.tags as string[]) ?? undefined,
  notes: (row.notes as string) ?? undefined,
  createdBy: (row.created_by as string) ?? undefined,
  createdAt: (row.created_at as Date) ?? undefined,
});
