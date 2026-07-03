/**
 * card-to-pr E2E (F3 #146): drives the REAL skill.yaml through
 * runStateMachine with the 4 script handlers registered and every external
 * effect mocked/injected — mirrors src/engine/state-machine-f1.test.ts's
 * harness pattern.
 *
 * preparacao -> plano -> implementacao -> verify(passed) -> pr_gate(pauses)
 * -> [approve] -> pr(mock push+PR) -> done.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import type { Pool } from "pg";
import { Effect } from "effect";
import { runStateMachine, type StateMachineContext } from "../../engine/state-machine.js";
import { makeScriptRegistry } from "../../script/registry.js";
import { parseSkillStateMachine } from "../../skill/parser.js";
import { makeGateEngine } from "../../gate/gate.js";
import { makeInMemoryGateRepository } from "../../gate/in-memory.js";
import { makeInMemoryActionLedgerRepository } from "../../persistence/action-ledger-in-memory.js";
import { makeInMemoryPrLinkRepository } from "../../persistence/pr-links-in-memory.js";
import { registerCardToPrHandlers } from "./index.js";
import type { CardToPrDeps } from "./index.js";
import type { CompletionResponse } from "../../provider/types.js";
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

/** In-memory execution repo that also captures the last persisted SM context (mirrors state-machine-f1.test.ts). */
const makeRepo = () => {
  const store = new Map<string, ExecutionRecord>();
  store.set("exec1", {
    id: "exec1",
    routineId: "r",
    triggerType: "task_source",
    skillName: "card-to-pr",
    status: "pending",
    startedAt: new Date(),
  });
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

/** Sequenced provider: one CompletionResponse per call, holds the last past the end of the queue. */
const seqProvider = (responses: CompletionResponse[]) => {
  let calls = 0;
  return {
    complete: () => {
      const r = responses[Math.min(calls, responses.length - 1)];
      calls++;
      return Effect.succeed(r);
    },
  };
};

describe("card-to-pr E2E (#146)", () => {
  it("preparacao -> plano -> implementacao -> verify -> pr_gate (pauses) -> approve -> pr -> done", async () => {
    const skill = parseSkillStateMachine(readFileSync(".gates/skills/card-to-pr/skill.yaml", "utf-8"));

    const registry: RepoRegistry = {
      repos: {
        "acme-widgets": {
          clonePath: "/tmp/or-e2e-clone",
          githubRepo: "acme/widgets",
          baseBranch: "development",
          verify: { build: "true", test: "true" },
        },
      },
    };

    const runGit = async (args: string[]): Promise<{ stdout: string; stderr: string }> =>
      args[0] === "rev-parse" ? { stdout: "deadbeefcafebabe1234\n", stderr: "" } : { stdout: "", stderr: "" };
    const runVerify = async () => ({
      build: { passed: true },
      typecheck: undefined,
      lint: undefined,
      test: { passed: true },
    });
    const getBaseline = async () => ({
      baseSha: "deadbeefcafebabe1234",
      results: { build: { passed: true }, typecheck: undefined, lint: undefined, test: { passed: true } },
    });

    const createdPr = { url: "https://github.com/acme/widgets/pull/7", number: 7, branch: "openroutines/card-card1" };
    const makeGithub = (() => ({
      listPullRequests: () => Effect.succeed([]),
      createPullRequest: () => Effect.succeed({ pr: createdPr }),
    })) as unknown as CardToPrDeps["makeGithub"];

    const moveToCalls: Array<[string, string]> = [];
    const taskSource = {
      moveTo: (id: string, state: string) => {
        moveToCalls.push([id, state]);
        return Effect.succeed(undefined);
      },
      comment: () => Effect.succeed(undefined),
    } as unknown as TaskSource;

    const prLinks = makeInMemoryPrLinkRepository();

    const deps: CardToPrDeps = {
      pool: {} as unknown as Pool, // never touched: getBaseline is stubbed below
      registry,
      githubToken: "gh_test",
      worktreeBase: "/tmp/or-e2e-worktrees",
      ledger: makeInMemoryActionLedgerRepository(),
      prLinks,
      taskSourceFor: (sourceId) => (sourceId === "trello-main" ? taskSource : undefined),
      makeGithub,
      checkProtection: async () => ({ protected: true }),
      runGit,
      runVerify,
      getBaseline,
    };

    const scriptRegistry = makeScriptRegistry();
    registerCardToPrHandlers(scriptRegistry, deps);

    const gateEngine = makeGateEngine({ repository: makeInMemoryGateRepository() });
    const repo = makeRepo();

    const planoJson = JSON.stringify({
      summary: "Add the missing validation",
      files: ["src/foo.ts"],
      testStrategy: "unit tests around the new validation",
      // estimatedLoc deliberately omitted (optional): the engine's minimal
      // JSON-schema validator (src/engine/schema-validate.ts) reports any
      // whole-number value as JSON type "integer" and requires an exact
      // string match against the schema's declared "number" — a real,
      // pre-existing engine quirk that would reject an LLM's typical
      // whole-number LOC estimate in production too (see deviationsFromSpec).
      dataChanges: [],
      risks: [],
    });
    const implementacaoJson = JSON.stringify({
      filesTouched: ["src/foo.ts"],
      commits: ["abc123 fix: add validation"],
      notes: "done",
      openDecisions: [],
    });
    const provider = seqProvider([resp(planoJson), resp(implementacaoJson)]);

    const event: TriggerEvent = {
      type: "task_source",
      payload: {
        source_id: "trello-main",
        task_id: "card1",
        repo: "acme-widgets",
        title: "Fix the bug",
        description: "Card description",
        night_id: "night-1",
      },
    } as TriggerEvent;

    const config = { provider, repository: repo.repo, scriptRegistry, gateEngine };

    const r1 = await Effect.runPromise(runStateMachine(config)(skill, routine, event, "exec1"));
    expect(r1.success).toBe(false);
    expect(r1.paused).toBe(true);
    expect(r1.gateId).toBeTruthy();
    expect(repo.get("exec1")!.status).toBe("paused");

    await gateEngine.approve(r1.gateId!, "approved in test");

    const context = repo.lastContext();
    expect(context?.currentState).toBe("pr_gate");

    const r2 = await Effect.runPromise(runStateMachine(config)(skill, routine, event, "exec1", context));

    expect(r2.success).toBe(true);
    expect(moveToCalls).toContainEqual(["card1", "review"]);

    const links = await prLinks.findByTask("trello-main", "card1");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ sourceId: "trello-main", taskId: "card1", status: "open" });
  });
});
