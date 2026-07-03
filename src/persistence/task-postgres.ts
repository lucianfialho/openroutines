/**
 * PostgreSQL Task Repository
 *
 * Snapshot persistence for Task (task-source poller output), keyed by the
 * composite (source_id, task_id) — never a bare card id (D33).
 */
import type { Pool } from "pg";
import type { Task } from "../task-source/types.js";
import type { TaskRepository } from "./types.js";

export const makePostgresTaskRepository = (pool: Pool): TaskRepository => {
  return {
    save: async (task) => {
      await pool.query(
        `INSERT INTO tasks (source_id, task_id, title, body, url, state, type, complexity, priority, labels, assignees, raw, created_at, updated_at, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
         ON CONFLICT (source_id, task_id) DO UPDATE SET
           title = EXCLUDED.title,
           body = EXCLUDED.body,
           url = EXCLUDED.url,
           state = EXCLUDED.state,
           type = EXCLUDED.type,
           complexity = EXCLUDED.complexity,
           priority = EXCLUDED.priority,
           labels = EXCLUDED.labels,
           assignees = EXCLUDED.assignees,
           raw = EXCLUDED.raw,
           updated_at = EXCLUDED.updated_at,
           synced_at = NOW()`,
        [
          task.sourceId,
          task.id,
          task.title,
          task.body,
          task.url,
          task.state,
          task.type,
          task.complexity ?? null,
          task.priority ?? null,
          JSON.stringify(task.labels),
          JSON.stringify(task.assignees),
          task.raw !== undefined ? JSON.stringify(task.raw) : null,
          task.createdAt,
          task.updatedAt,
        ]
      );
    },
    findByKey: async (sourceId, taskId) => {
      const { rows } = await pool.query(
        "SELECT * FROM tasks WHERE source_id = $1 AND task_id = $2",
        [sourceId, taskId]
      );
      return rows[0] ? rowToTask(rows[0]) : undefined;
    },
    findBySource: async (sourceId) => {
      const { rows } = await pool.query("SELECT * FROM tasks WHERE source_id = $1", [sourceId]);
      return rows.map(rowToTask);
    },
  };
};

const rowToTask = (row: Record<string, unknown>): Task => ({
  sourceId: String(row.source_id),
  id: String(row.task_id),
  title: String(row.title),
  body: String(row.body),
  url: row.url ? String(row.url) : "",
  state: row.state as Task["state"],
  type: row.type as Task["type"],
  complexity: row.complexity ? (row.complexity as Task["complexity"]) : undefined,
  priority: row.priority ? String(row.priority) : undefined,
  labels: (row.labels as unknown as string[]) ?? [],
  assignees: (row.assignees as unknown as string[]) ?? [],
  raw: row.raw ?? undefined,
  createdAt: row.created_at as Date,
  updatedAt: row.updated_at as Date,
});
