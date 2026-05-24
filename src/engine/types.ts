/**
 * Execution Engine Types
 *
 * The engine receives a trigger event, resolves the matching routine,
 * loads the skill, and orchestrates provider + connectors + gates.
 */

import type { Routine } from "../routine/types.js";
import type { Skill } from "../skill/types.js";
import type { CompletionResponse } from "../provider/types.js";

export interface ExecutionContext {
  executionId: string;
  routine: Routine;
  skill: Skill;
  trigger: TriggerEvent;
  startedAt: Date;
}

export interface TriggerEvent {
  type: string;
  payload: unknown;
}

export interface ExecutionResult {
  success: boolean;
  output: string;
  usage?: CompletionResponse["usage"];
  logs: string[];
  startedAt: Date;
  finishedAt: Date;
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "EngineError";
  }
}
