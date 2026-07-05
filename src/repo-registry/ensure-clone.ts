/**
 * Lazy repo clone (Bloco 1)
 *
 * Guarantees the card's repo is usable before preparation creates its worktree.
 *  - A registry hit (repos.yaml OR auto-discovery over REPOS_BASE_DIR) is
 *    returned as-is: it is assumed present on disk (the legacy contract — the
 *    system never re-clones a repo it already tracks).
 *  - A name in NEITHER is cloned lazily: derive `<REPOS_BASE_DIR>/<slug>`,
 *    resolve owner/repo (gh api over ALLOWED_REPO_OWNERS), and `gh repo clone`
 *    it (gh's own auth — no token in the remote URL), then discover its real
 *    config off the fresh clone.
 * Two guardrails, neither relaxable by card text: the clone target must resolve
 * strictly inside REPOS_BASE_DIR (fence), and only ALLOWED_REPO_OWNERS are
 * tried (the GITHUB_TOKEN's own scope is the ultimate boundary). Unresolvable
 * -> blockReason "repo-unresolvable".
 */

import { existsSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { join, relative, isAbsolute } from "path";
import { discoverRepo, defaultDiscoveryDeps } from "./discovery.js";
import { DEFAULT_BASE_BRANCH, VERIFY_DEFAULTS } from "./schema.js";
import type { RepoConfig } from "./schema.js";

const execFileAsync = promisify(execFile);

export interface EnsureRepoDeps {
  /** REPOS_BASE_DIR — the clone fence and the root a bare name resolves under. */
  baseDir?: string;
  /** ALLOWED_REPO_OWNERS — owners a bare name may be resolved against. */
  allowedOwners?: string[];
  githubToken: string;
  // Injectable seams (default to the real gh/fs impls):
  isGitRepo?: (clonePath: string) => boolean;
  repoExists?: (githubRepo: string) => Promise<boolean>;
  cloneRepo?: (githubRepo: string, clonePath: string) => Promise<void>;
  discover?: (baseDir: string, name: string) => RepoConfig | undefined;
}

export interface EnsureRepoResult {
  config?: RepoConfig;
  blockReason?: string;
}

const isUnderBase = (target: string, base: string): boolean => {
  const rel = relative(base, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

const ghRepoExists = (token: string) => async (githubRepo: string): Promise<boolean> => {
  try {
    await execFileAsync("gh", ["api", `repos/${githubRepo}`, "--silent"], { env: { ...process.env, GH_TOKEN: token } });
    return true;
  } catch {
    return false;
  }
};

const ghClone = (token: string) => async (githubRepo: string, clonePath: string): Promise<void> => {
  await execFileAsync("gh", ["repo", "clone", githubRepo, clonePath], { env: { ...process.env, GH_TOKEN: token } });
};

/** Try each allowed owner until `owner/slug` resolves on GitHub; "" if none. */
export const resolveGithubRepo = async (slug: string, deps: EnsureRepoDeps): Promise<string> => {
  const exists = deps.repoExists ?? ghRepoExists(deps.githubToken);
  for (const owner of deps.allowedOwners ?? []) {
    if (await exists(`${owner}/${slug}`)) return `${owner}/${slug}`;
  }
  return "";
};

/**
 * `known` is the registry hit (repos.yaml or auto-discovery), or undefined for
 * a name this install has never seen.
 */
export const ensureRepoAvailable = async (
  slug: string,
  known: RepoConfig | undefined,
  deps: EnsureRepoDeps
): Promise<EnsureRepoResult> => {
  // Registry hit — assumed present on disk (legacy contract).
  if (known) return { config: known };

  // Unknown name — must have a base dir to derive/clone under.
  if (!deps.baseDir) return { blockReason: "repo-unresolvable" };
  const clonePath = join(deps.baseDir, slug);
  const isGitRepo = deps.isGitRepo ?? ((p: string) => existsSync(join(p, ".git")));
  const discover = deps.discover ?? ((b: string, n: string) => discoverRepo(b, n, defaultDiscoveryDeps));

  // Freshly appeared under baseDir since load (e.g. cloned by hand) — just detect it.
  if (isGitRepo(clonePath)) {
    const detected = discover(deps.baseDir, slug);
    return detected ? { config: detected } : { blockReason: "repo-unresolvable" };
  }

  // Not on disk — resolve owner/repo and clone into the fenced base dir.
  const githubRepo = await resolveGithubRepo(slug, deps);
  if (!githubRepo) return { blockReason: "repo-unresolvable" };
  if (!isUnderBase(clonePath, deps.baseDir)) return { blockReason: "repo-unresolvable" };

  const clone = deps.cloneRepo ?? ghClone(deps.githubToken);
  await clone(githubRepo, clonePath);
  const detected = discover(deps.baseDir, slug);
  return {
    config: detected ?? {
      clonePath,
      githubRepo,
      baseBranch: DEFAULT_BASE_BRANCH,
      verify: VERIFY_DEFAULTS.npm,
      compose: null,
      critical: false,
    },
  };
};
