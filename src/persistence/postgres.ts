/**
 * PostgreSQL Execution Repository
 *
 * Production persistence for execution logs.
 */

import { Pool } from "pg";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { ExecutionRecord, ExecutionRepository } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface PostgresConfig {
  connectionString: string;
}

export const makePostgresRepository = (
  config: PostgresConfig
): ExecutionRepository & { migrate: () => Promise<void>; pool: Pool } => {
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

  const save = async (record: ExecutionRecord): Promise<void> => {
    await pool.query(
      `INSERT INTO executions (
        id, routine_id, trigger_type, skill_name, status,
        output, error, prompt_tokens, completion_tokens, total_tokens,
        started_at, finished_at, metadata, cost_usd, provider_breakdown,
        source_id, task_id, realized_complexity, alta_impl_escalated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        output = EXCLUDED.output,
        error = EXCLUDED.error,
        prompt_tokens = EXCLUDED.prompt_tokens,
        completion_tokens = EXCLUDED.completion_tokens,
        total_tokens = EXCLUDED.total_tokens,
        finished_at = EXCLUDED.finished_at,
        metadata = COALESCE(EXCLUDED.metadata, executions.metadata),
        cost_usd = EXCLUDED.cost_usd,
        provider_breakdown = EXCLUDED.provider_breakdown,
        source_id = EXCLUDED.source_id,
        task_id = EXCLUDED.task_id,
        realized_complexity = COALESCE(EXCLUDED.realized_complexity, executions.realized_complexity),
        alta_impl_escalated = COALESCE(EXCLUDED.alta_impl_escalated, executions.alta_impl_escalated)`,
      [
        record.id,
        record.routineId,
        record.triggerType,
        record.skillName,
        record.status,
        record.output ?? null,
        record.error ?? null,
        record.promptTokens ?? null,
        record.completionTokens ?? null,
        record.totalTokens ?? null,
        record.startedAt,
        record.finishedAt ?? null,
        record.metadata ? JSON.stringify(record.metadata) : null,
        record.costUsd ?? null,
        record.providerBreakdown ? JSON.stringify(record.providerBreakdown) : null,
        record.sourceId ?? null,
        record.taskId ?? null,
        record.realizedComplexity ?? null,
        record.altaImplEscalated ?? null,
      ]
    );
  };

  const findById = async (
    id: string
  ): Promise<ExecutionRecord | undefined> => {
    const result = await pool.query(
      `SELECT * FROM executions WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) return undefined;
    return rowToRecord(result.rows[0]);
  };

  const findByRoutine = async (
    routineId: string
  ): Promise<ExecutionRecord[]> => {
    const result = await pool.query(
      `SELECT * FROM executions WHERE routine_id = $1 ORDER BY started_at DESC`,
      [routineId]
    );
    return result.rows.map(rowToRecord);
  };

  const findByTask = async (
    sourceId: string,
    taskId: string
  ): Promise<ExecutionRecord[]> => {
    const result = await pool.query(
      `SELECT * FROM executions WHERE source_id = $1 AND task_id = $2 ORDER BY started_at DESC`,
      [sourceId, taskId]
    );
    return result.rows.map(rowToRecord);
  };

  const findAll = async (
    opts?: { limit?: number; offset?: number; status?: ExecutionRecord["status"] }
  ): Promise<ExecutionRecord[]> => {
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    if (opts?.status) {
      const result = await pool.query(
        `SELECT * FROM executions WHERE status = $1 ORDER BY started_at DESC LIMIT $2 OFFSET $3`,
        [opts.status, limit, offset]
      );
      return result.rows.map(rowToRecord);
    }
    const result = await pool.query(
      `SELECT * FROM executions ORDER BY started_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return result.rows.map(rowToRecord);
  };

  return { save, findById, findByRoutine, findByTask, findAll, migrate, pool };
};

const rowToRecord = (row: Record<string, unknown>): ExecutionRecord => ({
  id: row.id as string,
  routineId: row.routine_id as string,
  triggerType: row.trigger_type as string,
  skillName: row.skill_name as string,
  status: row.status as ExecutionRecord["status"],
  output: (row.output as string) ?? undefined,
  error: (row.error as string) ?? undefined,
  promptTokens: (row.prompt_tokens as number) ?? undefined,
  completionTokens: (row.completion_tokens as number) ?? undefined,
  totalTokens: (row.total_tokens as number) ?? undefined,
  metadata: (row.metadata as Record<string, unknown>) ?? undefined,
  // NUMERIC columns come back as strings from the pg driver
  costUsd: row.cost_usd != null ? Number(row.cost_usd) : undefined,
  providerBreakdown: (row.provider_breakdown as Record<string, number>) ?? undefined,
  sourceId: (row.source_id as string) ?? undefined,
  taskId: (row.task_id as string) ?? undefined,
  // Set once by the night-coordinator's raw INSERT (run.ts), never by save()
  // (its INSERT/UPDATE column lists omit night_id on purpose) — read-only here.
  nightId: (row.night_id as string) ?? undefined,
  realizedComplexity: (row.realized_complexity as string) ?? undefined,
  altaImplEscalated: row.alta_impl_escalated != null ? Boolean(row.alta_impl_escalated) : undefined,
  startedAt: row.started_at as Date,
  finishedAt: (row.finished_at as Date) ?? undefined,
});
