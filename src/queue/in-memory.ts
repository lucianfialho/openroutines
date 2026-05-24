/**
 * In-Memory Job Queue
 *
 * For testing and local development.
 */

import type { Job, JobQueue } from "./types.js";

export const makeInMemoryQueue = (
  handler: (job: Job) => void | Promise<void>
): JobQueue => {
  return {
    enqueue: async (job) => {
      await handler(job);
    },
  };
};
