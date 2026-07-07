import { describe, it, expect, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { makePreparation } from "./preparation.js";
import type { CardToPrDeps } from "./index.js";
import type { PreparationOutput } from "./preparation.js";
import { makeInMemoryActionLedgerRepository } from "../../persistence/action-ledger-in-memory.js";
import { makeInMemoryPrLinkRepository } from "../../persistence/pr-links-in-memory.js";
import type { RepoRegistry } from "../../repo-registry/schema.js";

const registry: RepoRegistry = {
  repos: {
    "acme-widgets": {
      clonePath: "/tmp/or-preparation-test-clone",
      githubRepo: "acme/widgets",
      baseBranch: "development",
      verify: { build: "npm run build", test: "npm test" },
    },
  },
};

const baseDeps = (overrides: Partial<CardToPrDeps> = {}): CardToPrDeps => ({
  registry,
  githubToken: "gh_test",
  worktreeBase: "/tmp/or-preparation-test-worktrees",
  ledger: makeInMemoryActionLedgerRepository(),
  prLinks: makeInMemoryPrLinkRepository(),
  taskSourceFor: () => undefined,
  ...overrides,
});

const inputs = { source_id: "s", task_id: "t1", repo: "acme-widgets" };

describe("makePreparation", () => {
  it("returns repo-unresolvable without ever calling runGit when the card's repo field matches no repos.yaml entry", async () => {
    const runGit = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const handler = makePreparation(baseDeps({ runGit }));

    const r = await handler({
      inputs: { ...inputs, repo: "does-not-exist" },
      outputs: {},
      executionId: "e1",
      stateId: "preparation",
    });

    expect(r).toEqual({ blockReason: "repo-unresolvable" });
    // Unresolved repo short-circuits before any git spend at all.
    expect(runGit).not.toHaveBeenCalled();
  });

  it("F4 #156: merges ignore-scripts=true into the new worktree's .npmrc before returning", async () => {
    const worktreePath = "/tmp/or-preparation-test-worktrees/card-t1";
    rmSync(worktreePath, { recursive: true, force: true });

    const runGit = vi.fn(async (args: string[]) =>
      args[0] === "rev-parse" || args[0] === "merge-base" ? { stdout: "abc123\n", stderr: "" } : { stdout: "", stderr: "" }
    );
    const handler = makePreparation(baseDeps({ runGit }));

    try {
      const r = (await handler({ inputs, outputs: {}, executionId: "e1", stateId: "preparation" })) as PreparationOutput;

      expect(r.worktree).toEqual({ path: worktreePath, branch: "openroutines/card-t1" });
      expect(r.baseSha).toBe("abc123");
      // git worktree add is mocked (a no-op on disk here), so this .npmrc can
      // only exist if preparation itself called ensureIgnoreScripts against
      // worktreePath — proves the guard is wired into the real success path.
      expect(readFileSync(join(worktreePath, ".npmrc"), "utf-8")).toContain("ignore-scripts=true");
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("idempotent retry: force-recreates when the dir on disk isn't a live worktree on the card's branch (crash mid `worktree add`, or a leftover from an earlier execution)", async () => {
    const worktreePath = "/tmp/or-preparation-test-worktrees/card-t1";
    const clonePath = "/tmp/or-preparation-test-clone";
    rmSync(worktreePath, { recursive: true, force: true });
    mkdirSync(worktreePath, { recursive: true }); // dir exists, but was never a real `git worktree add`

    const calls: Array<{ args: string[]; cwd: string }> = [];
    const runGit = vi.fn(async (args: string[], cwd: string) => {
      calls.push({ args, cwd });
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) throw new Error("fatal: not a git repository");
      if (args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "" };
      if (args[0] === "merge-base") return { stdout: "abc123\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const handler = makePreparation(baseDeps({ runGit }));

    try {
      const r = (await handler({ inputs, outputs: {}, executionId: "e1", stateId: "preparation" })) as PreparationOutput;

      expect(r.worktree).toEqual({ path: worktreePath, branch: "openroutines/card-t1" });
      expect(r.baseSha).toBe("abc123");
      // Force-clean before recreating — all against the ORIGIN clone, never the broken worktree dir.
      expect(calls).toContainEqual({ args: ["worktree", "remove", "--force", worktreePath], cwd: clonePath });
      expect(calls).toContainEqual({ args: ["worktree", "prune"], cwd: clonePath });
      expect(calls).toContainEqual({ args: ["branch", "-D", "openroutines/card-t1"], cwd: clonePath });
      expect(calls).toContainEqual({
        args: ["worktree", "add", "-b", "openroutines/card-t1", worktreePath, "development"],
        cwd: clonePath,
      });
      // New worktree (no reuse): baseSha comes from the SAME merge-base(HEAD, origin/<baseBranch>)
      // call the reuse path makes — mathematically equal to HEAD here since the freshly created
      // branch's tip is an ancestor of origin/<baseBranch> (no behavior change from before this fix).
      expect(calls).toContainEqual({ args: ["merge-base", "HEAD", "origin/development"], cwd: worktreePath });
      const addIdx = calls.findIndex((c) => c.args[0] === "worktree" && c.args[1] === "add");
      const mergeBaseIdx = calls.findIndex((c) => c.args[0] === "merge-base");
      expect(mergeBaseIdx).toBeGreaterThan(addIdx); // the worktree must exist before merge-base can run in it
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("idempotent retry: reuses the worktree untouched (no remove/add/branch -D) when it's already checked out on the card's branch, and baseSha is the merge-base with origin/<baseBranch> — not raw HEAD — so local commits from a previous attempt (e.g. a card back from Blocked) stay inside the review boundary", async () => {
    const worktreePath = "/tmp/or-preparation-test-worktrees/card-t1";
    rmSync(worktreePath, { recursive: true, force: true });
    mkdirSync(worktreePath, { recursive: true }); // simulates reuse: worktree already live on `branch`, with local commits ahead of origin from a prior attempt

    const calls: Array<{ args: string[]; cwd: string }> = [];
    const runGit = vi.fn(async (args: string[], cwd: string) => {
      calls.push({ args, cwd });
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) return { stdout: "openroutines/card-t1\n", stderr: "" };
      if (args[0] === "rev-parse") return { stdout: "rawhead-with-local-commits\n", stderr: "" }; // must NOT be used as baseSha
      if (args[0] === "merge-base") return { stdout: "mergebasesha777\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const handler = makePreparation(baseDeps({ runGit }));

    try {
      const r = (await handler({ inputs, outputs: {}, executionId: "e1", stateId: "preparation" })) as PreparationOutput;

      expect(r.worktree).toEqual({ path: worktreePath, branch: "openroutines/card-t1" });
      expect(calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(false);
      expect(calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add")).toBe(false);
      expect(calls.some((c) => c.args[0] === "branch" && c.args[1] === "-D")).toBe(false);
      expect(r.baseSha).toBe("mergebasesha777");
      expect(calls).toContainEqual({ args: ["merge-base", "HEAD", "origin/development"], cwd: worktreePath });
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });
});
