/**
 * card-to-pr / preparation (F3 #146)
 *
 * Resolves the card's repo, preflights branch protection (fail-closed — no
 * protection means the phase ends here, not a degraded run), creates or
 * reuses the card's worktree, and captures the night's verify baseline for
 * that repo.
 */
import { existsSync } from "fs";
import { join } from "path";
import type { ScriptHandler } from "../../script/registry.js";
import { resolveRepo, resolveRepoBySlug } from "../../repo-registry/registry.js";
import type { RepoConfig, RepoRegistry } from "../../repo-registry/schema.js";
import { checkBranchProtection } from "../../preflight/branch-protection.js";
import { getOrCreateBaseline } from "../../verify/baseline.js";
import type { VerifyResults } from "../../verify/run-commands.js";
import { ensureIgnoreScripts } from "../../security/supply-chain-guard.js";
import { defaultRunGit, type CardToPrDeps } from "./index.js";

export interface PreparationOutput {
  branchProtected: boolean;
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

// RepoConfig (repo-registry/schema.ts) carries no key of its own — repos.yaml
// maps key -> config — but verify/pr/pr_links need that key ("slug") carried
// forward. Recovered here by reference rather than re-deriving the resolution
// logic that resolveRepo/resolveRepoBySlug already own.
const findRegistrySlug = (registry: RepoRegistry, config: RepoConfig): string | undefined => {
  for (const [key, candidate] of Object.entries(registry.repos)) {
    if (candidate === config) return key;
  }
  return undefined;
};

const slugifyTaskId = (id: string): string => id.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);

export const makePreparation = (deps: CardToPrDeps): ScriptHandler => async (ctx) => {
  const taskId = String(ctx.inputs.task_id);
  const repoField = String(ctx.inputs.repo);
  const nightId = typeof ctx.inputs.night_id === "string" && ctx.inputs.night_id ? ctx.inputs.night_id : undefined;

  const repoConfig = resolveRepoBySlug(deps.registry, repoField) ?? resolveRepo(deps.registry, repoField);
  if (!repoConfig) {
    return { branchProtected: false, blockReason: "repo-unresolvable" } satisfies PreparationOutput;
  }
  const slug = findRegistrySlug(deps.registry, repoConfig) ?? repoField;

  const [owner, name] = repoConfig.githubRepo.split("/");
  const checkProtection = deps.checkProtection ?? checkBranchProtection;
  const bp = await checkProtection({ token: deps.githubToken }, owner, name, "main");
  if (!bp.protected) {
    // No budget spent past this point — the phase ends here (routes to blocked).
    return { branchProtected: false, blockReason: "no-branch-protection" } satisfies PreparationOutput;
  }

  const runGit = deps.runGit ?? defaultRunGit(deps.githubToken);
  await runGit(["fetch"], repoConfig.clonePath);

  const branch = `openroutines/card-${slugifyTaskId(taskId)}`;
  const worktreePath = join(deps.worktreeBase, `card-${slugifyTaskId(taskId)}`);
  if (!existsSync(worktreePath)) {
    await runGit(["worktree", "add", "-b", branch, worktreePath, repoConfig.baseBranch], repoConfig.clonePath);
  } // else: crash-resume of preparation — reuse the worktree already on disk.

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
    branchProtected: true,
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
