/**
 * Budget-hook tests (F3 #147, Wave D): the money gate added to runStateMachine
 * around the real LLM invocation. Mirrors state-machine-f1.test.ts's harness.
 */
import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { runStateMachine, type StateMachineContext } from "./state-machine.js";
import type { SkillStateMachine } from "../skill/schema.js";
import type { CompletionResponse } from "../provider/types.js";
import type { ProviderRegistry } from "../provider/registry.js";
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

/** In-memory execution repo that also captures the last persisted metadata (mirrors state-machine-f1.test.ts). */
const makeRepo = () => {
  const store = new Map<string, ExecutionRecord>();
  store.set("exec1", {
    id: "exec1",
    routineId: "r",
    triggerType: "api",
    skillName: "t",
    status: "pending",
    startedAt: new Date(),
  });
  return {
    repo: {
      save: async (rec: ExecutionRecord) => {
        store.set(rec.id, rec);
      },
      findById: async (id: string) => store.get(id),
      findByRoutine: async () => [],
      findByTask: async () => [],
      findAll: async () => [],
    },
    get: (id: string) => store.get(id),
  };
};

const seqProvider = (responses: CompletionResponse[] | (() => CompletionResponse)) => {
  let calls = 0;
  return {
    provider: {
      complete: vi.fn(() => {
        const r = typeof responses === "function" ? responses() : responses[Math.min(calls, responses.length - 1)];
        calls++;
        return Effect.succeed(r);
      }),
    },
    calls: () => calls,
  };
};

const oneAgentStateSkill: SkillStateMachine = {
  id: "t",
  initial_state: "plan",
  states: {
    plan: { agent_prompt: "p", model: "claude-sonnet-5", transitions: [{ to: "done" }] },
    done: { terminal: true },
  },
} as SkillStateMachine;

const run = (config: Parameters<typeof runStateMachine>[0], context?: StateMachineContext) =>
  Effect.runPromise(runStateMachine(config)(oneAgentStateSkill, routine, event, "exec1", context));

describe("F3 Wave D — budget hook", () => {
  it("AC7: budgetGate granted:false stops BEFORE executeLLMStep (provider spy 0 calls)", async () => {
    const { provider } = seqProvider(() => resp());
    const repo = makeRepo();
    const budgetGate = vi.fn(async () => ({ granted: false }));

    const r = await run({ provider, repository: repo.repo, budgetGate });

    expect(r.success).toBe(false);
    expect(r.output).toContain("budget");
    expect(provider.complete).not.toHaveBeenCalled();
    expect(budgetGate).toHaveBeenCalledWith({ phase: "plan", tier: "claude-sonnet-5", executionId: "exec1" });
    expect(repo.get("exec1")!.status).toBe("failed");
    expect(repo.get("exec1")!.metadata?.blockReason).toBe("budget");
  });

  it("a denied reservation preserves the stateMachineContext persisted for this state, instead of clobbering it", async () => {
    // runStateMachine's own persistStateContext writes stateMachineContext for
    // "plan" at the top of this same state's processing, BEFORE the budget
    // check runs — fail()'s read-then-merge must not wipe that write.
    const repo = makeRepo();
    const { provider } = seqProvider(() => resp());
    const budgetGate = vi.fn(async () => ({ granted: false }));

    await run({ provider, repository: repo.repo, budgetGate });

    const metadata = repo.get("exec1")!.metadata as { stateMachineContext?: { currentState?: string }; blockReason?: string };
    expect(metadata.blockReason).toBe("budget");
    expect(metadata.stateMachineContext?.currentState).toBe("plan");
  });

  it("budgetGate granted:true lets the call through and passes the reservationId to budgetSettle with the actual cost", async () => {
    const { provider } = seqProvider([resp({ costUsd: 0.42 })]);
    const repo = makeRepo();
    const budgetGate = vi.fn(async () => ({ granted: true, reservationId: "res-1" }));
    const budgetSettle = vi.fn(async () => {});

    const r = await run({ provider, repository: repo.repo, budgetGate, budgetSettle });

    expect(r.success).toBe(true);
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(budgetSettle).toHaveBeenCalledWith("res-1", 0.42);
  });

  it("without a budgetGate configured, the LLM call proceeds exactly as before (no behavior change)", async () => {
    const { provider } = seqProvider([resp()]);
    const repo = makeRepo();

    const r = await run({ provider, repository: repo.repo });

    expect(r.success).toBe(true);
    expect(provider.complete).toHaveBeenCalledOnce();
  });

  it("a fail() call without a blockReason keeps the pre-existing behavior (metadata untouched by fail itself)", async () => {
    const skill: SkillStateMachine = {
      id: "t",
      initial_state: "s1",
      states: { s1: { agent_prompt: "p", transitions: [] } }, // no matching transition -> fail("No matching transition...")
    } as SkillStateMachine;
    const repo = makeRepo();
    const { provider } = seqProvider([resp()]);

    const r = await Effect.runPromise(runStateMachine({ provider, repository: repo.repo })(skill, routine, event, "exec1"));

    expect(r.success).toBe(false);
    expect(r.output).toContain("No matching transition");
    // No blockReason path taken -> fail() never reads/merges metadata; final persisted
    // metadata is whatever persistStateContext already wrote for this state.
    expect((repo.get("exec1")!.metadata as { blockReason?: string } | undefined)?.blockReason).toBeUndefined();
  });
});

describe("F4 H6 — budget hook inside fanout (per-lens reservation)", () => {
  // `approvedWhen` doubles as the assert on the aggregated envelope: the run
  // only reaches `done` (success) when output.review.approved matches it.
  const fanoutSkill = (approvedWhen: string): SkillStateMachine =>
    ({
      id: "t",
      initial_state: "review",
      states: {
        review: {
          type: "fanout",
          lenses: [
            { name: "correctness", provider: "kimi-cli", model: "kimi-k2.6", agent_prompt: "lens A" },
            // No model: the reservation tier must fall back to the provider name.
            { name: "security", provider: "security-judge", agent_prompt: "lens B" },
          ],
          transitions: [{ to: "done", when: approvedWhen }],
        },
        done: { terminal: true },
      },
    }) as unknown as SkillStateMachine;

  const makeFanoutRegistry = () => {
    const completes: Record<string, ReturnType<typeof vi.fn>> = {};
    const registry = {
      resolve: (name: string) => {
        const complete = (completes[name] ??= vi.fn(() =>
          Effect.succeed(resp({ content: JSON.stringify({ ok: true }), costUsd: name === "kimi-cli" ? 0.1 : 0.7 }))
        ));
        return { complete };
      },
    } as unknown as ProviderRegistry;
    return { registry, completes };
  };

  it("reserves 1 call per lens (tier = lens.model ?? lens.provider) and settles each with the actual cost", async () => {
    const { registry, completes } = makeFanoutRegistry();
    const budgetGate = vi.fn(async ({ tier }: { tier: string }) => ({ granted: true, reservationId: `res-${tier}` }));
    const budgetSettle = vi.fn(async () => {});

    const r = await Effect.runPromise(
      runStateMachine({
        provider: { complete: () => Effect.succeed(resp()) },
        providerRegistry: registry,
        repository: makeRepo().repo,
        budgetGate,
        budgetSettle,
      })(fanoutSkill("output.review.approved == true"), routine, event, "exec1")
    );

    expect(r.success).toBe(true); // approved:true — no lens errored
    expect(budgetGate).toHaveBeenCalledTimes(2);
    expect(budgetGate).toHaveBeenCalledWith({ phase: "review", tier: "kimi-k2.6", executionId: "exec1" });
    expect(budgetGate).toHaveBeenCalledWith({ phase: "review", tier: "security-judge", executionId: "exec1" });
    expect(completes["kimi-cli"]).toHaveBeenCalledOnce();
    expect(completes["security-judge"]).toHaveBeenCalledOnce();
    expect(budgetSettle).toHaveBeenCalledWith("res-kimi-k2.6", 0.1);
    expect(budgetSettle).toHaveBeenCalledWith("res-security-judge", 0.7);
  });

  it("a denied reservation fails ONLY that lens (provider never called) and the fail-closed aggregation still resolves the state", async () => {
    const { registry, completes } = makeFanoutRegistry();
    const budgetGate = vi.fn(async ({ tier }: { tier: string }) => ({ granted: tier !== "kimi-k2.6" }));

    const r = await Effect.runPromise(
      runStateMachine({
        provider: { complete: () => Effect.succeed(resp()) },
        providerRegistry: registry,
        repository: makeRepo().repo,
        budgetGate,
      })(fanoutSkill("output.review.approved == false"), routine, event, "exec1")
    );

    // approved:false (denied lens carries {error}) and the machine still
    // transitioned — the state resolved instead of collapsing the execution.
    expect(r.success).toBe(true);
    expect(completes["kimi-cli"]).not.toHaveBeenCalled(); // reservation denied BEFORE any call
    expect(completes["security-judge"]).toHaveBeenCalledOnce();
  });

  it("without a budgetGate configured, fanout lenses run ungated exactly as before", async () => {
    const { registry, completes } = makeFanoutRegistry();

    const r = await Effect.runPromise(
      runStateMachine({
        provider: { complete: () => Effect.succeed(resp()) },
        providerRegistry: registry,
        repository: makeRepo().repo,
      })(fanoutSkill("output.review.approved == true"), routine, event, "exec1")
    );

    expect(r.success).toBe(true);
    expect(completes["kimi-cli"]).toHaveBeenCalledOnce();
    expect(completes["security-judge"]).toHaveBeenCalledOnce();
  });
});
