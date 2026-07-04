/**
 * Atomic card claim (F3 #147).
 *
 * A card is claimed by exactly one night_run: the per-row
 * `UPDATE ... WHERE state='queued' AND claimed_by_night_id IS NULL RETURNING`
 * makes two concurrent coordinators racing for the same card resolve to one
 * winner (the other's UPDATE returns zero rows) — no extra lock needed.
 *
 * Repo policy ("same repo in series") is injected, not hardcoded: tasks carry no
 * repo column (the repo lives in the card's "Repositório" field), so the caller
 * (night-coordinator run.ts, Wave D) passes `resolveRepo` — built on the
 * repo-registry — and `busyRepos` — the repos with a currently-running execution.
 * Wave A keeps the atomic guarantee here and the domain wiring out.
 */
import type { Pool } from "pg";
import { TASK_COMPLEXITIES, type TaskComplexity } from "../task-source/types.js";

export interface ClaimedCard {
  sourceId: string;
  taskId: string;
  repo: string;
  /** Raw task complexity (F4 #159 circuit breaker / D9 tier routing) — undefined when unclassified. */
  complexity?: TaskComplexity;
}

export interface ClaimCandidate {
  sourceId: string;
  taskId: string;
  body: string;
  labels: string[];
}

// Board-facing priority/complexity ranks (lower = picked first).
const PRIORITY_RANK: Record<string, number> = { highest: 0, high: 1, medium: 2, low: 3, lowest: 4 };
const COMPLEXITY_RANK: Record<string, number> = { lowest: 0, low: 1, medium: 2, high: 3, highest: 4, not_sure: 5 };

export const claimReadyCards = async (
  pool: Pool,
  nightId: string,
  limit: number,
  opts: {
    resolveRepo: (task: ClaimCandidate) => string | undefined;
    busyRepos?: Set<string>;
  }
): Promise<ClaimedCard[]> => {
  const { rows } = await pool.query(
    `SELECT source_id, task_id, body, labels, priority, complexity
     FROM tasks
     WHERE state = 'queued' AND claimed_by_night_id IS NULL`
  );

  const candidates = rows
    .map((r) => {
      const rawComplexity = String(r.complexity ?? "").toLowerCase();
      return {
        sourceId: String(r.source_id),
        taskId: String(r.task_id),
        body: String(r.body ?? ""),
        labels: ((r.labels as string[]) ?? []) as string[],
        priorityRank: PRIORITY_RANK[String(r.priority ?? "").toLowerCase()] ?? 9,
        complexityRank: COMPLEXITY_RANK[rawComplexity] ?? 9,
        complexity: (TASK_COMPLEXITIES as readonly string[]).includes(rawComplexity)
          ? (rawComplexity as TaskComplexity)
          : undefined,
      };
    })
    .sort(
      (a, b) =>
        a.priorityRank - b.priorityRank ||
        a.complexityRank - b.complexityRank ||
        a.taskId.localeCompare(b.taskId)
    );

  const claimed: ClaimedCard[] = [];
  // Seed with busy repos so a repo already running is skipped, and add each
  // picked repo so no two cards of the same repo land in one parallel batch.
  const pickedRepos = new Set<string>(opts.busyRepos ?? []);

  for (const c of candidates) {
    if (claimed.length >= limit) break;
    const repo = opts.resolveRepo({
      sourceId: c.sourceId,
      taskId: c.taskId,
      body: c.body,
      labels: c.labels,
    });
    if (!repo) continue; // unresolvable repo — coordinator routes these to Blocked separately
    if (pickedRepos.has(repo)) continue; // busy or already picked this batch (same repo in series)

    const upd = await pool.query(
      `UPDATE tasks SET claimed_by_night_id = $1
       WHERE source_id = $2 AND task_id = $3 AND state = 'queued' AND claimed_by_night_id IS NULL
       RETURNING source_id, task_id`,
      [nightId, c.sourceId, c.taskId]
    );
    if (upd.rows.length === 0) continue; // lost the race to a concurrent coordinator

    pickedRepos.add(repo);
    claimed.push({ sourceId: c.sourceId, taskId: c.taskId, repo, complexity: c.complexity });
  }

  return claimed;
};
