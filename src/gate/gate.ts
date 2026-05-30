/**
 * Quality Gate Engine
 *
 * Enforces human-in-the-loop approval before critical actions.
 */

import { randomUUID } from "crypto";
import type { Gate, GateRepository } from "./types.js";

export interface GateEngineConfig {
  repository: GateRepository;
}

export class GateBlockedError extends Error {
  constructor(
    readonly gateId: string,
    readonly executionId: string
  ) {
    super(`Gate ${gateId} blocked execution ${executionId}`);
    this.name = "GateBlockedError";
  }
}

export const makeGateEngine = (config: GateEngineConfig) => {
  const { repository } = config;

  const checkGate = async (
    executionId: string,
    type: Gate["type"],
    stateId?: string
  ): Promise<{ approved: true } | { approved: false; gateId: string }> => {
    const existing = stateId
      ? await repository.findByExecutionAndState(executionId, stateId)
      : await repository.findByExecution(executionId);

    if (existing) {
      if (existing.status === "approved") {
        return { approved: true };
      }
      if (existing.status === "rejected") {
        throw new GateBlockedError(existing.id, executionId);
      }
      return { approved: false, gateId: existing.id };
    }

    // No gate exists yet — create one and block
    const gate: Gate = {
      id: randomUUID(),
      executionId,
      stateId,
      type,
      status: "pending",
      createdAt: new Date(),
    };
    await repository.save(gate);
    return { approved: false, gateId: gate.id };
  };

  const approve = async (gateId: string, reason?: string): Promise<void> => {
    await repository.resolve(gateId, "approved", reason);
  };

  const reject = async (gateId: string, reason?: string): Promise<void> => {
    await repository.resolve(gateId, "rejected", reason);
  };

  return { checkGate, approve, reject };
};

export type GateEngine = ReturnType<typeof makeGateEngine>;
