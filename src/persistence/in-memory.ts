/**
 * In-Memory Execution Repository
 *
 * For testing and local development. Not for production use.
 */

import type { ExecutionRecord, ExecutionRepository } from "./types.js";

export const makeInMemoryRepository = (): ExecutionRepository => {
  const store = new Map<string, ExecutionRecord>();

  return {
    save: async (record) => {
      store.set(record.id, record);
    },
    findById: async (id) => store.get(id),
    findByRoutine: async (routineId) =>
      Array.from(store.values()).filter((r) => r.routineId === routineId),
  };
};
