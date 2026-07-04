/**
 * In-Memory PR Feedback Repository
 *
 * For testing and local development. Not for production use.
 */
import type { PrFeedback, PrFeedbackRepository } from "./types.js";

export const makeInMemoryPrFeedbackRepository = (): PrFeedbackRepository => {
  const store: PrFeedback[] = [];

  return {
    save: async (feedback) => {
      store.push({ ...feedback, createdAt: feedback.createdAt ?? new Date() });
    },
    findSince: async (since) =>
      store
        .filter((f) => (f.createdAt as Date).getTime() >= since.getTime())
        .sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime()),
    findByRepo: async (repo) =>
      store
        .filter((f) => f.repo === repo)
        .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime()),
  };
};
