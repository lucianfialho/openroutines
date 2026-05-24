#!/usr/bin/env node
/**
 * Generate vercel.json with cron jobs from routines
 *
 * Reads all routine YAML files, finds schedule triggers,
 * and generates the Vercel cron configuration.
 */

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseRoutine } from "../src/routine/parser.js";

const routinesDir = process.argv[2] ?? "./routines";
const outputPath = process.argv[3] ?? "./vercel.json";

const routines: Array<ReturnType<typeof parseRoutine>> = [];
try {
  const files = readdirSync(routinesDir);
  for (const file of files) {
    if (file.endsWith(".yaml") || file.endsWith(".yml")) {
      const content = readFileSync(join(routinesDir, file), "utf-8");
      routines.push(parseRoutine(content));
    }
  }
} catch (err) {
  console.warn(`No routines found in ${routinesDir}:`, err);
}

const crons = routines
  .flatMap((routine) =>
    routine.triggers
      .filter((t) => t.type === "schedule" && typeof t.cron === "string")
      .map((trigger) => ({
        path: `/api/cron/${routine.id}`,
        schedule: trigger.cron,
      }))
  )
  .filter((cron, index, self) => self.findIndex((c) => c.path === cron.path) === index);

const config = {
  version: 2,
  builds: [{ src: "api/**/*.ts", use: "@vercel/node" }],
  routes: [
    { src: "/webhooks/github", dest: "/api/webhooks/github.ts" },
    { src: "/cron/(?<routineId>[^/]+)", dest: "/api/cron/[routineId].ts?routineId=$routineId" },
    { src: "/health", dest: "/api/health.ts" },
  ],
  crons,
};

writeFileSync(outputPath, JSON.stringify(config, null, 2) + "\n");
console.log(`Generated ${outputPath} with ${crons.length} cron job(s)`);
for (const cron of crons) {
  console.log(`  ${cron.path} → ${cron.schedule}`);
}
