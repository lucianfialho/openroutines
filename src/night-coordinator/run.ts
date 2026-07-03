/**
 * Night coordinator cycle (F3 #147).
 *
 * Composes the Wave A primitives (acquireNightLock, claimReadyCards) with this
 * wave's pr-cap/hard-stop into ONE cycle: lock the night, sync clones, reap
 * zombie CLI processes, drain the currently-claimable backlog in small
 * same-repo-safe batches (respecting the PR cap/backpressure), and — only if
 * this call is still running once the night window has actually closed —
 * hard-stop whatever is left `running`.
 *
 * Deliberately NOT a long-lived all-night poll: this runs once per cron tick
 * (01:00) inside the BullMQ worker, and a long-lived call would pin one of
 * NIGHT_PARALLELISM worker slots for the whole night, starving actual card
 * executions. It drains what is claimable right now and returns — see
 * openDecisions in the handoff for the gap this leaves (nothing re-invokes
 * enforceHardStop later if the queue drains early in the window).
 */
import { randomUUID } from "crypto";
import type { Pool } from "pg";
import { acquireNightLock } from "./lock.js";
import { claimReadyCards, type ClaimCandidate } from "./claim.js";
import { canOpenPr } from "./pr-cap.js";
import { isWithinWindow, enforceHardStop } from "./hard-stop.js";
import { makeGitHubConnector } from "../connector/github.js";
import { defaultRunGit } from "../pipeline/card-to-pr/index.js";
import { cleanupZombieProcesses } from "../provider/process-cleanup.js";
import type { RepoRegistry } from "../repo-registry/schema.js";
import type { ExecutionRepository, ExecutionProcessRepository, PrLinkRepository } from "../persistence/types.js";
import type { JobQueue } from "../queue/types.js";

export interface NightSummary {
  started: boolean;
  reason?: "locked";
  nightId?: string;
  cardsClaimed?: number;
  cardsEnqueued?: number;
}

export interface RunNightCycleDeps {
  pool: Pool;
  registry: RepoRegistry;
  queue: JobQueue;
  executionRepo: ExecutionRepository;
  executionProcessRepo: ExecutionProcessRepository;
  prLinks: PrLinkRepository;
  githubToken: string;
  nightWindowStart: string; // "HH:MM"
  nightWindowEnd: string; // "HH:MM"
  nightBudgetUsd: number;
  nightPrCap: number;
  nightParallelism: number;
  tz: string;
  /** Injectable seams for tests; default to the real implementations. */
  runGit?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
  makeGithub?: (cfg: { token: string; repo: string }) => ReturnType<typeof makeGitHubConnector>;
  now?: () => Date;
  generateId?: () => string;
}

/** "YYYY-MM-DD" of `now`'s wall-clock date in `tz` — the night_runs.date lock key. */
const dateInTz = (now: Date, tz: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

const matchRegistryKey = (registry: RepoRegistry, candidate: string): string | undefined => {
  const slug = candidate.trim().toLowerCase();
  return Object.keys(registry.repos).find((key) => key.trim().toLowerCase() === slug);
};

// "## Repositório\n<slug>" (the card template, 02-FLUXO-TRELLO.md) or an
// inline "Repositório: <slug>" — lenient on purpose, cards are human-edited.
const REPO_HEADING_RE = /#{1,6}\s*reposit[óo]rio\s*\r?\n+\s*([^\n]+)/i;
const REPO_INLINE_RE = /reposit[óo]rio\s*:\s*([^\n]+)/i;

const extractRepoField = (body: string): string | undefined => {
  const match = REPO_HEADING_RE.exec(body) ?? REPO_INLINE_RE.exec(body);
  return match ? match[1].trim() : undefined;
};

/**
 * Resolve a claimed task's repo registry slug: labels first (a project label
 * that happens to name a registered repo), then the card's Repositório field.
 * Returns undefined (unresolvable — the card routes to Blocked elsewhere, not
 * this wave's concern) rather than guessing.
 */
export const resolveRepoForClaim = (registry: RepoRegistry) => (task: ClaimCandidate): string | undefined => {
  for (const label of task.labels) {
    const key = matchRegistryKey(registry, label);
    if (key) return key;
  }
  const field = extractRepoField(task.body);
  return field ? matchRegistryKey(registry, field) : undefined;
};

const getBusyRepos = async (pool: Pool, nightId: string): Promise<Set<string>> => {
  const { rows } = await pool.query(
    `SELECT DISTINCT repo FROM executions WHERE status = 'running' AND night_id = $1 AND repo IS NOT NULL`,
    [nightId]
  );
  return new Set(rows.map((r) => r.repo as string));
};

/**
 * ClaimedCard (Wave A) intentionally carries only identity + repo — enough
 * for the atomic claim and same-repo dedup. The card-to-pr skill also needs
 * title/description, so this hydrates them from `tasks` with the same pool.
 */
const getTaskContent = async (
  pool: Pool,
  sourceId: string,
  taskId: string
): Promise<{ title: string; description: string }> => {
  const { rows } = await pool.query(`SELECT title, body FROM tasks WHERE source_id = $1 AND task_id = $2`, [
    sourceId,
    taskId,
  ]);
  return { title: String(rows[0]?.title ?? ""), description: String(rows[0]?.body ?? "") };
};

const insertPendingExecution = async (
  pool: Pool,
  args: { executionId: string; nightId: string; repo: string; sourceId: string; taskId: string }
): Promise<void> => {
  await pool.query(
    `INSERT INTO executions (
      id, routine_id, trigger_type, skill_name, status, started_at, source_id, task_id, night_id, repo
    ) VALUES ($1, 'night-run', 'card-execution', 'card-to-pr', 'pending', NOW(), $2, $3, $4, $5)`,
    [args.executionId, args.sourceId, args.taskId, args.nightId, args.repo]
  );
};

export const runNightCycle = async (deps: RunNightCycleDeps): Promise<NightSummary> => {
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? randomUUID;

  const lock = await acquireNightLock(deps.pool, dateInTz(now(), deps.tz), {
    budgetCapUsd: deps.nightBudgetUsd,
    prCap: deps.nightPrCap,
  });
  if (!lock) {
    return { started: false, reason: "locked" };
  }
  const { nightId } = lock;

  // 2. Sync clones — best effort; one repo's fetch failure never blocks the night.
  const runGit = deps.runGit ?? defaultRunGit(deps.githubToken);
  for (const [slug, repoConfig] of Object.entries(deps.registry.repos)) {
    try {
      await runGit(["fetch"], repoConfig.clonePath);
    } catch (err) {
      console.error(`[NightCoordinator] git fetch failed for '${slug}':`, err instanceof Error ? err.message : err);
    }
  }

  // 3. Reap zombie CLI processes left by a previous, now-dead orchestrator run.
  await cleanupZombieProcesses(deps.executionProcessRepo);

  // 4. Baseline pre-warm: OPTIONAL for this wave, skipped by choice. Each
  // card's preparacao computes its repo's baseline lazily and idempotently
  // (getOrCreateBaseline, ON CONFLICT DO NOTHING), so the first card of a
  // repo tonight pays one extra verify run instead of the coordinator paying
  // it up front for every registered repo, including idle ones.

  let cardsClaimed = 0;
  let cardsEnqueued = 0;
  let windowEnded = false;

  // 5. Drain the currently-claimable backlog. Bounded and fast by design (see
  // module docstring) — NOT a poll across the whole window.
  for (;;) {
    if (!isWithinWindow(now(), deps.nightWindowStart, deps.nightWindowEnd, deps.tz)) {
      windowEnded = true;
      break;
    }

    const openCount = await deps.prLinks.countOpenForNight(nightId);
    if (openCount >= deps.nightPrCap) break; // global cap reached — nothing more to claim tonight

    const busyRepos = await getBusyRepos(deps.pool, nightId);
    const claimed = await claimReadyCards(deps.pool, nightId, deps.nightParallelism, {
      resolveRepo: resolveRepoForClaim(deps.registry),
      busyRepos,
    });
    if (claimed.length === 0) break; // nothing left to claim right now
    cardsClaimed += claimed.length;

    for (const card of claimed) {
      const ok = await canOpenPr(
        {
          prLinks: deps.prLinks,
          nightPrCap: deps.nightPrCap,
          githubToken: deps.githubToken,
          registry: deps.registry,
          makeGithub: deps.makeGithub,
        },
        { nightId, repo: card.repo }
      );
      if (!ok) {
        // Known Wave-D limitation: the card stays claimed_by_night_id for this
        // night (Wave A's claim has no unclaim path) but never gets enqueued.
        // Bounded by nightParallelism per batch; see openDecisions.
        console.log(
          `[NightCoordinator] card ${card.sourceId}/${card.taskId} claimed but not enqueued this cycle (PR cap/backpressure on '${card.repo}')`
        );
        continue;
      }

      const { title, description } = await getTaskContent(deps.pool, card.sourceId, card.taskId);
      const executionId = generateId();
      await insertPendingExecution(deps.pool, {
        executionId,
        nightId,
        repo: card.repo,
        sourceId: card.sourceId,
        taskId: card.taskId,
      });
      await deps.queue.enqueue({
        id: executionId,
        trigger: {
          type: "card-execution",
          executionId,
          payload: {
            source_id: card.sourceId,
            task_id: card.taskId,
            repo: card.repo,
            title,
            description,
            night_id: nightId,
            executionId,
            skill: "card-to-pr",
          },
        },
      });
      cardsEnqueued++;
    }
  }

  // 6. Only hard-stop when THIS call is still running once the window has
  // actually closed — never right after a normal early drain, which would
  // kill card executions that still have hours left (see module docstring).
  if (windowEnded) {
    await enforceHardStop({
      executionRepo: deps.executionRepo,
      executionProcessRepo: deps.executionProcessRepo,
      pool: deps.pool,
      nightId,
    });
  }

  return { started: true, nightId, cardsClaimed, cardsEnqueued };
};
