/**
 * Cron Trigger Scheduler
 *
 * Reads routine definitions, finds schedule triggers, and enqueues
 * jobs via node-cron at the specified times.
 */

import { schedule, validate, type ScheduledTask } from "node-cron";
import { randomUUID } from "crypto";
import type { Routine } from "../routine/types.js";
import type { JobQueue } from "../queue/types.js";

export class InvalidCronError extends Error {
  constructor(cron: string) {
    super(`Invalid cron expression: '${cron}'`);
    this.name = "InvalidCronError";
  }
}

export interface CronSchedulerConfig {
  routines: Routine[];
  queue: JobQueue;
  timezone?: string;
  /** Injected for testability. Defaults to crypto.randomUUID. */
  generateId?: () => string;
}

export class CronScheduler {
  private tasks: ScheduledTask[] = [];
  private started = false;

  constructor(private config: CronSchedulerConfig) {}

  start(): void {
    if (this.started) {
      throw new Error("CronScheduler already started. Call stop() before restart.");
    }

    const { routines, queue, timezone, generateId = randomUUID } = this.config;

    for (const routine of routines) {
      const cronTriggers = routine.triggers.filter(
        (t): t is { type: "schedule"; cron: string } =>
          t.type === "schedule" && typeof t.cron === "string"
      );

      for (const trigger of cronTriggers) {
        if (!validate(trigger.cron)) {
          throw new InvalidCronError(trigger.cron);
        }

        const task = schedule(
          trigger.cron,
          async () => {
            try {
              const job = {
                id: generateId(),
                routineId: routine.id,
                trigger: {
                  type: "schedule" as const,
                  payload: { cron: trigger.cron, routineId: routine.id },
                },
              };
              await queue.enqueue(job);
            } catch (err) {
              console.error(
                `[CronScheduler] Failed to enqueue job for routine '${routine.id}':`,
                err
              );
            }
          },
          { scheduled: true, timezone }
        );
        this.tasks.push(task);
      }
    }

    this.started = true;
  }

  stop(): void {
    for (const task of this.tasks) {
      task.stop();
    }
    this.tasks = [];
    this.started = false;
  }

  get runningTasks(): number {
    return this.tasks.length;
  }
}
