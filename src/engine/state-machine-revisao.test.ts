/**
 * Engine-level flow tests for the `revisao`/`refutacao` states (F4 #153) —
 * mirrors the transition shapes in .gates/skills/card-to-pr/skill.yaml with a
 * synthetic skill + mocked providers (the REAL aggregateRevisao wired in),
 * same harness pattern as state-machine-f1.test.ts / state-machine-f4.test.ts.
 */
import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { runStateMachine, type StateMachineConfig } from "./state-machine.js";
import { makeScriptRegistry } from "../script/registry.js";
import { aggregateRevisao } from "../review/aggregate.js";
import type { SkillStateMachine } from "../skill/schema.js";
import type { CompletionRequest, CompletionResponse } from "../provider/types.js";
import type { Routine } from "../routine/types.js";
import type { TriggerEvent } from "../routine/matcher.js";
import type { ExecutionRecord } from "../persistence/types.js";
import type { ProviderRegistry } from "../provider/registry.js";

const routine: Routine = { id: "r", triggers: [{ type: "api" }], pipeline: { skill: "t" } } as Routine;
const event: TriggerEvent = { type: "api", payload: {} } as TriggerEvent;

const resp = (over: Partial<CompletionResponse> = {}): CompletionResponse => ({
  content: "ok: true",
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  model: "mock",
  finishReason: "stop",
  ...over,
});

const makeRepo = () => {
  const store = new Map<string, ExecutionRecord>();
  store.set("exec1", { id: "exec1", routineId: "r", triggerType: "api", skillName: "t", status: "pending", startedAt: new Date() });
  let lastOutputs: Record<string, unknown> = {};
  return {
    repo: {
      save: async (rec: ExecutionRecord) => {
        const smc = (rec.metadata as { stateMachineContext?: { outputs?: Record<string, unknown> } } | undefined)?.stateMachineContext;
        if (smc?.outputs) lastOutputs = smc.outputs;
        store.set(rec.id, rec);
      },
      findById: async (id: string) => store.get(id),
      findByRoutine: async () => [],
      findAll: async () => [],
    },
    get: (id: string) => store.get(id),
    lastOutputs: () => lastOutputs,
  };
};

/** Registry whose providers serve queued content per provider:model key (mirrors state-machine-f4.test.ts). */
const makeTrackingRegistry = (contentByKey: Record<string, string | string[]> = {}) => {
  const calls: string[] = [];
  const requests: Array<{ key: string; request: CompletionRequest }> = [];
  const callCounts: Record<string, number> = {};
  const registry: ProviderRegistry = {
    resolve: (name, model) => {
      const key = `${name}:${model ?? "default"}`;
      return {
        complete: (request: CompletionRequest) => {
          calls.push(key);
          requests.push({ key, request });
          const queued = contentByKey[key];
          let content: string;
          if (Array.isArray(queued)) {
            const i = callCounts[key] ?? 0;
            content = queued[Math.min(i, queued.length - 1)];
            callCounts[key] = i + 1;
          } else {
            content = queued ?? "ok: true";
          }
          return Effect.succeed(resp({ content }));
        },
      };
    },
  };
  return { registry, calls, requests };
};

const run = (skill: SkillStateMachine, config: StateMachineConfig) =>
  Effect.runPromise(runStateMachine(config)(skill, routine, event, "exec1"));

const approvedCorrectness = JSON.stringify({ approved: true, gaps: [] });
const approvedSecurity = JSON.stringify({ approved: true, findings: [], criticalArea: false });

/** Mirrors .gates/skills/card-to-pr/skill.yaml's verify->revisao->refutacao wiring. */
const cardSkill = (): SkillStateMachine =>
  ({
    id: "t",
    initial_state: "verify",
    states: {
      verify: { type: "script", script: "verify", transitions: [{ to: "revisao" }] },
      revisao: {
        type: "fanout",
        lenses: [
          { name: "correctness", provider: "kimi-cli", model: "kimi-k2.6", agent_prompt: "review correctness" },
          {
            name: "data",
            provider: "claude-cli",
            model: "claude-sonnet-5",
            tools: ["Read", "Grep", "Glob"],
            when: "output.verify.dataChanges == true",
            agent_prompt: "review data",
          },
          { name: "security", provider: "security-judge", model: "claude-opus-4-8", agent_prompt: "review security" },
        ],
        aggregate: "aggregateRevisao",
        transitions: [
          { to: "refutacao", when: "output.revisao.gaps.length > 0", max_retries: 2, on_exhausted: "bloqueado" },
          { to: "bloqueado", when: "output.revisao.securityVerdict.approved == false" },
          { to: "pr", when: "output.revisao.approved == true" },
          { to: "bloqueado" },
        ],
      },
      refutacao: {
        agent_prompt: "responda aos gaps: {{outputs.revisao.gaps}}",
        transitions: [
          { to: "implementacao", when: "output.refutacao.status == 'corrigir'" },
          { to: "revisao", when: "output.refutacao.status == 'contestado'" },
        ],
      },
      implementacao: { terminal: true },
      pr: { terminal: true },
      bloqueado: { terminal: true },
    },
  }) as unknown as SkillStateMachine;

const registerVerify = (dataChanges: boolean) => {
  const scriptRegistry = makeScriptRegistry();
  scriptRegistry.register("verify", async () => ({ dataChanges }));
  return scriptRegistry;
};

describe("revisao/refutacao flow (#153)", () => {
  it("dataChanges:false — the data lens is never invoked and an all-approved review lands on pr", async () => {
    const { registry, calls } = makeTrackingRegistry({
      "kimi-cli:kimi-k2.6": approvedCorrectness,
      "security-judge:claude-opus-4-8": approvedSecurity,
    });
    const r = await run(cardSkill(), {
      provider: { complete: () => Effect.succeed(resp()) },
      providerRegistry: registry,
      scriptRegistry: registerVerify(false),
      repository: makeRepo().repo,
      fanoutAggregators: { aggregateRevisao },
    });
    expect(r.success).toBe(true);
    expect(r.logs.join(" ")).toContain("Reached terminal state: pr");
    expect(calls).not.toContain("claude-cli:claude-sonnet-5");
  });

  it("dataChanges:true — the data lens IS invoked", async () => {
    const { registry, calls } = makeTrackingRegistry({
      "kimi-cli:kimi-k2.6": approvedCorrectness,
      "claude-cli:claude-sonnet-5": JSON.stringify({ approved: true, gaps: [] }),
      "security-judge:claude-opus-4-8": approvedSecurity,
    });
    const r = await run(cardSkill(), {
      provider: { complete: () => Effect.succeed(resp()) },
      providerRegistry: registry,
      scriptRegistry: registerVerify(true),
      repository: makeRepo().repo,
      fanoutAggregators: { aggregateRevisao },
    });
    expect(r.success).toBe(true);
    expect(calls).toContain("claude-cli:claude-sonnet-5");
    expect(r.logs.join(" ")).toContain("Reached terminal state: pr");
  });

  it("a contestable correctness gap routes to refutacao; {status:'corrigir'} routes on to implementacao", async () => {
    const { registry } = makeTrackingRegistry({
      "kimi-cli:kimi-k2.6": JSON.stringify({ approved: false, gaps: [{ description: "missing AC", contestable: true }] }),
      "security-judge:claude-opus-4-8": approvedSecurity,
    });
    const r = await run(cardSkill(), {
      provider: { complete: () => Effect.succeed(resp({ content: JSON.stringify({ status: "corrigir", correcoes: ["fix it"] }) })) },
      providerRegistry: registry,
      scriptRegistry: registerVerify(false),
      repository: makeRepo().repo,
      fanoutAggregators: { aggregateRevisao },
    });
    expect(r.success).toBe(true);
    expect(r.logs.join(" ")).toContain("Reached terminal state: implementacao");
  });

  it("{status:'contestado'} routes back to revisao, and the re-invoked lens's prompt carries the evidence", async () => {
    const { registry, requests } = makeTrackingRegistry({
      "kimi-cli:kimi-k2.6": [
        JSON.stringify({ approved: false, gaps: [{ description: "missing AC", contestable: true }] }),
        approvedCorrectness,
      ],
      "security-judge:claude-opus-4-8": approvedSecurity,
    });
    const skill = cardSkill();
    // Real skill.yaml puts this block in every lens prompt file; this fixture
    // only needs it on the one lens under test.
    (skill.states.revisao.lenses![0] as Record<string, unknown>).agent_prompt =
      "review correctness <contestacao_refutacao>{{outputs.refutacao}}</contestacao_refutacao>";
    const r = await run(skill, {
      provider: {
        complete: () => Effect.succeed(resp({ content: JSON.stringify({ status: "contestado", evidencia: "o plano aprovou isso" }) })),
      },
      providerRegistry: registry,
      scriptRegistry: registerVerify(false),
      repository: makeRepo().repo,
      fanoutAggregators: { aggregateRevisao },
    });
    expect(r.success).toBe(true);
    expect(r.logs.join(" ")).toContain("Reached terminal state: pr");
    const kimiCalls = requests.filter((q) => q.key === "kimi-cli:kimi-k2.6");
    expect(kimiCalls).toHaveLength(2);
    expect(kimiCalls[1].request.messages?.[0]?.content).toContain("o plano aprovou isso");
  });

  it("caps revisao->refutacao at 2 retries, then escapes to bloqueado (on_exhausted) instead of failing the execution", async () => {
    const { registry } = makeTrackingRegistry({
      // correctness ALWAYS reports the same contestable gap; refutacao ALWAYS contests it — a stuck adjudication loop.
      "kimi-cli:kimi-k2.6": JSON.stringify({ approved: false, gaps: [{ description: "missing AC", contestable: true }] }),
      "security-judge:claude-opus-4-8": approvedSecurity,
    });
    const r = await run(cardSkill(), {
      provider: { complete: () => Effect.succeed(resp({ content: JSON.stringify({ status: "contestado", evidencia: "still disagree" }) })) },
      providerRegistry: registry,
      scriptRegistry: registerVerify(false),
      repository: makeRepo().repo,
      fanoutAggregators: { aggregateRevisao },
    });
    expect(r.success).toBe(true); // on_exhausted escapes to bloqueado; it does not fail the execution
    expect(r.logs.join(" ")).toContain("Reached terminal state: bloqueado");
  });

  it("an 'open' security finding routes to refutacao, NOT directly to bloqueado (explicit transition-order check)", async () => {
    const { registry } = makeTrackingRegistry({
      "kimi-cli:kimi-k2.6": approvedCorrectness,
      "security-judge:claude-opus-4-8": JSON.stringify({
        approved: true, // not yet reproved — an "open" finding alone must never flip this before adjudication
        findings: [{ description: "possible SSRF", status: "open", confidence: 9 }],
        criticalArea: false,
      }),
    });
    const r = await run(cardSkill(), {
      provider: { complete: () => Effect.succeed(resp({ content: JSON.stringify({ status: "corrigir", correcoes: ["patch it"] }) })) },
      providerRegistry: registry,
      scriptRegistry: registerVerify(false),
      repository: makeRepo().repo,
      fanoutAggregators: { aggregateRevisao },
    });
    expect(r.success).toBe(true);
    expect(r.logs.join(" ")).toContain("Reached terminal state: implementacao");
    expect(r.logs.join(" ")).not.toContain("Reached terminal state: bloqueado");
  });

  it("a terminal reproved security verdict (no open findings left) routes straight to bloqueado", async () => {
    const { registry } = makeTrackingRegistry({
      "kimi-cli:kimi-k2.6": approvedCorrectness,
      "security-judge:claude-opus-4-8": JSON.stringify({
        approved: false,
        findings: [{ description: "confirmed SSRF", status: "confirmado", confidence: 9 }],
        criticalArea: true,
      }),
    });
    const r = await run(cardSkill(), {
      provider: { complete: () => Effect.succeed(resp()) },
      providerRegistry: registry,
      scriptRegistry: registerVerify(false),
      repository: makeRepo().repo,
      fanoutAggregators: { aggregateRevisao },
    });
    expect(r.success).toBe(true);
    expect(r.logs.join(" ")).toContain("Reached terminal state: bloqueado");
  });
});
