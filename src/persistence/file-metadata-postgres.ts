/**
 * PostgreSQL File Metadata Repository
 */
import type { Pool } from "pg";
import type { FileMetadata, FileMetadataRepository } from "./types.js";

export const makePostgresFileMetadataRepository = (pool: Pool): FileMetadataRepository => {
  return {
    save: async (meta) => {
      await pool.query(
        `INSERT INTO file_metadata (path, execution_id, issue_number, status, summary, changes, specialist, decisions, alternatives_rejected, verified_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
         ON CONFLICT (path) DO UPDATE SET
           execution_id = EXCLUDED.execution_id,
           issue_number = EXCLUDED.issue_number,
           status = EXCLUDED.status,
           summary = EXCLUDED.summary,
           changes = EXCLUDED.changes,
           specialist = EXCLUDED.specialist,
           decisions = EXCLUDED.decisions,
           alternatives_rejected = EXCLUDED.alternatives_rejected,
           verified_by = EXCLUDED.verified_by,
           updated_at = NOW()`,
        [
          meta.path,
          meta.executionId ?? null,
          meta.issueNumber ?? null,
          meta.status,
          meta.summary ?? null,
          meta.changes ? JSON.stringify(meta.changes) : null,
          meta.specialist ?? null,
          meta.decisions ? JSON.stringify(meta.decisions) : null,
          meta.alternativesRejected ? JSON.stringify(meta.alternativesRejected) : null,
          meta.verifiedBy ?? null,
        ]
      );
    },
    findByPath: async (path) => {
      const { rows } = await pool.query("SELECT * FROM file_metadata WHERE path = $1", [path]);
      return rows[0] ? rowToMeta(rows[0]) : undefined;
    },
    findByExecution: async (executionId) => {
      const { rows } = await pool.query("SELECT * FROM file_metadata WHERE execution_id = $1", [executionId]);
      return rows.map(rowToMeta);
    },
    findByIssue: async (issueNumber) => {
      const { rows } = await pool.query("SELECT * FROM file_metadata WHERE issue_number = $1", [issueNumber]);
      return rows.map(rowToMeta);
    },
  };
};

const rowToMeta = (row: Record<string, unknown>): FileMetadata => ({
  id: String(row.id),
  path: String(row.path),
  executionId: row.execution_id ? String(row.execution_id) : undefined,
  issueNumber: row.issue_number ? Number(row.issue_number) : undefined,
  status: String(row.status) as "stub" | "complete",
  summary: row.summary ? String(row.summary) : undefined,
  changes: row.changes ? (row.changes as unknown as Array<{ file: string; description: string }>) : undefined,
  specialist: row.specialist ? String(row.specialist) : undefined,
  decisions: row.decisions ? (row.decisions as unknown as string[]) : undefined,
  alternativesRejected: row.alternatives_rejected ? (row.alternatives_rejected as unknown as string[]) : undefined,
  verifiedBy: row.verified_by ? String(row.verified_by) : undefined,
  createdAt: row.created_at ? new Date(String(row.created_at)) : undefined,
  updatedAt: row.updated_at ? new Date(String(row.updated_at)) : undefined,
});
