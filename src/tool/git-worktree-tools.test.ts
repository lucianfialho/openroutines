import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeGitWorktreeTools } from "./git-worktree-tools.js";

let calls: Array<{ file: string; args: string[]; options: any }> = [];

// promisify(execFile) resolves to the object passed as the callback's 2nd arg.
vi.mock("child_process", () => ({
  execFile: vi.fn((file: string, args: string[], options: any, cb: any) => {
    calls.push({ file, args, options });
    cb(null, { stdout: "", stderr: "" });
    return {};
  }),
}));

const tools = makeGitWorktreeTools();
const tool = (name: string) => tools.find((t) => t.definition.name === name)!;

describe("git worktree tools — argv + env hardening", () => {
  beforeEach(() => { calls = []; });

  it("commit passes the message as a distinct argv element (no shell)", async () => {
    const payload = 'Fix $(touch /tmp/pwned) `whoami`; rm -rf /';
    await tool("git_commit_and_push").handler({ cwd: "/wt", message: payload });
    const commit = calls.find((c) => c.args[0] === "commit")!;
    expect(commit.file).toBe("git");
    expect(commit.args).toEqual(["commit", "-m", payload]);
  });

  it("rejects an injection branch before any git call (create)", async () => {
    const r = JSON.parse(await tool("git_create_worktree").handler({ branch: "x; touch /tmp/pwned #" }));
    expect(r.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("rejects an injection branch before any git call (remove)", async () => {
    const r = JSON.parse(await tool("git_remove_worktree").handler({ cwd: "/wt", branch: "a; rm -rf /" }));
    expect(String(r.error)).toContain("Invalid branch");
    expect(calls).toHaveLength(0);
  });

  it("git env excludes unrelated secrets but keeps the token for push", async () => {
    process.env.DATABASE_URL = "postgres://secret";
    process.env.GH_TOKEN = "ghp_x";
    try {
      await tool("git_commit_and_push").handler({ cwd: "/wt", message: "ok" });
      const push = calls.find((c) => c.args[0] === "push")!;
      expect(push.options.env.DATABASE_URL).toBeUndefined();
      expect(push.options.env.GH_TOKEN).toBe("ghp_x");
    } finally {
      delete process.env.DATABASE_URL;
      delete process.env.GH_TOKEN;
    }
  });
});
