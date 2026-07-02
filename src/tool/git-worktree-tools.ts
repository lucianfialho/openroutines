/**
 * Git Worktree Tools
 *
 * Isolates each execution in a separate git worktree so that:
 * - The main repo stays clean (no uncommitted changes on main)
 * - Multiple issues can be worked on in parallel
 * - Each execution gets its own branch and working directory
 *
 * Every git call runs via execFile with an argv array (never a shell string),
 * so a branch/commit message derived from untrusted card/issue text can never
 * break out into a shell. Branches are validated before use.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import type { Tool } from "./types.js";
import { pickEnv, BASE_ENV_VARS } from "../util/env.js";
import { isValidBranch, BRANCH_RE } from "../util/validate.js";

const execFileAsync = promisify(execFile);

// git needs no orchestrator secrets EXCEPT the GitHub token: `git push` over
// HTTPS authenticates via the gh credential helper, which reads GH_TOKEN from
// the environment. Everything else (KIMI_API_KEY, DATABASE_URL, webhook secret)
// stays out. Computed per call so it reflects the env at run time, not import.
const GIT_ENV_VARS = [...BASE_ENV_VARS, "GH_TOKEN", "GITHUB_TOKEN"];

/** Run `git <args>` with argv (no shell) and the minimal git env. */
const git = (args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync("git", args, { cwd, env: pickEnv(GIT_ENV_VARS) }) as Promise<{ stdout: string; stderr: string }>;

const getProjectRoot = () =>
  process.env.PROJECT_ROOT ? resolve(process.env.PROJECT_ROOT) : resolve(process.cwd());

interface WorktreeInfo {
  path: string;
  branch: string;
}

// In-memory store: executionId -> worktree info
const worktrees = new Map<string, WorktreeInfo>();

export const makeGitWorktreeTools = (): Tool[] => [
  {
    definition: {
      name: "git_create_worktree",
      description:
        "Create a git worktree for isolated development. Returns the worktree path and branch name. Uses the current repo as base.",
      parameters: {
        type: "object",
        properties: {
          branch: {
            type: "string",
            description: "Branch name to create (e.g. 'feat/issue-123-validation')",
          },
        },
        required: ["branch"],
      },
    },
    handler: async (args) => {
      const branch = String(args.branch);
      if (!isValidBranch(branch)) {
        return JSON.stringify({ error: `Invalid branch ref (must match ${BRANCH_RE}): ${branch}`, success: false });
      }
      // Use a persistent directory for worktrees so they survive container restarts
      const worktreeBase = process.env.WORKTREE_BASE || tmpdir();
      const worktreePath = mkdtempSync(resolve(worktreeBase, "or-worktree-"));

      try {
        // Clean up existing branch/worktree with same name to avoid conflicts
        try {
          // Check if branch exists and delete it
          await git(["branch", "-D", branch], getProjectRoot());
        } catch {
          // Branch didn't exist, ignore
        }
        // Also check for any existing worktree with this branch and remove it
        try {
          const { stdout: worktreeList } = await git(["worktree", "list", "--porcelain"], getProjectRoot());
          const lines = worktreeList.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith("worktree ")) {
              const wtPath = lines[i].replace("worktree ", "");
              const branchLine = lines[i + 2]; // branch <name> or detached
              if (branchLine && branchLine.includes(branch)) {
                await git(["worktree", "remove", wtPath, "--force"], getProjectRoot());
              }
            }
          }
        } catch {
          // Ignore worktree cleanup errors
        }

        // Create worktree from current HEAD (has latest local code)
        await git(["worktree", "add", "-b", branch, worktreePath, "HEAD"], getProjectRoot());

        // Symlink node_modules so npm commands work in worktree
        // When PROJECT_ROOT is mounted (e.g. in Docker), node_modules lives
        // in the app directory (process.cwd()), not in the mounted repo.
        const nodeModulesSource = process.env.PROJECT_ROOT
          ? `${resolve(process.cwd())}/node_modules`
          : `${getProjectRoot()}/node_modules`;
        try {
          symlinkSync(nodeModulesSource, `${worktreePath}/node_modules`, "junction");
        } catch {
          // ignore if symlink already exists or fails
        }

        // Configure git user in worktree (needed for commits)
        await git(["config", "user.email", "openroutines@bot.local"], worktreePath);
        await git(["config", "user.name", "OpenRoutines Bot"], worktreePath);

        // Store for later cleanup
        const executionId = args._executionId as string | undefined;
        if (executionId) {
          worktrees.set(executionId, { path: worktreePath, branch });
        }

        return JSON.stringify({
          worktree: {
            path: worktreePath,
            branch,
          }
        });
      } catch (err: any) {
        // Cleanup on failure
        try { rmSync(worktreePath, { recursive: true }); } catch {}
        return JSON.stringify({
          error: err.message,
          stderr: err.stderr?.trim?.() || "",
          success: false,
        });
      }
    },
  },
  {
    definition: {
      name: "git_commit_and_push",
      description:
        "Stage all changes, commit, and push the current branch from a worktree.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Commit message",
          },
          cwd: {
            type: "string",
            description: "Worktree path (from git_create_worktree)",
          },
        },
        required: ["message", "cwd"],
      },
    },
    handler: async (args) => {
      const cwd = String(args.cwd);
      const message = String(args.message);

      try {
        // Pre-commit validation: check for environment artifacts
        const { stdout: statusStdout } = await git(["status", "--short"], cwd);
        const statusLines = statusStdout.trim().split("\n").filter((l) => l.length > 0);
        const forbiddenPatterns = [
          { pattern: /node_modules/, desc: "node_modules" },
          { pattern: /\.env/, desc: ".env file" },
          { pattern: /\->\s/, desc: "symlink" },
        ];
        const violations: string[] = [];
        for (const line of statusLines) {
          for (const { pattern, desc } of forbiddenPatterns) {
            if (pattern.test(line)) {
              violations.push(`  ${line}  (${desc})`);
            }
          }
        }
        if (violations.length > 0) {
          return JSON.stringify({
            error: `Pre-commit blocked: forbidden artifacts detected in staging area.\n${violations.join("\n")}\nRemove these before committing.`,
            stdout: statusStdout,
          });
        }

        await git(["add", "-A"], cwd);
        // message passed as a distinct argv element — no shell, no escaping.
        await git(["commit", "-m", message], cwd);
        await git(["push", "-u", "origin", "HEAD"], cwd);

        // Get branch name
        const { stdout: branchStdout } = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);

        return JSON.stringify({
          commit: {
            committed: true,
            pushed: true,
            branch: branchStdout.trim(),
          }
        });
      } catch (err: any) {
        return JSON.stringify({
          error: err.message,
          stderr: err.stderr?.trim?.() || "",
          stdout: err.stdout?.trim?.() || "",
        });
      }
    },
  },
  {
    definition: {
      name: "git_remove_worktree",
      description:
        "Remove a git worktree and its branch. Call this after the PR is created.",
      parameters: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Worktree path",
          },
          branch: {
            type: "string",
            description: "Branch name to delete",
          },
        },
        required: ["cwd", "branch"],
      },
    },
    handler: async (args) => {
      const cwd = String(args.cwd);
      const branch = String(args.branch);
      if (!isValidBranch(branch)) {
        return JSON.stringify({ error: `Invalid branch ref (must match ${BRANCH_RE}): ${branch}` });
      }

      try {
        // Remove worktree from git
        await git(["worktree", "remove", cwd], getProjectRoot());

        // Delete local branch
        await git(["branch", "-D", branch], getProjectRoot());

        return JSON.stringify({ removed: true, path: cwd, branch });
      } catch (err: any) {
        return JSON.stringify({
          error: err.message,
          stderr: err.stderr?.trim?.() || "",
        });
      }
    },
  },
];

/** Get stored worktree info for an execution. */
export const getWorktreeInfo = (executionId: string): WorktreeInfo | undefined =>
  worktrees.get(executionId);

/** Clean up all worktrees for an execution. */
export const cleanupWorktree = async (executionId: string): Promise<void> => {
  const info = worktrees.get(executionId);
  if (!info) return;
  try {
    await git(["worktree", "remove", info.path, "--force"], getProjectRoot());
    await git(["branch", "-D", info.branch], getProjectRoot());
  } catch {
    // Best effort cleanup
  }
  worktrees.delete(executionId);
};
