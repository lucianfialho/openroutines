/**
 * PostgreSQL PR Links Repository
 *
 * card ↔ PR linkage (F3 #146). The card-to-pr skill records one row per PR it
 * opens; the night-coordinator reads the open count for the per-night PR cap.
 * F4 adds rework accounting (#157), risk score (#158) and the review poller /
 * morning-report reads (#157/#159).
 */
import { Pool } from "pg";
import type { PrLink, PrLinkPatch, PrLinkRepository } from "./types.js";

/** PrLinkPatch key → pr_links column. Single source for the UPDATE builder. */
const PATCH_COLUMNS: Record<keyof PrLinkPatch, string> = {
  prNumber: "pr_number",
  status: "status",
  reviewState: "review_state",
  reworkCount: "rework_count",
  lastAgentCommitSha: "last_agent_commit_sha",
  lastReworkNightId: "last_rework_night_id",
  riskScore: "risk_score",
  greenLane: "green_lane",
};

export const makePostgresPrLinkRepository = (pool: Pool): PrLinkRepository => {
  return {
    create: async (link) => {
      await pool.query(
        `INSERT INTO pr_links (source_id, task_id, repo, pr_number, branch, status, review_state, rework_count, last_agent_commit_sha, risk_score, green_lane)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          link.sourceId,
          link.taskId,
          link.repo,
          link.prNumber ?? null,
          link.branch,
          link.status,
          link.reviewState ?? null,
          link.reworkCount ?? 0,
          link.lastAgentCommitSha ?? null,
          link.riskScore ?? null,
          link.greenLane ?? false,
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
    findOpen: async () => {
      const { rows } = await pool.query(`SELECT * FROM pr_links WHERE status = 'open' ORDER BY created_at ASC`);
      return rows.map(rowToPrLink);
    },
    update: async (key, patch) => {
      const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return;
      const sets = entries.map(([k], i) => `${PATCH_COLUMNS[k as keyof PrLinkPatch]} = $${i + 4}`);
      await pool.query(
        `UPDATE pr_links SET ${sets.join(", ")}, updated_at = NOW()
         WHERE source_id = $1 AND task_id = $2 AND branch = $3`,
        [key.sourceId, key.taskId, key.branch, ...entries.map(([, v]) => v)]
      );
    },
    findForNight: async (nightId) => {
      const { rows } = await pool.query(
        `SELECT DISTINCT pl.*
         FROM pr_links pl
         JOIN executions e ON e.source_id = pl.source_id AND e.task_id = pl.task_id
         WHERE e.night_id = $1
         ORDER BY pl.risk_score DESC NULLS LAST`,
        [nightId]
      );
      return rows.map(rowToPrLink);
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
  reworkCount: row.rework_count != null ? Number(row.rework_count) : 0,
  lastAgentCommitSha: (row.last_agent_commit_sha as string) ?? undefined,
  lastReworkNightId: (row.last_rework_night_id as string) ?? undefined,
  riskScore: row.risk_score != null ? Number(row.risk_score) : undefined,
  greenLane: Boolean(row.green_lane),
  createdAt: (row.created_at as Date) ?? undefined,
  updatedAt: (row.updated_at as Date) ?? undefined,
});
