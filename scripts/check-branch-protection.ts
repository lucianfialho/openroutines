#!/usr/bin/env node
/**
 * Standalone branch-protection preflight check (issue #151).
 *
 * Run: tsx scripts/check-branch-protection.ts <owner/repo> [branch]
 * Reads GITHUB_TOKEN from env, prints the BranchProtectionResult as JSON,
 * exits 1 when protected:false. Reusable as-is by the bootstrap smoke-test
 * and by a future weekly audit (F5) without duplicating the check logic.
 */

import "dotenv/config";
import { fileURLToPath } from "url";
import { checkBranchProtection, type BranchProtectionResult } from "../src/preflight/branch-protection.js";

export const run = async (
  argv: string[],
  deps: { token: string | undefined; fetchImpl?: typeof fetch }
): Promise<{ result: BranchProtectionResult; exitCode: number }> => {
  const [ownerRepo, branch] = argv;
  const [owner, repo] = ownerRepo?.split("/") ?? [];
  if (!owner || !repo) {
    throw new Error("Usage: tsx scripts/check-branch-protection.ts <owner/repo> [branch]");
  }
  if (!deps.token) {
    throw new Error("GITHUB_TOKEN env var is required");
  }

  const result = await checkBranchProtection({ token: deps.token, fetchImpl: deps.fetchImpl }, owner, repo, branch);
  return { result, exitCode: result.protected ? 0 : 1 };
};

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  run(process.argv.slice(2), { token: process.env.GITHUB_TOKEN })
    .then(({ result, exitCode }) => {
      console.log(JSON.stringify(result));
      process.exit(exitCode);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
