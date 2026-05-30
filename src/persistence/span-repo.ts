/**
 * Span Repository — PostgreSQL
 *
 * Stores execution spans (traces of each ReAct step).
 */

import { Pool } from "pg";
import type { ExecutionSpan, SpanRepository } from "./types.js";

export const makePostgresSpanRepository = (pool: Pool): SpanRepository => {
  const save = async (span: ExecutionSpan): Promise<void> => {
    await pool.query(
      `INSERT INTO execution_spans (
        id, execution_id, parent_id, type, name, status,
        input, output, error, duration_ms,
        prompt_tokens, completion_tokens, total_tokens, model,
        started_at, finished_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        output = EXCLUDED.output,
        error = EXCLUDED.error,
        duration_ms = EXCLUDED.duration_ms,
        prompt_tokens = EXCLUDED.prompt_tokens,
        completion_tokens = EXCLUDED.completion_tokens,
        total_tokens = EXCLUDED.total_tokens,
        finished_at = EXCLUDED.finished_at`,
      [
        span.id ?? crypto.randomUUID(),
        span.executionId,
        span.parentId ?? null,
        span.type,
        span.name ?? null,
        span.status,
        span.input ? JSON.stringify(span.input) : null,
        span.output ? JSON.stringify(span.output) : null,
        span.error ?? null,
        span.durationMs ?? null,
        span.promptTokens ?? null,
        span.completionTokens ?? null,
        span.totalTokens ?? null,
        span.model ?? null,
        span.startedAt,
        span.finishedAt ?? null,
      ]
    );
  };

  const findByExecution = async (executionId: string): Promise<ExecutionSpan[]> => {
    const result = await pool.query(
      `SELECT * FROM execution_spans WHERE execution_id = $1 ORDER BY started_at ASC`,
      [executionId]
    );
    return result.rows.map(rowToSpan);
  };

  const findById = async (id: string): Promise<ExecutionSpan | undefined> => {
    const result = await pool.query(
      `SELECT * FROM execution_spans WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) return undefined;
    return rowToSpan(result.rows[0]);
  };

  return { save, findByExecution, findById };
};

const rowToSpan = (row: Record<string, unknown>): ExecutionSpan => ({
  id: row.id as string,
  executionId: row.execution_id as string,
  parentId: (row.parent_id as string) ?? undefined,
  type: row.type as ExecutionSpan["type"],
  name: (row.name as string) ?? undefined,
  status: row.status as ExecutionSpan["status"],
  input: (row.input as Record<string, unknown>) ?? undefined,
  output: (row.output as Record<string, unknown>) ?? undefined,
  error: (row.error as string) ?? undefined,
  durationMs: (row.duration_ms as number) ?? undefined,
  promptTokens: (row.prompt_tokens as number) ?? undefined,
  completionTokens: (row.completion_tokens as number) ?? undefined,
  totalTokens: (row.total_tokens as number) ?? undefined,
  model: (row.model as string) ?? undefined,
  startedAt: row.started_at as Date,
  finishedAt: (row.finished_at as Date) ?? undefined,
});
