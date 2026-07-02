/**
 * F1 runner tests: declarative max_retries, auto_action by value, script/fanout
 * state types, per-state provider resolution, cost accumulation, and resume.
 * Drives runStateMachine end-to-end with mocked providers/registries/handlers.
 */
import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { runStateMachine, type StateMachineContext } from "./state-machine.js";
import { makeScriptRegistry, runShellSequence } from "../script/registry.js";
import type { SkillStateMachine } from "../skill/schema.js";
import type { CompletionResponse } from "../provider/types.js";
import type { Routine } from "../routine/types.js";
import type { TriggerEvent } from "../routine/matcher.js";
import type { ExecutionRecord } from "../persistence/types.js";

const routine: Routine = { id: "r", triggers: [{ type: "api" }], pipeline: { skill: "t" } } as Routine;
const event: TriggerEvent = { type: "api", payload: {} } as TriggerEvent;

const resp = (over: Partial<CompletionResponse> = {}): CompletionResponse => ({
  content: "ok: true",
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  model: "mock",
  finishReason: "stop",
  ...over,
});

/** In-memory execution repo that also captures the last persisted SM context. */
const makeRepo = () => {
  const store = new Map<string, ExecutionRecord>();
  // Pre-seed the "pending" record the engine normally creates before the runner,
  // so persistStateContext (which merges into an existing record) is not a no-op.
  store.set("exec1", {
    id: "exec1",
    routineId: "r",
    triggerType: "api",
    skillName: "t",
    status: "pending",
    startedAt: new Date(),
  });
  let lastContext: Record<string, unknown> | undefined;
  return {
    repo: {
      save: async (rec: ExecutionRecord) => {
        const smc = (rec.metadata as { stateMachineContext?: Record<string, unknown> } | undefined)?.stateMachineContext;
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

/** Provider whose complete() responses come from a queue (or a constant), counting calls. */
const seqProvider = (responses: CompletionResponse[] | (() => CompletionResponse)) => {
  let calls = 0;
  return {
    provider: {
      complete: () => {
        const r = typeof responses === "function" ? responses() : responses[Math.min(calls, responses.length - 1)];
        calls++;
        return Effect.succeed(r);
      },
    },
    calls: () => calls,
  };
};

const run = (skill: SkillStateMachine, config: Parameters<typeof runStateMachine>[0], context?: StateMachineContext) =>
  Effect.runPromise(runStateMachine(config)(skill, routine, event, "exec1", context));

describe("F1 runner — declarative max_retries", () => {
  it("fails after a transition with max_retries:1 is taken twice", async () => {
    const skill: SkillStateMachine = {
      id: "t",
      initial_state: "start",
      states: {
        start: { agent_prompt: "p", transitions: [{ to: "loop" }] },
        loop: { agent_prompt: "p", transitions: [{ to: "loop", max_retries: 1 }] },
      },
    } as SkillStateMachine;
    const { provider } = seqProvider(() => resp());
    const r = await run(skill, { provider, repository: makeRepo().repo });
    expect(r.success).toBe(false);
    expect(r.output).toContain("Max retries (1)");
    expect(r.output).toContain("loop->loop");
  });

  it("a transition without max_retries is not capped by the retry mechanism", async () => {
    // A self-loop with no max_retries runs until the global iteration cap, proving
    // no per-edge cap fired (message is the global cap, not "Max retries").
    const skill: SkillStateMachine = {
      id: "t",
      initial_state: "loop",
      states: { loop: { agent_prompt: "p", transitions: [{ to: "loop" }] } },
    } as SkillStateMachine;
    const { provider } = seqProvider(() => resp());
    const r = await run(skill, { provider, repository: makeRepo().repo });
    expect(r.success).toBe(false);
    expect(r.output).toContain("Max iterations exceeded");
    expect(r.output).not.toContain("Max retries");
  });

  it("resume preserves the transition count instead of resetting it", async () => {
    const skill: SkillStateMachine = {
      id: "t",
      initial_state: "loop",
      states: { loop: { agent_prompt: "p", transitions: [{ to: "loop", max_retries: 1 }] } },
    } as SkillStateMachine;
    const { provider } = seqProvider(() => resp());
    // Resume with the edge already taken once: one more traversal must trip the cap.
    const context: StateMachineContext = {
      currentState: "loop",
      outputs: {},
      inputs: {},
      transitionCounts: { "loop->loop": 1 },
    };
    const r = await run(skill, { provider, repository: makeRepo().repo }, context);
    expect(r.success).toBe(false);
    expect(r.output).toContain("Max retries (1)");
  });
});

describe("F1 runner — type: script", () => {
  const scriptSkill = (script?: string): SkillStateMachine =>
    ({
      id: "t",
      initial_state: "verify",
      states: {
        verify: {
          type: "script",
          ...(script ? { script } : {}),
          transitions: [
            { to: "done_ok", when: "output.verify.passed == true" },
            { to: "done_fail" },
          ],
        },
        done_ok: { terminal: true },
        done_fail: { terminal: true },
      },
    }) as SkillStateMachine;

  it("runs a passing handler without calling the provider", async () => {
    const registry = makeScriptRegistry();
    registry.register("green", () => runShellSequence(["true"]).then((res) => ({ ...res })));
    const { provider, calls } = seqProvider(() => resp());
    const repo = makeRepo();
    const r = await run(scriptSkill("green"), { provider, repository: repo.repo, scriptRegistry: registry });
    expect(r.success).toBe(true);
    expect(calls()).toBe(0); // provider never touched for a script state
    expect((repo.lastContext()!.outputs as any).verify.passed).toBe(true);
    expect(r.logs.join(" ")).toContain("Reached terminal state: done_ok");
  });

  it("marks a failing shell sequence as passed:false", async () => {
    const registry = makeScriptRegistry();
    registry.register("red", () => runShellSequence(["false"]).then((res) => ({ ...res })));
    const { provider } = seqProvider(() => resp());
    const repo = makeRepo();
    const r = await run(scriptSkill("red"), { provider, repository: repo.repo, scriptRegistry: registry });
    expect((repo.lastContext()!.outputs as any).verify.passed).toBe(false);
    expect(r.logs.join(" ")).toContain("Reached terminal state: done_fail");
  });

  it("resolves the handler by stateId when `script:` is omitted", async () => {
    const registry = makeScriptRegistry();
    registry.register("verify", async () => ({ passed: true }));
    const { provider } = seqProvider(() => resp());
    const repo = makeRepo();
    const r = await run(scriptSkill(undefined), { provider, repository: repo.repo, scriptRegistry: registry });
    expect(r.success).toBe(true);
    expect(r.logs.join(" ")).toContain("Reached terminal state: done_ok");
  });

  it("fails clearly when no handler is registered, without calling the provider", async () => {
    const registry = makeScriptRegistry();
    const { provider, calls } = seqProvider(() => resp());
    const r = await run(scriptSkill("missing"), { provider, repository: makeRepo().repo, scriptRegistry: registry });
    expect(r.success).toBe(false);
    expect(r.output).toContain("No script handler registered for 'missing'");
    expect(calls()).toBe(0);
  });
});

describe("F1 runner — type: fanout", () => {
  it("runs lenses in parallel and aggregates {lentes, approved}", async () => {
    const skill: SkillStateMachine = {
      id: "t",
      initial_state: "revisao",
      states: {
        revisao: {
          type: "fanout",
          lenses: [
            { name: "correctness", provider: "pA", agent_prompt: "review A" },
            { name: "security", provider: "pB", agent_prompt: "review B" },
          ],
          transitions: [
            { to: "done_ok", when: "output.revisao.approved == true" },
            { to: "done_fail" },
          ],
        },
        done_ok: { terminal: true },
        done_fail: { terminal: true },
      },
    } as SkillStateMachine;

    const pA = { complete: vi.fn(() => Effect.succeed(resp({ content: "verdict: ok", costUsd: 0.01 }))) };
    const pB = { complete: vi.fn(() => Effect.succeed(resp({ content: "verdict: ok", costUsd: 0.02 }))) };
    const providerRegistry = { resolve: (name: string) => (name === "pA" ? pA : pB) } as any;
    const repo = makeRepo();
    const { provider } = seqProvider(() => resp());

    const r = await run(skill, { provider, providerRegistry, repository: repo.repo });
    expect(r.success).toBe(true);
    expect(pA.complete).toHaveBeenCalledOnce();
    expect(pB.complete).toHaveBeenCalledOnce();
    const out = (repo.lastContext()!.outputs as any).revisao;
    expect(out.lentes).toHaveLength(2);
    expect(out.approved).toBe(true);
    expect(r.logs.join(" ")).toContain("Reached terminal state: done_ok");
    // lens costs summed into the execution total
    expect(repo.get("exec1")!.costUsd).toBeCloseTo(0.03, 6);
  });

  it("marks approved:false when a lens errors, without collapsing the state", async () => {
    const skill: SkillStateMachine = {
      id: "t",
      initial_state: "revisao",
      states: {
        revisao: {
          type: "fanout",
          lenses: [
            { name: "ok", provider: "pOk", agent_prompt: "a" },
            { name: "boom", provider: "pBoom", agent_prompt: "b" },
          ],
          transitions: [
            { to: "done_ok", when: "output.revisao.approved == true" },
            { to: "done_fail" },
          ],
        },
        done_ok: { terminal: true },
        done_fail: { terminal: true },
      },
    } as SkillStateMachine;
    const pOk = { complete: () => Effect.succeed(resp({ content: "verdict: ok" })) };
    const pBoom = { complete: () => Effect.fail(new Error("provider down")) };
    const providerRegistry = { resolve: (name: string) => (name === "pOk" ? pOk : pBoom) } as any;
    const repo = makeRepo();
    const { provider } = seqProvider(() => resp());
    const r = await run(skill, { provider, providerRegistry, repository: repo.repo });
    const out = (repo.lastContext()!.outputs as any).revisao;
    expect(out.lentes).toHaveLength(2);
    expect(out.approved).toBe(false);
    expect(r.logs.join(" ")).toContain("Reached terminal state: done_fail");
  });
});

describe("F1 runner — cost accumulation (#138)", () => {
  const twoStep: SkillStateMachine = {
    id: "t",
    initial_state: "s1",
    states: {
      s1: { agent_prompt: "p", transitions: [{ to: "s2" }] },
      s2: { agent_prompt: "p", transitions: [{ to: "done" }] },
      done: { terminal: true },
    },
  } as SkillStateMachine;

  it("sums per-invocation costUsd into the execution total", async () => {
    const { provider } = seqProvider([resp({ costUsd: 0.02 }), resp({ costUsd: 0.05 })]);
    const repo = makeRepo();
    const r = await run(twoStep, { provider, repository: repo.repo });
    expect(r.success).toBe(true);
    expect(repo.get("exec1")!.costUsd).toBeCloseTo(0.07, 6);
    expect(repo.get("exec1")!.providerBreakdown).toEqual({ default: 0.07 });
  });

  it("treats a missing costUsd as 0 without breaking the sum", async () => {
    const { provider } = seqProvider([resp({ costUsd: 0.03 }), resp({})]);
    const repo = makeRepo();
    const r = await run(twoStep, { provider, repository: repo.repo });
    expect(r.success).toBe(true);
    expect(repo.get("exec1")!.costUsd).toBeCloseTo(0.03, 6);
  });
});

describe("F1 runner — per-state provider resolution (#135)", () => {
  it("resolves an agent state's declared provider via the registry; a bare state uses the default", async () => {
    const skill: SkillStateMachine = {
      id: "t",
      initial_state: "s1",
      states: {
        s1: { agent_prompt: "p", provider: "claude-cli", model: "m1", transitions: [{ to: "s2" }] },
        s2: { agent_prompt: "p", transitions: [{ to: "done" }] },
        done: { terminal: true },
      },
    } as SkillStateMachine;
    const resolved = { complete: vi.fn(() => Effect.succeed(resp())) };
    const resolveFn = vi.fn(() => resolved);
    const providerRegistry = { resolve: resolveFn } as any;
    const defaultProv = { complete: vi.fn(() => Effect.succeed(resp())) };
    const r = await run(skill, { provider: defaultProv, providerRegistry, repository: makeRepo().repo });
    expect(r.success).toBe(true);
    expect(resolveFn).toHaveBeenCalledWith("claude-cli", "m1");
    expect(resolved.complete).toHaveBeenCalledOnce(); // s1 via registry
    expect(defaultProv.complete).toHaveBeenCalledOnce(); // s2 via default
  });

  it("routes a provider-resolution failure through fail() (persisting cost), not a raw defect", async () => {
    const skill: SkillStateMachine = {
      id: "t",
      initial_state: "s1",
      states: {
        s1: { agent_prompt: "p", provider: "claude-api", transitions: [{ to: "done" }] },
        done: { terminal: true },
      },
    } as SkillStateMachine;
    const providerRegistry = { resolve: () => { throw new Error("no apiKey"); } } as any;
    const defaultProv = { complete: () => Effect.succeed(resp()) };
    const repo = makeRepo();
    const r = await run(skill, { provider: defaultProv, providerRegistry, repository: repo.repo });
    expect(r.success).toBe(false);
    expect(r.output).toContain("Provider resolution failed");
    expect(repo.get("exec1")!.status).toBe("failed");
    expect(repo.get("exec1")!.providerBreakdown).toBeDefined();
  });
});
