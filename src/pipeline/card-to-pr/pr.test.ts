import { describe, it, expect, vi, beforeEach } from "vitest";
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

// A small, clean 3-line diff on a single non-sensitive file — everything the
// risk radar (F4 #158) reads via git, args-dispatched like the real runGit.
const RISKY_UNIFIED_DIFF = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -10,0 +11,3 @@",
  "+line1",
  "+line2",
  "+line3",
].join("\n");

const makeRiskyRunGit = () =>
  vi.fn(async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    if (args[0] === "diff" && args[1] === "--name-only") return { stdout: "src/foo.ts\n", stderr: "" };
    if (args[0] === "diff" && args[1] === "--unified=0") return { stdout: RISKY_UNIFIED_DIFF, stderr: "" };
    if (args[0] === "rev-parse") return { stdout: "cafefeed1234\n", stderr: "" };
    return { stdout: "", stderr: "" }; // push and anything else
  });

describe("makePr", () => {
  it("AC5: push, PR creation and card handoff each fire exactly once across two runs of the same execution", async () => {
    const ledger = makeInMemoryActionLedgerRepository();
    const prLinks = makeInMemoryPrLinkRepository();
    const runGit = vi.fn(async (_args: string[], _cwd: string) => ({ stdout: "", stderr: "" }));

    let prCreated = false;
    const createPullRequest = vi.fn(() =>
      Effect.sync(() => {
        prCreated = true;
        return { pr: CREATED_PR };
      })
    );
    const getOpenPrByBranch = vi.fn(() =>
      Effect.sync(() => (prCreated ? { url: CREATED_PR.url, number: 42 } : undefined))
    );
    const makeGithub = vi.fn(() => ({ getOpenPrByBranch, createPullRequest })) as unknown as CardToPrDeps["makeGithub"];

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
    // The push itself (ledger-guarded) fires exactly once across both runs —
    // the risk-radar git diff/rev-parse calls added by #158 are read-only and
    // legitimately repeat on every invocation, so count "push" specifically.
    expect(runGit.mock.calls.filter(([args]) => args[0] === "push")).toHaveLength(1);
    expect(runGit).toHaveBeenCalledWith(["push", "-u", "origin", "openroutines/card-t1"], "/tmp/or-pr-test-wt");
    expect(createPullRequest).toHaveBeenCalledTimes(1);
    expect(getOpenPrByBranch).toHaveBeenCalledTimes(1);
    expect(getOpenPrByBranch).toHaveBeenCalledWith("openroutines/card-t1");
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
    const getOpenPrByBranch = vi.fn(() => Effect.sync(() => ({ url: CREATED_PR.url, number: 42 })));
    const makeGithub = vi.fn(() => ({ getOpenPrByBranch, createPullRequest })) as unknown as CardToPrDeps["makeGithub"];
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

  describe("F4 #157: rework completion path (D24)", () => {
    const reworkOutputs = () => ({
      rework_preparacao: {
        aborted: false,
        prNumber: 42,
        reviewers: ["bob"],
        worktree: { path: "/tmp/or-rework-wt", branch: "openroutines/card-t1" },
        baseSha: "mergebase123",
        repo: preparacaoFixture().repo,
      },
      rework: { needsClarification: false, filesTouched: ["src/foo.ts"], commits: ["abc fix"], notes: "" },
      verify: { passed: true, newFailures: [], knownFailures: [] },
    });
    const reworkInputs = { ...inputs, night_id: "night-2", rework: true, prNumber: 42, branch: "openroutines/card-t1" };

    const makeReworkHarness = async () => {
      const ledger = makeInMemoryActionLedgerRepository();
      const prLinks = makeInMemoryPrLinkRepository();
      await prLinks.create({
        sourceId: "trello-main",
        taskId: "card1",
        repo: "acme-widgets",
        prNumber: 42,
        branch: "openroutines/card-t1",
        status: "open",
        reviewState: "changes_requested",
        lastAgentCommitSha: "oldsha",
        reworkCount: 0,
      });
      const runGit = vi.fn(async (args: string[]): Promise<{ stdout: string; stderr: string }> =>
        args[0] === "rev-parse" ? { stdout: "newhead789\n", stderr: "" } : { stdout: "", stderr: "" }
      );
      const createPullRequest = vi.fn();
      const getOpenPrByBranch = vi.fn();
      const requestReview = vi.fn(() => Effect.succeed(undefined));
      const makeGithub = vi.fn(() => ({ createPullRequest, getOpenPrByBranch, requestReview })) as unknown as CardToPrDeps["makeGithub"];
      const moveTo = vi.fn(() => Effect.succeed(undefined));
      const comment = vi.fn(() => Effect.succeed(undefined));
      const deps: CardToPrDeps = {
        registry: { repos: {} },
        githubToken: "gh_test",
        worktreeBase: "/tmp/or-pr-test-worktrees",
        ledger,
        prLinks,
        taskSourceFor: () => ({ moveTo, comment }) as unknown as TaskSource,
        makeGithub,
        runGit,
      };
      return { deps, prLinks, runGit, createPullRequest, getOpenPrByBranch, requestReview, moveTo, comment };
    };

    it("AC: pushes the SAME branch (never --force, never -u/new branch) + requestReview; github_create_pull_request is NEVER called", async () => {
      const h = await makeReworkHarness();

      const r = await makePr(h.deps)({ inputs: reworkInputs, outputs: reworkOutputs(), executionId: "exec-rw", stateId: "pr" });

      const push = h.runGit.mock.calls.find(([args]) => args[0] === "push");
      expect(push).toBeDefined();
      // Detached rework HEAD -> the PR's own branch ref, plain fast-forward.
      expect(push![0]).toEqual(["push", "origin", "HEAD:refs/heads/openroutines/card-t1"]);
      expect(push![0]).not.toContain("--force");
      expect(push![0]).not.toContain("-f");
      expect(push![0]).not.toContain("-u");
      expect(push![1]).toBe("/tmp/or-rework-wt");

      expect(h.requestReview).toHaveBeenCalledTimes(1);
      expect(h.requestReview).toHaveBeenCalledWith(42, ["bob"]);
      // NEVER a new PR in the rework path (explicit AC)
      expect(h.createPullRequest).not.toHaveBeenCalled();
      expect(h.getOpenPrByBranch).not.toHaveBeenCalled();
      expect(r).toMatchObject({ prNumber: 42, rework: true });
    });

    it("AC: completing the round updates pr_links — rework_count+1, last_agent_commit_sha = new HEAD, review_state 're-requested', last_rework_night_id — exactly once across two runs (idempotent)", async () => {
      const h = await makeReworkHarness();
      const handler = makePr(h.deps);

      await handler({ inputs: reworkInputs, outputs: reworkOutputs(), executionId: "exec-rw", stateId: "pr" });
      await handler({ inputs: reworkInputs, outputs: reworkOutputs(), executionId: "exec-rw", stateId: "pr" });

      const link = (await h.prLinks.findByTask("trello-main", "card1"))[0];
      expect(link.reworkCount).toBe(1); // NOT 2 — ledger-guarded increment
      expect(link.lastAgentCommitSha).toBe("newhead789");
      expect(link.reviewState).toBe("re-requested");
      expect(link.lastReworkNightId).toBe("night-2");
      expect(h.runGit.mock.calls.filter(([args]) => args[0] === "push")).toHaveLength(1);
      expect(h.requestReview).toHaveBeenCalledTimes(1);
      // card handed back to Review with a pt-BR note
      expect(h.moveTo).toHaveBeenCalledTimes(1);
      expect(h.moveTo).toHaveBeenCalledWith("card1", "review");
      expect(h.comment).toHaveBeenCalledWith("card1", expect.stringContaining("Retrabalho"));
    });

    it("M4: a crash between pr_links.update and ledger.complete never double-increments reworkCount on resume", async () => {
      const h = await makeReworkHarness();
      // Simulate round 1's run() already having executed successfully — pr_links
      // stamped with reworkCount:1/newHeadSha/re-requested — but the process
      // crashed before ledger.complete recorded "pr:rework-complete" as done.
      // The ledger entry is still 'pending', exactly what a boot-reconciliation
      // resume re-invokes.
      await h.deps.ledger.recordPending("exec-rw", "pr", "git:push");
      await h.deps.ledger.complete("exec-rw", "git:push");
      await h.deps.ledger.recordPending("exec-rw", "pr", "pr:rework-complete");
      await h.prLinks.update(
        { sourceId: "trello-main", taskId: "card1", branch: "openroutines/card-t1" },
        { lastAgentCommitSha: "newhead789", reviewState: "re-requested", reworkCount: 1, lastReworkNightId: "night-2" }
      );

      await makePr(h.deps)({ inputs: reworkInputs, outputs: reworkOutputs(), executionId: "exec-rw", stateId: "pr" });

      const link = (await h.prLinks.findByTask("trello-main", "card1"))[0];
      expect(link.reworkCount).toBe(1); // guard prevented a 2nd increment
      expect(h.requestReview).not.toHaveBeenCalled(); // round 1 already requested it
    });
  });

  describe("F4 #158: risk radar + green lane", () => {
    const baseDeps = (registry: CardToPrDeps["registry"] = { repos: {} }): CardToPrDeps => ({
      registry,
      githubToken: "gh_test",
      worktreeBase: "/tmp/or-pr-test-worktrees",
      ledger: makeInMemoryActionLedgerRepository(),
      prLinks: makeInMemoryPrLinkRepository(),
      taskSourceFor: () => ({ moveTo: () => Effect.succeed(undefined), comment: () => Effect.succeed(undefined) }) as unknown as TaskSource,
      makeGithub: (() => ({
        getOpenPrByBranch: () => Effect.sync(() => undefined),
        createPullRequest: (_b: string, _t: string, body: string) => {
          lastCreatedBody = body;
          return Effect.sync(() => ({ pr: CREATED_PR }));
        },
      })) as unknown as CardToPrDeps["makeGithub"],
      runGit: makeRiskyRunGit(),
    });

    let lastCreatedBody = "";
    beforeEach(() => {
      lastCreatedBody = "";
    });

    const outputsWithVerify = (verify: Record<string, unknown> = {}) => ({
      preparacao: preparacaoFixture(),
      plano: { summary: "Add validation", testStrategy: "unit tests" },
      verify: { passed: true, newFailures: [], knownFailures: [], diffLoc: 3, ...verify },
    });

    it("computes and persists risk_score/green_lane at PR creation; risk section at the TOP, rest collapsed in <details>", async () => {
      const deps = baseDeps();

      await makePr(deps)({ inputs, outputs: outputsWithVerify(), executionId: "exec-risk", stateId: "pr" });

      expect(lastCreatedBody.startsWith("## 🎯 Revise isto primeiro")).toBe(true);
      expect(lastCreatedBody.indexOf("<details>")).toBeGreaterThan(lastCreatedBody.indexOf("Revise isto primeiro"));
      expect(lastCreatedBody).toContain("src/foo.ts#L11-L13");
      expect(lastCreatedBody).toMatch(/⏱️ ~\d+ min/);

      const links = await deps.prLinks.findByTask("trello-main", "card1");
      expect(links).toHaveLength(1);
      expect(links[0].riskScore).toBeTypeOf("number");
      expect(links[0].greenLane).toBe(true); // tiny, clean, non-sensitive diff
      // F4 #157: creation records the agent's HEAD — the first rework round's human-commit guard baseline
      expect(links[0].lastAgentCommitSha).toBe("cafefeed1234");
    });

    it("a risky diff (dataChanges + auth path + new dependency) scores higher and is never green lane", async () => {
      const deps = baseDeps();
      const riskyOutputs = outputsWithVerify({ dataChanges: true, dependencyAudit: { new: ["left-pad"] } });

      await makePr(deps)({ inputs, outputs: riskyOutputs, executionId: "exec-risky", stateId: "pr" });

      const links = await deps.prLinks.findByTask("trello-main", "card1");
      expect(links[0].greenLane).toBe(false);
      expect(links[0].riskScore as number).toBeGreaterThan(0);
    });

    it("GREEN_LANE_ENABLED=false forces green_lane:false even for a 100% clean diff", async () => {
      const original = process.env.GREEN_LANE_ENABLED;
      process.env.GREEN_LANE_ENABLED = "false";
      try {
        const deps = baseDeps();
        await makePr(deps)({ inputs, outputs: outputsWithVerify(), executionId: "exec-killswitch", stateId: "pr" });
        const links = await deps.prLinks.findByTask("trello-main", "card1");
        expect(links[0].greenLane).toBe(false);
      } finally {
        if (original === undefined) delete process.env.GREEN_LANE_ENABLED;
        else process.env.GREEN_LANE_ENABLED = original;
      }
    });

    it("repos.yaml critical:true forces green_lane:false even for a 100% clean diff", async () => {
      const registry: CardToPrDeps["registry"] = {
        repos: {
          "acme-widgets": {
            clonePath: "/tmp/or-pr-test-clone",
            githubRepo: "acme/widgets",
            baseBranch: "development",
            verify: { build: "npm run build", test: "npm test" },
            critical: true,
          },
        },
      };
      const deps = baseDeps(registry);

      await makePr(deps)({ inputs, outputs: outputsWithVerify(), executionId: "exec-critical", stateId: "pr" });

      const links = await deps.prLinks.findByTask("trello-main", "card1");
      expect(links[0].greenLane).toBe(false);
    });
  });
});
