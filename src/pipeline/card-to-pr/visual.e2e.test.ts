/**
 * card-to-pr visual E2E (F5 #160): drives the REAL skill.yaml through
 * runStateMachine with a UI diff, so revisao routes to the new `visual` state.
 * Mirrors e2e.test.ts's harness; adds the visual seams (compose/SSIM/Kimi/
 * attach) as injected mocks.
 *
 * Flow: preparacao -> plano -> implementacao -> verify(isUI) -> revisao(approved)
 * -> visual(FAIL) -> implementacao -> verify -> revisao -> visual(PASS) -> pr.
 * The first visual failure returns to implementacao (never pr); the second pass
 * attaches the screenshots to the card and fills the PR's "Visual" section.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import type { Pool } from "pg";
import { Effect } from "effect";
import { runStateMachine, type StateMachineContext } from "../../engine/state-machine.js";
import { makeScriptRegistry } from "../../script/registry.js";
import { parseSkillStateMachine } from "../../skill/parser.js";
import { makeInMemoryActionLedgerRepository } from "../../persistence/action-ledger-in-memory.js";
import { makeInMemoryPrLinkRepository } from "../../persistence/pr-links-in-memory.js";
import { registerCardToPrHandlers, cardToPrFanoutAggregators } from "./index.js";
import type { CardToPrDeps } from "./index.js";
import type { CompletionResponse } from "../../provider/types.js";
import type { ProviderRegistry } from "../../provider/registry.js";
import type { Routine } from "../../routine/types.js";
import type { TriggerEvent } from "../../routine/matcher.js";
import type { ExecutionRecord } from "../../persistence/types.js";
import type { RepoRegistry } from "../../repo-registry/schema.js";
import type { TaskSource } from "../../task-source/types.js";

const routine: Routine = { id: "r", triggers: [{ type: "task_source" }], pipeline: { skill: "card-to-pr" } } as Routine;

const resp = (content: string): CompletionResponse => ({
  content,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  model: "mock",
  finishReason: "stop",
});

const makeRepo = () => {
  const store = new Map<string, ExecutionRecord>();
  store.set("exec1", { id: "exec1", routineId: "r", triggerType: "task_source", skillName: "card-to-pr", status: "pending", startedAt: new Date() });
  let lastContext: StateMachineContext | undefined;
  return {
    repo: {
      save: async (rec: ExecutionRecord) => {
        const smc = (rec.metadata as { stateMachineContext?: StateMachineContext } | undefined)?.stateMachineContext;
        if (smc) lastContext = smc;
        store.set(rec.id, rec);
      },
      findById: async (id: string) => store.get(id),
      findByRoutine: async () => [],
      findAll: async () => [],
    },
    get: (id: string) => store.get(id),
    lastContext: () => lastContext,
  };
};

describe("card-to-pr visual E2E (#160)", () => {
  it("visual reproves once (-> implementacao), then passes (-> pr) with screenshots attached and the PR 'Visual' section filled", async () => {
    const skill = parseSkillStateMachine(readFileSync(".gates/skills/card-to-pr/skill.yaml", "utf-8"));

    const registry: RepoRegistry = {
      repos: {
        "acme-widgets": {
          clonePath: "/tmp/or-visual-e2e-clone",
          githubRepo: "acme/widgets",
          baseBranch: "development",
          verify: { build: "true", test: "true" },
        },
      },
    };

    // A UI diff (.tsx) so verify.isUI is true -> revisao routes to `visual`.
    const runGit = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
      if (args[0] === "rev-parse") return { stdout: "deadbeefcafebabe1234\n", stderr: "" };
      if (args[0] === "diff" && args[1] === "--name-only") return { stdout: "src/Button.tsx\n", stderr: "" };
      if (args[0] === "diff" && args[1] === "--numstat") return { stdout: "5\t0\tsrc/Button.tsx\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const runVerify = async () => ({ build: { passed: true }, typecheck: undefined, lint: undefined, test: { passed: true } });
    const getBaseline = async () => ({
      baseSha: "deadbeefcafebabe1234",
      results: { build: { passed: true }, typecheck: undefined, lint: undefined, test: { passed: true } },
    });

    let prBody = "";
    const createdPr = { url: "https://github.com/acme/widgets/pull/9", number: 9, branch: "openroutines/card-card1" };
    const createPullRequest = vi.fn((_branch: string, _title: string, body: string) => {
      prBody = body;
      return Effect.succeed({ pr: createdPr });
    });
    const makeGithub = (() => ({
      getOpenPrByBranch: () => Effect.succeed(undefined),
      createPullRequest,
    })) as unknown as CardToPrDeps["makeGithub"];

    const moveToCalls: Array<[string, string]> = [];
    const taskSource = {
      moveTo: (id: string, state: string) => {
        moveToCalls.push([id, state]);
        return Effect.succeed(undefined);
      },
      comment: () => Effect.succeed(undefined),
      attachArtifact: () => Effect.succeed(undefined),
    } as unknown as TaskSource;

    // Visual seams. Kimi fails the assertion on the first phase, passes on the
    // second — confidence 9 so no vision escalation is involved.
    let visualCalls = 0;
    const agentProvider = {
      complete: () => {
        visualCalls++;
        const verdict = visualCalls === 1 ? "fail" : "pass";
        return Effect.succeed(
          resp(JSON.stringify({ assertions: [{ id: "a1", verdict, confidence: 9 }], screenshots: ["/x/a1.png"], consoleErrors: [] }))
        );
      },
    };
    const composeUp = vi.fn(async () => ({ baseUrl: "http://127.0.0.1:4000", project: "or-exec1" }));
    const composeDown = vi.fn(async () => undefined);
    const attachScreenshots = vi.fn(async () => undefined);

    const prLinks = makeInMemoryPrLinkRepository();
    const deps: CardToPrDeps = {
      pool: {} as unknown as Pool,
      registry,
      githubToken: "gh_test",
      worktreeBase: `/tmp/or-visual-e2e-wt-${process.pid}-${Date.now()}`,
      ledger: makeInMemoryActionLedgerRepository(),
      prLinks,
      taskSourceFor: (sourceId) => (sourceId === "trello-main" ? taskSource : undefined),
      makeGithub,
      checkProtection: async () => ({ protected: true }),
      runGit,
      runVerify,
      getBaseline,
      visual: {
        agentProvider,
        composeUp,
        composeDown,
        runSsim: async () => [],
        readGoldenRoutes: () => [],
        attachScreenshots,
      },
    };

    const scriptRegistry = makeScriptRegistry();
    registerCardToPrHandlers(scriptRegistry, deps);

    const repo = makeRepo();

    const planoJson = JSON.stringify({
      summary: "Add the branded button",
      files: ["src/Button.tsx"],
      testStrategy: "unit + visual",
      dataChanges: [],
      needsArchGate: false,
      risks: [],
      visualAssertions: [{ id: "a1", description: "botão aparece com o rótulo correto" }],
    });
    const implementacaoJson = JSON.stringify({ filesTouched: ["src/Button.tsx"], commits: ["abc fix"], notes: "done", openDecisions: [] });

    const providerRegistry: ProviderRegistry = {
      resolve: (name) => {
        const key = String(name);
        if (key === "claude-cli") {
          return {
            complete: (req: { messages?: Array<{ content: string }>; prompt?: string }) => {
              const prompt = req.messages?.[req.messages.length - 1]?.content ?? req.prompt ?? "";
              return Effect.succeed(resp(prompt.includes("Implemente o plano") ? implementacaoJson : planoJson));
            },
          } as unknown as ReturnType<ProviderRegistry["resolve"]>;
        }
        if (key === "kimi-cli") return { complete: () => Effect.succeed(resp(JSON.stringify({ approved: true, gaps: [] }))) } as unknown as ReturnType<ProviderRegistry["resolve"]>;
        if (key === "security-judge")
          return { complete: () => Effect.succeed(resp(JSON.stringify({ approved: true, findings: [], criticalArea: false }))) } as unknown as ReturnType<ProviderRegistry["resolve"]>;
        throw new Error(`visual e2e: unexpected provider '${key}'`);
      },
    };

    const event: TriggerEvent = {
      type: "task_source",
      payload: { source_id: "trello-main", task_id: "card1", repo: "acme-widgets", title: "Add button", description: "Card description", night_id: "night-1" },
    } as TriggerEvent;

    const config = {
      provider: { complete: () => Effect.succeed(resp("{}")) },
      providerRegistry,
      repository: repo.repo,
      scriptRegistry,
      fanoutAggregators: cardToPrFanoutAggregators,
    };

    const r = await Effect.runPromise(runStateMachine(config)(skill, routine, event, "exec1"));

    expect(r.success).toBe(true);
    expect(r.logs.join(" ")).toContain("Reached terminal state: done");
    // Visual ran twice (fail then pass); the sandbox went up and down each time.
    expect(visualCalls).toBe(2);
    expect(composeUp).toHaveBeenCalledTimes(2);
    expect(composeDown).toHaveBeenCalledTimes(2);
    // Screenshots attached to the card on the passing run.
    expect(attachScreenshots).toHaveBeenCalledTimes(1);
    expect(attachScreenshots).toHaveBeenCalledWith("card1", ["/x/a1.png"]);
    // The PR was created (not before the visual passed) and carries the Visual section.
    expect(createPullRequest).toHaveBeenCalledTimes(1);
    expect(prBody).toContain("## Visual");
    expect(prBody).toContain("Visual: 1/1 asserções ✅");
    expect(prBody).toContain("0 console.error");
    expect(moveToCalls).toContainEqual(["card1", "review"]);

    const links = await prLinks.findByTask("trello-main", "card1");
    expect(links).toHaveLength(1);
  }, 60000);
});
