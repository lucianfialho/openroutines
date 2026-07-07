/**
 * BullMQ Queue Implementation
 *
 * Production job queue using BullMQ + Redis.
 */

import { Queue, Worker, type Job as BullJob } from "bullmq";
import type { Job, JobQueue } from "./types.js";

// A card-execution job's handler runs the whole card-to-pr state machine —
// sequential provider calls up to 25min each (claude-cli.ts DEFAULT_TIMEOUT_MS)
// inside one job that can take minutes to hours. BullMQ's default lockDuration
// (30s) is far shorter than that: a busy event loop can miss one lock renewal
// and the stalled-checker reassigns the job to another worker while the first
// is still running, which stomps the shared worktree (prod incident 07/jul).
// 2h comfortably outlasts any real single execution while still being well
// inside the night window, so a worker that truly crashed still gets noticed.
const LOCK_DURATION_MS = 2 * 60 * 60 * 1000;

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
      lockDuration: LOCK_DURATION_MS,
      // 0: a job flagged stalled is never retried by BullMQ, only failed —
      // this handler isn't idempotent (rerunning it stomps the worktree the
      // first run is still using), so crash recovery is boot reconciliation's
      // job, not the queue's.
      maxStalledCount: 0,
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
