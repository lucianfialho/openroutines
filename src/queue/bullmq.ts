/**
 * BullMQ Queue Implementation
 *
 * Production job queue using BullMQ + Redis.
 */

import { Queue, Worker, type Job as BullJob } from "bullmq";
import type { Job, JobQueue } from "./types.js";

export interface BullMqConfig {
  redisUrl: string;
  queueName?: string;
  handler: (job: Job) => void | Promise<void>;
  /** Worker concurrency (default 5). Night-run wiring sets this to NIGHT_PARALLELISM. */
  concurrency?: number;
}

export const makeBullMqQueue = (config: BullMqConfig): JobQueue & { close: () => Promise<void> } => {
  const queueName = config.queueName ?? "openroutines";

  const queue = new Queue(queueName, {
    connection: { url: config.redisUrl },
    defaultJobOptions: {
      // attempts: 1 — a per-phase retry is the orchestrator's decision (via the
      // action_ledger + boot reconciliation), NEVER BullMQ re-running the job from
      // the start, which would re-invoke `preparation` and could create a second
      // worktree/PR for the same card (F3 #149).
      attempts: 1,
      backoff: {
        type: "exponential",
        delay: 1000,
      },
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  });

  const worker = new Worker(
    queueName,
    async (bullJob: BullJob) => {
      const job = bullJob.data as Job;
      await config.handler(job);
    },
    {
      connection: { url: config.redisUrl },
      concurrency: config.concurrency ?? 5,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[BullMQ] Job ${job?.id} failed:`, err.message);
  });

  const enqueue = async (job: Job): Promise<void> => {
    // Remove existing job with same ID to allow re-enqueue (resumed executions)
    try {
      const existing = await queue.getJob(job.id);
      if (existing) {
        await existing.remove();
        console.log(`[BullMQ] Removed existing job ${job.id} before re-enqueue`);
      }
    } catch {
      // Ignore removal errors
    }
    await queue.add(job.trigger.type, job, {
      jobId: job.id,
    });
  };

  const close = async (): Promise<void> => {
    await worker.close();
    await queue.close();
  };

  return { enqueue, close };
};
