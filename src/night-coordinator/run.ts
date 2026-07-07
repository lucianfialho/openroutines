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
import { claimReadyCards, type ClaimCandidate, type UnresolvedCard } from "./claim.js";
import { matchRepoByLabels, suggestRepoSlug, type RepoResolution } from "../repo-registry/match.js";
import { canOpenPr } from "./pr-cap.js";
import { isWithinWindow, enforceHardStop } from "./hard-stop.js";
import { makeGitHubConnector } from "../connector/github.js";
import { defaultRunGit } from "../pipeline/card-to-pr/index.js";
import { cleanupZombieProcesses } from "../provider/process-cleanup.js";
import { sendTelegramAlert } from "../notify/telegram.js";
import { isTierOpen, tierForComplexity } from "../engine/circuit-breaker.js";
import { nextTier } from "../engine/retry-classifier.js";
import { steeringPromptBlock, RESUME_BLOCKED_EFFECT } from "../orchestrator/steering.js";
import type { RepoRegistry } from "../repo-registry/schema.js";
import type { CardSteeringRepository, ExecutionRepository, ExecutionProcessRepository, PrLink, PrLinkRepository, TaskRepository } from "../persistence/types.js";
import type { TaskSource, TaskComplexity, TaskType } from "../task-source/types.js";
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
  /** Blocked cards resumed by human steering this night (F5 #169, D25). */
  blockedResumed?: number;
  /** Cards moved to Blocked this night because their repo could not be resolved. */
  cardsBlockedUnresolvable?: number;
}

export interface RunNightCycleDeps {
  pool: Pool;
  registry: RepoRegistry;
  /**
   * Flag-label names to ignore during label-based repo routing — the
   * "OpenRoutines" flag EVERY card carries name-collides with the same-named
   * repo and would otherwise hijack routing to it. app.ts fills this from the
   * configured trello sources' container.flag.name.
   */
  excludeLabels?: string[];
  queue: JobQueue;
  executionRepo: ExecutionRepository;
  executionProcessRepo: ExecutionProcessRepository;
  prLinks: PrLinkRepository;
  githubToken: string;
  nightWindowStart: string; // "HH:MM"
  nightWindowEnd: string; // "HH:MM"
  nightBudgetUsd: number;
  nightPrCap: number;
  /** Per-repo open-PR cap (F5 #168, policy.yaml backpressure.max_open_prs_per_repo). */
  perRepoOpenPrCap?: number;
  /** Tier circuit-breaker failure rate (F5 #168, policy.yaml night.circuit_breaker_failure_rate). */
  circuitBreakerFailureRate?: number;
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
  /** Human-steering store (F5 #169) — Blocked cards with a pending 🧭 are resumed here. */
  cardSteering?: CardSteeringRepository;
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
 * Resolve a claimed task's repo registry slug into a RepoResolution.
 *
 * The card's "Repositório" field is the canonical target and takes precedence
 * over labels: a field that is PRESENT never falls back to a label (a present-
 * but-unknown field returns `field_unmatched` with a typo suggestion, so the
 * card routes to Blocked with feedback instead of silently matching something
 * else). Labels are the fallback only when the field is absent — and the flag-
 * label collision (the "OpenRoutines" flag every card carries name-colliding
 * with the same-named repo) is now resolved by `excludeLabels`, not merely by
 * the field-wins rule: matchRepoByLabels skips the excluded flag and also
 * honors repo aliases (RepoConfig.labels). No repo at all → `unresolved`.
 */
export const resolveRepoForClaim =
  (registry: RepoRegistry, opts?: { excludeLabels?: string[] }) =>
  (task: ClaimCandidate): RepoResolution => {
    const field = extractRepoField(task.body);
    if (field) {
      const key = matchRegistryKey(registry, field);
      if (key) return { ok: true, repo: key };
      return { ok: false, reason: "field_unmatched", field, suggestion: suggestRepoSlug(registry, field) };
    }
    const repo = matchRepoByLabels(registry, task.labels, opts?.excludeLabels ?? []);
    if (repo) return { ok: true, repo };
    return { ok: false, reason: "unresolved" };
  };

/**
 * Best-effort board mirror of a claim: the card moves to the dedicated Working
 * list so a claimed card is distinguishable from one still waiting. Cosmetic —
 * a failure never aborts the night (the claim itself lives in `tasks`).
 */
const markCardWorking = async (deps: RunNightCycleDeps, sourceId: string, taskId: string): Promise<void> => {
  try {
    const ts = deps.taskSourceFor?.(sourceId);
    if (ts) await Effect.runPromise(ts.moveTo(taskId, "working"));
    await deps.pool.query(`UPDATE tasks SET state = 'working' WHERE source_id = $1 AND task_id = $2`, [
      sourceId,
      taskId,
    ]);
  } catch (err) {
    console.error(
      `[NightCoordinator] move-to-working failed for ${sourceId}/${taskId}:`,
      err instanceof Error ? err.message : err
    );
  }
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
 * Route a card to its pipeline skill by task type (F5 #163). `research` and
 * `mapping` have their own complete pipelines (card-research/card-mapping);
 * `implementation`, `update`, and an absent/unknown type all run the default
 * card-to-pr flow. The chosen name is written BOTH to executions.skill_name and
 * the queue payload so the two never diverge.
 */
export const skillForTaskType = (type: TaskType | undefined): string => {
  switch (type) {
    case "research":
      return "card-research";
    case "mapping":
      return "card-mapping";
    default:
      return "card-to-pr"; // implementation, update, or absent
  }
};

/**
 * ClaimedCard (Wave A) intentionally carries only identity + repo — enough
 * for the atomic claim and same-repo dedup. The card-to-pr skill also needs
 * title/description, so this hydrates them from `tasks` with the same pool.
 * `type` drives skill routing (skillForTaskType).
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
): Promise<{ title: string; description: string; altaImpl: boolean; complexity?: TaskComplexity; type?: TaskType }> => {
  const { rows } = await pool.query(
    `SELECT title, body, labels, complexity, type FROM tasks WHERE source_id = $1 AND task_id = $2`,
    [sourceId, taskId]
  );
  const labels = ((rows[0]?.labels as string[]) ?? []) as string[];
  return {
    title: String(rows[0]?.title ?? ""),
    description: String(rows[0]?.body ?? ""),
    altaImpl: labels.includes("altaImpl"),
    complexity: (rows[0]?.complexity as TaskComplexity | null) ?? undefined,
    type: (rows[0]?.type as TaskType | null) ?? undefined,
  };
};

const insertPendingExecution = async (
  pool: Pool,
  args: { executionId: string; nightId: string; repo: string; sourceId: string; taskId: string; skillName: string }
): Promise<void> => {
  await pool.query(
    `INSERT INTO executions (
      id, routine_id, trigger_type, skill_name, status, started_at, source_id, task_id, night_id, repo
    ) VALUES ($1, 'night-run', 'card-execution', $6, 'pending', NOW(), $2, $3, $4, $5)`,
    [args.executionId, args.sourceId, args.taskId, args.nightId, args.repo, args.skillName]
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
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[NightCoordinator] queue sync failed for source '${sourceId}':`, msg);
      // A source that stops syncing (e.g. a renamed queue column) is otherwise
      // invisible until the 07:30 report — alert best-effort, never let the
      // alert itself abort the sync of the remaining sources.
      try {
        await (deps.sendAlert ?? sendTelegramAlert)(
          `⚠️ [OpenRoutines] sincronização da fonte '${sourceId}' falhou: ${msg}`
        );
      } catch (alertErr) {
        console.error(`[NightCoordinator] sync-fail alert also failed:`, alertErr instanceof Error ? alertErr.message : alertErr);
      }
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
        `⛔ [Bloqueio]\nMotivo: rework-exhausted\nO que falta: ${REWORK_MAX_ROUNDS} rodadas de retrabalho não satisfizeram o review do PR #${link.prNumber ?? "?"}\nPróximo passo: assumir o PR manualmente`
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

/** Alphabetical known-repo keys for the feedback comment, capped at 15 with an ellipsis. */
const knownReposLine = (registry: RepoRegistry): string => {
  const keys = Object.keys(registry.repos).sort();
  const shown = keys.slice(0, 15).join(", ");
  return keys.length > 15 ? `${shown}…` : shown;
};

/** pt-BR feedback posted on the card explaining WHY it couldn't be routed and HOW to unblock it. */
const unresolvableComment = (registry: RepoRegistry, resolution: UnresolvedCard["resolution"]): string => {
  const footer =
    `\n\nRepositórios conhecidos: ${knownReposLine(registry)}.\n\n` +
    `Para destravar: adicione à descrição uma linha "## Repositório" seguida do slug ` +
    `(ou aplique a label do projeto) e mova o card de volta para a fila — ou responda aqui ` +
    `com um comentário 🧭 com instruções que eu retomo na próxima noite.`;
  if (resolution.reason === "field_unmatched") {
    const suggestion = resolution.suggestion ? ` Você quis dizer "${resolution.suggestion}"?` : "";
    return (
      `🤖 [OpenRoutines] Não consegui rotear este card: o campo Repositório diz ` +
      `"${resolution.field}", que não corresponde a nenhum repositório conhecido.${suggestion}${footer}`
    );
  }
  return (
    `🤖 [OpenRoutines] Não consegui identificar o repositório deste card: não há campo ` +
    `"## Repositório" na descrição e nenhuma label corresponde a um repositório conhecido.${footer}`
  );
};

/**
 * Give an unroutable card feedback and move it to Blocked (F-block). `seen`
 * dedups within the night — the drain's for(;;) re-surfaces the same unresolved
 * card each pass until it leaves 'queued', and we must not re-comment it.
 * Order: comment (best-effort) → moveTo → only if BOTH Trello calls succeed,
 * flip the DB row to 'blocked' and release the claim stamp. Any Trello failure
 * logs and leaves the card 'queued' for a clean retry next night — never crashes
 * the night. Returns true the first time a card is handled (for the counter).
 */
const blockUnresolvableCard = async (
  deps: RunNightCycleDeps,
  item: UnresolvedCard,
  seen: Set<string>
): Promise<boolean> => {
  const key = `${item.sourceId}:${item.taskId}`;
  if (seen.has(key)) return false;
  seen.add(key); // mark handled up front — covers success AND every failure branch below

  const ts = deps.taskSourceFor?.(item.sourceId);
  if (!ts) {
    console.error(`[NightCoordinator] card ${key} unresolvable (${item.resolution.reason}) but no task source to notify`);
    return true;
  }
  try {
    await Effect.runPromise(ts.comment(item.taskId, unresolvableComment(deps.registry, item.resolution)));
    await Effect.runPromise(ts.moveTo(item.taskId, "blocked"));
    // moveTo succeeded → persist Blocked + release the (never-set here) claim stamp.
    await deps.pool.query(
      `UPDATE tasks SET state = 'blocked', claimed_by_night_id = NULL WHERE source_id = $1 AND task_id = $2 AND state = 'queued'`,
      [item.sourceId, item.taskId]
    );
  } catch (err) {
    console.error(`[NightCoordinator] failed to block unresolvable card ${key}:`, err instanceof Error ? err.message : err);
  }
  return true;
};

/**
 * Rework admission (F4 #157, D24) — runs BEFORE the normal claim loop. An open
 * pr_link with review_state='changes_requested' is admitted at most when
 * rework_count < REWORK_MAX_ROUNDS and it hasn't already reworked TONIGHT
 * (last_rework_night_id — completed round — plus the claimed_by_night_id
 * stamp below, which refuses a 2nd admission of the same card in the same
 * night even before the first completes). At the cap it blocks with
 * 'rework-exhausted' instead.
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
    // Rework is inherently card-to-pr's PR-review loop; pr_links carries no
    // skill column, so the skill is fixed here rather than derived from type.
    await insertPendingExecution(deps.pool, {
      executionId,
      nightId,
      repo: link.repo,
      sourceId: link.sourceId,
      taskId: link.taskId,
      skillName: "card-to-pr",
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
          // rework_preparation when it sees rework:true.
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

/**
 * Blocked-resume admission (F5 #169, D25) — a whitelisted human's 🧭 on a
 * Blocked card was persisted by the steering poll as an unapplied
 * `resume-blocked` row; here the card is re-claimed and re-enqueued as a normal
 * card-execution, with the steering text injected as a DELIMITED DATA block
 * (steeringPromptBlock) appended to inputs.description. The card leaves Blocked
 * only now (when the coordinator actually resumes), never at the poll. Same
 * same-repo-in-series + PR-cap + atomic-per-night-claim fences as the claim
 * loop; markApplied closes the loop so a resumed card is never re-admitted.
 */
const admitSteeredBlockedCards = async (
  deps: RunNightCycleDeps,
  nightId: string,
  generateId: () => string
): Promise<number> => {
  if (!deps.cardSteering) return 0;
  const pending = (await deps.cardSteering.findUnapplied()).filter((s) => s.effectType === RESUME_BLOCKED_EFFECT);
  if (pending.length === 0) return 0;
  const busyRepos = await getBusyRepos(deps.pool, nightId);
  let resumed = 0;
  for (const steering of pending) {
    if ((await deps.prLinks.countOpenForNight(nightId)) >= deps.nightPrCap) break; // global cap — retry next night
    const { rows } = await deps.pool.query(
      `SELECT title, body, labels, complexity, type FROM tasks WHERE source_id = $1 AND task_id = $2`,
      [steering.sourceId, steering.taskId]
    );
    if (rows.length === 0) continue;
    const body = String(rows[0].body ?? "");
    const labels = ((rows[0].labels as string[]) ?? []) as string[];
    const resolution = resolveRepoForClaim(deps.registry, { excludeLabels: deps.excludeLabels })({
      sourceId: steering.sourceId,
      taskId: steering.taskId,
      body,
      labels,
    });
    if (!resolution.ok) continue; // unresolvable — leave unapplied, retry once the card names a repo
    const repo = resolution.repo;
    if (busyRepos.has(repo)) continue; // same-repo-in-series
    // Atomic per-night claim (same as rework): the card keeps its ORIGINAL
    // night's claimed_by_night_id, so "not this night" means claimable.
    const claim = await deps.pool.query(
      `UPDATE tasks SET claimed_by_night_id = $1
       WHERE source_id = $2 AND task_id = $3 AND (claimed_by_night_id IS NULL OR claimed_by_night_id != $1)
       RETURNING task_id`,
      [nightId, steering.sourceId, steering.taskId]
    );
    if (claim.rows.length === 0) continue; // already re-claimed tonight
    busyRepos.add(repo);

    const complexity = (rows[0].complexity as TaskComplexity | null) ?? undefined;
    const skillName = skillForTaskType((rows[0].type as TaskType | null) ?? undefined);
    const executionId = generateId();
    await insertPendingExecution(deps.pool, {
      executionId,
      nightId,
      repo,
      sourceId: steering.sourceId,
      taskId: steering.taskId,
      skillName,
    });
    await deps.queue.enqueue({
      id: executionId,
      trigger: {
        type: "card-execution",
        executionId,
        payload: {
          source_id: steering.sourceId,
          task_id: steering.taskId,
          repo,
          title: String(rows[0].title ?? ""),
          // The security boundary: human text enters ONLY as delimited data
          // appended to the card description — never a system instruction.
          description: `${body}\n\n${steeringPromptBlock(steering.text)}`,
          night_id: nightId,
          executionId,
          skill: skillName,
          tier: tierForComplexity(complexity),
          ...(complexity ? { complexity } : {}),
          ...(labels.includes("altaImpl") ? { altaImpl: true } : {}),
        },
      },
    });
    if (steering.id) await deps.cardSteering.markApplied(steering.id, RESUME_BLOCKED_EFFECT);
    await markCardWorking(deps, steering.sourceId, steering.taskId);
    resumed++;
  }
  return resumed;
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

    // 3d. Blocked-resume admission (F5 #169, D25) — a human's 🧭 on a Blocked
    // card, persisted by the steering poll, is resumed here BEFORE the normal
    // claim loop (human intent outranks fresh backlog). Window-guarded like rework.
    const blockedResumed = isWithinWindow(now(), deps.nightWindowStart, deps.nightWindowEnd, deps.tz)
      ? await admitSteeredBlockedCards(deps, nightId, generateId)
      : 0;

    // 4. Baseline pre-warm: OPTIONAL for this wave, skipped by choice. Each
    // card's preparation computes its repo's baseline lazily and idempotently
    // (getOrCreateBaseline, ON CONFLICT DO NOTHING), so the first card of a
    // repo tonight pays one extra verify run instead of the coordinator paying
    // it up front for every registered repo, including idle ones.

    let cardsClaimed = 0;
    let cardsEnqueued = 0;
    let cardsBlockedUnresolvable = 0;
    let windowEnded = false;
    // Repos denied by per-repo backpressure this cycle. Excluded from further
    // claims so an unclaimed-on-denial card can't be re-claimed → denied → loop
    // forever (a livelock): once a repo is blocked, its cards stay unclaimed and
    // the drain terminates when nothing claimable remains.
    const blockedRepos = new Set<string>();
    // Unresolvable cards already given feedback THIS night. The for(;;) below
    // calls claimReadyCards repeatedly and an unroutable card keeps surfacing in
    // `unresolved` until it leaves 'queued' (or Trello fails and it doesn't at
    // all) — this dedups the comment/move to once per card per night.
    const unresolvableFeedbackDone = new Set<string>();
    const resolveRepo = resolveRepoForClaim(deps.registry, { excludeLabels: deps.excludeLabels });

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
      const { claimed, unresolved } = await claimReadyCards(deps.pool, nightId, deps.nightParallelism, {
        resolveRepo,
        busyRepos,
      });
      // Feedback for unroutable cards runs BEFORE the drain-empty break — a
      // backlog of ONLY unresolvable cards claims nothing yet must still be
      // routed to Blocked with a comment.
      for (const item of unresolved) {
        if (await blockUnresolvableCard(deps, item, unresolvableFeedbackDone)) cardsBlockedUnresolvable++;
      }
      if (claimed.length === 0) break; // nothing left to claim right now
      cardsClaimed += claimed.length;

      for (const card of claimed) {
        const ok = await canOpenPr(
          {
            prLinks: deps.prLinks,
            nightPrCap: deps.nightPrCap,
            perRepoOpenPrCap: deps.perRepoOpenPrCap,
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
        // this card proceeds attributed to the ESCALATED tier — both for
        // recordTierOutcome bookkeeping AND for the actual route: app.ts's
        // resolveCardToPrDynamicProvider honors payload.tier when it outranks
        // the complexity-derived tier. With no next tier (already at opus),
        // there is nowhere safe to escalate — defer the card to a future
        // night instead of retrying a tier that is already failing >60% of
        // its attempts.
        const originalTier = tierForComplexity(card.complexity);
        let tier = originalTier;
        if (await isTierOpen(deps.pool, nightId, originalTier, deps.circuitBreakerFailureRate)) {
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

        const { title, description, altaImpl, type } = await getTaskContent(deps.pool, card.sourceId, card.taskId);
        const skillName = skillForTaskType(type);
        const executionId = generateId();
        await insertPendingExecution(deps.pool, {
          executionId,
          nightId,
          repo: card.repo,
          sourceId: card.sourceId,
          taskId: card.taskId,
          skillName,
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
              skill: skillName,
              tier,
              // F4 #185 (D9): consumed by card-to-pr's implementation dynamic
              // routing — independent of `tier` above (that one is the
              // circuit breaker's night-level bookkeeping bucket).
              complexity: card.complexity,
              ...(altaImpl ? { altaImpl: true } : {}),
            },
          },
        });
        cardsEnqueued++;
        await markCardWorking(deps, card.sourceId, card.taskId);
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

    return { started: true, nightId, cardsSynced, cardsClaimed, cardsEnqueued, cardsBlockedUnresolvable, reworkAdmitted, blockedResumed };
  } catch (err) {
    console.error(`[NightCoordinator] night cycle ${date} failed:`, err);
    await sendAlert(`🔥 night-run ${date} falhou: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
};
