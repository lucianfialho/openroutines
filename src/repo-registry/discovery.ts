/**
 * Repo auto-discovery (Bloco 1)
 *
 * Scan REPOS_BASE_DIR for git checkouts and register each by directory name,
 * so a card's `Repositório: meu-construtor-agent` resolves to
 * `<baseDir>/meu-construtor-agent` with NO repos.yaml entry required. Fields
 * the static parser can't know are read off the real clone: githubRepo from
 * the origin remote, the integration base branch, and verify commands from the
 * lockfile. repos.yaml stays an OPTIONAL override layered on top of this.
 *
 * All fs/git access goes through injectable seams so the unit test needs no
 * real repos on disk.
 */

import { readdirSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { DEFAULT_BASE_BRANCH, VERIFY_DEFAULTS } from "./schema.js";
import type { RepoConfig } from "./schema.js";

export interface DiscoveryDeps {
  listDir: (dir: string) => string[];
  isGitRepo: (repoPath: string) => boolean;
  /** Runs a git command in `cwd`, returns trimmed stdout ("" on failure). */
  git: (args: string[], cwd: string) => string;
  fileExists: (repoPath: string, relPath: string) => boolean;
}

const realGit = (args: string[], cwd: string): string => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

export const defaultDiscoveryDeps: DiscoveryDeps = {
  listDir: (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  },
  isGitRepo: (repoPath) => existsSync(join(repoPath, ".git")),
  git: realGit,
  fileExists: (repoPath, relPath) => existsSync(join(repoPath, relPath)),
};

/** "git@github.com:owner/repo.git" | "https://github.com/owner/repo.git" -> "owner/repo". */
export const parseGithubRemote = (remoteUrl: string): string => {
  const m = remoteUrl.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  return m ? m[1] : "";
};

/** Pick verify commands from the lockfile present in the clone. */
export const detectVerify = (repoPath: string, deps: DiscoveryDeps): RepoConfig["verify"] => {
  if (!deps.fileExists(repoPath, "package.json")) {
    return { build: "true", test: "true" }; // non-npm repo: no-op gate, refined by a Mapping card later
  }
  if (deps.fileExists(repoPath, "bun.lockb")) return VERIFY_DEFAULTS.bun;
  if (deps.fileExists(repoPath, "pnpm-lock.yaml")) return VERIFY_DEFAULTS.pnpm;
  if (deps.fileExists(repoPath, "yarn.lock")) return VERIFY_DEFAULTS.yarn;
  return VERIFY_DEFAULTS.npm;
};

/**
 * Integration base branch — NEVER main/master (D14). Prefer an existing
 * `development`/`develop` remote branch; else the repo's default branch if it
 * isn't main/master; else fall back to `development` (preparation fails loud if
 * it truly doesn't exist, which is the correct signal to create one).
 */
export const detectBaseBranch = (repoPath: string, deps: DiscoveryDeps): string => {
  for (const candidate of [DEFAULT_BASE_BRANCH, "develop"]) {
    // rev-parse --verify prints the SHA on success, nothing (our seam: "") on failure.
    if (deps.git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${candidate}`], repoPath)) {
      return candidate;
    }
  }
  const head = deps.git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repoPath); // e.g. "origin/main"
  const def = head.replace(/^origin\//, "");
  return def && def !== "main" && def !== "master" ? def : DEFAULT_BASE_BRANCH;
};

/** Build a RepoConfig for one already-cloned repo directory. */
export const discoverRepo = (baseDir: string, name: string, deps: DiscoveryDeps = defaultDiscoveryDeps): RepoConfig | undefined => {
  const clonePath = join(baseDir, name);
  if (!deps.isGitRepo(clonePath)) return undefined;
  return {
    clonePath,
    githubRepo: parseGithubRemote(deps.git(["remote", "get-url", "origin"], clonePath)),
    baseBranch: detectBaseBranch(clonePath, deps),
    verify: detectVerify(clonePath, deps),
    compose: null,
    critical: false,
  };
};

/** Discover every git checkout directly under baseDir, keyed by directory name. */
export const discoverRepos = (baseDir: string, deps: DiscoveryDeps = defaultDiscoveryDeps): Record<string, RepoConfig> => {
  const out: Record<string, RepoConfig> = {};
  for (const name of deps.listDir(baseDir)) {
    if (name.startsWith(".")) continue;
    const cfg = discoverRepo(baseDir, name, deps);
    if (cfg) out[name] = cfg;
  }
  return out;
};
