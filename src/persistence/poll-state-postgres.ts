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
    claimUnseen: async (sourceId, taskId) => {
      // Single atomic claim: the row is inserted iff it wasn't there. RETURNING
      // yields a row only on a real insert (ON CONFLICT DO NOTHING returns none
      // on a duplicate), so rows.length distinguishes "we claimed it" from
      // "already seen" without a separate SELECT — no TOCTOU window.
      const { rows } = await pool.query(
        `INSERT INTO task_source_seen (source_id, task_id, seen_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (source_id, task_id) DO NOTHING
         RETURNING 1`,
        [sourceId, taskId]
      );
      return rows.length > 0;
    },
  };
};
