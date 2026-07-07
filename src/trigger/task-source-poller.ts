/**
 * Task Source Poller
 *
 * Periodically pulls new/changed tasks from configured TaskSources — via
 * `watchNew` only, never a source's raw API — resumable across restarts via a
 * persisted cursor (mirror of src/trigger/cron.ts, but interval-based rather
 * than cron-based).
 *
 * On a burst of newly-seen tasks it enqueues ONE `card-triage` cycle (never one
 * job per card): the triage cycle re-scans the whole queue and dedups by
 * fingerprint, so a single wake-up covers every card discovered this tick and an
 * extra tick is cheap. Moving a card to the queue thus produces a triage brief in
 * ~5min instead of waiting up to the 30-min triage cron.
 */

import { randomUUID } from "crypto";
import { Effect } from "effect";
import { isWithinWindow } from "../night-coordinator/hard-stop.js";
import type { TaskSource, TaskState } from "../task-source/types.js";
import type { JobQueue } from "../queue/types.js";
import type { PollStateRepository, TaskRepository } from "../persistence/types.js";

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
  /** Eagerly mirrors each newly-seen card into `tasks` (triage's scan refreshes it too). */
  taskRepo?: TaskRepository;
  /**
   * Daytime window — a tick whose wall-clock time (in `tz`) is outside
   * [start,end] is skipped entirely (no watchNew, cursor untouched), so the
   * first in-window tick catches up on everything accumulated overnight in one
   * triage job. Absent = poll around the clock.
   */
  window?: { start: string; end: string; tz: string };
  /** Injected for testability. Defaults to () => new Date(). */
  now?: () => Date;
  /** Injected for testability. Defaults to crypto.randomUUID. */
  generateId?: () => string;
}

export class TaskSourcePoller {
  private intervals: Array<ReturnType<typeof setInterval>> = [];
  private started = false;
  /** Guards against re-entrant ticks for the same source (e.g. a slow network call). */
  private runningTicks = new Set<string>();

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
    // Reset reentrancy guard: any in-flight tick from the old intervals is
    // abandoned, so new intervals after a restart must not be blocked by it.
    this.runningTicks.clear();
  }

  get runningPolls(): number {
    return this.intervals.length;
  }

  /** One poll cycle for a single source. Never throws/rejects — errors are logged. */
  private async tick(source: TaskSourcePollerSourceConfig): Promise<void> {
    const { queue, pollState, taskRepo, window, now = () => new Date(), generateId = randomUUID } = this.config;
    const { sourceId, taskSource } = source;

    // Daytime-only: an out-of-window tick returns before touching watchNew or the
    // cursor, so the next in-window tick resumes from the same point and folds the
    // whole overnight backlog into one triage job.
    if (window && !isWithinWindow(now(), window.start, window.end, window.tz)) return;

    if (this.runningTicks.has(sourceId)) return;
    this.runningTicks.add(sourceId);

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

      let discovered = 0;
      for (const task of result.tasks) {
        // Atomic claim: only the tick that wins the claim counts the task, so
        // overlapping ticks / an imprecise cursor resending a task never
        // double-count it (and thus never enqueue a redundant triage tick).
        if (!(await pollState.claimUnseen(sourceId, task.id))) continue;
        // Eager mirror so `tasks` reflects the card the moment it is seen; the
        // triage cycle's own scan refreshes it again per card.
        if (taskRepo) await taskRepo.save(task);
        discovered++;
      }

      // One triage cycle per burst — NOT one job per card. The card-triage
      // queueHandler interception runs the full cycle and dedups by fingerprint,
      // so an extra tick is cheap and a burst collapses to a single wake-up.
      if (discovered > 0) {
        await queue.enqueue({
          id: generateId(),
          routineId: "card-triage",
          trigger: { type: "schedule", payload: {} },
        });
      }

      await pollState.setCursor(sourceId, result.cursor);
    } catch (err) {
      console.error(`[TaskSourcePoller] Poll tick failed for source '${sourceId}':`, err);
    } finally {
      this.runningTicks.delete(sourceId);
    }
  }
}
