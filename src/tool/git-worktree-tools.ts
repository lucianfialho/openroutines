/**
 * Git Worktree Tools
 *
 * Isolates each execution in a separate git worktree so that:
 * - The main repo stays clean (no uncommitted changes on main)
 * - Multiple issues can be worked on in parallel
 * - Each execution gets its own branch and working directory
 */

import { exec } from "child_process";
import { promisify } from "util";
import { mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import type { Tool } from "./types.js";

const execAsync = promisify(exec);
const PROJECT_ROOT = process.env.PROJECT_ROOT
  ? resolve(process.env.PROJECT_ROOT)
  : resolve(process.cwd());

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
      let branch = String(args.branch);
      // Use a persistent directory for worktrees so they survive container restarts
      const worktreeBase = process.env.WORKTREE_BASE || tmpdir();
      const worktreePath = mkdtempSync(resolve(worktreeBase, "or-worktree-"));

      try {
        // Clean up existing branch/worktree with same name to avoid conflicts
        try {
          // Check if branch exists and delete it
          await execAsync(`git branch -D ${branch}`, { cwd: PROJECT_ROOT });
        } catch {
          // Branch didn't exist, ignore
        }
        // Also check for any existing worktree with this branch and remove it
        try {
          const { stdout: worktreeList } = await execAsync("git worktree list --porcelain", { cwd: PROJECT_ROOT });
          const lines = worktreeList.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith("worktree ")) {
              const wtPath = lines[i].replace("worktree ", "");
              const branchLine = lines[i + 2]; // branch <name> or detached
              if (branchLine && branchLine.includes(branch)) {
                await execAsync(`git worktree remove ${wtPath} --force`, { cwd: PROJECT_ROOT });
              }
            }
          }
        } catch {
          // Ignore worktree cleanup errors
        }

        // Create worktree from current HEAD (has latest local code)
        await execAsync(
          `git worktree add -b ${branch} ${worktreePath} HEAD`,
          { cwd: PROJECT_ROOT }
        );

        // Symlink node_modules so npm commands work in worktree
        // When PROJECT_ROOT is mounted (e.g. in Docker), node_modules lives
        // in the app directory (process.cwd()), not in the mounted repo.
        const nodeModulesSource = process.env.PROJECT_ROOT
          ? `${resolve(process.cwd())}/node_modules`
          : `${PROJECT_ROOT}/node_modules`;
        try {
          symlinkSync(nodeModulesSource, `${worktreePath}/node_modules`, "junction");
        } catch {
          // ignore if symlink already exists or fails
        }

        // Configure git user in worktree (needed for commits)
        await execAsync('git config user.email "openroutines@bot.local"', {
          cwd: worktreePath,
        });
        await execAsync('git config user.name "OpenRoutines Bot"', {
          cwd: worktreePath,
        });

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
        await execAsync("git add -A", { cwd });
        await execAsync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
          cwd,
        });
        await execAsync("git push -u origin HEAD", { cwd });

        // Get branch name
        const { stdout: branchStdout } = await execAsync(
          "git rev-parse --abbrev-ref HEAD",
          { cwd }
        );

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

      try {
        // Remove worktree from git
        await execAsync(`git worktree remove ${cwd}`, {
          cwd: PROJECT_ROOT,
        });

        // Delete local branch
        await execAsync(`git branch -D ${branch}`, {
          cwd: PROJECT_ROOT,
        });

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
    await execAsync(`git worktree remove ${info.path} --force`, {
      cwd: PROJECT_ROOT,
    });
    await execAsync(`git branch -D ${info.branch}`, {
      cwd: PROJECT_ROOT,
    });
  } catch {
    // Best effort cleanup
  }
  worktrees.delete(executionId);
};
