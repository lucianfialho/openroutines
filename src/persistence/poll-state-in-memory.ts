/**
 * In-Memory Poll State Repository
 *
 * For testing and local development. Not for production use.
 */
import type { PollStateRepository } from "./types.js";

const seenKey = (sourceId: string, taskId: string): string => `${sourceId}|${taskId}`;

export const makeInMemoryPollStateRepository = (): PollStateRepository => {
  const cursors = new Map<string, string>();
  const seen = new Set<string>();

  return {
    getCursor: async (sourceId) => cursors.get(sourceId),
    setCursor: async (sourceId, cursor) => {
      cursors.set(sourceId, cursor);
    },
    claimUnseen: async (sourceId, taskId) => {
      // check-and-add is atomic under Node's single-threaded model (no await
      // between has() and add()), mirroring the Postgres atomic claim.
      const key = seenKey(sourceId, taskId);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  };
};
