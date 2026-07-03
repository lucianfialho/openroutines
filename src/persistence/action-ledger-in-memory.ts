/**
 * In-Memory Action Ledger Repository
 *
 * For testing and local development. Not for production use.
 */
import type { ActionLedgerEntry, ActionLedgerRepository } from "./types.js";

const keyOf = (executionId: string, actionKey: string): string => `${executionId}|${actionKey}`;

export const makeInMemoryActionLedgerRepository = (): ActionLedgerRepository => {
  const store = new Map<string, ActionLedgerEntry>();

  return {
    findByKey: async (executionId, actionKey) => store.get(keyOf(executionId, actionKey)),
    recordPending: async (executionId, stateId, actionKey) => {
      store.set(keyOf(executionId, actionKey), {
        executionId,
        stateId,
        actionKey,
        status: "pending",
        createdAt: new Date(),
      });
    },
    complete: async (executionId, actionKey, externalRef) => {
      const entry = store.get(keyOf(executionId, actionKey));
      if (entry) {
        entry.status = "done";
        entry.externalRef = externalRef;
        entry.completedAt = new Date();
      }
    },
    fail: async (executionId, actionKey) => {
      const entry = store.get(keyOf(executionId, actionKey));
      if (entry) {
        entry.status = "failed";
        entry.completedAt = new Date();
      }
    },
  };
};
