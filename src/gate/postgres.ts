/**
 * PostgreSQL Gate Repository
 *
 * Production persistence for quality gates.
 */

import { Pool } from "pg";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { Gate, GateRepository } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface PostgresGateConfig {
  connectionString: string;
}

export const makePostgresGateRepository = (
  config: PostgresGateConfig
): GateRepository & { migrate: () => Promise<void>; pool: Pool } => {
  const pool = new Pool({ connectionString: config.connectionString });

  const migrate = async (): Promise<void> => {
    const client = await pool.connect();
    try {
      const migrationsDir = join(__dirname, "migrations");
      const files = readdirSync(migrationsDir)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const file of files) {
        const sql = readFileSync(join(migrationsDir, file), "utf-8");
        await client.query(sql);
      }
    } finally {
      client.release();
    }
  };

  const save = async (gate: Gate): Promise<void> => {
    await pool.query(
      `INSERT INTO gates (
        id, execution_id, state_id, type, status, reason, created_at, resolved_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        reason = EXCLUDED.reason,
        resolved_at = EXCLUDED.resolved_at`,
      [
        gate.id,
        gate.executionId,
        gate.stateId ?? null,
        gate.type,
        gate.status,
        gate.reason ?? null,
        gate.createdAt,
        gate.resolvedAt ?? null,
      ]
    );
  };

  const findByExecution = async (
    executionId: string
  ): Promise<Gate | undefined> => {
    const result = await pool.query(
      `SELECT * FROM gates WHERE execution_id = $1 AND state_id IS NULL ORDER BY created_at DESC LIMIT 1`,
      [executionId]
    );
    if (result.rows.length === 0) return undefined;
    return rowToGate(result.rows[0]);
  };

  const findByExecutionAndState = async (
    executionId: string,
    stateId: string
  ): Promise<Gate | undefined> => {
    const result = await pool.query(
      `SELECT * FROM gates WHERE execution_id = $1 AND state_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [executionId, stateId]
    );
    if (result.rows.length === 0) return undefined;
    return rowToGate(result.rows[0]);
  };

  const resolve = async (
    gateId: string,
    status: Gate["status"],
    reason?: string
  ): Promise<void> => {
    await pool.query(
      `UPDATE gates SET status = $1, reason = $2, resolved_at = NOW() WHERE id = $3`,
      [status, reason ?? null, gateId]
    );
  };

  return { save, findByExecution, findByExecutionAndState, resolve, migrate, pool };
};

const rowToGate = (row: Record<string, unknown>): Gate => ({
  id: row.id as string,
  executionId: row.execution_id as string,
  stateId: (row.state_id as string) ?? undefined,
  type: row.type as Gate["type"],
  status: row.status as Gate["status"],
  reason: (row.reason as string) ?? undefined,
  createdAt: row.created_at as Date,
  resolvedAt: (row.resolved_at as Date) ?? undefined,
});
