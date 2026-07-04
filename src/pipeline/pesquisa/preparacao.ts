/**
 * card-pesquisa / preparacao (F5 #161)
 *
 * Read-only context setup for a research card: resolve every repo the card
 * references, read each repo's docs/REPO-PROFILE.md (best-effort), and mount an
 * ephemeral DETACHED worktree at the primary repo's base branch so the survey
 * explores a stable, isolated HEAD (concurrent night git ops on the clone can't
 * shift it mid-survey).
 *
 * "read-only" is enforced by the levantamento phase's tool allowlist (no
 * Write/Edit), NOT by filesystem permissions — the detached worktree exists
 * only to pin the view. Unlike card-to-pr's preparacao there is no branch
 * protection preflight and no verify baseline (nothing is ever pushed), and the
 * phase is TOLERANT: a card with no resolvable repo still proceeds (the survey
 * can lean on raizes-docs/ctx7 for a docs/ecosystem question).
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { ScriptHandler } from "../../script/registry.js";
import { resolveRepo, resolveRepoBySlug } from "../../repo-registry/registry.js";
import type { RepoConfig, RepoRegistry } from "../../repo-registry/schema.js";
import { defaultRunGit, type PesquisaDeps } from "./index.js";

export interface PreparacaoRepo {
  slug: string;
  githubRepo: string;
  clonePath: string;
  baseBranch: string;
  /** docs/REPO-PROFILE.md contents, truncated; undefined when the repo has none. */
  profile?: string;
}

export interface PreparacaoOutput {
  repos: PreparacaoRepo[];
  worktree?: { path: string };
}

// RepoConfig carries no key of its own (repos.yaml maps key -> config) — recover
// the "slug" by reference, same as card-to-pr's preparacao does.
const findRegistrySlug = (registry: RepoRegistry, config: RepoConfig): string | undefined => {
  for (const [key, candidate] of Object.entries(registry.repos)) {
    if (candidate === config) return key;
  }
  return undefined;
};

const slugifyTaskId = (id: string): string => id.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);

// REPO-PROFILE.md is bounded before it reaches the survey prompt — a huge file
// must not blow the context window; 8k chars is plenty for a repo profile.
const readRepoProfile = (clonePath: string): string | undefined => {
  try {
    return readFileSync(join(clonePath, "docs", "REPO-PROFILE.md"), "utf-8").slice(0, 8000);
  } catch {
    return undefined;
  }
};

export const makePreparacao = (deps: PesquisaDeps): ScriptHandler => async (ctx) => {
  const runGit = deps.runGit ?? defaultRunGit;
  const fields = String(ctx.inputs.repo ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const repos: PreparacaoRepo[] = [];
  for (const field of fields) {
    const cfg = resolveRepoBySlug(deps.registry, field) ?? resolveRepo(deps.registry, field);
    if (!cfg) continue; // unresolvable repo field is skipped, not fatal (tolerant)
    const slug = findRegistrySlug(deps.registry, cfg) ?? field;
    if (repos.some((r) => r.slug === slug)) continue; // same repo referenced twice
    repos.push({
      slug,
      githubRepo: cfg.githubRepo,
      clonePath: cfg.clonePath,
      baseBranch: cfg.baseBranch,
      profile: readRepoProfile(cfg.clonePath),
    });
  }

  let worktree: { path: string } | undefined;
  if (repos.length > 0) {
    // ponytail: only the FIRST resolved repo gets a worktree — a multi-repo card
    // still lists every repo (+ profile) in the survey prompt, but juggling N
    // worktrees isn't worth it until a card actually needs cross-repo edits
    // (this pipeline never edits). Add per-repo worktrees when that lands.
    const primary = repos[0];
    const worktreePath = join(deps.worktreeBase, `pesquisa-${slugifyTaskId(String(ctx.inputs.task_id))}`);
    if (!existsSync(worktreePath)) {
      // --detach: a read-only view pinned at base, never a branch (nothing is
      // ever committed/pushed from a research worktree).
      await runGit(["worktree", "add", "--detach", worktreePath, primary.baseBranch], primary.clonePath);
    } // else: crash-resume — reuse the worktree already on disk.
    worktree = { path: worktreePath };
  }

  return { repos, worktree } satisfies PreparacaoOutput;
};
