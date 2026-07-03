/**
 * In-Memory Task Repository
 *
 * For testing and local development. Not for production use.
 */
import type { Task } from "../task-source/types.js";
import type { TaskRepository } from "./types.js";

const keyOf = (sourceId: string, taskId: string): string => `${sourceId}|${taskId}`;

export const makeInMemoryTaskRepository = (): TaskRepository => {
  const store = new Map<string, Task>();

  return {
    save: async (task) => {
      store.set(keyOf(task.sourceId, task.id), { ...task });
    },
    findByKey: async (sourceId, taskId) => store.get(keyOf(sourceId, taskId)),
    findBySource: async (sourceId) =>
      Array.from(store.values()).filter((t) => t.sourceId === sourceId),
  };
};
