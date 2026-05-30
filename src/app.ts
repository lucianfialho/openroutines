/**
 * OpenRoutines Application Bootstrap
 *
 * Wires together all components: triggers, engine, provider, connectors,
 * persistence, and queue. Supports both in-memory (dev) and production
 * (PostgreSQL + BullMQ) configurations via environment variables.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import express from "express";
import { Effect } from "effect";
import { parseRoutine } from "./routine/parser.js";
import type { Routine } from "./routine/types.js";
import { makeEngine } from "./engine/engine.js";
import { makeKimiProvider } from "./provider/kimi.js";

import { makeInMemoryRepository } from "./persistence/in-memory.js";
import { makePostgresRepository } from "./persistence/postgres.js";
import { makeInMemoryQueue } from "./queue/in-memory.js";
import { makeBullMqQueue } from "./queue/bullmq.js";
import { CronScheduler } from "./trigger/cron.js";
import { setupGitHubWebhook } from "./trigger/webhook.js";

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

  // 3. Setup provider
  const provider = config.kimiApiKey
    ? makeKimiProvider({
        apiKey: config.kimiApiKey,
        model: config.kimiModel,
      })
    : {
        complete: (req: { prompt: string }) =>
          Effect.succeed({
            content: `[Stub Provider] Would process: ${req.prompt.slice(0, 50)}...`,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            model: "stub",
            finishReason: "stop",
          }),
      };

  // 4. Setup engine
  const engine = makeEngine({
    routines,
    skillsDir: config.skillsDir,
    provider: provider as Parameters<typeof makeEngine>[0]["provider"],
    repository: persistence,
  });

  // 5. Setup queue (connects to engine)
  const queueHandler = async (job: { trigger: { type: string; payload: unknown } }) => {
    const result = await Effect.runPromise(
      engine.execute({
        type: job.trigger.type,
        payload: job.trigger.payload,
      })
    );
    console.log(`[Queue] Job completed: success=${result.success}`);
  };

  const queue = config.redisUrl
    ? makeBullMqQueue({ redisUrl: config.redisUrl, handler: queueHandler })
    : makeInMemoryQueue(queueHandler);

  // 6. Setup cron scheduler
  const cronScheduler = new CronScheduler({
    routines,
    queue,
    timezone: process.env.TZ,
  });

  // 7. Setup Express app
  const app = express();

  if (config.githubWebhookSecret) {
    setupGitHubWebhook(app, {
      secret: config.githubWebhookSecret,
      queue,
    });
    console.log("[App] GitHub webhook endpoint: POST /webhooks/github");
  }

  // Hello endpoint
  app.get("/hello", (_req, res) => {
    res.json({ message: "Hello, world!" });
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      routines: routines.length,
      provider: config.kimiApiKey ? "kimi" : "stub",
      persistence: config.databaseUrl ? "postgresql" : "in-memory",
      queue: config.redisUrl ? "bullmq" : "in-memory",
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
  };
};
