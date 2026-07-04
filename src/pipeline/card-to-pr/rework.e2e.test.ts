/**
 * card-to-pr rework-loop E2E (F4 #157, D24): drives the REAL skill.yaml from
 * `rework_preparacao` (the exact context app.ts's queueHandler builds for a
 * rework:true payload) through runStateMachine with the real script handlers,
 * the real revisao fanout and the #185 dynamic-provider hook wired.
 *
 * Covers the yaml wiring the unit tests can't: aborted -> done (no agent
 * call), needsClarification -> rework_pergunta -> done (question posted, no
 * round counted), and the full happy path rework -> verify -> revisao -> pr
 * (same-branch push + re-request, NEVER createPullRequest) — with `rework`
 * routed to the card's ORIGINAL tier via resolveCardToPrDynamicProvider.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { Effect } from "effect";
import { runStateMachine, type StateMachineContext } from "../../engine/state-machine.js";
import { makeScriptRegistry } from "../../script/registry.js";
import { parseSkillStateMachine } from "../../skill/parser.js";
import { registerCardToPrHandlers, cardToPrFanoutAggregators, type CardToPrDeps } from "./index.js";
import { makeInMemoryActionLedgerRepository } from "../../persistence/action-ledger-in-memory.js";
import { makeInMemoryPrLinkRepository } from "../../persistence/pr-links-in-memory.js";
import { resolveCardToPrDynamicProvider } from "../../app.js";
import type { CompletionResponse } from "../../provider/types.js";
import type { ProviderRegistry } from "../../provider/registry.js";
import type { Routine } from "../../routine/types.js";
import type { TriggerEvent } from "../../routine/matcher.js";
import type { ExecutionRecord } from "../../persistence/types.js";
import type { RepoRegistry } from "../../repo-registry/schema.js";
import type { TaskSource } from "../../task-source/types.js";

const routine: Routine = { id: "night-run", triggers: [{ type: "schedule", cron: "0 1 * * *" }], pipeline: { skill: "card-to-pr" } };

const resp = (content: string): CompletionResponse => ({
  content,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  model: "mock",
  finishReason: "stop",
});

const makeRepo = () => {
  const store = new Map<string, ExecutionRecord>();
  store.set("exec1", {
    id: "exec1",
    routineId: "night-run",
    triggerType: "card-execution",
    skillName: "card-to-pr",
    status: "pending",
    startedAt: new Date(),
  });
  return {
    save: async (rec: ExecutionRecord) => void store.set(rec.id, rec),
    findById: async (id: string) => store.get(id),
    findByRoutine: async () => [],
    findAll: async () => [],
  };
};

const registry: RepoRegistry = {
  repos: {
    "acme-widgets": {
      clonePath: "/tmp/or-rework-e2e-clone",
      githubRepo: "acme/widgets",
      baseBranch: "development",
      verify: { build: "true", test: "true" },
    },
  },
};

// The exact context app.ts builds for a rework:true card-execution payload.
const startContext = (): StateMachineContext => ({ currentState: "rework_preparacao", outputs: {} });

const event: TriggerEvent = {
  type: "card-execution",
  payload: {
    source_id: "trello-main",
    task_id: "card1",
    repo: "acme-widgets",
    title: "Fix the bug",
    description: "Card description",
    night_id: "night-2",
    complexity: "lowest", // D9: original tier = kimi — rework must route there
    rework: true,
    prNumber: 42,
    branch: "openroutines/card-card1",
  },
} as TriggerEvent;

interface HarnessOpts {
  humanCommit?: boolean;
  reworkAgentOutput?: string;
}

const makeHarness = async (opts: HarnessOpts = {}) => {
  const prLinks = makeInMemoryPrLinkRepository();
  await prLinks.create({
    sourceId: "trello-main",
    taskId: "card1",
    repo: "acme-widgets",
    prNumber: 42,
    branch: "openroutines/card-card1",
    status: "open",
    reviewState: "changes_requested",
    lastAgentCommitSha: "agentsha",
    reworkCount: 0,
  });

  const gitLog = opts.humanCommit ? ["Henrik", "henrik@example.com"].join("\n") : "";
  const runGit = vi.fn(async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    if (args[0] === "log") return { stdout: gitLog, stderr: "" };
    if (args[0] === "merge-base") return { stdout: "mergebase123\n", stderr: "" };
    if (args[0] === "rev-parse") return { stdout: "newhead789\n", stderr: "" };
    if (args[0] === "diff") return { stdout: "src/foo.ts\n", stderr: "" };
    return { stdout: "", stderr: "" };
  });

  const prComments: string[] = [];
  const createPullRequest = vi.fn();
  const getOpenPrByBranch = vi.fn();
  const requestReview = vi.fn(() => Effect.succeed(undefined));
  const github = {
    listPullRequestReviews: vi.fn(() =>
      Effect.succeed({
        prState: "OPEN",
        reviewState: "CHANGES_REQUESTED" as const,
        changesRequestedBy: ["bob"],
        latestReviews: [{ author: "bob", state: "CHANGES_REQUESTED", body: "faltou tratar o null" }],
        pendingReviewRequests: [],
      })
    ),
    listReviewComments: vi.fn(() => Effect.succeed([{ file: "src/foo.ts", line: 12, body: "trate o null aqui", author: "bob" }])),
    commentOnPullRequest: vi.fn((_n: number, body: string) => {
      prComments.push(body);
      return Effect.succeed(undefined);
    }),
    requestReview,
    createPullRequest,
    getOpenPrByBranch,
  };

  const moveToCalls: Array<[string, string]> = [];
  const taskSource = {
    moveTo: (id: string, state: string) => {
      moveToCalls.push([id, state]);
      return Effect.succeed(undefined);
    },
    comment: () => Effect.succeed(undefined),
  } as unknown as TaskSource;

  const deps: CardToPrDeps = {
    registry,
    githubToken: "gh_test",
    worktreeBase: `/tmp/or-rework-e2e-wt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ledger: makeInMemoryActionLedgerRepository(),
    prLinks,
    taskSourceFor: () => taskSource,
    makeGithub: (() => github) as unknown as CardToPrDeps["makeGithub"],
    runGit,
    runVerify: async () => ({ build: { passed: true }, typecheck: undefined, lint: undefined, test: { passed: true } }),
  };

  const scriptRegistry = makeScriptRegistry();
  registerCardToPrHandlers(scriptRegistry, deps);

  const reworkOutput =
    opts.reworkAgentOutput ??
    JSON.stringify({ needsClarification: false, question: "", filesTouched: ["src/foo.ts"], commits: ["abc fix"], notes: "" });

  const providerCalls: string[] = [];
  const providerRegistry: ProviderRegistry = {
    resolve: (name, model) => {
      const key = `${String(name)}:${model ?? ""}`;
      providerCalls.push(key);
      if (String(name) === "kimi-cli") {
        // Serves BOTH the routed rework agent (kimi-k2.6) and the correctness lens.
        return {
          complete: (req: { messages: Array<{ content: string }> }) => {
            const prompt = req.messages[req.messages.length - 1].content;
            return prompt.includes("Retrabalho")
              ? Effect.succeed(resp(reworkOutput))
              : Effect.succeed(resp(JSON.stringify({ approved: true, gaps: [] })));
          },
        } as unknown as ReturnType<ProviderRegistry["resolve"]>;
      }
      if (String(name) === "security-judge") {
        return { complete: () => Effect.succeed(resp(JSON.stringify({ approved: true, findings: [], criticalArea: false }))) };
      }
      if (String(name) === "claude-cli") {
        return { complete: () => Effect.succeed(resp(reworkOutput)) };
      }
      throw new Error(`rework e2e fixture: unexpected provider '${String(name)}'`);
    },
  };

  const config = {
    provider: { complete: () => Effect.succeed(resp("{}")) },
    providerRegistry,
    scriptRegistry,
    repository: makeRepo(),
    fanoutAggregators: cardToPrFanoutAggregators as never,
    resolveDynamicProvider: resolveCardToPrDynamicProvider,
  };

  return { deps, prLinks, runGit, github, prComments, moveToCalls, providerCalls, config };
};

describe("card-to-pr rework E2E (#157, D24)", () => {
  it("full round: rework_preparacao -> rework (routed to the card's ORIGINAL kimi tier) -> verify -> revisao -> pr (same branch + re-request, never createPullRequest) -> done", async () => {
    const h = await makeHarness();

    const r = await Effect.runPromise(
      runStateMachine(h.config)(
        parseSkillStateMachine(readFileSync(".gates/skills/card-to-pr/skill.yaml", "utf-8")),
        routine,
        event,
        "exec1",
        startContext()
      )
    );

    expect(r.success).toBe(true);
    expect(r.logs.join(" ")).toContain("Reached terminal state: done");
    // D9/D24: complexity lowest -> the rework agent ran on kimi-k2.6, via the SAME hook as implementacao
    expect(h.providerCalls).toContain("kimi-cli:kimi-k2.6");
    // orchestrator pushed the SAME branch, no --force, and re-requested bob
    const push = h.runGit.mock.calls.find(([args]) => args[0] === "push");
    expect(push![0]).toEqual(["push", "origin", "HEAD:refs/heads/openroutines/card-card1"]);
    expect(h.github.requestReview).toHaveBeenCalledWith(42, ["bob"]);
    expect(h.github.createPullRequest).not.toHaveBeenCalled();
    // round accounting on pr_links
    const link = (await h.prLinks.findByTask("trello-main", "card1"))[0];
    expect(link.reworkCount).toBe(1);
    expect(link.lastAgentCommitSha).toBe("newhead789");
    expect(link.reviewState).toBe("re-requested");
    expect(link.lastReworkNightId).toBe("night-2");
    // card handed back to Review
    expect(h.moveToCalls).toContainEqual(["card1", "review"]);
  });

  it("human commit on the branch: rework_preparacao aborts straight to done — no agent call, no push, no round counted, direction asked on the PR", async () => {
    const h = await makeHarness({ humanCommit: true });

    const r = await Effect.runPromise(
      runStateMachine(h.config)(
        parseSkillStateMachine(readFileSync(".gates/skills/card-to-pr/skill.yaml", "utf-8")),
        routine,
        event,
        "exec1",
        startContext()
      )
    );

    expect(r.success).toBe(true);
    expect(r.logs.join(" ")).toContain("Reached terminal state: done");
    expect(h.providerCalls).toHaveLength(0); // no LLM ever invoked
    expect(h.runGit.mock.calls.some(([args]) => args[0] === "push")).toBe(false);
    expect(h.prComments.some((c) => c.includes("Retrabalho abortado"))).toBe(true);
    const link = (await h.prLinks.findByTask("trello-main", "card1"))[0];
    expect(link.reworkCount).toBe(0);
    expect(link.reviewState).toBe("changes_requested"); // untouched — the card stays where it is
    expect(h.moveToCalls).toHaveLength(0);
  });

  it("ambiguous feedback: rework -> rework_pergunta posts the question on the PR thread -> done, without counting a round", async () => {
    const h = await makeHarness({
      reworkAgentOutput: JSON.stringify({ needsClarification: true, question: "o comentário pede X ou Y?" }),
    });

    const r = await Effect.runPromise(
      runStateMachine(h.config)(
        parseSkillStateMachine(readFileSync(".gates/skills/card-to-pr/skill.yaml", "utf-8")),
        routine,
        event,
        "exec1",
        startContext()
      )
    );

    expect(r.success).toBe(true);
    expect(r.logs.join(" ")).toContain("Reached terminal state: done");
    expect(h.prComments.some((c) => c.includes("o comentário pede X ou Y?"))).toBe(true);
    expect(h.runGit.mock.calls.some(([args]) => args[0] === "push")).toBe(false);
    expect(h.github.requestReview).not.toHaveBeenCalled();
    expect(h.github.createPullRequest).not.toHaveBeenCalled();
    const link = (await h.prLinks.findByTask("trello-main", "card1"))[0];
    expect(link.reworkCount).toBe(0); // a question is not a spent round
    expect(link.reviewState).toBe("changes_requested"); // next night re-admits after direction arrives
  });
});
