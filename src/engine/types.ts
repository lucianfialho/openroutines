/**
 * Execution Engine Types
 *
 * The engine receives a trigger event, resolves the matching routine,
 * loads the skill, and orchestrates provider + connectors + gates.
 */

export interface ExecutionContext {
  routineId: string;
  trigger: unknown;
  startedAt: Date;
}

export interface ExecutionResult {
  success: boolean;
  output: string;
  logs: string[];
  finishedAt: Date;
}
