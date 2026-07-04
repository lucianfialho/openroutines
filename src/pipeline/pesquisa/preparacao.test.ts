import { describe, it, expect, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { makePreparacao } from "./preparacao.js";
import type { PreparacaoOutput } from "./preparacao.js";
import type { PesquisaDeps } from "./index.js";
import type { RepoRegistry } from "../../repo-registry/schema.js";

const registry: RepoRegistry = {
  repos: {
    "acme-widgets": {
      clonePath: "/tmp/or-pesquisa-clone-A",
      githubRepo: "acme/widgets",
      baseBranch: "development",
      verify: { build: "true", test: "true" },
    },
  },
};

const baseDeps = (o: Partial<PesquisaDeps> = {}): PesquisaDeps => ({
  registry,
  githubToken: "gh",
  worktreeBase: "/tmp/or-pesquisa-wt",
  taskSourceFor: () => undefined,
  claudeApiKey: "sk",
  ...o,
});

const inputs = { source_id: "s", task_id: "t1", repo: "acme-widgets", title: "T", description: "D" };
const ctx = (over: Record<string, unknown> = {}) => ({ inputs, outputs: {}, executionId: "e", stateId: "preparacao", ...over });

describe("card-pesquisa preparacao", () => {
  it("resolves the repo and mounts a DETACHED read-only worktree at the base branch", async () => {
    const wtBase = `/tmp/or-pesquisa-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const runGit = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const r = (await makePreparacao(baseDeps({ runGit, worktreeBase: wtBase }))(ctx())) as PreparacaoOutput;

    expect(r.repos).toHaveLength(1);
    expect(r.repos[0]).toMatchObject({ slug: "acme-widgets", githubRepo: "acme/widgets", baseBranch: "development" });
    expect(r.worktree?.path).toBe(join(wtBase, "pesquisa-t1"));
    // Detached (never `-b <branch>`) — a research worktree never commits/pushes.
    expect(runGit).toHaveBeenCalledWith(
      ["worktree", "add", "--detach", join(wtBase, "pesquisa-t1"), "development"],
      "/tmp/or-pesquisa-clone-A"
    );
  });

  it("is tolerant: an unresolvable repo yields no repos, no worktree, and no git call", async () => {
    const runGit = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const r = (await makePreparacao(baseDeps({ runGit }))(ctx({ inputs: { ...inputs, repo: "does-not-exist" } }))) as PreparacaoOutput;

    expect(r.repos).toEqual([]);
    expect(r.worktree).toBeUndefined();
    expect(runGit).not.toHaveBeenCalled();
  });

  it("resolves multiple repo fields but only worktrees the first", async () => {
    const reg: RepoRegistry = {
      repos: {
        "acme-widgets": { clonePath: "/c/a", githubRepo: "acme/widgets", baseBranch: "development", verify: { build: "true", test: "true" } },
        "acme-api": { clonePath: "/c/b", githubRepo: "acme/api", baseBranch: "main", verify: { build: "true", test: "true" } },
      },
    };
    const runGit = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const r = (await makePreparacao(baseDeps({ registry: reg, runGit }))(
      ctx({ inputs: { ...inputs, repo: "acme-widgets, acme-api" } })
    )) as PreparacaoOutput;

    expect(r.repos.map((x) => x.slug)).toEqual(["acme-widgets", "acme-api"]);
    expect(runGit).toHaveBeenCalledTimes(1); // one worktree, for the first repo only
  });

  it("reads docs/REPO-PROFILE.md into the repo context (best-effort)", async () => {
    const clone = `/tmp/or-pesquisa-clone-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    mkdirSync(join(clone, "docs"), { recursive: true });
    writeFileSync(join(clone, "docs", "REPO-PROFILE.md"), "# Perfil\nStack: TypeScript ESM");
    try {
      const reg: RepoRegistry = {
        repos: { "acme-widgets": { clonePath: clone, githubRepo: "acme/widgets", baseBranch: "development", verify: { build: "true", test: "true" } } },
      };
      const runGit = vi.fn(async () => ({ stdout: "", stderr: "" }));
      const r = (await makePreparacao(baseDeps({ registry: reg, runGit, worktreeBase: `/tmp/or-pesquisa-wt-${Date.now()}` }))(ctx())) as PreparacaoOutput;
      expect(r.repos[0].profile).toContain("Stack: TypeScript ESM");
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });
});
