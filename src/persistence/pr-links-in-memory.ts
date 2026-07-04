/**
 * In-Memory PR Links Repository
 *
 * For testing and local development. Not for production use. countOpenForNight
 * and findForNight can't join executions here, so they operate over all links
 * (tests that need the night join use the postgres repo).
 */
import type { PrLink, PrLinkRepository } from "./types.js";

export const makeInMemoryPrLinkRepository = (): PrLinkRepository => {
  const store: PrLink[] = [];

  return {
    create: async (link) => {
      store.push({ reworkCount: 0, greenLane: false, ...link, createdAt: new Date() });
    },
    findByTask: async (sourceId, taskId) =>
      store.filter((l) => l.sourceId === sourceId && l.taskId === taskId),
    countOpenForNight: async () => store.filter((l) => l.status === "open").length,
    findOpen: async () => store.filter((l) => l.status === "open"),
    update: async (key, patch) => {
      const link = store.find(
        (l) => l.sourceId === key.sourceId && l.taskId === key.taskId && l.branch === key.branch
      );
      if (!link) return;
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) (link as unknown as Record<string, unknown>)[k] = v;
      }
      link.updatedAt = new Date();
    },
    findForNight: async () =>
      [...store].sort((a, b) => (b.riskScore ?? -Infinity) - (a.riskScore ?? -Infinity)),
  };
};
