/**
 * card-to-pr / preparation (F3 #146)
 *
 * Resolves the card's repo (cloning it lazily if new — Bloco 1), creates or
 * reuses the card's worktree off the repo's baseBranch, and captures the
 * night's verify baseline. Worktree setup is idempotent: a retry only reuses
 * what's on disk when git itself confirms it's still a live worktree on the
 * card's branch, otherwise it force-recreates from scratch.
 * The main branch is protected by CONSTRUCTION, not by
 * a GitHub-side preflight: schema.ts forbids baseBranch being main/master and
 * pr.ts refuses to open a PR against main/master — so the pipeline never targets
 * main regardless of the repo's GitHub plan. Repo that can't be resolved ->
 * blockReason, the phase ends before any git/LLM spend.
 */
import { existsSync, rmSync } from "fs";
import { join } from "path";
import type { ScriptHandler } from "../../script/registry.js";
import { resolveRepoBySlug, resolveSlug } from "../../repo-registry/registry.js";
import { ensureRepoAvailable } from "../../repo-registry/ensure-clone.js";
import type { RepoConfig } from "../../repo-registry/schema.js";
import { getOrCreateBaseline } from "../../verify/baseline.js";
import type { VerifyResults } from "../../verify/run-commands.js";
import { ensureIgnoreScripts } from "../../security/supply-chain-guard.js";
import { defaultRunGit, type CardToPrDeps } from "./index.js";

export interface PreparationOutput {
  blockReason?: string;
  worktree?: { path: string; branch: string };
  baseSha?: string;
  baselineResults?: VerifyResults | null;
  repo?: {
    githubRepo: string;
    baseBranch: string;
    clonePath: string;
    slug: string;
    verify: RepoConfig["verify"];
  };
}

const slugifyTaskId = (id: string): string => id.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);

/** True only when `worktreePath` is a live worktree already checked out on `branch` — the sole case safe to reuse untouched. */
const isOnExpectedBranch = async (
  runGit: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>,
  worktreePath: string,
  branch: string
): Promise<boolean> => {
  try {
    const { stdout } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
    return stdout.trim() === branch;
  } catch {
    return false;
  }
};

export const makePreparation = (deps: CardToPrDeps): ScriptHandler => async (ctx) => {
  const taskId = String(ctx.inputs.task_id);
  const repoField = String(ctx.inputs.repo);
  const nightId = typeof ctx.inputs.night_id === "string" && ctx.inputs.night_id ? ctx.inputs.night_id : undefined;

  // Resolve the repo, cloning it lazily if the card names one this install
  // doesn't have yet (Bloco 1). A registry hit (repos.yaml/auto-discovery) is
  // assumed present; an unknown name is cloned into REPOS_BASE_DIR.
  const known = resolveRepoBySlug(deps.registry, repoField);
  const slug = resolveSlug(deps.registry, repoField);
  const ensured = await ensureRepoAvailable(slug, known, {
    baseDir: deps.reposBaseDir,
    allowedOwners: deps.allowedOwners,
    githubToken: deps.githubToken,
  });
  if (!ensured.config) {
    return { blockReason: ensured.blockReason ?? "repo-unresolvable" } satisfies PreparationOutput;
  }
  const repoConfig = ensured.config;

  const runGit = deps.runGit ?? defaultRunGit(deps.githubToken);
  await runGit(["fetch"], repoConfig.clonePath);

  const branch = `openroutines/card-${slugifyTaskId(taskId)}`;
  const worktreePath = join(deps.worktreeBase, `card-${slugifyTaskId(taskId)}`);
  const reusable = existsSync(worktreePath) && (await isOnExpectedBranch(runGit, worktreePath, branch));
  if (!reusable) {
    // Idempotent recreate: existsSync alone isn't proof of a live worktree — a
    // crash mid `worktree add`, or a leftover from an earlier/unrelated
    // execution of this same card, both leave a dir that fails `rev-parse`
    // ("not a git repository", the exact prod failure) or sits on the wrong
    // branch. Force-clean (best-effort — a no-op set of failures on a fresh
    // path) then recreate from repoConfig.baseBranch: deterministic, and
    // never stale since `fetch` above just ran.
    if (existsSync(worktreePath)) {
      await runGit(["worktree", "remove", "--force", worktreePath], repoConfig.clonePath).catch(() => {});
      rmSync(worktreePath, { recursive: true, force: true });
      await runGit(["worktree", "prune"], repoConfig.clonePath).catch(() => {});
      await runGit(["branch", "-D", branch], repoConfig.clonePath).catch(() => {});
    }
    await runGit(["worktree", "add", "-b", branch, worktreePath, repoConfig.baseBranch], repoConfig.clonePath);
  } // else: crash-resume before implementation ever ran — same branch already checked out, reuse it.

  // F4 #156: every install in this worktree runs with --ignore-scripts by
  // default from here on (implementation/rework, and any verify install step
  // that touches this same worktree). Re-asserted on crash-resume too — cheap
  // no-op once already merged in.
  ensureIgnoreScripts({ worktree: worktreePath });

  const { stdout } = await runGit(["rev-parse", "HEAD"], worktreePath);
  const baseSha = stdout.trim();

  let baselineResults: VerifyResults | null = null;
  if (nightId && deps.pool) {
    const getBaseline = deps.getBaseline ?? getOrCreateBaseline;
    const baseline = await getBaseline({ pool: deps.pool }, { repo: slug, nightId, repoConfig });
    baselineResults = baseline.results;
  } // else: manual run, no night_id/pool — verify treats a missing baseline as strict.

  return {
    worktree: { path: worktreePath, branch },
    baseSha,
    baselineResults,
    repo: {
      githubRepo: repoConfig.githubRepo,
      baseBranch: repoConfig.baseBranch,
      clonePath: repoConfig.clonePath,
      slug,
      verify: repoConfig.verify,
    },
  } satisfies PreparationOutput;
};
