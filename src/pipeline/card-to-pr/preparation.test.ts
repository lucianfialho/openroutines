import { describe, it, expect, vi } from "vitest";
import { readFileSync, rmSync } from "fs";
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

    const runGit = vi.fn(async (args: string[]) => (args[0] === "rev-parse" ? { stdout: "abc123\n", stderr: "" } : { stdout: "", stderr: "" }));
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
});
