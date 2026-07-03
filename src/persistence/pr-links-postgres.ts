/**
 * PostgreSQL PR Links Repository
 *
 * card ↔ PR linkage (F3 #146). The card-to-pr skill records one row per PR it
 * opens; the night-coordinator reads the open count for the per-night PR cap.
 */
import { Pool } from "pg";
import type { PrLink, PrLinkRepository } from "./types.js";

export const makePostgresPrLinkRepository = (pool: Pool): PrLinkRepository => {
  return {
    create: async (link) => {
      await pool.query(
        `INSERT INTO pr_links (source_id, task_id, repo, pr_number, branch, status, review_state)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          link.sourceId,
          link.taskId,
          link.repo,
          link.prNumber ?? null,
          link.branch,
          link.status,
          link.reviewState ?? null,
        ]
      );
    },
    findByTask: async (sourceId, taskId) => {
      const { rows } = await pool.query(
        `SELECT * FROM pr_links WHERE source_id = $1 AND task_id = $2 ORDER BY created_at DESC`,
        [sourceId, taskId]
      );
      return rows.map(rowToPrLink);
    },
    countOpenForNight: async (nightId) => {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n
         FROM pr_links pl
         JOIN executions e ON e.source_id = pl.source_id AND e.task_id = pl.task_id
         WHERE pl.status = 'open' AND e.night_id = $1`,
        [nightId]
      );
      return Number(rows[0].n);
    },
  };
};

const rowToPrLink = (row: Record<string, unknown>): PrLink => ({
  id: row.id as string,
  sourceId: row.source_id as string,
  taskId: row.task_id as string,
  repo: row.repo as string,
  prNumber: row.pr_number != null ? Number(row.pr_number) : undefined,
  branch: row.branch as string,
  status: row.status as string,
  reviewState: (row.review_state as string) ?? undefined,
  createdAt: (row.created_at as Date) ?? undefined,
  updatedAt: (row.updated_at as Date) ?? undefined,
});
