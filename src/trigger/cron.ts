/**
 * Cron Trigger Scheduler
 *
 * Reads routine definitions, finds schedule triggers, and enqueues
 * jobs via node-cron at the specified times.
 */

import { schedule, type ScheduledTask } from "node-cron";
import { randomUUID } from "crypto";
import type { Routine } from "../routine/types.js";
import type { JobQueue } from "../queue/types.js";

export interface CronSchedulerConfig {
  routines: Routine[];
  queue: JobQueue;
  timezone?: string;
}

export class CronScheduler {
  private tasks: ScheduledTask[] = [];

  constructor(private config: CronSchedulerConfig) {}

  start(): void {
    const { routines, queue, timezone } = this.config;

    for (const routine of routines) {
      const cronTriggers = routine.triggers.filter(
        (t): t is { type: "schedule"; cron: string } =>
          t.type === "schedule" && typeof t.cron === "string"
      );

      for (const trigger of cronTriggers) {
        const task = schedule(
          trigger.cron,
          async () => {
            const job = {
              id: randomUUID(),
              routineId: routine.id,
              trigger: {
                type: "schedule" as const,
                payload: { cron: trigger.cron, routineId: routine.id },
              },
            };
            await queue.enqueue(job);
          },
          { scheduled: true, timezone }
        );
        this.tasks.push(task);
      }
    }
  }

  stop(): void {
    for (const task of this.tasks) {
      task.stop();
    }
    this.tasks = [];
  }

  get runningTasks(): number {
    return this.tasks.length;
  }
}
