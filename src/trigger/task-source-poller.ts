/**
 * Task Source Poller
 *
 * Periodically pulls new/changed tasks from configured TaskSources — via
 * `watchNew` only, never a source's raw API — and enqueues one Job per new
 * task, resumable across restarts via a persisted cursor (mirror of
 * src/trigger/cron.ts, but interval-based rather than cron-based).
 */

import { randomUUID } from "crypto";
import { Effect } from "effect";
import type { TaskSource, TaskState } from "../task-source/types.js";
import type { JobQueue } from "../queue/types.js";
import type { PollStateRepository } from "../persistence/types.js";

export interface TaskSourcePollerSourceConfig {
  sourceId: string;
  taskSource: TaskSource;
  pollIntervalMinutes: number;
  /** Reserved: watchNew has no state filter today, this is not yet wired to behavior. */
  watchState?: TaskState;
}

export interface TaskSourcePollerConfig {
  sources: TaskSourcePollerSourceConfig[];
  queue: JobQueue;
  pollState: PollStateRepository;
  /** Injected for testability. Defaults to crypto.randomUUID. */
  generateId?: () => string;
}

export class TaskSourcePoller {
  private intervals: Array<ReturnType<typeof setInterval>> = [];
  private started = false;

  constructor(private config: TaskSourcePollerConfig) {}

  start(): void {
    if (this.started) {
      throw new Error("TaskSourcePoller already started. Call stop() before restart.");
    }

    for (const source of this.config.sources) {
      const intervalMs = source.pollIntervalMinutes * 60_000;
      // Expression-bodied arrow so the returned promise is observable by
      // callers/tests that capture the callback — real setInterval ignores it.
      const interval = setInterval(() => this.tick(source), intervalMs);
      this.intervals.push(interval);
    }

    this.started = true;
  }

  stop(): void {
    for (const interval of this.intervals) {
      clearInterval(interval);
    }
    this.intervals = [];
    this.started = false;
  }

  get runningPolls(): number {
    return this.intervals.length;
  }

  /** One poll cycle for a single source. Never throws/rejects — errors are logged. */
  private async tick(source: TaskSourcePollerSourceConfig): Promise<void> {
    const { queue, pollState, generateId = randomUUID } = this.config;
    const { sourceId, taskSource } = source;

    try {
      const cursor = (await pollState.getCursor(sourceId)) ?? null;

      const result = await Effect.runPromise(
        taskSource.watchNew(cursor).pipe(
          Effect.matchEffect({
            onFailure: (err) =>
              Effect.sync(() => {
                console.error(`[TaskSourcePoller] watchNew failed for source '${sourceId}':`, err);
                return null;
              }),
            onSuccess: (value) => Effect.succeed(value),
          })
        )
      );
      // Failure already logged above; keep the previous cursor so the next
      // tick retries from the same point.
      if (result === null) return;

      for (const task of result.tasks) {
        // Atomic claim: only the tick that wins the claim enqueues, so
        // overlapping ticks of the same source can't double-enqueue a task.
        if (!(await pollState.claimUnseen(sourceId, task.id))) continue;
        await queue.enqueue({
          id: generateId(),
          trigger: { type: "task_source", payload: { sourceId, task } },
        });
      }

      await pollState.setCursor(sourceId, result.cursor);
    } catch (err) {
      console.error(`[TaskSourcePoller] Poll tick failed for source '${sourceId}':`, err);
    }
  }
}
