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
    hasSeen: async (sourceId, taskId) => seen.has(seenKey(sourceId, taskId)),
    markSeen: async (sourceId, taskId) => {
      seen.add(seenKey(sourceId, taskId));
    },
  };
};
