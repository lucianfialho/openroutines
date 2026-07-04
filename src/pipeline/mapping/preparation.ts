/**
 * card-mapping / preparation (F5 #162)
 *
 * Resolve the card's single target repo and mount a worktree on the docs
 * branch `openroutines/mapeamento-<repo>-<data>`. scan/visual_capture
 * write docs/** into this worktree; pr_docs commits and pushes the branch.
 *
 * Unlike card-research's tolerant preparation (a research card with no
 * resolvable repo still proceeds), a mapeamento card REQUIRES a resolvable repo
 * — there is nothing to map otherwise, so an unresolvable field fails the state
 * (returns an error string the runner surfaces). No branch-protection preflight
 * (a docs PR carries no product-code risk; the docs-only invariant is enforced
 * at pr_docs).
 */
import { existsSync } from "fs";
import { join } from "path";
import type { ScriptHandler } from "../../script/registry.js";
import { resolveRepo, resolveRepoBySlug } from "../../repo-registry/registry.js";
import type { RepoConfig, RepoRegistry } from "../../repo-registry/schema.js";
import { defaultRunGit, type MappingDeps } from "./index.js";

export interface MappingPreparationRepo {
  slug: string;
  githubRepo: string;
  clonePath: string;
  baseBranch: string;
}

export interface MappingPreparationOutput {
  repo: MappingPreparationRepo;
  worktree: { path: string; branch: string };
  baseSha: string;
}

// RepoConfig carries no key of its own (repos.yaml maps key -> config) — recover
// the "slug" by reference, same as card-to-pr/card-research preparation.
const findRegistrySlug = (registry: RepoRegistry, config: RepoConfig): string | undefined => {
  for (const [key, candidate] of Object.entries(registry.repos)) {
    if (candidate === config) return key;
  }
  return undefined;
};

const slugify = (id: string): string => id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** Local date (YYYY-MM-DD) for the branch name / header stamp. */
export const today = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

export const makePreparation = (deps: MappingDeps): ScriptHandler => async (ctx) => {
  const repoField = String(ctx.inputs.repo ?? "").trim();
  const cfg = resolveRepoBySlug(deps.registry, repoField) ?? resolveRepo(deps.registry, repoField);
  if (!cfg) {
    // Hard error (returned string) — a mapeamento card must name a resolvable repo.
    return `card-mapping preparation: repo não resolvível: "${repoField}"`;
  }
  const slug = findRegistrySlug(deps.registry, cfg) ?? repoField;

  const runGit = deps.runGit ?? defaultRunGit(deps.githubToken);
  await runGit(["fetch"], cfg.clonePath);

  const branch = `openroutines/mapeamento-${slugify(slug)}-${today()}`;
  const worktreePath = join(deps.worktreeBase, `mapeamento-${slugify(slug)}-${today()}`);
  if (!existsSync(worktreePath)) {
    await runGit(["worktree", "add", "-b", branch, worktreePath, cfg.baseBranch], cfg.clonePath);
  } // else: crash-resume of preparation — reuse the worktree already on disk.

  const { stdout } = await runGit(["rev-parse", "HEAD"], worktreePath);

  return {
    repo: { slug, githubRepo: cfg.githubRepo, clonePath: cfg.clonePath, baseBranch: cfg.baseBranch },
    worktree: { path: worktreePath, branch },
    baseSha: stdout.trim(),
  } satisfies MappingPreparationOutput;
};
