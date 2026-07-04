/**
 * card-to-pr E2E (F3 #146, F4 #153): drives the REAL skill.yaml through
 * runStateMachine with the 4 script handlers registered and every external
 * effect mocked/injected — mirrors src/engine/state-machine-f1.test.ts's
 * harness pattern.
 *
 * preparacao -> plano -> implementacao -> verify(passed) -> revisao (fanout,
 * approved; dataChanges stays false in this fixture so the data lens never
 * fires) -> pr(mock push+PR) -> done. `pr_gate` is gone (F4 #153): the
 * adversarial review + security lens ARE the pre-PR gate now, so this happy
 * path no longer pauses for manual approval.
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
import { resolveCardToPrDynamicProvider } from "../../app.js";
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

describe("card-to-pr E2E (#146, #153)", () => {
  it("preparacao -> plano -> implementacao -> verify -> revisao (approved) -> pr -> done", async () => {
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
      getOpenPrByBranch: () => Effect.succeed(undefined),
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
      // needsArchGate:false (F4 #185) — this happy-path fixture goes straight
      // to implementacao, never through gate_plano; see gate-plano.e2e.test.ts
      // for the architecture-gate flow.
      needsArchGate: false,
      risks: [],
    });
    const implementacaoJson = JSON.stringify({
      filesTouched: ["src/foo.ts"],
      commits: ["abc123 fix: add validation"],
      notes: "done",
      openDecisions: [],
    });
    // plano/implementacao both declare provider:claude-cli and are served in
    // order from one queue. The revisao fanout (F4 #153) resolves its lenses
    // to their OWN named providers: correctness (kimi-cli) and security
    // (security-judge) always answer approved; data (claude-cli) is never
    // called because runGit's diff is empty here (dataChanges stays false).
    const claudeCliResponses = [resp(planoJson), resp(implementacaoJson)];
    let claudeCliCalls = 0;
    const providerRegistry: ProviderRegistry = {
      resolve: (name) => {
        // Compare against a plain string key (not the ProviderName literal
        // union) since "security-judge" is a provider registered by a
        // separate issue and isn't (yet) one of ProviderName's members.
        const key = String(name);
        if (key === "claude-cli") {
          return {
            complete: () => {
              const r = claudeCliResponses[Math.min(claudeCliCalls, claudeCliResponses.length - 1)];
              claudeCliCalls++;
              return Effect.succeed(r);
            },
          };
        }
        if (key === "kimi-cli") {
          return { complete: () => Effect.succeed(resp(JSON.stringify({ approved: true, gaps: [] }))) };
        }
        if (key === "security-judge") {
          return { complete: () => Effect.succeed(resp(JSON.stringify({ approved: true, findings: [], criticalArea: false }))) };
        }
        throw new Error(`e2e fixture: unexpected provider '${key}'`);
      },
    };

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

    const config = {
      provider: { complete: () => Effect.succeed(resp("{}")) }, // never invoked: every agent state resolves via providerRegistry
      providerRegistry,
      repository: repo.repo,
      scriptRegistry,
      fanoutAggregators: cardToPrFanoutAggregators,
    };

    const r = await Effect.runPromise(runStateMachine(config)(skill, routine, event, "exec1"));

    expect(r.success).toBe(true);
    expect(r.logs.join(" ")).toContain("Reached terminal state: done");
    expect(moveToCalls).toContainEqual(["card1", "review"]);
    expect(claudeCliCalls).toBe(2); // plano + implementacao only — the data lens never fires

    const links = await prLinks.findByTask("trello-main", "card1");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ sourceId: "trello-main", taskId: "card1", status: "open" });
  });

  // Normal-flow analog of rework.e2e.test.ts's H8 (this file's review found the
  // escalation path covered only for rework, never for a fresh card): verify
  // failing retryable twice must retry `implementacao` on the card's original
  // tier once, then grant the F4 #159 tier escalation for the 2nd retry — and
  // never divert through the rework flow's `rework`/`rework_preparacao`
  // states, since `output.rework_preparacao` is never set here (skill.yaml's
  // verify->rework edge only matches inside the rework flow).
  it("H8-normal: verify failing twice from preparacao escalates implementacao's tier once (kimi -> sonnet), never the rework route, then verify's attempt cap routes to bloqueado", async () => {
    const skill = parseSkillStateMachine(readFileSync(".gates/skills/card-to-pr/skill.yaml", "utf-8"));

    const registry: RepoRegistry = {
      repos: {
        "acme-widgets": {
          clonePath: "/tmp/or-e2e-esc-clone",
          githubRepo: "acme/widgets",
          baseBranch: "development",
          verify: { build: "true", test: "true" },
        },
      },
    };

    const runGit = async (args: string[]): Promise<{ stdout: string; stderr: string }> =>
      args[0] === "rev-parse" ? { stdout: "deadbeefcafebabe1234\n", stderr: "" } : { stdout: "", stderr: "" };
    // Different failing step each attempt -> different failureSignatures, so
    // the engine's stall detector (same signature twice) never preempts the
    // escalation path being exercised here (mirrors rework.e2e.test.ts's H8).
    const verifyQueue: Array<Record<string, { passed: boolean } | undefined>> = [
      { build: { passed: true }, test: { passed: false } },
      { build: { passed: false }, test: { passed: true } },
      { build: { passed: false }, test: { passed: false } },
    ];
    const runVerify = vi.fn(async () => verifyQueue.shift()!);
    const getBaseline = async () => ({
      baseSha: "deadbeefcafebabe1234",
      results: { build: { passed: true }, typecheck: undefined, lint: undefined, test: { passed: true } },
    });

    const createPullRequest = vi.fn();
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
    } as unknown as TaskSource;

    const deps: CardToPrDeps = {
      pool: {} as unknown as Pool, // never touched: getBaseline is stubbed below
      registry,
      githubToken: "gh_test",
      worktreeBase: `/tmp/or-e2e-esc-wt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ledger: makeInMemoryActionLedgerRepository(),
      prLinks: makeInMemoryPrLinkRepository(),
      taskSourceFor: (sourceId) => (sourceId === "trello-main" ? taskSource : undefined),
      makeGithub,
      checkProtection: async () => ({ protected: true }),
      runGit,
      runVerify,
      getBaseline,
    };

    const scriptRegistry = makeScriptRegistry();
    registerCardToPrHandlers(scriptRegistry, deps);

    const repo = makeRepo();

    const planoJson = JSON.stringify({
      summary: "Add the missing validation",
      files: ["src/foo.ts"],
      testStrategy: "unit tests around the new validation",
      dataChanges: [],
      needsArchGate: false, // straight to implementacao, same as the happy-path fixture above
      risks: [],
    });
    const implementacaoJson = JSON.stringify({
      filesTouched: ["src/foo.ts"],
      commits: ["abc123 fix: add validation"],
      notes: "done",
      openDecisions: [],
    });

    /** Every prompt any provider received, tagged with its provider:model key. */
    const prompts: Array<{ key: string; prompt: string }> = [];
    const mkProvider = (key: string, reply: (prompt: string) => string) =>
      ({
        complete: (req: { messages: Array<{ content: string }> }) => {
          const prompt = req.messages[req.messages.length - 1].content;
          prompts.push({ key, prompt });
          return Effect.succeed(resp(reply(prompt)));
        },
      }) as unknown as ReturnType<ProviderRegistry["resolve"]>;

    const providerRegistry: ProviderRegistry = {
      resolve: (name, model) => {
        const key = `${String(name)}:${model ?? ""}`;
        if (String(name) === "claude-cli") {
          // Serves BOTH plano (static tier) and the ESCALATED 3rd implementacao
          // attempt (D9's "lowest" complexity escalates kimi -> sonnet, the
          // same claude-cli/claude-sonnet-5 route plano already uses).
          return mkProvider(key, (prompt) => (prompt.includes("Implemente o plano") ? implementacaoJson : planoJson));
        }
        if (String(name) === "kimi-cli") {
          // implementacao's card-original tier for complexity "lowest" (D9) —
          // only ever hit by implementacao here (revisao is never reached).
          return mkProvider(key, () => implementacaoJson);
        }
        throw new Error(`e2e escalation fixture: unexpected provider '${key}'`);
      },
    };

    const event: TriggerEvent = {
      type: "task_source",
      payload: {
        source_id: "trello-main",
        task_id: "card1",
        repo: "acme-widgets",
        title: "Fix the bug",
        description: "Card description",
        night_id: "night-3",
        complexity: "lowest", // D9: original tier = kimi — escalation must land on sonnet
      },
    } as TriggerEvent;

    const routeSpy = vi.fn(resolveCardToPrDynamicProvider);
    const config = {
      provider: { complete: () => Effect.succeed(resp("{}")) },
      providerRegistry,
      repository: repo.repo,
      scriptRegistry,
      fanoutAggregators: cardToPrFanoutAggregators,
      resolveDynamicProvider: routeSpy,
    };

    const r = await Effect.runPromise(runStateMachine(config)(skill, routine, event, "exec1"));

    expect(r.success).toBe(true); // bloqueado -> done is a clean terminal path
    expect(runVerify).toHaveBeenCalledTimes(3);
    // The runner asked the hook for the ESCALATED route on implementacao —
    // never on `rework` (this execution never enters the rework flow at all).
    expect(routeSpy).toHaveBeenCalledWith(expect.objectContaining({ stateId: "implementacao", escalated: true }));
    expect(routeSpy).not.toHaveBeenCalledWith(expect.objectContaining({ stateId: "rework" }));

    // implementacao ran twice on the card's original kimi tier, then ONCE on
    // the escalated sonnet tier — and never through rework's own template.
    const implPrompts = prompts.filter((p) => p.prompt.includes("Implemente o plano"));
    expect(implPrompts.map((p) => p.key)).toEqual(["kimi-cli:kimi-k2.6", "kimi-cli:kimi-k2.6", "claude-cli:claude-sonnet-5"]);
    // 1st pass: the retry-context placeholder is literal (no prior verify to
    // interpolate yet — accepted wart, same one rework.e2e.test.ts's H5 documents).
    expect(implPrompts[0].prompt).toContain("{{outputs.verify}}");
    // 2nd (unescalated retry) and 3rd (escalated retry): NO dangling
    // placeholder — the agent is never blind, and never sees rework's markers.
    expect(implPrompts[1].prompt).not.toContain("{{outputs.");
    expect(implPrompts[2].prompt).not.toContain("{{outputs.");
    expect(prompts.some((p) => p.prompt.includes("Retrabalho"))).toBe(false);

    // Pin (deliberate, mirrors rework.e2e.test.ts's H8): skill.yaml's
    // verify->implementacao edge carries max_retries:1 + on_exhausted:bloqueado.
    // Exhaustion spends that edge's ONE grant as a tier escalation instead of
    // firing on_exhausted immediately — so a would-be SECOND exhaustion of the
    // SAME edge falls straight to bloqueado (escalatedEdges guards against
    // ever granting twice), never an infinite retry loop on the escalated
    // tier. Here verify.ts's own attempt<=2 cap wins the race first (3rd
    // failure -> retryable:false -> the earlier `retryable != true` edge), but
    // on_exhausted is the same bounded safety net either way: no PR ever
    // created, card moved to blocked.
    expect(createPullRequest).not.toHaveBeenCalled();
    expect(moveToCalls).toContainEqual(["card1", "blocked"]);
  }, 30000);
});
