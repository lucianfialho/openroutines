/**
 * PostgreSQL Action Ledger Repository
 *
 * Idempotency record for external side effects (git push, PR create, Trello
 * move/comment). Checked before the effect fires so a crash-and-resume never
 * double-fires (F3 #149).
 */
import { Pool } from "pg";
import type { ActionLedgerEntry, ActionLedgerRepository } from "./types.js";

export const makePostgresActionLedgerRepository = (pool: Pool): ActionLedgerRepository => {
  return {
    findByKey: async (executionId, actionKey) => {
      const { rows } = await pool.query(
        `SELECT * FROM action_ledger WHERE execution_id = $1 AND action_key = $2`,
        [executionId, actionKey]
      );
      return rows[0] ? rowToEntry(rows[0]) : undefined;
    },
    recordPending: async (executionId, stateId, actionKey) => {
      // ON CONFLICT re-arms a prior 'failed'/'pending' row back to 'pending'
      // (runIdempotent only calls this after confirming there is no 'done' row),
      // so a retried action starts clean without a duplicate row.
      await pool.query(
        `INSERT INTO action_ledger (execution_id, state_id, action_key, status)
         VALUES ($1, $2, $3, 'pending')
         ON CONFLICT (execution_id, action_key) DO UPDATE SET
           status = 'pending', external_ref = NULL, completed_at = NULL`,
        [executionId, stateId, actionKey]
      );
    },
    complete: async (executionId, actionKey, externalRef) => {
      await pool.query(
        `UPDATE action_ledger SET status = 'done', external_ref = $3, completed_at = NOW()
         WHERE execution_id = $1 AND action_key = $2`,
        [executionId, actionKey, externalRef ?? null]
      );
    },
    // ponytail: the ledger schema has no error column (idempotency, not diagnostics —
    // runIdempotent rethrows the real error, and spans/executions.error hold forensics).
    // We only flip status so the next attempt re-does the action instead of hanging in 'pending'.
    fail: async (executionId, actionKey, _error) => {
      await pool.query(
        `UPDATE action_ledger SET status = 'failed', completed_at = NOW()
         WHERE execution_id = $1 AND action_key = $2`,
        [executionId, actionKey]
      );
    },
  };
};

const rowToEntry = (row: Record<string, unknown>): ActionLedgerEntry => ({
  id: row.id as string,
  executionId: row.execution_id as string,
  stateId: row.state_id as string,
  actionKey: row.action_key as string,
  status: row.status as ActionLedgerEntry["status"],
  externalRef: (row.external_ref as string) ?? undefined,
  createdAt: (row.created_at as Date) ?? undefined,
  completedAt: (row.completed_at as Date) ?? undefined,
});
