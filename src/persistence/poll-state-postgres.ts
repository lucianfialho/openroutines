/**
 * PostgreSQL Poll State Repository
 *
 * Cursor + seen-task dedupe state backing TaskSourcePoller (F2 #143).
 */
import type { Pool } from "pg";
import type { PollStateRepository } from "./types.js";

export const makePostgresPollStateRepository = (pool: Pool): PollStateRepository => {
  return {
    getCursor: async (sourceId) => {
      const { rows } = await pool.query(
        "SELECT cursor FROM task_source_cursors WHERE source_id = $1",
        [sourceId]
      );
      return rows[0]?.cursor ?? undefined;
    },
    setCursor: async (sourceId, cursor) => {
      await pool.query(
        `INSERT INTO task_source_cursors (source_id, cursor, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (source_id) DO UPDATE SET
           cursor = EXCLUDED.cursor,
           updated_at = NOW()`,
        [sourceId, cursor]
      );
    },
    hasSeen: async (sourceId, taskId) => {
      const { rows } = await pool.query(
        "SELECT 1 FROM task_source_seen WHERE source_id = $1 AND task_id = $2",
        [sourceId, taskId]
      );
      return rows.length > 0;
    },
    markSeen: async (sourceId, taskId) => {
      await pool.query(
        `INSERT INTO task_source_seen (source_id, task_id, seen_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (source_id, task_id) DO NOTHING`,
        [sourceId, taskId]
      );
    },
  };
};
