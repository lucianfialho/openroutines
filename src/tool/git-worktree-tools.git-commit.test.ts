/**
 * git_commit AC6 (F3 #146): commits locally without ever pushing — the
 * orchestrator owns the remote (D13), the model only commits.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { makeGitWorktreeTools } from "./git-worktree-tools.js";

describe("git_commit tool", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("AC6: commits locally; the remote stays empty until an explicit push", async () => {
    const remoteDir = mkdtempSync(join(tmpdir(), "or-git-commit-remote-"));
    dirs.push(remoteDir);
    execFileSync("git", ["init", "-q", "--bare"], { cwd: remoteDir });

    const workDir = mkdtempSync(join(tmpdir(), "or-git-commit-work-"));
    dirs.push(workDir);
    execFileSync("git", ["init", "-q"], { cwd: workDir });
    execFileSync("git", ["config", "user.email", "test@test.local"], { cwd: workDir });
    execFileSync("git", ["config", "user.name", "test"], { cwd: workDir });
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: workDir });
    writeFileSync(join(workDir, "feature.txt"), "hello");

    const gitCommit = makeGitWorktreeTools().find((t) => t.definition.name === "git_commit")!;
    expect(gitCommit).toBeDefined();

    const raw = await gitCommit.handler({ message: "feat: add feature", cwd: workDir });
    const result = JSON.parse(raw) as { commit?: { committed: boolean; pushed: boolean; branch: string } };

    expect(result.commit).toMatchObject({ committed: true, pushed: false });

    const log = execFileSync("git", ["log", "--oneline"], { cwd: workDir }).toString();
    expect(log).toContain("feat: add feature");

    // Nothing was ever pushed — the bare remote must have no refs at all.
    const lsRemote = execFileSync("git", ["ls-remote", remoteDir], { cwd: workDir }).toString().trim();
    expect(lsRemote).toBe("");
  });

  it("blocks the commit when a forbidden artifact (.env) is staged, without touching git", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "or-git-commit-forbidden-"));
    dirs.push(workDir);
    execFileSync("git", ["init", "-q"], { cwd: workDir });
    execFileSync("git", ["config", "user.email", "test@test.local"], { cwd: workDir });
    execFileSync("git", ["config", "user.name", "test"], { cwd: workDir });
    writeFileSync(join(workDir, ".env"), "SECRET=1");

    const gitCommit = makeGitWorktreeTools().find((t) => t.definition.name === "git_commit")!;
    const raw = await gitCommit.handler({ message: "oops", cwd: workDir });
    const result = JSON.parse(raw) as { error?: string };

    expect(result.error).toContain("Pre-commit blocked");

    // A repo with zero commits makes `git log` itself fail — that failure IS
    // the proof no commit was ever made.
    expect(() => execFileSync("git", ["log", "--oneline"], { cwd: workDir, stdio: "pipe" })).toThrow();
  });
});
