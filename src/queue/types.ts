/**
 * Job Queue Types
 *
 * Abstraction for enqueueing execution jobs.
 * In-memory for testing; BullMQ for production.
 */

import type { TriggerEvent } from "../routine/matcher.js";

export interface Job {
  id: string;
  routineId: string;
  trigger: TriggerEvent;
}

export interface JobQueue {
  enqueue: (job: Job) => Promise<void>;
}
