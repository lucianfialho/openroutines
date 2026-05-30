#!/usr/bin/env node
import "dotenv/config";
/**
 * OpenRoutines — Entry Point
 *
 * Self-hosted automation platform for engineering workflows.
 * Bring your own model. Start with Kimi K2.6.
 */

import { createApp } from "./app.js";

const config = {
  routinesDir: process.env.ROUTINES_DIR ?? "./routines",
  skillsDir: process.env.SKILLS_DIR ?? "./.gates/skills",
  port: parseInt(process.env.PORT ?? "3000", 10),
  kimiApiKey: process.env.KIMI_API_KEY,
  kimiModel: process.env.KIMI_MODEL,
  githubToken: process.env.GITHUB_TOKEN,
  githubRepo: process.env.GITHUB_REPO,
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
};

async function main() {
  console.log("OpenRoutines starting...\n");

  const { app, cronScheduler, queue } = await createApp(config);

  const server = app.listen(config.port, () => {
    console.log(`\nOpenRoutines ready on http://localhost:${config.port}`);
    console.log(`Health check: http://localhost:${config.port}/health`);
    if (config.githubWebhookSecret) {
      console.log(`Webhook: http://localhost:${config.port}/webhooks/github`);
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    server.close();
    cronScheduler.stop();
    if ("close" in queue && typeof (queue as { close?: unknown }).close === "function") {
      await (queue as { close: () => Promise<void> }).close();
    }
    console.log("Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
