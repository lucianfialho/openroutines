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
      // H3: succeed()/fail() (state-machine.ts) persist a fresh record with no
      // `metadata` at all — mirror postgres.ts's `COALESCE(EXCLUDED.metadata,
      // executions.metadata)` so an absent metadata never nulls out what an
      // earlier persistStateContext() call already stored for this id.
      // realizedComplexity/altaImplEscalated (F5 #167) hit the same hazard —
      // succeed()/fail() don't carry them either — so preserve them the same way.
      const existing = store.get(record.id);
      store.set(record.id, {
        ...record,
        metadata: record.metadata ?? existing?.metadata,
        realizedComplexity: record.realizedComplexity ?? existing?.realizedComplexity,
        altaImplEscalated: record.altaImplEscalated ?? existing?.altaImplEscalated,
      });
    },
    findById: async (id) => store.get(id),
    findByRoutine: async (routineId) =>
      Array.from(store.values()).filter((r) => r.routineId === routineId),
    findByTask: async (sourceId, taskId) =>
      Array.from(store.values()).filter((r) => r.sourceId === sourceId && r.taskId === taskId),
    findAll: async (opts) => {
      const all = Array.from(store.values())
        .filter((r) => (opts?.status ? r.status === opts.status : true))
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      const offset = opts?.offset ?? 0;
      const limit = opts?.limit ?? all.length;
      return all.slice(offset, offset + limit);
    },
  };
};
