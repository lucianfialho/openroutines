/**
 * In-Memory PR Links Repository
 *
 * For testing and local development. Not for production use. countOpenForNight
 * can't join executions here, so it counts all open links (tests that need the
 * night join use the postgres repo).
 */
import type { PrLink, PrLinkRepository } from "./types.js";

export const makeInMemoryPrLinkRepository = (): PrLinkRepository => {
  const store: PrLink[] = [];

  return {
    create: async (link) => {
      store.push({ ...link, createdAt: new Date() });
    },
    findByTask: async (sourceId, taskId) =>
      store.filter((l) => l.sourceId === sourceId && l.taskId === taskId),
    countOpenForNight: async () => store.filter((l) => l.status === "open").length,
  };
};
