/**
 * Per-repo/per-night verify baseline (F3 #150).
 *
 * The base branch's build/typecheck/lint/test result is captured once per
 * repo per night (see compare.ts for how a card's verify is judged against
 * it). The first caller for a (repo, nightId) pair does the real work and
 * persists it; every later caller for the same pair reads the cached row
 * without touching the clone or spawning a single process.
 *
 * NOTE (shared-clone risk): the checkout below runs in-place on
 * repoConfig.clonePath. The night-coordinator's claim policy runs at most one
 * execution per repo at a time ("same repo in series", see claim.ts), so in
 * normal operation this clone is never touched concurrently. But if two
 * callers for the same (repo, nightId) DO race (e.g. a defensive retry, or a
 * future relaxation of that policy), two concurrent `git checkout` calls on
 * the identical working directory can collide on `.git/index.lock` — a real,
 * confirmed git behavior, not theoretical. The DB race below (two INSERTs for
 * the same repo+night) is handled safely; the filesystem race is not — a fix
 * would mean a dedicated baseline worktree isolated from card-execution
 * worktrees, which is out of scope for #150 (candidate for repo-registry /
 * REPO-PROFILE follow-up work).
 */
import { execFile } from "child_process";
import { promisify } from "util";
import type { Pool } from "pg";
import type { RepoConfig } from "../repo-registry/schema.js";
import { runVerifyCommands, type VerifyResults } from "./run-commands.js";

const execFileAsync = promisify(execFile);

export interface BaselineDeps {
  pool: Pool;
}

export interface Baseline {
  baseSha: string;
  results: VerifyResults;
}

const rowToBaseline = (row: Record<string, unknown>): Baseline => ({
  baseSha: row.base_sha as string,
  results: row.results as VerifyResults,
});

const readBaseline = async (pool: Pool, repo: string, nightId: string): Promise<Baseline | undefined> => {
  const { rows } = await pool.query(
    `SELECT base_sha, results FROM verify_baselines WHERE repo = $1 AND night_id = $2`,
    [repo, nightId]
  );
  return rows[0] ? rowToBaseline(rows[0]) : undefined;
};

export const getOrCreateBaseline = async (
  deps: BaselineDeps,
  args: { repo: string; nightId: string; repoConfig: RepoConfig }
): Promise<Baseline> => {
  const { repo, nightId, repoConfig } = args;

  const existing = await readBaseline(deps.pool, repo, nightId);
  if (existing) return existing;

  const GIT_TIMEOUT_MS = 60_000; // git ops shouldn't hang the night on a stuck lock/prompt
  await execFileAsync("git", ["checkout", repoConfig.baseBranch], { cwd: repoConfig.clonePath, timeout: GIT_TIMEOUT_MS });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoConfig.clonePath, timeout: GIT_TIMEOUT_MS });
  const baseSha = stdout.trim();
  const results = await runVerifyCommands(repoConfig.clonePath, repoConfig.verify);

  const inserted = await deps.pool.query(
    `INSERT INTO verify_baselines (repo, night_id, base_sha, results)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (repo, night_id) DO NOTHING
     RETURNING base_sha, results`,
    [repo, nightId, baseSha, JSON.stringify(results)]
  );
  if (inserted.rows[0]) return rowToBaseline(inserted.rows[0]);

  // Lost the race — another caller's INSERT committed first; use their row.
  const winner = await readBaseline(deps.pool, repo, nightId);
  if (!winner) {
    throw new Error(`verify_baselines: no row for repo=${repo} night_id=${nightId} after a lost insert race`);
  }
  return winner;
};
