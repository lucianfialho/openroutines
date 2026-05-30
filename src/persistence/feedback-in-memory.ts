/**
 * Feedback Repository — In-Memory
 *
 * For development mode. Stores execution feedback in memory.
 */

import type { ExecutionFeedback, FeedbackRepository } from "./types.js";

export const makeInMemoryFeedbackRepository = (): FeedbackRepository => {
  const feedbacks: ExecutionFeedback[] = [];

  const save = async (feedback: ExecutionFeedback): Promise<void> => {
    const idx = feedbacks.findIndex((f) => f.executionId === feedback.executionId);
    if (idx >= 0) {
      feedbacks[idx] = { ...feedbacks[idx], ...feedback };
    } else {
      feedback.id = feedback.id ?? crypto.randomUUID();
      feedback.createdAt = feedback.createdAt ?? new Date();
      feedbacks.push(feedback);
    }
  };

  const findByExecution = async (executionId: string): Promise<ExecutionFeedback | undefined> => {
    return feedbacks.find((f) => f.executionId === executionId);
  };

  const findAll = async (opts?: { limit?: number; offset?: number }): Promise<ExecutionFeedback[]> => {
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    return feedbacks
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
      .slice(offset, offset + limit);
  };

  return { save, findByExecution, findAll };
};
