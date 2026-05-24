/**
 * Neon Serverless Execution Repository
 *
 * Production persistence for execution logs using Neon serverless
 * PostgreSQL. Optimized for serverless/edge environments with
 * connection caching via fetch.
 */

import { neon, neonConfig } from "@neondatabase/serverless";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { ExecutionRecord, ExecutionRepository } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Enable connection caching for serverless environments
neonConfig.fetchConnectionCache = true;

export interface NeonConfig {
  connectionString: string;
}

export const makeNeonRepository = (
  config: NeonConfig
): ExecutionRepository & { migrate: () => Promise<void> } => {
  const sql = neon(config.connectionString);

  const migrate = async (): Promise<void> => {
    const migrationSql = readFileSync(
      join(__dirname, "migrations", "001_executions.sql"),
      "utf-8"
    );
    // Execute migration SQL directly (Neon serverless supports multi-statement)
    await sql.query(migrationSql);
  };

  const save = async (record: ExecutionRecord): Promise<void> => {
    await sql`
      INSERT INTO executions (
        id, routine_id, trigger_type, skill_name, status,
        output, error, prompt_tokens, completion_tokens, total_tokens,
        started_at, finished_at
      ) VALUES (
        ${record.id}, ${record.routineId}, ${record.triggerType}, ${record.skillName}, ${record.status},
        ${record.output ?? null}, ${record.error ?? null}, ${record.promptTokens ?? null},
        ${record.completionTokens ?? null}, ${record.totalTokens ?? null},
        ${record.startedAt}, ${record.finishedAt ?? null}
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        output = EXCLUDED.output,
        error = EXCLUDED.error,
        prompt_tokens = EXCLUDED.prompt_tokens,
        completion_tokens = EXCLUDED.completion_tokens,
        total_tokens = EXCLUDED.total_tokens,
        finished_at = EXCLUDED.finished_at
    `;
  };

  const findById = async (id: string): Promise<ExecutionRecord | undefined> => {
    const rows = await sql`SELECT * FROM executions WHERE id = ${id}`;
    if (rows.length === 0) return undefined;
    return rowToRecord(rows[0]);
  };

  const findByRoutine = async (routineId: string): Promise<ExecutionRecord[]> => {
    const rows =
      await sql`SELECT * FROM executions WHERE routine_id = ${routineId} ORDER BY started_at DESC`;
    return rows.map(rowToRecord);
  };

  return { save, findById, findByRoutine, migrate };
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
  startedAt: row.started_at as Date,
  finishedAt: (row.finished_at as Date) ?? undefined,
});
