/**
 * OpenRoutines Application Bootstrap
 *
 * Wires together all components: triggers, engine, provider, connectors,
 * persistence, queue, and tools. Supports both in-memory (dev) and production
 * (PostgreSQL + BullMQ) configurations via environment variables.
 */

import { readdirSync, readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import express from "express";
import { Effect } from "effect";
import { parseRoutine } from "./routine/parser.js";
import { loadSkill } from "./skill/loader.js";
import type { Routine } from "./routine/types.js";
import { makeEngine } from "./engine/engine.js";
import { makeKimiCodingProvider } from "./provider/kimi-coding.js";
import { makeKimiCliProvider } from "./provider/kimi-cli.js";

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
import type { SpanRepository, FeedbackRepository } from "./persistence/types.js";
import { analyzeExecution, aggregateMetrics } from "./observability/analyzer.js";
import {
  analyzeFeedback,
  listImprovements,
  applyImprovement,
  dismissImprovement,
} from "./observability/feedback-loop.js";

export interface AppConfig {
  routinesDir: string;
  skillsDir: string;
  port: number;
  kimiApiKey?: string;
  kimiModel?: string;
  githubToken?: string;
  githubRepo?: string;
  githubWebhookSecret?: string;
  databaseUrl?: string;
  redisUrl?: string;
}

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

  // 3. Setup provider
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

  // Filesystem tools (always available for self-improvement)
  const fsTools = makeFilesystemTools();
  toolRegistry.registerMany(fsTools);
  console.log(`[App] Registered ${fsTools.length} filesystem tools`);

  // Git worktree tools (always available for isolated development)
  const gitWorktreeTools = makeGitWorktreeTools();
  toolRegistry.registerMany(gitWorktreeTools);
  console.log(`[App] Registered ${gitWorktreeTools.length} git worktree tools`);

  // 5. Setup engine
  const engine = makeEngine({
    routines,
    skillsDir: config.skillsDir,
    provider: provider as Parameters<typeof makeEngine>[0]["provider"],
    repository: persistence,
    toolRegistry,
    gateEngine,
    spanRepository,
    runStateRepository,
  });

  // 6. Setup queue (connects to engine)
  const queueHandler = async (job: { id?: string; routineId?: string; trigger: { type: string; payload: unknown; executionId?: string } }) => {
    // Load state machine context for resumed executions
    let stateMachineContext: import("./engine/state-machine.js").StateMachineContext | undefined;
    if (job.trigger.executionId) {
      const existing = await persistence.findById(job.trigger.executionId);
      const ctx = existing?.metadata?.stateMachineContext as import("./engine/state-machine.js").StateMachineContext | undefined;
      if (ctx) {
        stateMachineContext = ctx;
        console.log(`[Queue] Resuming execution ${job.trigger.executionId} at state ${ctx.currentState}`);
      }
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
    ? makeBullMqQueue({ redisUrl: config.redisUrl, handler: queueHandler })
    : makeInMemoryQueue(queueHandler);

  // 7. Setup cron scheduler
  const cronScheduler = new CronScheduler({
    routines,
    queue,
    timezone: process.env.TZ,
  });

  // 8. Setup Express app
  const app = express();

  if (config.githubWebhookSecret) {
    setupGitHubWebhook(app, {
      secret: config.githubWebhookSecret,
      queue,
    });
    console.log("[App] GitHub webhook endpoint: POST /webhooks/github");
  }

  // Manual trigger endpoint
  app.post("/trigger/:routineId", express.json(), async (req, res) => {
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

  app.post("/gates/:executionId/approve", express.json(), async (req, res) => {
    try {
      const gate = await gateRepository.findByExecution(req.params.executionId);
      if (!gate) {
        res.status(404).json({ error: "Gate not found" });
        return;
      }
      await gateEngine.approve(gate.id, req.body.reason);

      // Retomar execução pausada
      const execution = await persistence.findById(req.params.executionId);
      if (execution && execution.status === "paused") {
        const routine = routines.find((r) => r.id === execution.routineId);
        if (routine) {
          queue.enqueue({
            id: execution.id,
            routineId: routine.id,
            trigger: {
              type: routine.triggers[0]?.type ?? "api",
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

  app.post("/gates/:executionId/reject", express.json(), async (req, res) => {
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
  app.post("/executions/:id/resume", async (req, res) => {
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
      await queue.enqueue({
        id: execution.id,
        routineId: routine.id,
        trigger: {
          type: routine.triggers[0]?.type ?? "api",
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

  app.post("/executions/:id/feedback", express.json(), async (req, res) => {
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
  app.post("/skills/:name", express.json(), (req, res) => {
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
        const { mkdirSync } = require("fs");
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

  app.post("/metrics/improvements/:id/apply", async (req, res) => {
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

  app.post("/metrics/improvements/:id/dismiss", async (req, res) => {
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
    res.sendFile(join(process.cwd(), "public", "index.html"));
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      routines: routines.length,
      provider: config.kimiApiKey ? "kimi" : "stub",
      persistence: config.databaseUrl ? "postgresql" : "in-memory",
      queue: config.redisUrl ? "bullmq" : "in-memory",
      tools: toolRegistry.listDefinitions().length,
      gates: "migrate" in gateRepository ? "postgresql" : "in-memory",
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
