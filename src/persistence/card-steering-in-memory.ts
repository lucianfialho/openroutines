/**
 * In-Memory Card Steering Repository
 *
 * For testing and local development. Not for production use.
 */
import type { CardSteering, CardSteeringRepository } from "./types.js";

export const makeInMemoryCardSteeringRepository = (): CardSteeringRepository => {
  const store: CardSteering[] = [];

  return {
    save: async (steering) => {
      store.push({
        ...steering,
        id: steering.id ?? crypto.randomUUID(),
        createdAt: steering.createdAt ?? new Date(),
        applied: steering.applied ?? false,
      });
    },
    findUnapplied: async (sourceId, taskId) =>
      store
        .filter((s) => !s.applied)
        .filter((s) => sourceId === undefined || s.sourceId === sourceId)
        .filter((s) => taskId === undefined || s.taskId === taskId),
    markApplied: async (id, effectType) => {
      const steering = store.find((s) => s.id === id);
      if (steering) {
        steering.applied = true;
        steering.effectType = effectType;
      }
    },
  };
};
