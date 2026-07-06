/**
 * OpenRoutines Application Bootstrap
 *
 * Wires together all components: triggers, engine, provider, connectors,
 * persistence, queue, and tools. Supports both in-memory (dev) and production
 * (PostgreSQL + BullMQ) configurations via environment variables.
 */

import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { timingSafeEqual } from "crypto";
import express, { type RequestHandler } from "express";
import { Redis } from "ioredis";
import { Effect } from "effect";
import { parseRoutine } from "./routine/parser.js";
import { loadSkill } from "./skill/loader.js";
import type { Routine } from "./routine/types.js";
import { makeEngine } from "./engine/engine.js";
import { makeKimiCodingProvider } from "./provider/kimi-coding.js";
import { makeKimiCliProvider } from "./provider/kimi-cli.js";
import { makeProviderRegistry } from "./provider/registry.js";
import { makeScriptRegistry } from "./script/registry.js";
import { makePostgresExecutionProcessRepository } from "./persistence/execution-process-repo.js";
import { cleanupZombieProcesses } from "./provider/process-cleanup.js";
import { reconcileOrphanedExecutions } from "./execution/boot-reconciliation.js";

import { makeInMemoryRepository } from "./persistence/in-memory.js";
import { makePostgresRepository } from "./persistence/postgres.js";
import { makeInMemoryQueue } from "./queue/in-memory.js";
import { makeBullMqQueue } from "./queue/bullmq.js";
import { CronScheduler } from "./trigger/cron.js";
import { setupGitHubWebhook } from "./trigger/webhook.js";
import { ToolRegistry } from "./tool/registry.js";
import { makeGitHubTools } from "./tool/github-tools.js";
import { makeFilesystemTools } from "./tool/filesystem-tools.js";
import { makeGitWorktreeTools } from "./tool/git-worktree-tools.js";
import { makeGateEngine } from "./gate/gate.js";
import { makeInMemoryGateRepository } from "./gate/in-memory.js";
import { makePostgresGateRepository } from "./gate/postgres.js";
import { makeInMemorySpanRepository } from "./persistence/span-in-memory.js";
import { makePostgresSpanRepository } from "./persistence/span-repo.js";
import { makeInMemoryFeedbackRepository } from "./persistence/feedback-in-memory.js";
import { makePostgresFeedbackRepository } from "./persistence/feedback-repo.js";
import { makePostgresRunRepository } from "./persistence/run-repository.js";
import { makeInMemoryFileMetadataRepository } from "./persistence/file-metadata-in-memory.js";
import { makePostgresFileMetadataRepository } from "./persistence/file-metadata-postgres.js";
import type { SpanRepository, FeedbackRepository, ExecutionRepository, PrLinkRepository } from "./persistence/types.js";
import { analyzeExecution, aggregateMetrics } from "./observability/analyzer.js";
import {
  analyzeFeedback,
  listImprovements,
  applyImprovement,
  dismissImprovement,
} from "./observability/feedback-loop.js";
import { loadRepoRegistry } from "./repo-registry/registry.js";
import { loadPolicy } from "./config/policy.js";
import { makeInMemoryActionLedgerRepository } from "./persistence/action-ledger-in-memory.js";
import { makePostgresActionLedgerRepository } from "./persistence/action-ledger-postgres.js";
import { makeInMemoryPrLinkRepository } from "./persistence/pr-links-in-memory.js";
import { makePostgresPrLinkRepository } from "./persistence/pr-links-postgres.js";
import { makePostgresTaskRepository } from "./persistence/task-postgres.js";
import { makeInMemoryTaskRepository } from "./persistence/task-in-memory.js";
import { makeInMemoryRepoLearningRepository } from "./persistence/repo-learnings-in-memory.js";
import { makePostgresRepoLearningRepository } from "./persistence/repo-learnings-postgres.js";
import { makeSimilarCards } from "./orchestrator/tactical-memory.js";
import { makePostgresPrFeedbackRepository } from "./persistence/pr-feedback-postgres.js";
import { loadTaskSources, type ResolvedTaskSource } from "./task-source/loader.js";
import { makeTrelloTaskSource, makeTrelloCreateCard, makeTrelloLinkCards, makeTrelloReadComments, makeTrelloReadLinkedCards } from "./connector/trello.js";
import { runSteeringPoll, type SteeringPollDeps } from "./orchestrator/steering.js";
import { runDegradedModeUnblockPoll, type DegradedModeUnblockDeps } from "./orchestrator/degraded-mode.js";
import { makePostgresPollStateRepository } from "./persistence/poll-state-postgres.js";
import { makePostgresCardSteeringRepository } from "./persistence/card-steering-postgres.js";
import { makeRestTaskSource } from "./task-source/rest-executor.js";
import type { TaskSource, TaskComplexity } from "./task-source/types.js";
import { registerCardToPrHandlers, cardToPrFanoutAggregators } from "./pipeline/card-to-pr/index.js";
import { registerResearchHandlers } from "./pipeline/research/index.js";
import { registerMappingHandlers } from "./pipeline/mapping/index.js";
import { resolveCardToPrProvider, resolveImplementationTier, resolveEscalatedProvider } from "./pipeline/card-to-pr/routing.js";
import { registerMorningReportHandlers, MORNING_REPORT_TRELLO_LIST } from "./pipeline/morning-report/index.js";
import { runStateMachine, type StateMachineConfig, type StateMachineContext, type DynamicProviderContext } from "./engine/state-machine.js";
import { recordTierOutcome, type Tier } from "./engine/circuit-breaker.js";
import type { SkillStateMachine } from "./skill/schema.js";
import type { TriggerEvent } from "./routine/matcher.js";
import { reserveBudget, BUDGET_UNIT_WEIGHTS, normalizeBudgetTier } from "./night-coordinator/budget.js";
import { runNightCycle, type RunNightCycleDeps } from "./night-coordinator/run.js";
import { runNightHardStop, isWithinWindow } from "./night-coordinator/hard-stop.js";
import { runPrReviewPoll, type PrReviewPollDeps } from "./trigger/pr-review-poller.js";

/**
 * Build a TaskSource from one loaded task-sources.yaml entry (F2 #144 left
 * this unwired). `entry.auth` holds env var NAMES, never resolved secrets
 * (see task-sources.yaml.example) — Trello needs the resolved values up
 * front, the generic REST executor resolves them itself per-call.
 */
const buildTaskSource = (resolved: ResolvedTaskSource): TaskSource => {
  const { entry, manifest } = resolved;
  if (entry.type === "trello") {
    const apiKey = entry.auth.key ? process.env[entry.auth.key] : undefined;
    const apiToken = entry.auth.token ? process.env[entry.auth.token] : undefined;
    if (!apiKey || !apiToken) {
      throw new Error(`trello source '${entry.id}': missing env var(s) named by auth.key/auth.token`);
    }
    return makeTrelloTaskSource({ manifest, sourceId: entry.id, boardId: entry.containers.board ?? "", apiKey, apiToken });
  }
  return makeRestTaskSource({ manifest, sourceId: entry.id, containers: entry.containers, authEnv: entry.auth });
};

/**
 * D9 tier ladder order (kimi < sonnet < opus) for the escalation-rank
 * comparisons below — routing.ts documents the same order; kept here as rank
 * only, never as a route (routing.ts's IMPLEMENTATION_ROUTES stays the only
 * source of truth for provider/model, F4 #185).
 */
const TIER_LADDER: readonly Tier[] = ["kimi", "sonnet", "opus"];
const tierRank = (t: Tier): number => TIER_LADDER.indexOf(t);

/**
 * Route for an explicit target tier, via routing.ts's own "one tier up"
 * primitive (resolveEscalatedProvider) fed its predecessor — avoids a 2nd
 * copy of the provider/model table in this file.
 */
const routeForTier = (tier: Tier): { provider: string; model?: string } | undefined => {
  const belowIdx = tierRank(tier) - 1;
  return belowIdx >= 0 ? resolveEscalatedProvider(TIER_LADDER[belowIdx]) : undefined;
};

/**
 * Complexity routing hook (F4 #185, D9) for card-to-pr's dispatch — wired as
 * `StateMachineConfig.resolveDynamicProvider` for the `card-to-pr` skill.
 * Only `implementation` declares `dynamic_provider: true` in skill.yaml
 * (`plan`/`gate_plan` stay static; routing.ts's fixed routes for them exist
 * only as the one auditable source of truth, never wired here) — an
 * unescalated call resolves straight from the card's complexity/altaImpl
 * inputs, an escalated one (F4 #159: the verify->implementation retry cap just
 * exhausted) bumps one tier up the same D9 ladder instead of re-deriving it
 * from scratch.
 */
export const resolveCardToPrDynamicProvider = (
  ctx: DynamicProviderContext
): { provider: string; model?: string } | undefined => {
  // `rework` (F4 #157, D24) routes exactly like implementation: the card's
  // ORIGINAL D9 tier from the same complexity/altaImpl inputs.
  if (ctx.stateId !== "implementation" && ctx.stateId !== "rework") return undefined;
  const complexity = ctx.inputs.complexity as TaskComplexity | undefined;
  const altaImpl = ctx.inputs.altaImpl as boolean | undefined;
  const derivedTier = resolveImplementationTier({ complexity, altaImpl });

  // H9c/#159: the night-level circuit breaker (run.ts) may have already
  // escalated this card one tier up before it ever reached the queue, riding
  // along as payload.tier -> ctx.inputs.tier (run.ts:404-412 calls this
  // "honest partial today" — the escalation only affected
  // recordTierOutcome's bookkeeping bucket, never the actual route). Honor
  // it when it outranks the derived tier; never downgrade — a stale/lower
  // payload.tier must never override a legitimately higher derived one
  // (e.g. altaImpl already forcing opus).
  const payloadTier = ctx.inputs.tier as Tier | undefined;
  const payloadEscalates = payloadTier !== undefined && tierRank(payloadTier) > tierRank(derivedTier);

  if (!ctx.escalated && !payloadEscalates) return resolveCardToPrProvider(ctx.stateId, { complexity, altaImpl });
  if (!payloadEscalates) return resolveEscalatedProvider(derivedTier); // ctx.escalated only — unchanged (incl. undefined at the opus ceiling)
  return routeForTier(payloadTier!); // payload names a higher rung directly (whether or not ctx.escalated also fired)
};

export interface CardExecutionJobDeps {
  cardToPrStateMachineConfig: StateMachineConfig | undefined;
  cardToPrSkill: SkillStateMachine | undefined;
  persistence: ExecutionRepository;
  prLinks: PrLinkRepository;
  pgPool: import("pg").Pool | undefined;
  nightWindowStart: string;
  nightWindowEnd: string;
  nightTz: string;
  /** Injectable seam for tests; defaults to the real engine runner. */
  runStateMachine?: typeof runStateMachine;
  now?: () => Date;
}

/**
 * Dispatches one `card-execution` job (enqueued by the night coordinator)
 * straight through the card-to-pr state machine — it has no matching Routine
 * trigger, so it bypasses engine.execute()'s routine resolution entirely.
 * Extracted out of queueHandler's closure so H7/H9's guards below are directly
 * testable without standing up the full createApp() wiring (BullMQ/Redis/real
 * skill files).
 */
export const runCardExecutionJob = async (
  deps: CardExecutionJobDeps,
  job: { trigger: { type: string; payload: unknown; executionId?: string } },
  stateMachineContextIn: StateMachineContext | undefined
): Promise<void> => {
  if (!deps.cardToPrStateMachineConfig || !deps.cardToPrSkill) {
    console.error("[Queue] card-execution job received but card-to-pr is not registered (need GITHUB_TOKEN + repos.yaml)");
    return;
  }
  const executionId = job.trigger.executionId;
  if (!executionId) {
    console.error("[Queue] card-execution job missing executionId, dropping");
    return;
  }

  const payload = job.trigger.payload as {
    source_id?: string;
    task_id?: string;
    night_id?: string;
    tier?: Tier;
    rework?: boolean;
  } | null;

  // The execution is loaded once, up front, and reused below both for the H7
  // guard's fallback and the "mark running" step — one lookup, not two.
  const executionRecord = await deps.persistence.findById(executionId);

  // H7: a job can survive in Redis past its night's window — the 06:30
  // hard-stop only kills executions already `running` (enforceHardStop's
  // `WHERE status='running'`); anything still queued in BullMQ (backlog past
  // nightParallelism, or redelivered after an app restart) would otherwise
  // run the full pipeline (CLI + PR) the next morning once the hard-stop's
  // kill frees a worker slot. Manual executions (no night_id) are untouched.
  // Same blockReason vocabulary as enforceHardStop (hard-stop.ts) so the
  // morning report reads a dropped night job identically either way.
  // payload.night_id is ALWAYS absent on a resumed job (boot reconciliation,
  // the human gate, /executions/:id/resume all re-enqueue with `payload: {}`)
  // — executionRecord.nightId (persisted once at night-coordinator INSERT
  // time, never overwritten) is the fallback that actually covers those
  // paths; the payload wins when both are present (it's a fresh dispatch).
  const nightId = payload?.night_id ?? executionRecord?.nightId;
  if (nightId) {
    const now = deps.now ?? (() => new Date());
    let stale = !isWithinWindow(now(), deps.nightWindowStart, deps.nightWindowEnd, deps.nightTz);
    if (!stale && deps.pgPool) {
      const { rows } = await deps.pgPool.query(`SELECT finished_at FROM night_runs WHERE id = $1`, [nightId]);
      stale = rows[0]?.finished_at != null;
    }
    if (stale) {
      if (executionRecord) {
        await deps.persistence.save({
          ...executionRecord,
          status: "failed",
          finishedAt: new Date(),
          error: executionRecord.error ?? "night window closed before this job could run",
          metadata: { ...(executionRecord.metadata ?? {}), blockReason: "timeout" },
        });
      }
      if (deps.pgPool && payload?.source_id && payload?.task_id) {
        // Release the claim so the NEXT night can pick this card back up —
        // same release query the PR-cap/circuit-breaker denials use in run.ts.
        await deps.pgPool.query(
          `UPDATE tasks SET claimed_by_night_id = NULL WHERE source_id = $1 AND task_id = $2 AND claimed_by_night_id = $3`,
          [payload.source_id, payload.task_id, nightId]
        );
      }
      console.log(`[Queue] card-execution ${executionId} dropped — night ${nightId} window closed`);
      return;
    }
  }

  let stateMachineContext = stateMachineContextIn;
  // Rework admission (F4 #157): a fresh rework job enters the machine at
  // rework_preparation, not preparation. A persisted (crash-resume) context
  // above always wins — it already points at the right state.
  if (!stateMachineContext && payload?.rework === true) {
    stateMachineContext = { currentState: "rework_preparation", outputs: {} };
    console.log(`[Queue] card-execution ${executionId} is a rework round — starting at rework_preparation`);
  }

  // runStateMachine never itself transitions executions.status to 'running'
  // (only fail/succeed/pause) — mark it here (fresh start or resume alike)
  // so enforceHardStop's `WHERE status='running'` query (and boot
  // reconciliation) can actually find this execution while in flight.
  // save() never writes night_id/repo back (postgres.ts's INSERT/UPDATE
  // column lists omit them on purpose), so they survive untouched here.
  if (executionRecord) await deps.persistence.save({ ...executionRecord, status: "running" });
  const event: TriggerEvent = { type: "card-execution", payload: job.trigger.payload, executionId };
  const syntheticRoutine: Routine = { id: "night-run", triggers: [{ type: "schedule", cron: "0 1 * * *" }], pipeline: { skill: "card-to-pr" } };
  const run = deps.runStateMachine ?? runStateMachine;
  const result = await Effect.runPromise(
    run(deps.cardToPrStateMachineConfig)(deps.cardToPrSkill, syntheticRoutine, event, executionId, stateMachineContext)
  );
  console.log(`[Queue] card-execution job completed: success=${result.success}`);

  // F4 #159 circuit breaker: record this card's tier outcome for the night.
  // The outcome is only observable HERE (runNightCycle enqueues and returns
  // long before the job actually runs) — `tier` and `night_id` ride along on
  // the payload run.ts already built.
  if (deps.pgPool && payload?.night_id && payload?.tier && payload?.source_id && payload?.task_id) {
    try {
      // H9b: a pre-LLM script block (this card never reached its tier's LLM
      // call at all) must not charge that tier a failure it never had a
      // chance at. blockReason lives at metadata.stateMachineContext.
      // outputs.blocked (same path morning-report.ts reads); the two
      // pre-LLM blocks are "repo-unresolvable" (preparation) and
      // "budget" (budget denial, state-machine.ts) — anything blocked
      // LATER (verify/security/review/...) did reach the tier, so it stays
      // chargeable.
      const finished = await deps.persistence.findById(executionId);
      const blocked = (
        finished?.metadata as { stateMachineContext?: { outputs?: { blocked?: { blockReason?: string } } } } | undefined
      )?.stateMachineContext?.outputs?.blocked;
      const preLlmBlock = blocked?.blockReason === "repo-unresolvable" || blocked?.blockReason === "budget";
      if (!preLlmBlock) {
        // H9a: for a rework round the pr_link ALWAYS pre-exists (rework only
        // ever starts from one), so "shipped" can't be "a link exists" — it
        // has to be "this round actually completed" (pr:rework-complete
        // stamps lastReworkNightId when it does; a blocked/aborted round
        // never reaches that step).
        const shipped = payload.rework === true
          ? (await deps.prLinks.findByTask(payload.source_id, payload.task_id)).some((l) => l.lastReworkNightId === payload.night_id)
          : result.success && (await deps.prLinks.findByTask(payload.source_id, payload.task_id)).length > 0;
        await recordTierOutcome(deps.pgPool, payload.night_id, payload.tier, shipped ? "success" : "failure");
      }
    } catch (err) {
      console.error("[Queue] Failed to record tier outcome:", err);
    }
  }
};

export interface AppConfig {
  routinesDir: string;
  skillsDir: string;
  port: number;
  kimiApiKey?: string;
  kimiModel?: string;
  /** Anthropic API key for the billed claude-api provider (judge/architecture roles). */
  anthropicApiKey?: string;
  /** --settings file passed to the headless claude-cli provider. */
  claudeCliSettingsFile?: string;
  /** Default model for the claude-cli provider. */
  claudeCliModel?: string;
  githubToken?: string;
  githubRepo?: string;
  githubWebhookSecret?: string;
  databaseUrl?: string;
  redisUrl?: string;
}

/**
 * Auth guard for mutating orchestrator routes. Single-tenant, self-hosted: no
 * user accounts. Accepts either a shared bearer token (constant-time compare)
 * or a Tailscale-injected identity header. The Tailscale path is only safe
 * because the server binds to loopback behind `tailscale serve` (see main.ts).
 * With no token configured and no Tailscale header, every mutating route fails
 * closed with 401.
 */
export const makeRequireAuth = (token: string | undefined): RequestHandler => (req, res, next) => {
  const tsUser = req.header("Tailscale-User-Login");
  if (tsUser && tsUser.trim() !== "") {
    next();
    return;
  }

  const header = req.header("Authorization") ?? "";
  const prefix = "Bearer ";
  if (token && header.startsWith(prefix)) {
    const provided = Buffer.from(header.slice(prefix.length));
    const expected = Buffer.from(token);
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      next();
      return;
    }
  }

  res.status(401).json({ error: "Unauthorized" });
};

/** One-shot Redis reachability probe using a short-lived dedicated client. */
export const pingRedis = async (redisUrl: string): Promise<void> => {
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
  });
  try {
    await client.connect();
    await client.ping();
  } finally {
    client.disconnect();
  }
};

/**
 * Run the active-dependency health checks in parallel. Each probe is optional
 * (absent → reported as "in-memory"); a rejected probe is "error". Injectable
 * probes keep this unit-testable without a live Postgres/Redis.
 */
export const checkHealth = async (deps: {
  pg?: () => Promise<unknown>;
  redis?: () => Promise<unknown>;
  cronOk: boolean;
}): Promise<{ checks: Record<string, string>; healthy: boolean }> => {
  const [pg, redis] = await Promise.allSettled([
    deps.pg ? deps.pg() : Promise.resolve(undefined),
    deps.redis ? deps.redis() : Promise.resolve(undefined),
  ]);
  const checks: Record<string, string> = {
    postgres: deps.pg ? (pg.status === "fulfilled" ? "ok" : "error") : "in-memory",
    redis: deps.redis ? (redis.status === "fulfilled" ? "ok" : "error") : "in-memory",
    cron: deps.cronOk ? "ok" : "error",
  };
  return { checks, healthy: !Object.values(checks).includes("error") };
};

export const createApp = async (config: AppConfig) => {
  // 1. Load routines from filesystem
  const routines: Routine[] = [];
  try {
    const files = readdirSync(config.routinesDir);
    for (const file of files) {
      if (file.endsWith(".yaml") || file.endsWith(".yml")) {
        const content = readFileSync(join(config.routinesDir, file), "utf-8");
        routines.push(parseRoutine(content));
      }
    }
  } catch {
    console.warn(`[App] No routines found in ${config.routinesDir}`);
  }

  console.log(`[App] Loaded ${routines.length} routines`);

  // 1b. Night coordinator config (F3 #147) — read once, reused by the BullMQ
  // worker concurrency below and by the night-coordinator deps further down.
  const nightWindowStart = process.env.NIGHT_WINDOW_START ?? "01:00";
  const nightWindowEnd = process.env.NIGHT_WINDOW_END ?? "06:30";
  // F5 #168 (D32): operational caps come from the versioned, bounds-checked
  // policy.yaml — no env fallback. A missing/invalid file fails boot loud and
  // clear here rather than silently applying a hardcoded default.
  const policy = loadPolicy(process.env.POLICY_PATH ?? "policy.yaml");
  const nightBudgetUsd = policy.night.budget_usd;
  const nightPrCap = policy.night.max_prs_per_night;
  const perRepoOpenPrCap = policy.backpressure.max_open_prs_per_repo;
  const nightParallelism = Math.max(1, Math.min(3, parseInt(process.env.NIGHT_PARALLELISM ?? "2", 10) || 2));
  const nightTz = process.env.TZ ?? "America/Sao_Paulo";

  // 2. Setup persistence
  const persistence = config.databaseUrl
    ? makePostgresRepository({ connectionString: config.databaseUrl })
    : makeInMemoryRepository();

  if (config.databaseUrl && "migrate" in persistence && typeof (persistence as { migrate?: unknown }).migrate === "function") {
    await (persistence as { migrate: () => Promise<void> }).migrate();
    console.log("[App] PostgreSQL migrations applied");
  }

  // 2b. Setup gate repository
  const gateRepository = config.databaseUrl
    ? makePostgresGateRepository({ connectionString: config.databaseUrl })
    : makeInMemoryGateRepository();

  if (config.databaseUrl && "migrate" in gateRepository && typeof (gateRepository as { migrate?: unknown }).migrate === "function") {
    await (gateRepository as { migrate: () => Promise<void> }).migrate();
    console.log("[App] Gate migrations applied");
  }

  const gateEngine = makeGateEngine({ repository: gateRepository });

  // 2c. Setup span and feedback repositories
  const pgPool = config.databaseUrl
    ? (persistence as unknown as { pool: import("pg").Pool }).pool
    : undefined;
  const spanRepository: SpanRepository = pgPool
    ? makePostgresSpanRepository(pgPool)
    : makeInMemorySpanRepository();

  const feedbackRepository: FeedbackRepository = pgPool
    ? makePostgresFeedbackRepository(pgPool)
    : makeInMemoryFeedbackRepository();

  const runStateRepository = pgPool
    ? makePostgresRunRepository(pgPool)
    : undefined;

  const fileMetadataRepository = pgPool
    ? makePostgresFileMetadataRepository(pgPool)
    : makeInMemoryFileMetadataRepository();

  // Track spawned coarse-state processes so timeouts kill the group and boot
  // reaps zombies. Postgres-only (real processes only matter in production).
  const executionProcessRepository = pgPool
    ? makePostgresExecutionProcessRepository(pgPool)
    : undefined;

  if (executionProcessRepository) {
    try {
      const cleanup = await cleanupZombieProcesses(executionProcessRepository);
      console.log(`[App] Zombie process cleanup: checked ${cleanup.checked}, killed ${cleanup.killed}`);
    } catch (err) {
      console.error("[App] Zombie process cleanup failed:", err);
    }
  }

  // card <-> PR linkage (F3 #146/#147) — one instance shared by the card-to-pr
  // script handlers and the night-coordinator's PR-cap check below.
  const prLinks = pgPool ? makePostgresPrLinkRepository(pgPool) : makeInMemoryPrLinkRepository();

  // F5 #166 tactical memory — optional StateMachineConfig deps; absent keeps
  // the engine behavior identical, so constructing them unconditionally is safe.
  const repoLearnings = pgPool ? makePostgresRepoLearningRepository(pgPool) : makeInMemoryRepoLearningRepository();
  const tacticalTasks = pgPool ? makePostgresTaskRepository(pgPool) : makeInMemoryTaskRepository();

  // 3. Setup provider(s)
  // Default provider — used by markdown/ReAct skills and by state-machine states
  // that do not declare `provider:`. State-machine states can override per state
  // via the name-keyed registry below.
  let provider: Parameters<typeof makeEngine>[0]["provider"];
  if (config.kimiApiKey) {
    provider = makeKimiCodingProvider({
      apiKey: config.kimiApiKey,
      model: config.kimiModel,
    });
    console.log("[App] Using Kimi Coding API provider");
  } else {
    provider = makeKimiCliProvider({
      model: config.kimiModel,
    });
    console.log("[App] Using Kimi CLI provider (local)");
  }

  const providerRegistry = makeProviderRegistry({
    kimiCli: { model: config.kimiModel },
    claudeCli: {
      settingsFile: config.claudeCliSettingsFile,
      model: config.claudeCliModel,
      processRepository: executionProcessRepository,
    },
    claudeApi: config.anthropicApiKey ? { apiKey: config.anthropicApiKey } : undefined,
  });
  const scriptRegistry = makeScriptRegistry();
  console.log(
    `[App] Provider registry ready (claude-api: ${config.anthropicApiKey ? "on" : "off"})`
  );

  // 4. Setup tool registry (GitHub tools if configured)
  const toolRegistry = new ToolRegistry();
  if (config.githubToken && config.githubRepo) {
    const githubTools = makeGitHubTools({
      token: config.githubToken,
      repo: config.githubRepo,
    });
    toolRegistry.registerMany(githubTools);
    console.log(`[App] Registered ${githubTools.length} GitHub tools`);
  }

  // Legacy ReAct micro-tools (filesystem + git worktree) — the execution
  // primitives of the pre-F1 solve-issue loop, including run_shell (arbitrary
  // shell). Disabled by default so they are never implicitly reachable via
  // /trigger; the operator opts in with OPENROUTINES_LEGACY_TOOLS=1 until skills
  // migrate to the Claude Code CLI executor (F1).
  if (process.env.OPENROUTINES_LEGACY_TOOLS === "1") {
    const legacyTools = [...makeFilesystemTools(), ...makeGitWorktreeTools()];
    toolRegistry.registerMany(legacyTools);
    console.log(`[App] Registered ${legacyTools.length} legacy micro-tools (OPENROUTINES_LEGACY_TOOLS=1)`);
  } else {
    console.log("[App] Legacy micro-tools disabled (set OPENROUTINES_LEGACY_TOOLS=1 for pre-F1 solve-issue)");
  }

  // Money/rate-limit gate (F3 #147), wired into the state-machine runner for
  // card-execution jobs only (see cardToPrStateMachineConfig below). `phase` is
  // the state id; `tier` is the state's declared model (falling back to
  // provider). No pgPool (in-memory/dev mode) -> undefined -> no gating at all.
  const budgetGate = pgPool
    ? async ({ phase, tier, executionId }: { phase: string; tier: string; executionId: string }) => {
        const { rows } = await pgPool.query("SELECT night_id FROM executions WHERE id = $1", [executionId]);
        const nightId = rows[0]?.night_id as string | undefined;
        if (!nightId) return { granted: true }; // no night = manual run, no cap
        const resolvedTier = normalizeBudgetTier(tier);
        return reserveBudget(pgPool, {
          nightId,
          executionId,
          phase,
          tier: resolvedTier,
          estimatedUnits: BUDGET_UNIT_WEIGHTS[resolvedTier],
        });
      }
    : undefined;
  // NO budgetSettle in F3: the budget is counted in per-tier EFFORT UNITS (D3
  // subscription login — there is no per-token billing), so a reservation IS the
  // permanent charge. Settling with the invocation's real USD cost (which is 0
  // under the subscription) would collapse the running total and let the night
  // cap be overrun without bound. settleBudget stays a Wave A primitive for a
  // future token-billing tier; the effort model reconciles nothing.

  // 4b. Setup card-to-pr script handlers (F3 #146) — the deterministic states
  // of the card-to-pr pilot skill. Gated on a GitHub token (the pilot can't
  // push/open a PR without one); repos.yaml/task-sources.yaml are optional in
  // dev, so a missing/invalid one is logged and skipped rather than crashing boot.
  // repoRegistry/cardToPrSkill/cardToPrStateMachineConfig are hoisted (not
  // block-scoped) because the night-coordinator wiring and the card-execution
  // queue dispatch below both need them.
  let repoRegistry: import("./repo-registry/schema.js").RepoRegistry | undefined;
  let cardToPrSkill: SkillStateMachine | undefined;
  let cardToPrStateMachineConfig: StateMachineConfig | undefined;
  // Hoisted so the night-coordinator (which syncs these sources' queues into
  // `tasks`) can reuse the same live TaskSource instances built below.
  let cardTaskSources: Map<string, TaskSource> | undefined;
  // Hoisted resolved Trello auth (F5 #169) — the steering poll wiring below
  // (outside the `if (config.githubToken)` block where resolvedSources lives)
  // needs board + key + token + sourceId to read comments and seed cards.
  let trelloSteeringConfig: { boardId: string; apiKey: string; apiToken: string; sourceId: string } | undefined;

  if (config.githubToken) {
    // git_commit is commit-only (no push — D13, the orchestrator owns the
    // remote), so it is safe to promote to the always-on toolset. The rest of
    // the legacy git-worktree tools (create/remove worktree, run_shell) stay
    // behind OPENROUTINES_LEGACY_TOOLS: they carry real destructive power
    // (force-delete a branch by name/path) and predate the F1 per-state tool
    // allowlist. card-to-pr's implementation state declares only `git_commit`
    // in its own `tools:` list anyway — its worktree is created by the
    // deterministic preparation script, never by an LLM tool call.
    const gitCommitTool = makeGitWorktreeTools().find((t) => t.definition.name === "git_commit");
    if (gitCommitTool) {
      toolRegistry.registerMany([gitCommitTool]);
      console.log("[App] Registered git_commit tool (commit-only, no push)");
    }

    try {
      repoRegistry = loadRepoRegistry();
    } catch (err) {
      console.warn("[App] repos.yaml not loaded, card-to-pr disabled:", err instanceof Error ? err.message : err);
    }

    if (repoRegistry) {
      let resolvedSources: ResolvedTaskSource[] = [];
      try {
        resolvedSources = loadTaskSources();
      } catch (err) {
        console.warn(
          "[App] task-sources.yaml not loaded, card-to-pr TaskSource lookups will be empty:",
          err instanceof Error ? err.message : err
        );
      }

      cardTaskSources = new Map<string, TaskSource>();
      for (const resolved of resolvedSources) {
        try {
          cardTaskSources.set(resolved.entry.id, buildTaskSource(resolved));
        } catch (err) {
          console.warn(`[App] Skipping task source '${resolved.entry.id}':`, err instanceof Error ? err.message : err);
        }
      }

      const trelloEntry = resolvedSources.find((s) => s.entry.type === "trello");
      const trelloKey = trelloEntry?.entry.auth.key ? process.env[trelloEntry.entry.auth.key] : undefined;
      const trelloToken = trelloEntry?.entry.auth.token ? process.env[trelloEntry.entry.auth.token] : undefined;
      if (trelloEntry?.entry.containers.board && trelloKey && trelloToken) {
        trelloSteeringConfig = {
          boardId: trelloEntry.entry.containers.board,
          apiKey: trelloKey,
          apiToken: trelloToken,
          sourceId: trelloEntry.entry.id,
        };
      }

      // One action ledger shared by every pipeline that fires idempotent
      // external effects (card-to-pr PR/push/handoff, card-research delivery,
      // card-mapping pr_docs). Keyed by (executionId, actionKey) so a single
      // instance never collides across pipelines.
      const actionLedger = pgPool ? makePostgresActionLedgerRepository(pgPool) : makeInMemoryActionLedgerRepository();

      registerCardToPrHandlers(scriptRegistry, {
        pool: pgPool,
        registry: repoRegistry,
        githubToken: config.githubToken,
        worktreeBase: process.env.WORKTREE_BASE ?? "/tmp/or-worktrees",
        // Bloco 1 — resolve/clone a card's repo by name under REPOS_BASE_DIR.
        reposBaseDir: process.env.REPOS_BASE_DIR,
        allowedOwners: (process.env.ALLOWED_REPO_OWNERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        ledger: actionLedger,
        prLinks,
        taskSourceFor: (sourceId) => cardTaskSources?.get(sourceId),
        // Visual phase (F5 #160): Kimi-with-MCP navigates + judges; Sonnet
        // vision (claude-api) escalates low-confidence/brand-fidelity items —
        // wired only when ANTHROPIC_API_KEY exists (else escalation is skipped
        // and the Kimi verdict stands, degraded but functional). compose/SSIM/
        // attach seams use their real defaults.
        visual: {
          agentProvider: providerRegistry.resolve("kimi-cli", "kimi-k2.6"),
          visionProvider: config.anthropicApiKey
            ? providerRegistry.resolve("claude-api", "claude-sonnet-5")
            : undefined,
        },
      });
      console.log("[App] Registered card-to-pr script handlers");

      registerResearchHandlers(scriptRegistry, {
        registry: repoRegistry,
        githubToken: config.githubToken,
        worktreeBase: process.env.WORKTREE_BASE ?? "/tmp/or-worktrees",
        taskSourceFor: (sourceId) => cardTaskSources?.get(sourceId),
        claudeApiKey: config.anthropicApiKey ?? "",
        // F5 #162 hardening: makes delivery's issue/milestone creation idempotent
        // (a crash mid-delivery + resume no longer duplicates GitHub issues).
        ledger: actionLedger,
      });
      console.log("[App] Registered card-research script handlers");

      // card-mapping (F5 #162): read-broad survey -> docs-only PR
      // (REPO-PROFILE.md + visual profile). scan runs on Sonnet CLI;
      // visual_capture reuses card-to-pr's Kimi-with-Playwright-MCP provider and
      // the shared compose-lifecycle. Wired whenever card-to-pr is (same
      // GITHUB_TOKEN + repos.yaml gate).
      registerMappingHandlers(scriptRegistry, {
        registry: repoRegistry,
        githubToken: config.githubToken,
        worktreeBase: process.env.WORKTREE_BASE ?? "/tmp/or-worktrees",
        ledger: actionLedger,
        taskSourceFor: (sourceId) => cardTaskSources?.get(sourceId),
        visual: {
          agentProvider: providerRegistry.resolve("kimi-cli", "kimi-k2.6"),
        },
      });
      console.log("[App] Registered card-mapping script handlers");

      // The night-run coordinator dispatches card-execution jobs by calling
      // runStateMachine directly (queueHandler §6) rather than engine.execute():
      // a card-execution trigger matches no routine (night-run.yaml's own
      // trigger is `schedule`), so the generic routine resolution would fail.
      // Build the skill + runner config once here, reused per card-execution job.
      try {
        const loaded = loadSkill(config.skillsDir, "card-to-pr");
        if (loaded.format === "state-machine") {
          cardToPrSkill = loaded.stateMachine;
          cardToPrStateMachineConfig = {
            provider: provider as Parameters<typeof makeEngine>[0]["provider"],
            providerRegistry,
            scriptRegistry,
            repository: persistence,
            runStateRepository,
            fileMetadataRepository,
            gateEngine,
            toolRegistry,
            budgetGate,
            // budgetSettle intentionally omitted — see the effort-unit note above.
            // Named `type: fanout` aggregators (F4 #153) — card-to-pr's `review`
            // state declares `aggregate: aggregateReview`; without this the
            // runner fails that state (fanoutAggregators lookup miss). Cast:
            // aggregateReview's return type is the named ReviewOutput (no
            // index signature) rather than FanoutAggregator's generic
            // Record<string, unknown> — same values at runtime, TS just wants
            // an index signature on the nominal type; not modifying
            // src/review/aggregate.ts's own return type for this.
            fanoutAggregators: cardToPrFanoutAggregators as unknown as StateMachineConfig["fanoutAggregators"],
            // F4 #185 (D9): routes implementation's provider/model by the
            // card's complexity/altaImpl (falls back to the YAML's static
            // claude-cli/claude-sonnet-5 for every other state, unchanged).
            resolveDynamicProvider: resolveCardToPrDynamicProvider,
            repoLearnings,
            similarCards: makeSimilarCards({
              executions: persistence,
              prLinks,
              tasks: tacticalTasks,
              runStates: runStateRepository,
            }),
          };
        }
      } catch (err) {
        console.warn(
          "[App] card-to-pr skill.yaml not loaded, night-run card dispatch disabled:",
          err instanceof Error ? err.message : err
        );
      }

      // 4c. Morning-report script handlers (F4 #159, 07:30 digest) — reuses
      // this same pgPool/cardTaskSources/repoRegistry. Dispatches as a NORMAL
      // routine (routineId-forced resolution, src/routine/matcher.ts), not a
      // queueHandler interception: every state is type:script, so the shared
      // `engine` (step 5 below) already runs it end to end.
      if (pgPool) {
        const trelloEntry = resolvedSources.find((s) => s.entry.type === "trello");
        const trelloBoardId = trelloEntry?.entry.containers.board;
        const trelloApiKey = trelloEntry?.entry.auth.key ? process.env[trelloEntry.entry.auth.key] : undefined;
        const trelloApiToken = trelloEntry?.entry.auth.token ? process.env[trelloEntry.entry.auth.token] : undefined;
        // makeTrelloCreateCard (connector/trello.ts) creates in an arbitrary
        // list and returns {cardId,url}; morning-report only ever wants
        // MORNING_REPORT_TRELLO_LIST and its deps.createCard predates that
        // general shape, so adapt here rather than changing MorningReportDeps.
        const trelloCreateCard =
          trelloBoardId && trelloApiKey && trelloApiToken
            ? makeTrelloCreateCard({ boardId: trelloBoardId, apiKey: trelloApiKey, apiToken: trelloApiToken })
            : undefined;
        const createCard = trelloCreateCard
          ? async (title: string) => {
              const { cardId, url } = await trelloCreateCard({ listName: MORNING_REPORT_TRELLO_LIST, title });
              return { id: cardId, url };
            }
          : async () => {
              throw new Error("morning-report: no Trello source configured (need a 'trello' entry in task-sources.yaml)");
            };
        registerMorningReportHandlers(scriptRegistry, {
          pool: pgPool,
          tz: nightTz,
          taskSourceFor: (sourceId) => cardTaskSources?.get(sourceId),
          sourceId: trelloEntry?.entry.id ?? "trello-main",
          createCard,
          resolveGithubRepo: (slug) => repoRegistry?.repos[slug]?.githubRepo,
        });
        console.log("[App] Registered morning-report script handlers");
      }
    }
  } else {
    console.log("[App] No GITHUB_TOKEN configured, card-to-pr script handlers not registered");
  }

  // 5. Setup engine
  const engine = makeEngine({
    routines,
    skillsDir: config.skillsDir,
    provider: provider as Parameters<typeof makeEngine>[0]["provider"],
    providerRegistry,
    scriptRegistry,
    repository: persistence,
    toolRegistry,
    gateEngine,
    spanRepository,
    runStateRepository,
    fileMetadataRepository,
  });

  // Night-coordinator deps (F3 #147): assigned below, right after `queue` is
  // built (runNightCycle enqueues onto it) — declared here so the closures in
  // queueHandler and the /trigger/night-run route (defined later) see the
  // final value; both only read it once actually invoked, well after createApp
  // has finished assigning it.
  let nightCoordinatorDeps: RunNightCycleDeps | undefined;
  // PR-review poller deps (F4 #157) — same gating/lifecycle as the coordinator.
  let prReviewPollDeps: PrReviewPollDeps | undefined;
  // Steering poller deps (F5 #169) — runs on the same daytime tick as PR-review.
  let steeringPollDeps: SteeringPollDeps | undefined;
  // Degraded-mode unblock poller deps (F5 #163) — same daytime tick, Trello-only.
  let degradedModeUnblockDeps: DegradedModeUnblockDeps | undefined;

  // 6. Setup queue (connects to engine)
  const queueHandler = async (job: { id?: string; routineId?: string; trigger: { type: string; payload: unknown; executionId?: string } }) => {
    // Night-run cron tick: run the coordinator cycle itself, not a generic
    // skill dispatch (night-run.yaml's pipeline.skill is only a placeholder —
    // it is never loaded/executed by engine.execute() for this trigger).
    if (job.routineId === "night-run" && job.trigger.type === "schedule") {
      if (!nightCoordinatorDeps) {
        console.warn("[Queue] night-run cron fired but the night coordinator is not wired (need DATABASE_URL + GITHUB_TOKEN + repos.yaml)");
        return;
      }
      const summary = await runNightCycle(nightCoordinatorDeps);
      console.log(`[Queue] Night cycle: ${JSON.stringify(summary)}`);
      return;
    }

    // PR-review poll tick (F4 #157): sweep open pr_links for review-state
    // transitions (CHANGES_REQUESTED -> card back to Working, merged/closed ->
    // link closed). Same interception pattern as night-run.
    if (job.routineId === "pr-review-poll" && job.trigger.type === "schedule") {
      // Two independent sweeps share this daytime tick: the GitHub PR-review
      // poll (F4 #157) and the Trello human-steering poll (F5 #169). Each runs
      // if wired; neither gates the other (steering needs no GitHub token).
      if (prReviewPollDeps) {
        const summary = await runPrReviewPoll(prReviewPollDeps);
        console.log(`[Queue] PR review poll: ${JSON.stringify(summary)}`);
      } else {
        console.warn("[Queue] pr-review-poll cron fired but the poller is not wired (need DATABASE_URL + GITHUB_TOKEN + repos.yaml)");
      }
      if (steeringPollDeps) {
        const summary = await runSteeringPoll(steeringPollDeps);
        console.log(`[Queue] Steering poll: ${JSON.stringify(summary)}`);
      }
      // Degraded-mode unblock sweep (F5 #163): a Mapping card reaching Done ->
      // its linked Blocked cards return to the queue. Independent of the two
      // sweeps above (Trello-only, no GitHub token needed).
      if (degradedModeUnblockDeps) {
        const summary = await runDegradedModeUnblockPoll(degradedModeUnblockDeps);
        console.log(`[Queue] Degraded-mode unblock poll: ${JSON.stringify(summary)}`);
      }
      return;
    }

    // Daytime triage tick (F5 #170): the routine's schedule is live, but its
    // `card-triage` skill is an F2 deliverable that does not exist yet, and no
    // runtime dispatcher routes a research card into card-research. Intercept
    // it here (same pattern as night-run) so the cron is a harmless no-op
    // instead of failing to load a missing skill every 30 minutes. Swap this
    // for the real classify -> checkProfileAndBlock (#163) / dispatchResearch-
    // IfEligible (#170) call once the triage classifier lands.
    if (job.routineId === "card-triage" && job.trigger.type === "schedule") {
      console.log("[Queue] card-triage tick: dispatch deferred (F2 triage skill not yet implemented)");
      return;
    }

    // Night hard-stop cron tick (F3 #147): kill anything still running past the
    // window and close the night. runNightCycle can't do this itself (it drains
    // and returns at 01:00), so it lives in its own scheduled tick.
    if (job.routineId === "night-hard-stop" && job.trigger.type === "schedule") {
      if (!nightCoordinatorDeps) {
        console.warn("[Queue] night-hard-stop cron fired but the night coordinator is not wired");
        return;
      }
      const result = await runNightHardStop({
        pool: nightCoordinatorDeps.pool,
        executionRepo: nightCoordinatorDeps.executionRepo,
        executionProcessRepo: nightCoordinatorDeps.executionProcessRepo,
        tz: nightCoordinatorDeps.tz,
      });
      console.log(`[Queue] Night hard-stop: ${JSON.stringify(result)}`);
      return;
    }

    // Load state machine context for resumed executions
    let stateMachineContext: StateMachineContext | undefined;
    if (job.trigger.executionId) {
      const existing = await persistence.findById(job.trigger.executionId);
      const ctx = existing?.metadata?.stateMachineContext as StateMachineContext | undefined;
      if (ctx) {
        stateMachineContext = ctx;
        console.log(`[Queue] Resuming execution ${job.trigger.executionId} at state ${ctx.currentState}`);
      }
    }

    // A card-execution job (enqueued by the night coordinator) runs the
    // card-to-pr skill directly — it has no matching Routine trigger, so it
    // bypasses engine.execute()'s routine resolution entirely. See
    // runCardExecutionJob for the H7 (stale-night guard) / H9 (circuit
    // breaker attribution) logic.
    if (job.trigger.type === "card-execution") {
      await runCardExecutionJob(
        {
          cardToPrStateMachineConfig,
          cardToPrSkill,
          persistence,
          prLinks,
          pgPool,
          nightWindowStart,
          nightWindowEnd,
          nightTz,
        },
        job,
        stateMachineContext
      );
      return;
    }

    const result = await Effect.runPromise(
      engine.execute({
        type: job.trigger.type,
        payload: job.trigger.payload,
        routineId: job.routineId,
        executionId: job.trigger.executionId,
      }, stateMachineContext)
    );
    console.log(`[Queue] Job completed: success=${result.success}`);

    // Auto-tag execution based on spans
    if (result.executionId) {
      try {
        const execution = await persistence.findById(result.executionId);
        const spans = await spanRepository.findByExecution(result.executionId);
        if (execution) {
          const analysis = analyzeExecution(execution, spans);
          await persistence.save({
            ...execution,
            metadata: {
              ...(execution.metadata || {}),
              autoTags: analysis.autoTags,
              insights: analysis.insights,
              riskLevel: analysis.riskLevel,
            },
          });
        }
      } catch (err) {
        console.error("[Queue] Failed to auto-tag execution:", err);
      }
    }
  };

  const queue = config.redisUrl
    ? makeBullMqQueue({ redisUrl: config.redisUrl, handler: queueHandler, concurrency: nightParallelism })
    : makeInMemoryQueue(queueHandler);

  // Night-coordinator deps (F3 #147): only meaningful with a real Postgres
  // (the lock/claim/budget primitives need real transactions) and a resolved
  // repos.yaml + GitHub token (same gating as the card-to-pr handlers above).
  // Assigned AFTER `queue` exists (runNightCycle enqueues onto it) — read by
  // queueHandler and /trigger/night-run above/below via closure, both of which
  // only fire well after createApp has returned.
  if (pgPool && repoRegistry && config.githubToken) {
    // Shared across the coordinator and the steering poll (F5 #169): the
    // Blocked-resume admission reads what the poll persists.
    const cardSteeringRepo = makePostgresCardSteeringRepository(pgPool);
    const nightTaskRepo = makePostgresTaskRepository(pgPool);
    nightCoordinatorDeps = {
      pool: pgPool,
      registry: repoRegistry,
      queue,
      executionRepo: persistence,
      // Guaranteed defined: executionProcessRepository is built from this same
      // pgPool check above (step 2c).
      executionProcessRepo: executionProcessRepository!,
      prLinks,
      githubToken: config.githubToken,
      nightWindowStart,
      nightWindowEnd,
      nightBudgetUsd,
      nightPrCap,
      perRepoOpenPrCap,
      circuitBreakerFailureRate: policy.night.circuit_breaker_failure_rate,
      nightParallelism,
      tz: nightTz,
      // Ingest these sources' queued cards into `tasks` at cycle start (F2's
      // poller runtime is unwired) so the claim loop has rows to claim.
      sources: cardTaskSources ? [...cardTaskSources.keys()] : [],
      taskSourceFor: (id) => cardTaskSources?.get(id),
      taskRepo: nightTaskRepo,
      cardSteering: cardSteeringRepo,
    };
    prReviewPollDeps = {
      prLinks,
      registry: repoRegistry,
      githubToken: config.githubToken,
      taskSourceFor: (id) => cardTaskSources?.get(id),
      // F5 #165: mine review comments into pr_feedback on merge so the weekly
      // calibration loop has data. computeHumanDelta (the agent-commit..merge
      // diff) is a deferred F6 seam — comment mining runs without it.
      prFeedback: makePostgresPrFeedbackRepository(pgPool),
    };
    console.log("[App] Night coordinator wired (POST /trigger/night-run, cron 0 1 * * *)");
    console.log("[App] PR-review poller wired (cron */30 8-22 * * *)");

    // Steering poll (F5 #169): whitelisted humans steer via 🧭 comments. Needs
    // a resolved Trello source (board/key/token) and a live TaskSource for it.
    const steeringTaskSource = trelloSteeringConfig ? cardTaskSources?.get(trelloSteeringConfig.sourceId) : undefined;
    if (trelloSteeringConfig && steeringTaskSource) {
      const whitelist = (process.env.TRELLO_STEERING_WHITELIST ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      steeringPollDeps = {
        sourceId: trelloSteeringConfig.sourceId,
        taskSource: steeringTaskSource,
        cardSteering: cardSteeringRepo,
        pollState: makePostgresPollStateRepository(pgPool),
        prLinks,
        taskRepo: nightTaskRepo,
        readComments: makeTrelloReadComments(trelloSteeringConfig),
        createCard: makeTrelloCreateCard(trelloSteeringConfig),
        linkCards: makeTrelloLinkCards(trelloSteeringConfig),
        whitelist,
      };
      console.log(
        `[App] Steering poller wired (cron */30 8-22 * * *, whitelist: ${whitelist.length} member(s))`
      );
    } else {
      console.log("[App] Steering poller not wired (need a 'trello' task source with key+token)");
    }

    // Degraded-mode unblock poll (F5 #163): same Trello source as steering, no
    // GitHub token needed — reacts to a Mapping card reaching Done.
    if (trelloSteeringConfig && steeringTaskSource) {
      degradedModeUnblockDeps = {
        sourceId: trelloSteeringConfig.sourceId,
        taskSource: steeringTaskSource,
        pollState: makePostgresPollStateRepository(pgPool),
        readLinkedCards: makeTrelloReadLinkedCards(trelloSteeringConfig),
      };
      console.log("[App] Degraded-mode unblock poller wired (cron */30 8-22 * * *)");
    }
  } else {
    console.log("[App] Night coordinator not wired (need DATABASE_URL + GITHUB_TOKEN + repos.yaml)");
  }

  // 6b. Boot reconciliation (F3 #149): recover executions left `running` by a
  // crashed run — reset their worktree, re-enqueue from the persisted phase
  // frontier. Runs after the queue/worker exist (so resumed jobs are picked up)
  // and before main.ts calls app.listen (so /trigger cannot re-claim a card
  // mid-reconciliation). action_ledger prevents any external effect duplicating.
  try {
    const recon = await reconcileOrphanedExecutions({
      executionRepo: persistence,
      queue,
      executionProcessRepo: executionProcessRepository,
      // Same default as worktree CREATION (the card-to-pr handlers) — the reset
      // fence and the worktrees it guards must resolve to the identical base.
      worktreeBase: process.env.WORKTREE_BASE ?? "/tmp/or-worktrees",
    });
    if (recon.resumed.length || recon.failed.length) {
      console.log(
        `[App] Boot reconciliation: resumed ${recon.resumed.length}, failed ${recon.failed.length}`
      );
    }
  } catch (err) {
    console.error("[App] Boot reconciliation failed:", err);
  }

  // 7. Setup cron scheduler
  const cronScheduler = new CronScheduler({
    routines,
    queue,
    timezone: process.env.TZ,
  });

  // 8. Setup Express app
  const app = express();
  const requireAuth = makeRequireAuth(process.env.OPENROUTINES_API_TOKEN);
  const expectedCronTasks = routines.filter((r) => r.triggers.some((t) => t.type === "schedule")).length;

  if (config.githubWebhookSecret) {
    setupGitHubWebhook(app, {
      secret: config.githubWebhookSecret,
      queue,
    });
    console.log("[App] GitHub webhook endpoint: POST /webhooks/github");
  }

  // Night coordinator trigger (F3 #147) — registered BEFORE /trigger/:routineId
  // so this literal path always wins the match; night-run is not a single
  // skill/execution, so it gets its own route rather than /trigger/:routineId.
  app.post("/trigger/night-run", requireAuth, async (_req, res) => {
    if (!nightCoordinatorDeps) {
      res.status(503).json({ error: "Night coordinator not configured (need DATABASE_URL + GITHUB_TOKEN + repos.yaml)" });
      return;
    }
    try {
      const summary = await runNightCycle(nightCoordinatorDeps);
      res.status(summary.started ? 200 : 409).json(summary);
    } catch (err) {
      console.error("[Trigger] Night cycle failed:", err);
      res.status(500).json({ error: "Night cycle failed", details: String(err) });
    }
  });

  // Manual trigger endpoint
  app.post("/trigger/:routineId", requireAuth, express.json(), async (req, res) => {
    const routine = routines.find((r) => r.id === req.params.routineId);
    if (!routine) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }

    const triggerType = routine.triggers[0]?.type ?? "api";

    try {
      const result = await Effect.runPromise(
        engine.execute({
          type: triggerType,
          payload: req.body,
          routineId: routine.id,
        })
      );
      res.status(result.success ? 200 : 500).json(result);
    } catch (err) {
      console.error("[Trigger] Execution failed:", err);
      res.status(500).json({ error: "Execution failed", details: String(err) });
    }
  });

  // Execution management API
  app.get("/executions", async (_req, res) => {
    try {
      const limit = Math.min(parseInt(String(_req.query.limit ?? "100"), 10), 1000);
      const offset = parseInt(String(_req.query.offset ?? "0"), 10);
      const records = await persistence.findAll({ limit, offset });
      res.json({ records, limit, offset });
    } catch (err) {
      console.error("[API] Failed to list executions:", err);
      res.status(500).json({ error: "Failed to list executions" });
    }
  });

  app.get("/executions/:id", async (req, res) => {
    try {
      const record = await persistence.findById(req.params.id);
      if (!record) {
        res.status(404).json({ error: "Execution not found" });
        return;
      }
      res.json(record);
    } catch (err) {
      console.error("[API] Failed to get execution:", err);
      res.status(500).json({ error: "Failed to get execution" });
    }
  });

  // Gate management API
  app.get("/gates/:executionId", async (req, res) => {
    try {
      const gate = await gateRepository.findByExecution(req.params.executionId);
      if (!gate) {
        res.status(404).json({ error: "Gate not found" });
        return;
      }
      res.json(gate);
    } catch (err) {
      console.error("[API] Failed to get gate:", err);
      res.status(500).json({ error: "Failed to get gate" });
    }
  });

  app.post("/gates/:executionId/approve", requireAuth, express.json(), async (req, res) => {
    try {
      const gate = await gateRepository.findByExecution(req.params.executionId);
      if (!gate) {
        res.status(404).json({ error: "Gate not found" });
        return;
      }
      await gateEngine.approve(gate.id, req.body.reason);

      // Retomar execução pausada. Use the execution's OWN triggerType (set once
      // at creation from the real event.type — same field boot-reconciliation
      // re-enqueues with), never a routine-derived guess: night-run's routine
      // trigger is `schedule`, but a card-execution job it spawned (e.g. paused
      // at solve-issue's pr_gate) must resume as `card-execution`, not restart
      // the whole night cycle (F3 #147).
      const execution = await persistence.findById(req.params.executionId);
      if (execution && execution.status === "paused") {
        const routine = routines.find((r) => r.id === execution.routineId);
        if (routine) {
          queue.enqueue({
            id: execution.id,
            routineId: routine.id,
            trigger: {
              type: execution.triggerType,
              payload: {},
              executionId: execution.id,
            },
          }).catch((err) => console.error("[Gate] Failed to re-enqueue:", err));
        }
      }

      res.json({ approved: true, gateId: gate.id, resumed: execution?.status === "paused" });
    } catch (err) {
      console.error("[API] Failed to approve gate:", err);
      res.status(500).json({ error: "Failed to approve gate" });
    }
  });

  app.post("/gates/:executionId/reject", requireAuth, express.json(), async (req, res) => {
    try {
      const gate = await gateRepository.findByExecution(req.params.executionId);
      if (!gate) {
        res.status(404).json({ error: "Gate not found" });
        return;
      }
      await gateEngine.reject(gate.id, req.body.reason);
      res.json({ rejected: true, gateId: gate.id });
    } catch (err) {
      console.error("[API] Failed to reject gate:", err);
      res.status(500).json({ error: "Failed to reject gate" });
    }
  });

  // Resume paused execution manually
  app.post("/executions/:id/resume", requireAuth, async (req, res) => {
    try {
      const execution = await persistence.findById(req.params.id);
      if (!execution) {
        res.status(404).json({ error: "Execution not found" });
        return;
      }
      if (execution.status !== "paused") {
        res.status(400).json({ error: "Execution is not paused" });
        return;
      }
      const routine = routines.find((r) => r.id === execution.routineId);
      if (!routine) {
        res.status(404).json({ error: "Routine not found" });
        return;
      }
      // execution.triggerType (not routine.triggers[0]) — see the same fix's
      // rationale on /gates/:executionId/approve above.
      await queue.enqueue({
        id: execution.id,
        routineId: routine.id,
        trigger: {
          type: execution.triggerType,
          payload: {},
          executionId: execution.id,
        },
      });
      res.json({ resumed: true, executionId: execution.id });
    } catch (err) {
      console.error("[API] Failed to resume execution:", err);
      res.status(500).json({ error: "Failed to resume execution" });
    }
  });

  // Span API
  app.get("/executions/:id/spans", async (req, res) => {
    try {
      const spans = await spanRepository.findByExecution(req.params.id);
      res.json({ executionId: req.params.id, spans });
    } catch (err) {
      console.error("[API] Failed to get spans:", err);
      res.status(500).json({ error: "Failed to get spans" });
    }
  });

  // Feedback API
  app.get("/executions/:id/feedback", async (req, res) => {
    try {
      const feedback = await feedbackRepository.findByExecution(req.params.id);
      res.json({ executionId: req.params.id, feedback });
    } catch (err) {
      console.error("[API] Failed to get feedback:", err);
      res.status(500).json({ error: "Failed to get feedback" });
    }
  });

  app.post("/executions/:id/feedback", requireAuth, express.json(), async (req, res) => {
    try {
      await feedbackRepository.save({
        executionId: req.params.id,
        rating: req.body.rating,
        tags: req.body.tags,
        notes: req.body.notes,
        createdBy: req.body.createdBy,
      });

      /* ---- Phase 3: Feedback Loop ---- */
      try {
        const execution = await persistence.findById(req.params.id);
        const spans = execution
          ? await spanRepository.findByExecution(execution.id)
          : [];
        if (execution) {
          analyzeFeedback(execution, spans, {
            rating: req.body.rating,
            tags: req.body.tags,
            notes: req.body.notes,
          });
        }
      } catch (loopErr) {
        console.error("[FeedbackLoop] Analysis failed:", loopErr);
      }

      res.json({ saved: true, executionId: req.params.id });
    } catch (err) {
      console.error("[API] Failed to save feedback:", err);
      res.status(500).json({ error: "Failed to save feedback" });
    }
  });

  // Routines API
  app.get("/routines", (_req, res) => {
    res.json({
      routines: routines.map((r) => ({
        id: r.id,
        triggers: r.triggers,
        pipeline: r.pipeline,
        gates: r.gates,
        connectors: r.connectors,
      })),
    });
  });

  // Skills API
  app.get("/skills", (_req, res) => {
    try {
      const skills: Array<{ name: string; format: string; file: string }> = [];
      const entries = readdirSync(config.skillsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillYaml = join(config.skillsDir, entry.name, "skill.yaml");
          if (existsSync(skillYaml)) {
            skills.push({ name: entry.name, format: "state-machine", file: "skill.yaml" });
          }
        } else if (entry.name.endsWith(".md")) {
          skills.push({ name: entry.name.replace(/\.md$/, ""), format: "markdown", file: entry.name });
        } else if (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) {
          skills.push({
            name: entry.name.replace(/\.(yaml|yml)$/, ""),
            format: "state-machine",
            file: entry.name,
          });
        }
      }

      res.json({ skills });
    } catch {
      res.json({ skills: [] });
    }
  });

  app.get("/skills/:name", (req, res) => {
    try {
      // Try state-machine skill first: skills/<name>/skill.yaml
      const dirPath = join(config.skillsDir, req.params.name);
      const yamlPath = join(dirPath, "skill.yaml");
      if (existsSync(yamlPath)) {
        const content = readFileSync(yamlPath, "utf-8");
        res.json({ name: req.params.name, format: "state-machine", content });
        return;
      }

      // Try markdown skill: skills/<name>.md
      const mdPath = join(config.skillsDir, req.params.name + ".md");
      if (existsSync(mdPath)) {
        const content = readFileSync(mdPath, "utf-8");
        res.json({ name: req.params.name, format: "markdown", content });
        return;
      }

      // Try flat YAML skill: skills/<name>.yaml
      const flatYamlPath = join(config.skillsDir, req.params.name + ".yaml");
      if (existsSync(flatYamlPath)) {
        const content = readFileSync(flatYamlPath, "utf-8");
        res.json({ name: req.params.name, format: "state-machine", content });
        return;
      }

      res.status(404).json({ error: "Skill not found" });
    } catch {
      res.status(500).json({ error: "Failed to read skill" });
    }
  });

  app.get("/skills/:name/states", (req, res) => {
    try {
      const skill = loadSkill(config.skillsDir, req.params.name);
      if (skill.format !== "state-machine") {
        res.status(400).json({ error: "Skill is not a state machine" });
        return;
      }
      const states = Object.entries(skill.stateMachine.states).map(([id, s]) => ({
        id,
        description: (s as import("./skill/schema.js").SkillStateMachineState).description,
        terminal: (s as import("./skill/schema.js").SkillStateMachineState).terminal,
        gate: (s as import("./skill/schema.js").SkillStateMachineState).gate,
        delegate_to: (s as import("./skill/schema.js").SkillStateMachineState).delegate_to,
        transitions: (s as import("./skill/schema.js").SkillStateMachineState).transitions ?? [],
      }));
      res.json({
        id: skill.stateMachine.id,
        initial_state: skill.stateMachine.initial_state,
        states,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to load skill states", details: String(err) });
    }
  });

  // Save skill YAML
  app.post("/skills/:name", requireAuth, express.json(), (req, res) => {
    try {
      const name = req.params.name;
      const { content } = req.body;
      if (typeof content !== "string") {
        res.status(400).json({ error: "content must be a string" });
        return;
      }
      // Determine file path: prefer nested dir, then flat yaml
      const dirPath = join(config.skillsDir, name);
      const yamlInDir = join(dirPath, "skill.yaml");
      const flatYaml = join(config.skillsDir, name + ".yaml");
      const flatYml = join(config.skillsDir, name + ".yml");

      if (existsSync(yamlInDir)) {
        writeFileSync(yamlInDir, content, "utf-8");
      } else if (existsSync(flatYaml)) {
        writeFileSync(flatYaml, content, "utf-8");
      } else if (existsSync(flatYml)) {
        writeFileSync(flatYml, content, "utf-8");
      } else {
        // Create new skill in nested directory
        if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
        writeFileSync(yamlInDir, content, "utf-8");
      }
      res.json({ saved: true, name });
    } catch (err) {
      res.status(500).json({ error: "Failed to save skill", details: String(err) });
    }
  });

  // Timeline API
  app.get("/metrics/timeline", async (req, res) => {
    try {
      const days = Math.min(parseInt(req.query.days as string) || 14, 90);
      const allExecs = await persistence.findAll({ limit: 10000 });
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      const buckets = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split("T")[0];
        const dayExecs = allExecs.filter(
          (e) => e.startedAt && new Date(e.startedAt).toISOString().startsWith(dateStr)
        );
        buckets.push({
          date: dateStr,
          total: dayExecs.length,
          completed: dayExecs.filter((e) => e.status === "completed").length,
          failed: dayExecs.filter((e) => e.status === "failed").length,
          paused: dayExecs.filter((e) => e.status === "paused").length,
          tokens: dayExecs.reduce((sum, e) => sum + (e.totalTokens || 0), 0),
        });
      }
      res.json({ days, buckets });
    } catch (err) {
      console.error("[API] Failed to get timeline:", err);
      res.status(500).json({ error: "Failed to get timeline" });
    }
  });

  // Metrics API
  app.get("/metrics/overview", async (_req, res) => {
    try {
      const allExecutions = await persistence.findAll({ limit: 1000 });
      const allSpans: import("./persistence/types.js").ExecutionSpan[] = [];
      for (const ex of allExecutions) {
        const spans = await spanRepository.findByExecution(ex.id);
        allSpans.push(...spans);
      }
      const metrics = aggregateMetrics(allExecutions, allSpans);
      res.json(metrics);
    } catch (err) {
      console.error("[API] Failed to get metrics:", err);
      res.status(500).json({ error: "Failed to get metrics" });
    }
  });

  // Improvements API (Phase 3: Feedback Loop)
  app.get("/metrics/improvements", async (_req, res) => {
    try {
      res.json({ improvements: listImprovements() });
    } catch (err) {
      console.error("[API] Failed to get improvements:", err);
      res.status(500).json({ error: "Failed to get improvements" });
    }
  });

  app.post("/metrics/improvements/:id/apply", requireAuth, async (req, res) => {
    try {
      const imp = applyImprovement(req.params.id);
      if (!imp) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ applied: true, improvement: imp });
      return;
    } catch (err) {
      console.error("[API] Failed to apply improvement:", err);
      res.status(500).json({ error: "Failed to apply improvement" });
      return;
    }
  });

  app.post("/metrics/improvements/:id/dismiss", requireAuth, async (req, res) => {
    try {
      const imp = dismissImprovement(req.params.id);
      if (!imp) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ dismissed: true, improvement: imp });
      return;
    } catch (err) {
      console.error("[API] Failed to dismiss improvement:", err);
      res.status(500).json({ error: "Failed to dismiss improvement" });
      return;
    }
  });

  // Web UI
  app.get("/ui", (_req, res) => {
    const projectRoot = process.env.PROJECT_ROOT || process.cwd();
    res.sendFile(join(projectRoot, "public", "index.html"));
  });

  const providerName = config.kimiApiKey ? "kimi-coding-api" : "kimi-cli";
  const baseHealth = () => ({
    routines: routines.length,
    provider: providerName,
    persistence: config.databaseUrl ? "postgresql" : "in-memory",
    queue: config.redisUrl ? "bullmq" : "in-memory",
    tools: toolRegistry.listDefinitions().length,
    gates: "migrate" in gateRepository ? "postgresql" : "in-memory",
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", ...baseHealth() });
  });

  app.get("/health/detailed", async (_req, res) => {
    const { checks, healthy } = await checkHealth({
      pg: pgPool ? () => pgPool.query("SELECT 1") : undefined,
      redis: config.redisUrl ? () => pingRedis(config.redisUrl!) : undefined,
      cronOk: cronScheduler.runningTasks >= expectedCronTasks,
    });
    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      ...baseHealth(),
      checks,
      memory: process.memoryUsage(),
    });
  });

  // Start cron
  cronScheduler.start();
  console.log("[App] Cron scheduler started");

  return {
    app,
    cronScheduler,
    queue,
    engine,
    routines,
    toolRegistry,
    gateEngine,
    gateRepository,
  };
};
