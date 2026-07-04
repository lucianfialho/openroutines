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
import { Effect } from "effect";
import type { Pool } from "pg";
import { acquireNightLock } from "./lock.js";
import { claimReadyCards, type ClaimCandidate } from "./claim.js";
import { canOpenPr } from "./pr-cap.js";
import { isWithinWindow, enforceHardStop } from "./hard-stop.js";
import { makeGitHubConnector } from "../connector/github.js";
import { defaultRunGit } from "../pipeline/card-to-pr/index.js";
import { cleanupZombieProcesses } from "../provider/process-cleanup.js";
import { sendTelegramAlert } from "../notify/telegram.js";
import { isTierOpen, tierForComplexity } from "../engine/circuit-breaker.js";
import { nextTier } from "../engine/retry-classifier.js";
import type { RepoRegistry } from "../repo-registry/schema.js";
import type { ExecutionRepository, ExecutionProcessRepository, PrLink, PrLinkRepository, TaskRepository } from "../persistence/types.js";
import type { TaskSource, TaskComplexity } from "../task-source/types.js";
import type { JobQueue } from "../queue/types.js";

export interface NightSummary {
  started: boolean;
  reason?: "locked";
  nightId?: string;
  cardsSynced?: number;
  cardsClaimed?: number;
  cardsEnqueued?: number;
  /** Rework rounds admitted this night (F4 #157, D24). */
  reworkAdmitted?: number;
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
  /**
   * Task sources to sync into `tasks` at cycle start (the ids from
   * task-sources.yaml). Without this, `tasks` is never populated and the claim
   * loop finds nothing — F2 left the poller runtime unwired, so the night-run
   * ingests the queue itself.
   */
  sources?: string[];
  taskSourceFor?: (sourceId: string) => TaskSource | undefined;
  taskRepo?: TaskRepository;
  /** Injectable seams for tests; default to the real implementations. */
  runGit?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
  makeGithub?: (cfg: { token: string; repo: string }) => ReturnType<typeof makeGitHubConnector>;
  now?: () => Date;
  generateId?: () => string;
  /** Telegram alert seam (D22, F4 #186) — defaults to the real sender; tests inject a mock. */
  sendAlert?: typeof sendTelegramAlert;
}

/**
 * "YYYY-MM-DD" of `now`'s wall-clock date in `tz` — the night_runs.date lock
 * key. Exported so the morning-report pipeline (F4 #159, 07:30 same calendar
 * day) can resolve the SAME night_runs row without re-deriving this logic.
 */
export const dateInTz = (now: Date, tz: string): string =>
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
  // Any NON-TERMINAL execution occupies its repo (same-repo-in-series). A card
  // just claimed+enqueued this cycle is 'pending' until a worker starts it, so
  // excluding only 'running' would let the very next loop iteration claim a
  // SECOND card of the same repo and run both in parallel.
  const { rows } = await pool.query(
    `SELECT DISTINCT repo FROM executions
     WHERE status IN ('pending', 'running', 'paused') AND night_id = $1 AND repo IS NOT NULL`,
    [nightId]
  );
  return new Set(rows.map((r) => r.repo as string));
};

/**
 * ClaimedCard (Wave A) intentionally carries only identity + repo — enough
 * for the atomic claim and same-repo dedup. The card-to-pr skill also needs
 * title/description, so this hydrates them from `tasks` with the same pool.
 *
 * `altaImpl` (D9 "regra ALTA", F4 #185) has no upstream writer yet — no
 * triage routine sets it and Task/TaskClassification (F2) carry no such
 * field — so this is a best-effort bridge via a literal "altaImpl" label
 * until that routine exists, not a designed contract.
 */
const getTaskContent = async (
  pool: Pool,
  sourceId: string,
  taskId: string
): Promise<{ title: string; description: string; altaImpl: boolean; complexity?: TaskComplexity }> => {
  const { rows } = await pool.query(
    `SELECT title, body, labels, complexity FROM tasks WHERE source_id = $1 AND task_id = $2`,
    [sourceId, taskId]
  );
  const labels = ((rows[0]?.labels as string[]) ?? []) as string[];
  return {
    title: String(rows[0]?.title ?? ""),
    description: String(rows[0]?.body ?? ""),
    altaImpl: labels.includes("altaImpl"),
    complexity: (rows[0]?.complexity as TaskComplexity | null) ?? undefined,
  };
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

/**
 * Ingest each source's queued cards into the `tasks` table so the claim loop has
 * something to claim. Upsert by (source_id, task_id); a card already claimed by a
 * prior night keeps its claimed_by_night_id (save doesn't touch that column), so
 * re-syncing never re-opens a claimed card.
 */
const syncQueuedCards = async (deps: RunNightCycleDeps): Promise<number> => {
  if (!deps.sources || !deps.taskSourceFor || !deps.taskRepo) return 0;
  let synced = 0;
  for (const sourceId of deps.sources) {
    const ts = deps.taskSourceFor(sourceId);
    if (!ts) continue;
    try {
      const tasks = await Effect.runPromise(ts.listQueue("queued"));
      for (const task of tasks) {
        await deps.taskRepo.save(task);
        synced++;
      }
    } catch (err) {
      console.error(
        `[NightCoordinator] queue sync failed for source '${sourceId}':`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return synced;
};

/** Completed rework rounds allowed per card (D24) — the 3rd request blocks the card instead. */
export const REWORK_MAX_ROUNDS = 2;

/** Move an exhausted-rework card to Blocked. Deliberately NO Telegram alert — D22's taxonomy excludes it. */
const blockExhaustedRework = async (deps: RunNightCycleDeps, link: PrLink): Promise<void> => {
  const ts = deps.taskSourceFor?.(link.sourceId);
  if (ts) {
    await Effect.runPromise(ts.moveTo(link.taskId, "blocked"));
    await Effect.runPromise(
      ts.comment(
        link.taskId,
        `⛔ [Bloqueio]\nMotivo: retrabalho-esgotado\nO que falta: ${REWORK_MAX_ROUNDS} rodadas de retrabalho não satisfizeram o review do PR #${link.prNumber ?? "?"}\nPróximo passo: assumir o PR manualmente`
      )
    );
  }
  // Leaving 'changes_requested' would re-block every night AND let the poller
  // re-open the card — this terminal review_state makes both skip it for good.
  await deps.prLinks.update(
    { sourceId: link.sourceId, taskId: link.taskId, branch: link.branch },
    { reviewState: "rework-exhausted" }
  );
};

/**
 * Rework admission (F4 #157, D24) — runs BEFORE the normal claim loop. An open
 * pr_link with review_state='changes_requested' is admitted at most when
 * rework_count < REWORK_MAX_ROUNDS and it hasn't already reworked TONIGHT
 * (last_rework_night_id — completed round — plus the claimed_by_night_id
 * stamp below, which refuses a 2nd admission of the same card in the same
 * night even before the first completes). At the cap it blocks with
 * 'retrabalho-esgotado' instead.
 */
const admitReworkCards = async (deps: RunNightCycleDeps, nightId: string, generateId: () => string): Promise<number> => {
  let admitted = 0;
  // No prNumber -> the poller can never have marked it changes_requested; the
  // filter is defense in depth against a hand-edited row.
  const candidates = (await deps.prLinks.findOpen()).filter(
    (l) => l.reviewState === "changes_requested" && l.prNumber !== undefined
  );
  // M10: same same-repo-in-series rule the normal claim loop enforces via
  // getBusyRepos — without it, two rework rounds on the SAME clone run `git
  // fetch`/`worktree add` in parallel and collide on index.lock. Seeded once
  // (this loop isn't a re-queried `for(;;)` like the claim loop below) and
  // grown in-memory as each rework is admitted.
  const busyRepos = await getBusyRepos(deps.pool, nightId);
  for (const link of candidates) {
    if ((link.reworkCount ?? 0) >= REWORK_MAX_ROUNDS) {
      await blockExhaustedRework(deps, link);
      continue;
    }
    if (link.lastReworkNightId === nightId) continue; // max 1 completed round/card/night
    if (busyRepos.has(link.repo)) continue; // same-repo-in-series — retry next night
    // Atomic per-night claim: the card keeps its old claimed_by_night_id after
    // the original night, so "not claimed" here means "not claimed by THIS
    // night" — stamping it refuses any 2nd admission tonight.
    const { rows } = await deps.pool.query(
      `UPDATE tasks SET claimed_by_night_id = $1
       WHERE source_id = $2 AND task_id = $3 AND (claimed_by_night_id IS NULL OR claimed_by_night_id != $1)
       RETURNING task_id`,
      [nightId, link.sourceId, link.taskId]
    );
    if (rows.length === 0) continue; // already claimed tonight
    busyRepos.add(link.repo);

    const { title, description, altaImpl, complexity } = await getTaskContent(deps.pool, link.sourceId, link.taskId);
    const executionId = generateId();
    await insertPendingExecution(deps.pool, {
      executionId,
      nightId,
      repo: link.repo,
      sourceId: link.sourceId,
      taskId: link.taskId,
    });
    await deps.queue.enqueue({
      id: executionId,
      trigger: {
        type: "card-execution",
        executionId,
        payload: {
          source_id: link.sourceId,
          task_id: link.taskId,
          repo: link.repo,
          title,
          description,
          night_id: nightId,
          executionId,
          skill: "card-to-pr",
          tier: tierForComplexity(complexity),
          ...(complexity ? { complexity } : {}),
          ...(altaImpl ? { altaImpl: true } : {}),
          // Rework markers: the queue handler starts the machine at
          // rework_preparacao when it sees rework:true.
          rework: true,
          prNumber: link.prNumber,
          branch: link.branch,
        },
      },
    });
    admitted++;
  }
  return admitted;
};

export const runNightCycle = async (deps: RunNightCycleDeps): Promise<NightSummary> => {
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? randomUUID;
  const sendAlert = deps.sendAlert ?? sendTelegramAlert;
  const date = dateInTz(now(), deps.tz);

  const lock = await acquireNightLock(deps.pool, date, {
    budgetCapUsd: deps.nightBudgetUsd,
    prCap: deps.nightPrCap,
  });
  if (!lock) {
    return { started: false, reason: "locked" };
  }
  const { nightId } = lock;

  // D22/F4 #186: from here on, any uncaught error IS the night-run "crash" —
  // alert once, then re-throw so the caller (cron tick / POST /trigger/night-run)
  // still sees the failure and never silently swallows it. The null-lock return
  // above is deliberately OUTSIDE this try — a second process finding the night
  // already locked is normal backpressure, not a failure, so it alerts 0 times.
  try {
    // 2. Sync clones + prune orphaned worktrees — best effort; one repo's failure
    // never blocks the night. `git worktree prune` clears admin metadata for
    // worktrees whose directory is gone (a crashed/cleaned prior run).
    const runGit = deps.runGit ?? defaultRunGit(deps.githubToken);
    for (const [slug, repoConfig] of Object.entries(deps.registry.repos)) {
      try {
        await runGit(["fetch"], repoConfig.clonePath);
        await runGit(["worktree", "prune"], repoConfig.clonePath);
      } catch (err) {
        console.error(`[NightCoordinator] sync/prune failed for '${slug}':`, err instanceof Error ? err.message : err);
      }
    }

    // 3. Reap zombie CLI processes left by a previous, now-dead orchestrator run.
    await cleanupZombieProcesses(deps.executionProcessRepo);

    // 3b. Ingest the sources' queued cards into `tasks` so the claim loop below
    // has rows to claim (F2's poller runtime is unwired — the night-run syncs).
    const cardsSynced = await syncQueuedCards(deps);

    // 3c. Rework admission (F4 #157, D24) — BEFORE the normal claim loop, so
    // PRs waiting on human-requested corrections take priority over new cards.
    // Window-guarded like the claim loop: an out-of-window invocation (the
    // hard-stop path below) must not enqueue new work.
    const reworkAdmitted = isWithinWindow(now(), deps.nightWindowStart, deps.nightWindowEnd, deps.tz)
      ? await admitReworkCards(deps, nightId, generateId)
      : 0;

    // 4. Baseline pre-warm: OPTIONAL for this wave, skipped by choice. Each
    // card's preparacao computes its repo's baseline lazily and idempotently
    // (getOrCreateBaseline, ON CONFLICT DO NOTHING), so the first card of a
    // repo tonight pays one extra verify run instead of the coordinator paying
    // it up front for every registered repo, including idle ones.

    let cardsClaimed = 0;
    let cardsEnqueued = 0;
    let windowEnded = false;
    // Repos denied by per-repo backpressure this cycle. Excluded from further
    // claims so an unclaimed-on-denial card can't be re-claimed → denied → loop
    // forever (a livelock): once a repo is blocked, its cards stay unclaimed and
    // the drain terminates when nothing claimable remains.
    const blockedRepos = new Set<string>();

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
      for (const r of blockedRepos) busyRepos.add(r);
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
          // Release the claim so a FUTURE night can pick this card up — without
          // this, a card denied by the PR cap/backpressure would keep
          // claimed_by_night_id set forever and never be processed again. Mark the
          // repo blocked-this-cycle so it isn't re-claimed into a livelock.
          blockedRepos.add(card.repo);
          await deps.pool.query(
            `UPDATE tasks SET claimed_by_night_id = NULL WHERE source_id = $1 AND task_id = $2 AND claimed_by_night_id = $3`,
            [card.sourceId, card.taskId, nightId]
          );
          console.log(
            `[NightCoordinator] card ${card.sourceId}/${card.taskId} unclaimed (PR cap/backpressure on '${card.repo}') — retry next night`
          );
          continue;
        }

        // F4 #159 circuit breaker: a tier with >60% failure this night (over
        // a minimum sample) stops receiving new cards. If a next tier exists,
        // this card proceeds — attributed to the ESCALATED tier for
        // recordTierOutcome bookkeeping (card-to-pr's states don't yet route
        // per-card dynamically at the ceiling, #185; this is the honest
        // partial today: the failing tier stops being CHARGED for it). With
        // no next tier (already at opus), there is nowhere safe to escalate —
        // defer the card to a future night instead of retrying a tier that is
        // already failing >60% of its attempts.
        const originalTier = tierForComplexity(card.complexity);
        let tier = originalTier;
        if (await isTierOpen(deps.pool, nightId, originalTier)) {
          const escalated = nextTier(originalTier);
          if (!escalated) {
            // Same "don't re-claim this cycle" fence as the PR-cap/backpressure
            // denial above — without it, unclaiming here would let the very
            // next claimReadyCards() call re-pick this same card into a
            // defer-loop for the rest of the cycle.
            blockedRepos.add(card.repo);
            await deps.pool.query(
              `UPDATE tasks SET claimed_by_night_id = NULL WHERE source_id = $1 AND task_id = $2 AND claimed_by_night_id = $3`,
              [card.sourceId, card.taskId, nightId]
            );
            console.log(
              `[NightCoordinator] card ${card.sourceId}/${card.taskId} deferred (tier '${originalTier}' circuit open, no next tier) — retry next night`
            );
            continue;
          }
          console.log(
            `[NightCoordinator] card ${card.sourceId}/${card.taskId} escalated ${originalTier} -> ${escalated} (tier '${originalTier}' circuit open this night)`
          );
          tier = escalated;
        }

        const { title, description, altaImpl } = await getTaskContent(deps.pool, card.sourceId, card.taskId);
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
              tier,
              // F4 #185 (D9): consumed by card-to-pr's implementacao dynamic
              // routing — independent of `tier` above (that one is the
              // circuit breaker's night-level bookkeeping bucket).
              complexity: card.complexity,
              ...(altaImpl ? { altaImpl: true } : {}),
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

    return { started: true, nightId, cardsSynced, cardsClaimed, cardsEnqueued, reworkAdmitted };
  } catch (err) {
    console.error(`[NightCoordinator] night cycle ${date} failed:`, err);
    await sendAlert(`🔥 night-run ${date} falhou: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
};
