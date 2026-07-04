import { describe, it, expect } from "vitest";
import { makePreparacao, today, type MapeamentoPreparacaoOutput } from "./preparacao.js";
import type { MapeamentoDeps } from "./index.js";
import type { RepoRegistry } from "../../repo-registry/schema.js";

const registry: RepoRegistry = {
  repos: { "acme-widgets": { clonePath: "/clones/acme", githubRepo: "acme/widgets", baseBranch: "development", verify: { build: "true", test: "true" } } },
};

const run = (deps: MapeamentoDeps, repo: string) =>
  makePreparacao(deps)({ inputs: { task_id: "card1", repo }, outputs: {}, executionId: "e", stateId: "preparacao" });

describe("card-mapeamento preparacao (#162)", () => {
  it("resolves the repo and mounts a worktree on the dated mapeamento branch", async () => {
    const gitCalls: string[][] = [];
    const deps = {
      registry,
      githubToken: "gh",
      worktreeBase: "/tmp/or-wt",
      taskSourceFor: () => undefined,
      runGit: async (args: string[]) => {
        gitCalls.push(args);
        return { stdout: args[0] === "rev-parse" ? "deadbeef\n" : "", stderr: "" };
      },
    } as unknown as MapeamentoDeps;

    const out = (await run(deps, "acme-widgets")) as MapeamentoPreparacaoOutput;

    expect(out.repo).toEqual({ slug: "acme-widgets", githubRepo: "acme/widgets", clonePath: "/clones/acme", baseBranch: "development" });
    expect(out.baseSha).toBe("deadbeef");
    expect(out.worktree.branch).toMatch(/^openroutines\/mapeamento-acme-widgets-\d{4}-\d{2}-\d{2}$/);
    expect(out.worktree.branch).toContain(today());
    // worktree created with -b on the base branch, off the clone
    const wtAdd = gitCalls.find((a) => a[0] === "worktree");
    expect(wtAdd).toBeDefined();
    expect(wtAdd).toContain("-b");
    expect(wtAdd).toContain("development");
    expect(wtAdd![wtAdd!.indexOf("-b") + 1]).toBe(out.worktree.branch);
  });

  it("returns an error string (fails the state) when the repo is unresolvable", async () => {
    const deps = {
      registry,
      githubToken: "gh",
      worktreeBase: "/tmp/or-wt",
      taskSourceFor: () => undefined,
      runGit: async () => ({ stdout: "", stderr: "" }),
    } as unknown as MapeamentoDeps;
    const out = await run(deps, "does-not-exist");
    expect(typeof out).toBe("string");
    expect(out as string).toContain("não resolvível");
  });
});
