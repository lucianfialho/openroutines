/**
 * PostgreSQL Run State Repository
 *
 * Persistence for state-machine run states and sub-runs.
 */

import { Pool } from "pg";
import type { RunState, RunStateRepository, SubRun, SubRunRepository } from "./types.js";

export const makePostgresRunRepository = (pool: Pool): RunStateRepository => {
  const save = async (state: RunState): Promise<void> => {
    await pool.query(
      `INSERT INTO run_states (
        id, execution_id, state_id, skill_id, agent_prompt, output,
        output_validated, gate_id, status, started_at, finished_at,
        duration_ms, prompt_tokens, completion_tokens, total_tokens
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (id) DO UPDATE SET
        output = EXCLUDED.output,
        output_validated = EXCLUDED.output_validated,
        gate_id = EXCLUDED.gate_id,
        status = EXCLUDED.status,
        finished_at = EXCLUDED.finished_at,
        duration_ms = EXCLUDED.duration_ms,
        prompt_tokens = EXCLUDED.prompt_tokens,
        completion_tokens = EXCLUDED.completion_tokens,
        total_tokens = EXCLUDED.total_tokens`,
      [
        state.id ?? crypto.randomUUID(),
        state.executionId,
        state.stateId,
        state.skillId,
        state.agentPrompt ?? null,
        state.output ? JSON.stringify(state.output) : null,
        state.outputValidated ?? false,
        state.gateId ?? null,
        state.status,
        state.startedAt,
        state.finishedAt ?? null,
        state.durationMs ?? null,
        state.promptTokens ?? null,
        state.completionTokens ?? null,
        state.totalTokens ?? null,
      ]
    );
  };

  const findByExecution = async (executionId: string): Promise<RunState[]> => {
    const result = await pool.query(
      `SELECT * FROM run_states WHERE execution_id = $1 ORDER BY started_at ASC`,
      [executionId]
    );
    return result.rows.map(rowToRunState);
  };

  return { save, findByExecution };
};

export const makePostgresSubRunRepository = (pool: Pool): SubRunRepository => {
  const save = async (subRun: SubRun): Promise<void> => {
    await pool.query(
      `INSERT INTO sub_runs (
        id, parent_execution_id, parent_state_id, child_execution_id, child_skill_id
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET
        parent_execution_id = EXCLUDED.parent_execution_id,
        parent_state_id = EXCLUDED.parent_state_id`,
      [
        subRun.id ?? crypto.randomUUID(),
        subRun.parentExecutionId,
        subRun.parentStateId,
        subRun.childExecutionId,
        subRun.childSkillId,
      ]
    );
  };

  const findByParent = async (parentExecutionId: string): Promise<SubRun[]> => {
    const result = await pool.query(
      `SELECT * FROM sub_runs WHERE parent_execution_id = $1`,
      [parentExecutionId]
    );
    return result.rows.map(rowToSubRun);
  };

  const findByChild = async (childExecutionId: string): Promise<SubRun | undefined> => {
    const result = await pool.query(
      `SELECT * FROM sub_runs WHERE child_execution_id = $1`,
      [childExecutionId]
    );
    if (result.rows.length === 0) return undefined;
    return rowToSubRun(result.rows[0]);
  };

  return { save, findByParent, findByChild };
};

const rowToRunState = (row: Record<string, unknown>): RunState => ({
  id: row.id as string,
  executionId: row.execution_id as string,
  stateId: row.state_id as string,
  skillId: row.skill_id as string,
  agentPrompt: (row.agent_prompt as string) ?? undefined,
  output: (row.output as Record<string, unknown>) ?? undefined,
  outputValidated: (row.output_validated as boolean) ?? false,
  gateId: (row.gate_id as string) ?? undefined,
  status: row.status as RunState["status"],
  startedAt: row.started_at as Date,
  finishedAt: (row.finished_at as Date) ?? undefined,
  durationMs: (row.duration_ms as number) ?? undefined,
  promptTokens: (row.prompt_tokens as number) ?? undefined,
  completionTokens: (row.completion_tokens as number) ?? undefined,
  totalTokens: (row.total_tokens as number) ?? undefined,
});

const rowToSubRun = (row: Record<string, unknown>): SubRun => ({
  id: row.id as string,
  parentExecutionId: row.parent_execution_id as string,
  parentStateId: row.parent_state_id as string,
  childExecutionId: row.child_execution_id as string,
  childSkillId: row.child_skill_id as string,
  createdAt: (row.created_at as Date) ?? undefined,
});
