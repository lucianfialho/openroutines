/**
 * Night window + hard stop (F3 #147).
 *
 * `isWithinWindow` is the pure predicate the coordinator loop polls to decide
 * whether it may keep claiming/enqueueing cards. `enforceHardStop` is what
 * runs once the window has closed: every execution this night that is still
 * `running` gets its process group killed and is marked `failed` — the
 * worktree is deliberately left on disk (F4 resumes from it; this wave only
 * closes the loop that would otherwise leave a CLI process running past the
 * budget window).
 */
import type { Pool } from "pg";
import { killExecutionProcessGroup } from "../provider/process-cleanup.js";
import type { ExecutionRepository, ExecutionProcessRepository } from "../persistence/types.js";

const parseHHMM = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Minutes since local midnight, reading the wall-clock HH:MM of `now` in `tz`. */
const minutesOfDayInTz = (now: Date, tz: string): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
};

/**
 * Pure: `now` is injected so tests never depend on the wall clock. Handles
 * the midnight wrap (e.g. 22:00–06:00) by comparing minutes-of-day and
 * switching to an OR when end < start. Half-open at both bounds: the window
 * covers [start, end) so the loop stops exactly at NIGHT_WINDOW_END.
 */
export const isWithinWindow = (now: Date, start: string, end: string, tz: string): boolean => {
  const nowMin = minutesOfDayInTz(now, tz);
  const startMin = parseHHMM(start);
  const endMin = parseHHMM(end);
  if (startMin <= endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  return nowMin >= startMin || nowMin < endMin; // wraps past midnight
};

export interface HardStopDeps {
  executionRepo: ExecutionRepository;
  executionProcessRepo: ExecutionProcessRepository;
  pool: Pool;
  nightId: string;
}

export const enforceHardStop = async (deps: HardStopDeps): Promise<void> => {
  const { rows } = await deps.pool.query(
    `SELECT id FROM executions WHERE status = 'running' AND night_id = $1`,
    [deps.nightId]
  );

  for (const row of rows) {
    const executionId = row.id as string;
    await killExecutionProcessGroup(executionId, deps.executionProcessRepo);

    const existing = await deps.executionRepo.findById(executionId);
    if (!existing) continue;
    // DO NOT touch the worktree here — it is preserved for a future resume;
    // this only stops the process and marks the record so it is not
    // mistaken for a live execution.
    await deps.executionRepo.save({
      ...existing,
      status: "failed",
      finishedAt: new Date(),
      error: existing.error ?? "night window closed (hard stop)",
      metadata: { ...(existing.metadata ?? {}), blockReason: "timeout" },
    });
  }
};
