import { describe, it, expect, vi } from "vitest";
import { makePreparacao } from "./preparacao.js";
import type { CardToPrDeps } from "./index.js";
import { makeInMemoryActionLedgerRepository } from "../../persistence/action-ledger-in-memory.js";
import { makeInMemoryPrLinkRepository } from "../../persistence/pr-links-in-memory.js";
import type { RepoRegistry } from "../../repo-registry/schema.js";

const registry: RepoRegistry = {
  repos: {
    "acme-widgets": {
      clonePath: "/tmp/or-preparacao-test-clone",
      githubRepo: "acme/widgets",
      baseBranch: "development",
      verify: { build: "npm run build", test: "npm test" },
    },
  },
};

const baseDeps = (overrides: Partial<CardToPrDeps> = {}): CardToPrDeps => ({
  registry,
  githubToken: "gh_test",
  worktreeBase: "/tmp/or-preparacao-test-worktrees",
  ledger: makeInMemoryActionLedgerRepository(),
  prLinks: makeInMemoryPrLinkRepository(),
  taskSourceFor: () => undefined,
  ...overrides,
});

const inputs = { source_id: "s", task_id: "t1", repo: "acme-widgets" };

describe("makePreparacao", () => {
  it("returns repo-nao-resolvivel without ever calling runGit when the card's repo field matches no repos.yaml entry", async () => {
    const runGit = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const checkProtection = vi.fn(async () => ({ protected: true }));
    const handler = makePreparacao(baseDeps({ runGit, checkProtection }));

    const r = await handler({
      inputs: { ...inputs, repo: "does-not-exist" },
      outputs: {},
      executionId: "e1",
      stateId: "preparacao",
    });

    expect(r).toEqual({ branchProtected: false, blockReason: "repo-nao-resolvivel" });
    // Unresolved repo short-circuits before any preflight/git spend at all.
    expect(checkProtection).not.toHaveBeenCalled();
    expect(runGit).not.toHaveBeenCalled();
  });

  it("returns sem-branch-protection and never creates a worktree/baseline when checkProtection reports protected:false", async () => {
    const runGit = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const checkProtection = vi.fn(async () => ({ protected: false, reason: "no rules configured" }));
    const handler = makePreparacao(baseDeps({ runGit, checkProtection }));

    const r = await handler({ inputs, outputs: {}, executionId: "e1", stateId: "preparacao" });

    expect(r).toEqual({ branchProtected: false, blockReason: "sem-branch-protection" });
    expect(checkProtection).toHaveBeenCalledTimes(1);
    // No fetch, no worktree add, no rev-parse — no runGit call happens past the protection check.
    expect(runGit).not.toHaveBeenCalled();
  });
});
