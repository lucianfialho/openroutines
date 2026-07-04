import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Effect } from "effect";
import { makePrDocs, stampProfileHeader, type PrDocsOutput } from "./pr-docs.js";
import type { MappingDeps } from "./index.js";
import { makeInMemoryActionLedgerRepository } from "../../persistence/action-ledger-in-memory.js";
import type { TaskSource } from "../../task-source/types.js";

describe("card-mapping stampProfileHeader (#162)", () => {
  it("stamps today's date onto the `Compilado em` header line", () => {
    const wt = mkdtempSync(join(tmpdir(), "or-stamp-"));
    const docs = join(wt, "docs");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "REPO-PROFILE.md"), "# Repo Profile — acme\n> Compilado em AAAA-MM-DD pelo OpenRoutines · x\n\n## Tese\n");
    expect(stampProfileHeader(wt, "2026-07-04")).toBe(true);
    const after = readFileSync(join(docs, "REPO-PROFILE.md"), "utf-8");
    expect(after).toContain("> Compilado em 2026-07-04 pelo OpenRoutines");
    expect(after).not.toContain("AAAA-MM-DD");
    rmSync(wt, { recursive: true, force: true });
  });
  it("is a no-op (returns false) when the profile file is absent", () => {
    expect(stampProfileHeader("/no/such/worktree", "2026-07-04")).toBe(false);
  });
});

interface GhCalls {
  created: Array<{ branch: string; base?: string; title: string }>;
}
const makeDeps = (opts: {
  gh: GhCalls;
  moves: Array<{ id: string; state: string }>;
  diff: string; // `git diff --name-only base HEAD` output
  ledger?: ReturnType<typeof makeInMemoryActionLedgerRepository>;
  pushCalls?: string[];
}): MappingDeps =>
  ({
    registry: { repos: {} },
    githubToken: "gh",
    worktreeBase: "/tmp",
    ledger: opts.ledger ?? makeInMemoryActionLedgerRepository(),
    taskSourceFor: () =>
      ({
        moveTo: (id: string, state: string) => {
          opts.moves.push({ id, state });
          return Effect.succeed(undefined);
        },
        comment: () => Effect.succeed(undefined),
      }) as unknown as TaskSource,
    makeGithub: (() => ({
      getOpenPrByBranch: () => Effect.succeed(undefined),
      createPullRequest: (branch: string, title: string, _body: string, base?: string) => {
        opts.gh.created.push({ branch, base, title });
        return Effect.succeed({ pr: { url: "https://github.com/acme/w/pull/7", number: 7, branch } });
      },
    })) as unknown as MappingDeps["makeGithub"],
    runGit: async (args: string[]) => {
      if (args[0] === "diff" && args[1] === "--cached") return { stdout: "docs/REPO-PROFILE.md", stderr: "" };
      if (args[0] === "diff" && args[1] === "--name-only") return { stdout: opts.diff, stderr: "" };
      if (args[0] === "push") {
        opts.pushCalls?.push(args.join(" "));
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  }) as unknown as MappingDeps;

const prep = {
  repo: { slug: "acme", githubRepo: "acme/w", clonePath: "/c", baseBranch: "development" },
  worktree: { path: "/wt", branch: "openroutines/mapeamento-acme-2026-07-04" },
  baseSha: "base0",
};
const scan = { profile: {}, coreSectionsComplete: true, goldenRoutes: ["/x"], exemplars: [{ sha: "a", changeShape: "route" }], hasFrontend: false };
const ctx = (deps: MappingDeps, extraOutputs: Record<string, unknown> = {}) =>
  makePrDocs(deps)({
    inputs: { source_id: "s", task_id: "card1", title: "Mapear acme" },
    outputs: { preparation: prep, scan, ...extraOutputs },
    executionId: "exec1",
    stateId: "pr_docs",
  }) as Promise<PrDocsOutput>;

describe("card-mapping pr_docs (#162)", () => {
  it("criterion 4: changedFiles is a subset of docs/**, PR opens against the integration branch, card -> Review", async () => {
    const gh: GhCalls = { created: [] };
    const moves: Array<{ id: string; state: string }> = [];
    const out = await ctx(makeDeps({ gh, moves, diff: "docs/REPO-PROFILE.md\ndocs/visual/01-home.png" }));

    expect(out.changedFiles.every((f) => f.startsWith("docs/"))).toBe(true);
    expect(out.prUrl).toBe("https://github.com/acme/w/pull/7");
    expect(gh.created).toHaveLength(1);
    expect(gh.created[0].base).toBe("development"); // never main/master
    expect(moves).toEqual([{ id: "card1", state: "review" }]);
  });

  it("REFUSES to open a PR when the diff escapes docs/** (deterministic docs-only guard)", async () => {
    const gh: GhCalls = { created: [] };
    const moves: Array<{ id: string; state: string }> = [];
    await expect(
      ctx(makeDeps({ gh, moves, diff: "docs/REPO-PROFILE.md\nsrc/leaked.ts" }))
    ).rejects.toThrow(/non-docs files: src\/leaked\.ts/);
    expect(gh.created).toHaveLength(0); // never reached PR creation
  });

  it("is idempotent: a second run on the same ledger never re-creates the PR or re-pushes", async () => {
    const gh: GhCalls = { created: [] };
    const moves: Array<{ id: string; state: string }> = [];
    const ledger = makeInMemoryActionLedgerRepository();
    const pushCalls: string[] = [];
    const deps = makeDeps({ gh, moves, diff: "docs/REPO-PROFILE.md", ledger, pushCalls });

    await ctx(deps);
    await ctx(deps); // resume — everything already 'done'

    expect(gh.created).toHaveLength(1);
    expect(pushCalls).toHaveLength(1);
  });
});
