import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { makePr } from "./pr.js";
import type { CardToPrDeps } from "./index.js";
import type { PreparacaoOutput } from "./preparacao.js";
import { makeInMemoryActionLedgerRepository } from "../../persistence/action-ledger-in-memory.js";
import { makeInMemoryPrLinkRepository } from "../../persistence/pr-links-in-memory.js";
import type { TaskSource } from "../../task-source/types.js";

const preparacaoFixture = (): PreparacaoOutput => ({
  branchProtected: true,
  worktree: { path: "/tmp/or-pr-test-wt", branch: "openroutines/card-t1" },
  baseSha: "base-sha",
  baselineResults: null,
  repo: {
    githubRepo: "acme/widgets",
    baseBranch: "development",
    clonePath: "/tmp/or-pr-test-clone",
    slug: "acme-widgets",
    verify: { build: "npm run build", test: "npm test" },
  },
});

const inputs = { source_id: "trello-main", task_id: "card1", repo: "acme-widgets", title: "Fix the bug" };
const CREATED_PR = { url: "https://github.com/acme/widgets/pull/42", number: 42, branch: "openroutines/card-t1" };

describe("makePr", () => {
  it("AC5: push, PR creation and card handoff each fire exactly once across two runs of the same execution", async () => {
    const ledger = makeInMemoryActionLedgerRepository();
    const prLinks = makeInMemoryPrLinkRepository();
    const runGit = vi.fn(async () => ({ stdout: "", stderr: "" }));

    let prCreated = false;
    const createPullRequest = vi.fn(() =>
      Effect.sync(() => {
        prCreated = true;
        return { pr: CREATED_PR };
      })
    );
    const listPullRequests = vi.fn(() =>
      Effect.sync(() =>
        prCreated
          ? [{ number: 42, title: "t", url: CREATED_PR.url, state: "open", headRefName: "openroutines/card-t1" }]
          : []
      )
    );
    const makeGithub = vi.fn(() => ({ listPullRequests, createPullRequest })) as unknown as CardToPrDeps["makeGithub"];

    const moveTo = vi.fn(() => Effect.succeed(undefined));
    const comment = vi.fn(() => Effect.succeed(undefined));
    const taskSource = { moveTo, comment } as unknown as TaskSource;

    const deps: CardToPrDeps = {
      registry: { repos: {} },
      githubToken: "gh_test",
      worktreeBase: "/tmp/or-pr-test-worktrees",
      ledger,
      prLinks,
      taskSourceFor: () => taskSource,
      makeGithub,
      runGit,
    };

    const outputs = {
      preparacao: preparacaoFixture(),
      plano: { summary: "Add validation", testStrategy: "unit tests" },
      verify: { passed: true, newFailures: [], knownFailures: [] },
    };
    const handler = makePr(deps);

    const r1 = await handler({ inputs, outputs, executionId: "exec1", stateId: "pr" });
    const r2 = await handler({ inputs, outputs, executionId: "exec1", stateId: "pr" });

    expect(r1).toEqual(r2);
    expect(r1).toMatchObject({ prUrl: CREATED_PR.url, prNumber: 42 });
    expect(runGit).toHaveBeenCalledTimes(1);
    expect(runGit).toHaveBeenCalledWith(["push", "-u", "origin", "openroutines/card-t1"], "/tmp/or-pr-test-wt");
    expect(createPullRequest).toHaveBeenCalledTimes(1);
    expect(listPullRequests).toHaveBeenCalledTimes(1);
    expect(moveTo).toHaveBeenCalledTimes(1);
    expect(moveTo).toHaveBeenCalledWith("card1", "review");
    expect(comment).toHaveBeenCalledTimes(1);
    expect(comment).toHaveBeenCalledWith("card1", expect.stringContaining(CREATED_PR.url));

    const links = await prLinks.findByTask("trello-main", "card1");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ branch: "openroutines/card-t1", status: "open", prNumber: 42 });
  });

  it("is idempotent by construction: check-before-create finds an already-open PR even when the ledger never recorded 'done' (crash before ledger.complete)", async () => {
    const ledger = makeInMemoryActionLedgerRepository();
    const prLinks = makeInMemoryPrLinkRepository();

    // Simulate a prior attempt that crashed between the real effects succeeding
    // and the ledger recording 'done': push completed, the PR + pr_links row
    // already exist, but "pr:create" is still 'pending'.
    await ledger.recordPending("exec1", "pr", "git:push");
    await ledger.complete("exec1", "git:push");
    await ledger.recordPending("exec1", "pr", "pr:create");
    await prLinks.create({
      sourceId: "trello-main",
      taskId: "card1",
      repo: "acme-widgets",
      branch: "openroutines/card-t1",
      status: "open",
      prNumber: 42,
    });

    const createPullRequest = vi.fn();
    const listPullRequests = vi.fn(() =>
      Effect.sync(() => [{ number: 42, title: "t", url: CREATED_PR.url, state: "open", headRefName: "openroutines/card-t1" }])
    );
    const makeGithub = vi.fn(() => ({ listPullRequests, createPullRequest })) as unknown as CardToPrDeps["makeGithub"];
    const moveTo = vi.fn(() => Effect.succeed(undefined));
    const comment = vi.fn(() => Effect.succeed(undefined));
    const taskSource = { moveTo, comment } as unknown as TaskSource;

    const deps: CardToPrDeps = {
      registry: { repos: {} },
      githubToken: "gh_test",
      worktreeBase: "/tmp/or-pr-test-worktrees",
      ledger,
      prLinks,
      taskSourceFor: () => taskSource,
      makeGithub,
      runGit: vi.fn(async () => ({ stdout: "", stderr: "" })),
    };

    const outputs = { preparacao: preparacaoFixture() };
    const r = await makePr(deps)({ inputs, outputs, executionId: "exec1", stateId: "pr" });

    expect(createPullRequest).not.toHaveBeenCalled();
    expect(r).toMatchObject({ prUrl: CREATED_PR.url, prNumber: 42 });

    const links = await prLinks.findByTask("trello-main", "card1");
    expect(links).toHaveLength(1); // no duplicate row from the resumed run
  });

  it("refuses to open a PR against main/master even if a repo config slipped through with one", async () => {
    const deps: CardToPrDeps = {
      registry: { repos: {} },
      githubToken: "gh_test",
      worktreeBase: "/tmp/or-pr-test-worktrees",
      ledger: makeInMemoryActionLedgerRepository(),
      prLinks: makeInMemoryPrLinkRepository(),
      taskSourceFor: () => undefined,
      runGit: vi.fn(async () => ({ stdout: "", stderr: "" })),
    };
    const preparacao = { ...preparacaoFixture(), repo: { ...preparacaoFixture().repo!, baseBranch: "main" } };

    await expect(makePr(deps)({ inputs, outputs: { preparacao }, executionId: "exec1", stateId: "pr" })).rejects.toThrow(
      /main\/master/
    );
  });
});
