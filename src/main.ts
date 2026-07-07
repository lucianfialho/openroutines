#!/usr/bin/env node
import "dotenv/config";
/**
 * OpenRoutines — Entry Point
 *
 * Self-hosted automation platform for engineering workflows.
 * Bring your own model. Start with Kimi K2.6.
 */

import { createApp } from "./app.js";
import { timezoneWarning } from "./util/timezone.js";
import { maybeRunOnboarding } from "./onboarding/index.js";

const config = {
  routinesDir: process.env.ROUTINES_DIR ?? "./routines",
  skillsDir: process.env.SKILLS_DIR ?? "./.gates/skills",
  port: parseInt(process.env.PORT ?? "3000", 10),
  kimiApiKey: process.env.KIMI_API_KEY,
  kimiModel: process.env.KIMI_MODEL,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  claudeCliSettingsFile: process.env.CLAUDE_CLI_SETTINGS_FILE,
  claudeCliModel: process.env.CLAUDE_CLI_MODEL,
  githubToken: process.env.GITHUB_TOKEN,
  githubRepo: process.env.GITHUB_REPO,
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
};

async function main() {
  console.log("OpenRoutines starting...\n");

  // Bloco 3: first-run wizard when config is incomplete and a TTY is attached
  // (writes task-sources.yaml / connector.yaml / .env, then the boot continues).
  //
  // The wizard reads stdin, which `tsx watch` hijacks — it restarts the process
  // on *any* stdin data, so every keypress would reset the wizard. So `npm run
  // dev` runs onboarding in a plain (non-watch) process first (`--setup-then-exit`),
  // then starts the watcher with it skipped (`--skip-onboarding`).
  if (!process.argv.includes("--skip-onboarding")) {
    await maybeRunOnboarding();
  }
  if (process.argv.includes("--setup-then-exit")) process.exit(0);

  const tzWarn = timezoneWarning(process.env.TZ);
  if (tzWarn) console.warn(`[Boot] WARNING: ${tzWarn}`);

  const { app, cronScheduler, queue } = await createApp(config);

  // Bind to loopback by default: the Tailscale auth path is only safe when the
  // Express port is not directly reachable off-host (behind `tailscale serve`).
  // Override with HOST=0.0.0.0 only when direct LAN/public exposure is intended.
  const host = process.env.HOST ?? "127.0.0.1";
  const server = app.listen(config.port, host, () => {
    console.log(`\nOpenRoutines ready on http://${host}:${config.port}`);
    console.log(`Health check: http://${host}:${config.port}/health`);
    if (config.githubWebhookSecret) {
      console.log(`Webhook: http://${host}:${config.port}/webhooks/github`);
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
