/**
 * Execution Engine Types
 *
 * The engine receives a trigger event, resolves the matching routine,
 * loads the skill, and orchestrates provider + connectors + gates.
 */

import type { CompletionResponse } from "../provider/types.js";

export interface ExecutionResult {
  executionId: string;
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
