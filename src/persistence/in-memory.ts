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
    findAll: async (opts) => {
      const all = Array.from(store.values()).sort(
        (a, b) => b.startedAt.getTime() - a.startedAt.getTime()
      );
      const offset = opts?.offset ?? 0;
      const limit = opts?.limit ?? all.length;
      return all.slice(offset, offset + limit);
    },
  };
};
