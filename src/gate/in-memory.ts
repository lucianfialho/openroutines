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
    findOrCreate: async (gate) => {
      for (const existing of store.values()) {
        if (
          existing.executionId === gate.executionId &&
          existing.stateId === gate.stateId
        ) {
          return existing;
        }
      }
      store.set(gate.id, gate);
      return gate;
    },
    findByExecution: async (executionId) => {
      let mostRecent: Gate | undefined;
      for (const gate of store.values()) {
        if (gate.executionId === executionId) {
          if (!mostRecent || gate.createdAt > mostRecent.createdAt) {
            mostRecent = gate;
          }
        }
      }
      return mostRecent;
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
