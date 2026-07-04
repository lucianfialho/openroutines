/**
 * PostgreSQL Card Steering Repository
 *
 * Human steering comments on a card mid-pipeline (F5 #169, D33): the agent
 * reads unapplied rows, acts on them, then marks them applied with what it did.
 */
import type { Pool } from "pg";
import type { CardSteering, CardSteeringRepository } from "./types.js";

export const makePostgresCardSteeringRepository = (pool: Pool): CardSteeringRepository => {
  return {
    save: async (steering) => {
      await pool.query(
        `INSERT INTO card_steering (source_id, task_id, author_trello_id, text, applied, effect_type)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          steering.sourceId,
          steering.taskId,
          steering.authorTrelloId,
          steering.text,
          steering.applied ?? false,
          steering.effectType ?? null,
        ]
      );
    },
    findUnapplied: async (sourceId, taskId) => {
      const conditions = ["applied = FALSE"];
      const params: unknown[] = [];
      if (sourceId !== undefined) {
        params.push(sourceId);
        conditions.push(`source_id = $${params.length}`);
      }
      if (taskId !== undefined) {
        params.push(taskId);
        conditions.push(`task_id = $${params.length}`);
      }
      const { rows } = await pool.query(
        `SELECT * FROM card_steering WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC`,
        params
      );
      return rows.map(rowToCardSteering);
    },
    markApplied: async (id, effectType) => {
      await pool.query(`UPDATE card_steering SET applied = TRUE, effect_type = $2 WHERE id = $1`, [id, effectType]);
    },
  };
};

const rowToCardSteering = (row: Record<string, unknown>): CardSteering => ({
  id: row.id as string,
  sourceId: row.source_id as string,
  taskId: row.task_id as string,
  authorTrelloId: row.author_trello_id as string,
  text: row.text as string,
  createdAt: (row.created_at as Date) ?? undefined,
  applied: Boolean(row.applied),
  effectType: (row.effect_type as string) ?? undefined,
});
