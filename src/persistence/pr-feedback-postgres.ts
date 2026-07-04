/**
 * PostgreSQL PR Feedback Repository
 *
 * Raw mining corpus for how humans react to an agent's PR — code deltas,
 * review comments, steering comments — one row per signal (F5 #165). Feeds
 * a later mining pass into repo_learnings.
 */
import type { Pool } from "pg";
import type { PrFeedback, PrFeedbackRepository } from "./types.js";

export const makePostgresPrFeedbackRepository = (pool: Pool): PrFeedbackRepository => {
  return {
    save: async (feedback) => {
      await pool.query(
        `INSERT INTO pr_feedback (repo, pr_number, source_id, task_id, kind, content, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()))`,
        [
          feedback.repo,
          feedback.prNumber ?? null,
          feedback.sourceId,
          feedback.taskId,
          feedback.kind,
          feedback.content,
          feedback.createdAt ?? null,
        ]
      );
    },
    findSince: async (since) => {
      const { rows } = await pool.query(
        `SELECT * FROM pr_feedback WHERE created_at >= $1 ORDER BY created_at ASC`,
        [since]
      );
      return rows.map(rowToPrFeedback);
    },
    findByRepo: async (repo) => {
      const { rows } = await pool.query(
        `SELECT * FROM pr_feedback WHERE repo = $1 ORDER BY created_at DESC`,
        [repo]
      );
      return rows.map(rowToPrFeedback);
    },
  };
};

const rowToPrFeedback = (row: Record<string, unknown>): PrFeedback => ({
  id: row.id as string,
  repo: row.repo as string,
  prNumber: row.pr_number != null ? Number(row.pr_number) : undefined,
  sourceId: row.source_id as string,
  taskId: row.task_id as string,
  kind: row.kind as PrFeedback["kind"],
  content: row.content as string,
  createdAt: (row.created_at as Date) ?? undefined,
});
