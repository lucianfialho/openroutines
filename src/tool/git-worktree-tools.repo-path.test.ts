/**
 * git_create_worktree / git_remove_worktree — optional repoPath.
 *
 * Real git against temp repos (no mocking of child_process), mirroring the
 * end-to-end style in engine/integration.test.ts. Verifies that passing
 * repoPath redirects the "origin repo" git calls away from PROJECT_ROOT, and
 * that omitting it keeps the existing solve-issue behavior unchanged.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { resolve, join } from "path";
import { execSync } from "child_process";
import { makeGitWorktreeTools } from "./git-worktree-tools.js";

const tools = makeGitWorktreeTools();
const tool = (name: string) => tools.find((t) => t.definition.name === name)!;

/** A minimal repo with one commit, tagged by a marker file so tests can tell repos apart. */
const initRepo = (marker: string): string => {
  const dir = mkdtempSync(resolve(tmpdir(), "repo-path-test-"));
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email 'test@test.com'", { cwd: dir });
  execSync("git config user.name 'Test'", { cwd: dir });
  writeFileSync(join(dir, marker), "marker\n");
  // node_modules must be gitignored — git_create_worktree symlinks one into every
  // worktree, and git_remove_worktree runs without --force (same as production repos).
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  execSync("git add -A", { cwd: dir });
  execSync("git commit -q -m init", { cwd: dir });
  return dir;
};

describe("git worktree tools — optional repoPath", () => {
  const dirs: string[] = [];
  const originalProjectRoot = process.env.PROJECT_ROOT;

  afterEach(() => {
    if (originalProjectRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = originalProjectRoot;
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with repoPath: worktree is created from that clone, not from PROJECT_ROOT", async () => {
    const decoyProjectRoot = initRepo("marker-decoy.txt");
    const repoPath = initRepo("marker-real.txt");
    dirs.push(decoyProjectRoot, repoPath);
    process.env.PROJECT_ROOT = decoyProjectRoot; // must be ignored once repoPath is given

    const created = JSON.parse(
      await tool("git_create_worktree").handler({ branch: "from-repo-path", repoPath })
    );
    expect(created.error).toBeUndefined();
    dirs.push(created.worktree.path);

    expect(existsSync(join(created.worktree.path, "marker-real.txt"))).toBe(true);
    expect(existsSync(join(created.worktree.path, "marker-decoy.txt"))).toBe(false);
  });

  it("without repoPath: behavior is unchanged — still resolves against PROJECT_ROOT", async () => {
    const projectRoot = initRepo("marker-real.txt");
    dirs.push(projectRoot);
    process.env.PROJECT_ROOT = projectRoot;

    const created = JSON.parse(await tool("git_create_worktree").handler({ branch: "from-project-root" }));
    expect(created.error).toBeUndefined();
    dirs.push(created.worktree.path);

    expect(existsSync(join(created.worktree.path, "marker-real.txt"))).toBe(true);
  });

  it("git_remove_worktree with repoPath removes the worktree and branch from that origin clone", async () => {
    const repoPath = initRepo("marker-real.txt");
    dirs.push(repoPath);
    delete process.env.PROJECT_ROOT;

    const created = JSON.parse(
      await tool("git_create_worktree").handler({ branch: "to-remove", repoPath })
    );
    expect(created.error).toBeUndefined();

    const removed = JSON.parse(
      await tool("git_remove_worktree").handler({ cwd: created.worktree.path, branch: "to-remove", repoPath })
    );
    expect(removed.removed).toBe(true);

    const branches = execSync("git branch --list to-remove", { cwd: repoPath }).toString().trim();
    expect(branches).toBe("");
    const worktreeList = execSync("git worktree list --porcelain", { cwd: repoPath }).toString();
    expect(worktreeList).not.toContain(created.worktree.path);
  });

  it("git_remove_worktree without repoPath: unchanged — still resolves against PROJECT_ROOT", async () => {
    const projectRoot = initRepo("marker-real.txt");
    dirs.push(projectRoot);
    process.env.PROJECT_ROOT = projectRoot;

    const created = JSON.parse(await tool("git_create_worktree").handler({ branch: "to-remove-default" }));
    expect(created.error).toBeUndefined();

    const removed = JSON.parse(
      await tool("git_remove_worktree").handler({ cwd: created.worktree.path, branch: "to-remove-default" })
    );
    expect(removed.removed).toBe(true);

    const branches = execSync("git branch --list to-remove-default", { cwd: projectRoot }).toString().trim();
    expect(branches).toBe("");
  });
});
