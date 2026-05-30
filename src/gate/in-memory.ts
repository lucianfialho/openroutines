/**
 * In-Memory Gate Repository
 *
 * For testing and local development.
 */

import type { Gate, GateRepository } from "./types.js";

export const makeInMemoryGateRepository = (): GateRepository => {
  const store = new Map<string, Gate>();

  return {
    save: async (gate) => {
      store.set(gate.id, gate);
    },
    findByExecution: async (executionId) => {
      for (const gate of store.values()) {
        if (gate.executionId === executionId && !gate.stateId) return gate;
      }
      return undefined;
    },
    findByExecutionAndState: async (executionId, stateId) => {
      for (const gate of store.values()) {
        if (gate.executionId === executionId && gate.stateId === stateId) return gate;
      }
      return undefined;
    },
    resolve: async (gateId, status, reason) => {
      const gate = store.get(gateId);
      if (!gate) throw new Error(`Gate not found: ${gateId}`);
      gate.status = status;
      gate.reason = reason;
      gate.resolvedAt = new Date();
      store.set(gateId, gate);
    },
  };
};
