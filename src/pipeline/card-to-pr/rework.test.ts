import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { makeReworkPreparacao, makeReworkPergunta, findHumanAuthors, DEFAULT_AGENT_GIT_AUTHORS } from "./rework.js";
import type { ReworkPreparacaoOutput } from "./rework.js";
import type { CardToPrDeps } from "./index.js";
import { makeInMemoryActionLedgerRepository } from "../../persistence/action-ledger-in-memory.js";
import { makeInMemoryPrLinkRepository } from "../../persistence/pr-links-in-memory.js";
import { FIX_LIST_HIERARCHY } from "../../review/build-fix-list.js";
import type { RepoRegistry } from "../../repo-registry/schema.js";

const registry: RepoRegistry = {
  repos: {
    "acme-widgets": {
      clonePath: "/tmp/or-rework-clone",
      githubRepo: "acme/widgets",
      baseBranch: "development",
      verify: { build: "true", test: "true" },
    },
  },
};

const inputs = {
  source_id: "trello-main",
  task_id: "card1",
  repo: "acme-widgets",
  title: "Fix the bug",
  description: "desc",
  rework: true,
  prNumber: 42,
  branch: "openroutines/card-card1",
};

interface GithubMockOpts {
  prState?: string;
  latestReviews?: Array<{ author: string; state: string; body: string }>;
  comments?: Array<{ file: string; line?: number; body: string; author: string }>;
}

const makeGithubMock = (opts: GithubMockOpts = {}) => {
  const latestReviews = opts.latestReviews ?? [{ author: "bob", state: "CHANGES_REQUESTED", body: "" }];
  const prComments: string[] = [];
  const github = {
    listPullRequestReviews: vi.fn(() =>
      Effect.succeed({
        prState: opts.prState ?? "OPEN",
        reviewState: "CHANGES_REQUESTED" as const,
        changesRequestedBy: latestReviews.filter((r) => r.state === "CHANGES_REQUESTED").map((r) => r.author),
        latestReviews,
        pendingReviewRequests: [],
      })
    ),
    listReviewComments: vi.fn(() => Effect.succeed(opts.comments ?? [])),
    commentOnPullRequest: vi.fn((_n: number, body: string) => {
      prComments.push(body);
      return Effect.succeed(undefined);
    }),
  };
  return { github, prComments };
};

/** runGit mock keyed by subcommand; `log` output is the %an%n%ae pair stream. */
const makeRunGit = (logOutput = "") =>
  vi.fn(async (args: string[], _cwd: string): Promise<{ stdout: string; stderr: string }> => {
    if (args[0] === "log") return { stdout: logOutput, stderr: "" };
    if (args[0] === "merge-base") return { stdout: "mergebase123\n", stderr: "" };
    if (args[0] === "rev-parse") return { stdout: "remotehead456\n", stderr: "" };
    return { stdout: "", stderr: "" };
  });

// Unique per run: ensureIgnoreScripts mkdirs the worktree path for real, and a
// stale dir from a previous run would make the existsSync guard skip `worktree add`.
const WORKTREE_BASE = `/tmp/or-rework-wt-${process.pid}-${Date.now()}`;

const makeDeps = (overrides: Partial<CardToPrDeps> = {}): CardToPrDeps => ({
  registry,
  githubToken: "gh_test",
  worktreeBase: WORKTREE_BASE,
  ledger: makeInMemoryActionLedgerRepository(),
  prLinks: makeInMemoryPrLinkRepository(),
  taskSourceFor: () => undefined,
  runGit: makeRunGit(),
  ...overrides,
});

const seedLink = async (deps: CardToPrDeps, lastAgentCommitSha?: string) => {
  await deps.prLinks.create({
    sourceId: "trello-main",
    taskId: "card1",
    repo: "acme-widgets",
    prNumber: 42,
    branch: "openroutines/card-card1",
    status: "open",
    reviewState: "changes_requested",
    ...(lastAgentCommitSha ? { lastAgentCommitSha } : {}),
  });
};

describe("makeReworkPreparacao (F4 #157, D24)", () => {
  it("AC: recreates the worktree from origin/<branch> — detached, no -b (inspected via git args)", async () => {
    const runGit = makeRunGit();
    const { github } = makeGithubMock();
    const deps = makeDeps({ runGit, makeGithub: (() => github) as unknown as CardToPrDeps["makeGithub"] });
    await seedLink(deps, "agentsha1");

    const out = (await makeReworkPreparacao(deps)({ inputs, outputs: {}, executionId: "exec-rw1", stateId: "rework_preparacao" })) as unknown as ReworkPreparacaoOutput;

    expect(out.aborted).toBe(false);
    const wtCall = runGit.mock.calls.find(([args]) => args[0] === "worktree");
    expect(wtCall).toBeDefined();
    const [wtArgs, wtCwd] = wtCall!;
    expect(wtArgs[0]).toBe("worktree");
    expect(wtArgs[1]).toBe("add");
    expect(wtArgs).not.toContain("-b"); // never a new branch
    expect(wtArgs[wtArgs.length - 1]).toBe("origin/openroutines/card-card1"); // the PR's REMOTE head
    expect(wtCwd).toBe("/tmp/or-rework-clone");
    // fetch happened before the worktree add
    const fetchIdx = runGit.mock.calls.findIndex(([args]) => args[0] === "fetch");
    const wtIdx = runGit.mock.calls.findIndex(([args]) => args[0] === "worktree");
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeLessThan(wtIdx);
    expect(out.worktree?.branch).toBe("openroutines/card-card1");
  });

  it("AC: human commit since last_agent_commit_sha aborts — no code touched, comment asking for direction, prLinks untouched", async () => {
    // git log pairs: one agent commit, then a human one.
    const logOutput = ["OpenRoutines Bot", "openroutines@bot.local", "Henrik", "henrik@example.com"].join("\n");
    const runGit = makeRunGit(logOutput);
    const { github, prComments } = makeGithubMock();
    const deps = makeDeps({ runGit, makeGithub: (() => github) as unknown as CardToPrDeps["makeGithub"] });
    await seedLink(deps, "agentsha1");

    const out = (await makeReworkPreparacao(deps)({ inputs, outputs: {}, executionId: "exec-rw2", stateId: "rework_preparacao" })) as unknown as ReworkPreparacaoOutput;

    expect(out.aborted).toBe(true);
    expect(out.abortReason).toBe("commit-humano");
    // the guard log ranged exactly from the agent's last pushed sha
    expect(runGit).toHaveBeenCalledWith(["log", "agentsha1..HEAD", "--format=%an%n%ae"], expect.any(String));
    // a pt-BR comment asking for direction was posted on the PR
    expect(prComments).toHaveLength(1);
    expect(prComments[0]).toContain("Retrabalho abortado");
    expect(prComments[0]).toContain("Henrik");
    // rework_count untouched (increment only happens in pr.ts on completion)
    const link = (await deps.prLinks.findByTask("trello-main", "card1"))[0];
    expect(link.reworkCount ?? 0).toBe(0);
    expect(link.reviewState).toBe("changes_requested");
  });

  it("missing last_agent_commit_sha is fail-safe: aborts without touching the branch", async () => {
    const runGit = makeRunGit();
    const { github, prComments } = makeGithubMock();
    const deps = makeDeps({ runGit, makeGithub: (() => github) as unknown as CardToPrDeps["makeGithub"] });
    await seedLink(deps); // no sha

    const out = (await makeReworkPreparacao(deps)({ inputs, outputs: {}, executionId: "exec-rw3", stateId: "rework_preparacao" })) as unknown as ReworkPreparacaoOutput;

    expect(out.aborted).toBe(true);
    expect(out.abortReason).toBe("sem-last-agent-sha");
    expect(prComments).toHaveLength(1);
    expect(runGit.mock.calls.some(([args]) => args[0] === "log")).toBe(false); // never even ranged the log
  });

  it("builds the fix-list (hierarchy + review body + inline comments in order) and captures the re-request reviewers", async () => {
    const { github } = makeGithubMock({
      latestReviews: [{ author: "bob", state: "CHANGES_REQUESTED", body: "faltou tratar o null" }],
      comments: [
        { file: "src/a.ts", line: 12, body: "rename this", author: "bob" },
        { file: "src/b.ts", line: 30, body: "off by one", author: "bob" },
      ],
    });
    const deps = makeDeps({ makeGithub: (() => github) as unknown as CardToPrDeps["makeGithub"] });
    await seedLink(deps, "agentsha1");

    const out = (await makeReworkPreparacao(deps)({ inputs, outputs: {}, executionId: "exec-rw4", stateId: "rework_preparacao" })) as unknown as ReworkPreparacaoOutput;

    expect(out.fixList!.startsWith(FIX_LIST_HIERARCHY)).toBe(true);
    expect(out.fixList).toContain("faltou tratar o null");
    const a = out.fixList!.indexOf("src/a.ts:12 — rename this");
    const b = out.fixList!.indexOf("src/b.ts:30 — off by one");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(out.reviewers).toEqual(["bob"]);
    expect(out.baseSha).toBe("mergebase123"); // merge-base with origin/<baseBranch>, whole-PR diff scope
  });

  it("PR merged/closed between poll and night: aborts and closes the link (never reworks a dead PR)", async () => {
    const { github } = makeGithubMock({ prState: "MERGED" });
    const runGit = makeRunGit();
    const deps = makeDeps({ runGit, makeGithub: (() => github) as unknown as CardToPrDeps["makeGithub"] });
    await seedLink(deps, "agentsha1");

    const out = (await makeReworkPreparacao(deps)({ inputs, outputs: {}, executionId: "exec-rw5", stateId: "rework_preparacao" })) as unknown as ReworkPreparacaoOutput;

    expect(out.aborted).toBe(true);
    expect(out.abortReason).toBe("pr-nao-aberto");
    expect((await deps.prLinks.findByTask("trello-main", "card1"))[0].status).toBe("merged");
    expect(runGit.mock.calls.some(([args]) => args[0] === "worktree")).toBe(false); // no worktree for a dead PR
  });
});

describe("findHumanAuthors", () => {
  it("agent-only history yields no humans; name OR email match counts as agent", () => {
    const agentLog = ["OpenRoutines Bot", "someone@else.local", "Someone Else", "openroutines@bot.local"].join("\n");
    expect(findHumanAuthors(agentLog, DEFAULT_AGENT_GIT_AUTHORS)).toEqual([]);
    const humanLog = ["Henrik", "henrik@example.com"].join("\n");
    expect(findHumanAuthors(humanLog, DEFAULT_AGENT_GIT_AUTHORS)).toEqual(["Henrik <henrik@example.com>"]);
    expect(findHumanAuthors("", DEFAULT_AGENT_GIT_AUTHORS)).toEqual([]);
  });
});

describe("makeReworkPergunta (F4 #157, D13)", () => {
  it("posts the agent's question on the PR thread exactly once across a crash-resume (ledger-guarded)", async () => {
    const { github, prComments } = makeGithubMock();
    const deps = makeDeps({ makeGithub: (() => github) as unknown as CardToPrDeps["makeGithub"] });
    const outputs = {
      rework_preparacao: {
        aborted: false,
        prNumber: 42,
        repo: { githubRepo: "acme/widgets", baseBranch: "development", clonePath: "/tmp/c", slug: "acme-widgets", verify: { build: "true", test: "true" } },
      },
      rework: { needsClarification: true, question: "o comentário pede X ou Y?" },
    };

    const handler = makeReworkPergunta(deps);
    const r1 = await handler({ inputs, outputs, executionId: "exec-q1", stateId: "rework_pergunta" });
    const r2 = await handler({ inputs, outputs, executionId: "exec-q1", stateId: "rework_pergunta" });

    expect(prComments).toHaveLength(1); // idempotent across the two runs
    expect(prComments[0]).toContain("o comentário pede X ou Y?");
    expect(r1).toMatchObject({ asked: true });
    expect(r2).toMatchObject({ asked: true });
    // no rework_count side effects in this path
    expect(await deps.prLinks.findByTask("trello-main", "card1")).toHaveLength(0);
  });
});
