/**
 * F4 runner tests: dynamic provider routing (#185), on_exhausted escape (#185),
 * format/transient retry classes + stall detection + tier escalation (#159),
 * and fanout lens extensions — when/tools/agent_prompt_file/aggregate (#153).
 */
import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runStateMachine, type StateMachineConfig } from "./state-machine.js";
import { makeScriptRegistry } from "../script/registry.js";
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
  store.set("exec1", {
    id: "exec1",
    routineId: "r",
    triggerType: "api",
    skillName: "t",
    status: "pending",
    startedAt: new Date(),
  });
  // succeed()/fail() persist a fresh record without metadata, clobbering the
  // stored stateMachineContext — capture the last one at save time instead.
  let lastContext: { outputs?: Record<string, unknown> } | undefined;
  return {
    repo: {
      save: async (rec: ExecutionRecord) => {
        const smc = (rec.metadata as { stateMachineContext?: { outputs?: Record<string, unknown> } } | undefined)
          ?.stateMachineContext;
        if (smc) lastContext = smc;
        store.set(rec.id, rec);
      },
      findById: async (id: string) => store.get(id),
      findByRoutine: async () => [],
      findAll: async () => [],
    },
    get: (id: string) => store.get(id),
    lastOutputs: () => lastContext?.outputs ?? {},
  };
};

/** Registry whose providers record which key served each call (and the requests). */
const makeTrackingRegistry = (contentByKey: Record<string, string | (() => string)> = {}) => {
  const calls: string[] = [];
  const requests: Array<{ key: string; request: CompletionRequest }> = [];
  const registry: ProviderRegistry = {
    resolve: (name, model) => {
      const key = `${name}:${model ?? "default"}`;
      return {
        complete: (request: CompletionRequest) => {
          calls.push(key);
          requests.push({ key, request });
          const c = contentByKey[key];
          const content = typeof c === "function" ? c() : (c ?? "ok: true");
          return Effect.succeed(resp({ content }));
        },
      };
    },
  };
  return { registry, calls, requests };
};

const run = (skill: SkillStateMachine, config: StateMachineConfig) =>
  Effect.runPromise(runStateMachine(config)(skill, routine, event, "exec1"));

describe("F4 — dynamic provider routing (#185)", () => {
  const skill: SkillStateMachine = {
    id: "t",
    initial_state: "impl",
    states: {
      impl: {
        dynamic_provider: true,
        provider: "claude-cli",
        model: "claude-sonnet-5",
        agent_prompt: "p",
        transitions: [{ to: "done" }],
      },
      done: { terminal: true },
    },
  } as SkillStateMachine;

  it("uses the hook's route instead of the static provider", async () => {
    const { registry, calls } = makeTrackingRegistry();
    const r = await run(skill, {
      provider: { complete: () => Effect.succeed(resp()) },
      providerRegistry: registry,
      repository: makeRepo().repo,
      resolveDynamicProvider: ({ stateId, escalated }) =>
        stateId === "impl" && !escalated ? { provider: "kimi-cli", model: "kimi-k2.6" } : undefined,
    });
    expect(r.success).toBe(true);
    expect(calls).toEqual(["kimi-cli:kimi-k2.6"]);
  });

  it("falls back to the static provider when the hook returns undefined", async () => {
    const { registry, calls } = makeTrackingRegistry();
    const r = await run(skill, {
      provider: { complete: () => Effect.succeed(resp()) },
      providerRegistry: registry,
      repository: makeRepo().repo,
      resolveDynamicProvider: () => undefined,
    });
    expect(r.success).toBe(true);
    expect(calls).toEqual(["claude-cli:claude-sonnet-5"]);
  });

  it("falls back to the static provider when no hook is configured", async () => {
    const { registry, calls } = makeTrackingRegistry();
    const r = await run(skill, {
      provider: { complete: () => Effect.succeed(resp()) },
      providerRegistry: registry,
      repository: makeRepo().repo,
    });
    expect(r.success).toBe(true);
    expect(calls).toEqual(["claude-cli:claude-sonnet-5"]);
  });
});

describe("F4 — on_exhausted escape (#185)", () => {
  it("escapes to the declared state with exhausted:true instead of failing", async () => {
    const scriptRegistry = makeScriptRegistry();
    scriptRegistry.register("judge", async () => ({ verdict: "refutado" }));
    scriptRegistry.register("escape", async ({ outputs }) => ({
      sawExhausted: (outputs.judge as { exhausted?: boolean }).exhausted === true,
    }));
    const skill: SkillStateMachine = {
      id: "t",
      initial_state: "judge",
      states: {
        judge: {
          type: "script",
          script: "judge",
          transitions: [
            { to: "judge", when: "output.judge.verdict == 'refutado'", max_retries: 1, on_exhausted: "blocked" },
            { to: "done" },
          ],
        },
        blocked: { type: "script", script: "escape", transitions: [{ to: "done" }] },
        done: { terminal: true },
      },
    } as SkillStateMachine;
    const repo = makeRepo();
    const r = await run(skill, {
      provider: { complete: () => Effect.succeed(resp()) },
      scriptRegistry,
      repository: repo.repo,
    });
    expect(r.success).toBe(true);
    expect((repo.lastOutputs().blocked as { sawExhausted?: boolean }).sawExhausted).toBe(true);
  });

  it("a transition without on_exhausted still fails on exhaustion (F1 behavior preserved)", async () => {
    const scriptRegistry = makeScriptRegistry();
    scriptRegistry.register("judge", async () => ({ verdict: "refutado" }));
    const skill: SkillStateMachine = {
      id: "t",
      initial_state: "judge",
      states: {
        judge: {
          type: "script",
          script: "judge",
          transitions: [{ to: "judge", when: "output.judge.verdict == 'refutado'", max_retries: 1 }, { to: "done" }],
        },
        done: { terminal: true },
      },
    } as SkillStateMachine;
    const r = await run(skill, {
      provider: { complete: () => Effect.succeed(resp()) },
      scriptRegistry,
      repository: makeRepo().repo,
    });
    expect(r.success).toBe(false);
    expect(r.output).toContain("Max retries (1)");
  });
});

describe("F4 — format retry (#159)", () => {
  it("retries once with a format reminder without consuming logic retries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-schema-"));
    const schemaPath = join(dir, "out.schema.json");
    writeFileSync(schemaPath, JSON.stringify({ type: "object", required: ["passed"], properties: { passed: { type: "boolean" } } }));
    const prompts: string[] = [];
    let call = 0;
    const provider = {
      complete: (request: CompletionRequest) => {
        prompts.push(request.messages?.find((m) => m.role === "user")?.content ?? "");
        call++;
        return Effect.succeed(resp({ content: call === 1 ? "not: valid" : JSON.stringify({ passed: true }) }));
      },
    };
    const skill: SkillStateMachine = {
      id: "t",
      initial_state: "s",
      states: {
        s: { agent_prompt: "do it", output_schema: schemaPath, transitions: [{ to: "done" }] },
        done: { terminal: true },
      },
    } as SkillStateMachine;
    const r = await run(skill, { provider, repository: makeRepo().repo });
    expect(r.success).toBe(true);
    expect(call).toBe(2);
    expect(prompts[1]).toContain("FORMAT REMINDER");
  });

  it("fails after the format retry cap when the output stays invalid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-schema-"));
    const schemaPath = join(dir, "out.schema.json");
    writeFileSync(schemaPath, JSON.stringify({ type: "object", required: ["passed"], properties: { passed: { type: "boolean" } } }));
    let call = 0;
    const provider = {
      complete: () => {
        call++;
        return Effect.succeed(resp({ content: "still: wrong" }));
      },
    };
    const skill: SkillStateMachine = {
      id: "t",
      initial_state: "s",
      states: {
        s: { agent_prompt: "do it", output_schema: schemaPath, transitions: [{ to: "done" }] },
        done: { terminal: true },
      },
    } as SkillStateMachine;
    const r = await run(skill, { provider, repository: makeRepo().repo });
    expect(r.success).toBe(false);
    expect(call).toBe(2); // 1 original + FORMAT_RETRY_CAP(1)
    expect(String(r.output)).toContain("Schema validation failed");
  });
});

describe("F4 — transient retry (#159)", () => {
  it("retries residual transient provider errors up to the cap, then succeeds", async () => {
    let call = 0;
    const provider = {
      complete: () => {
        call++;
        return call <= 2
          ? Effect.fail(new Error("HTTP 429: overloaded"))
          : Effect.succeed(resp());
      },
    };
    const skill: SkillStateMachine = {
      id: "t",
      initial_state: "s",
      states: { s: { agent_prompt: "p", transitions: [{ to: "done" }] }, done: { terminal: true } },
    } as SkillStateMachine;
    const r = await run(skill, { provider, repository: makeRepo().repo });
    expect(r.success).toBe(true);
    expect(call).toBe(3);
  });

  it("does not retry non-transient provider errors", async () => {
    let call = 0;
    const provider = {
      complete: () => {
        call++;
        return Effect.fail(new Error("invalid api key"));
      },
    };
    const skill: SkillStateMachine = {
      id: "t",
      initial_state: "s",
      states: { s: { agent_prompt: "p", transitions: [{ to: "done" }] }, done: { terminal: true } },
    } as SkillStateMachine;
    const r = await run(skill, { provider, repository: makeRepo().repo });
    expect(r.success).toBe(false);
    expect(call).toBe(1);
  });
});

describe("F4 — stall detection (#159)", () => {
  it("same failureSignature on the retry edge skips remaining retries", async () => {
    const scriptRegistry = makeScriptRegistry();
    let runs = 0;
    scriptRegistry.register("check", async () => {
      runs++;
      return { passed: false, failureSignature: "sig-static" };
    });
    const skill: SkillStateMachine = {
      id: "t",
      initial_state: "check",
      states: {
        check: {
          type: "script",
          script: "check",
          // Cap of 5 — the stall must trip long before it.
          transitions: [{ to: "check", when: "output.check.passed == false", max_retries: 5 }, { to: "done" }],
        },
        done: { terminal: true },
      },
    } as SkillStateMachine;
    const r = await run(skill, {
      provider: { complete: () => Effect.succeed(resp()) },
      scriptRegistry,
      repository: makeRepo().repo,
    });
    expect(r.success).toBe(false);
    expect(String(r.output)).toContain("Stalled");
    // 1st run records the signature; 2nd run repeats it → stall. No 3rd run.
    expect(runs).toBe(2);
  });

  it("changing signatures keep consuming the normal cap", async () => {
    const scriptRegistry = makeScriptRegistry();
    let runs = 0;
    scriptRegistry.register("check", async () => {
      runs++;
      return { passed: false, failureSignature: `sig-${runs}` };
    });
    const skill: SkillStateMachine = {
      id: "t",
      initial_state: "check",
      states: {
        check: {
          type: "script",
          script: "check",
          transitions: [{ to: "check", when: "output.check.passed == false", max_retries: 2 }, { to: "done" }],
        },
        done: { terminal: true },
      },
    } as SkillStateMachine;
    const r = await run(skill, {
      provider: { complete: () => Effect.succeed(resp()) },
      scriptRegistry,
      repository: makeRepo().repo,
    });
    expect(r.success).toBe(false);
    expect(String(r.output)).toContain("Max retries (2)");
    expect(runs).toBe(3);
  });
});

describe("F4 — tier escalation on cap exhaustion (#159)", () => {
  it("grants one final attempt at the escalated tier, then exhausts for good", async () => {
    const { registry, calls } = makeTrackingRegistry({
      "claude-cli:claude-sonnet-5": JSON.stringify({ done: false }),
      "claude-cli:claude-opus-4-8": JSON.stringify({ done: false }),
    });
    const scriptRegistry = makeScriptRegistry();
    scriptRegistry.register("check", async () => ({ passed: false }));
    const escalationCtx: Array<{ escalated: boolean }> = [];
    const skill: SkillStateMachine = {
      id: "t",
      initial_state: "impl",
      states: {
        impl: {
          dynamic_provider: true,
          provider: "claude-cli",
          model: "claude-sonnet-5",
          agent_prompt: "p",
          transitions: [{ to: "check" }],
        },
        check: {
          type: "script",
          script: "check",
          transitions: [
            { to: "impl", when: "output.check.passed == false", max_retries: 1, on_exhausted: "blocked" },
            { to: "done" },
          ],
        },
        blocked: { type: "script", script: "blocked", transitions: [{ to: "done" }] },
        done: { terminal: true },
      },
    } as SkillStateMachine;
    scriptRegistry.register("blocked", async () => ({ blocked: true }));
    const r = await run(skill, {
      provider: { complete: () => Effect.succeed(resp()) },
      providerRegistry: registry,
      scriptRegistry,
      repository: makeRepo().repo,
      resolveDynamicProvider: ({ escalated }) => {
        escalationCtx.push({ escalated });
        return escalated
          ? { provider: "claude-cli", model: "claude-opus-4-8" }
          : { provider: "claude-cli", model: "claude-sonnet-5" };
      },
    });
    expect(r.success).toBe(true); // escaped to blocked, then done
    // sonnet ran twice (initial + 1 retry), opus exactly once (the escalation).
    expect(calls.filter((c) => c === "claude-cli:claude-sonnet-5")).toHaveLength(2);
    expect(calls.filter((c) => c === "claude-cli:claude-opus-4-8")).toHaveLength(1);
    expect(escalationCtx.some((c) => c.escalated)).toBe(true);
  });

  it("exhausts immediately when the hook has no higher tier to offer", async () => {
    const { registry, calls } = makeTrackingRegistry({
      "claude-cli:claude-opus-4-8": JSON.stringify({ done: false }),
    });
    const scriptRegistry = makeScriptRegistry();
    scriptRegistry.register("check", async () => ({ passed: false }));
    scriptRegistry.register("blocked", async () => ({ blocked: true }));
    const skill: SkillStateMachine = {
      id: "t",
      initial_state: "impl",
      states: {
        impl: {
          dynamic_provider: true,
          provider: "claude-cli",
          model: "claude-opus-4-8",
          agent_prompt: "p",
          transitions: [{ to: "check" }],
        },
        check: {
          type: "script",
          script: "check",
          transitions: [
            { to: "impl", when: "output.check.passed == false", max_retries: 1, on_exhausted: "blocked" },
            { to: "done" },
          ],
        },
        blocked: { type: "script", script: "blocked", transitions: [{ to: "done" }] },
        done: { terminal: true },
      },
    } as SkillStateMachine;
    const r = await run(skill, {
      provider: { complete: () => Effect.succeed(resp()) },
      providerRegistry: registry,
      scriptRegistry,
      repository: makeRepo().repo,
      resolveDynamicProvider: ({ escalated }) =>
        escalated ? undefined : { provider: "claude-cli", model: "claude-opus-4-8" },
    });
    expect(r.success).toBe(true);
    // opus ran twice (initial + 1 retry) and NO escalated third attempt happened.
    expect(calls.filter((c) => c === "claude-cli:claude-opus-4-8")).toHaveLength(2);
  });
});

describe("F4 — fanout lens extensions (#153)", () => {
  const lensSkill = (overrides: Record<string, unknown> = {}): SkillStateMachine =>
    ({
      id: "t",
      initial_state: "prep",
      states: {
        prep: { type: "script", script: "prep", transitions: [{ to: "review" }] },
        review: {
          type: "fanout",
          lenses: [
            { name: "correctness", provider: "kimi-cli", model: "kimi-k2.6", agent_prompt: "lens A" },
            {
              name: "data",
              provider: "claude-cli",
              model: "claude-sonnet-5",
              agent_prompt: "lens B",
              when: "output.prep.dataChanges == true",
              tools: ["Read", "Grep", "Glob"],
            },
          ],
          transitions: [{ to: "done" }],
          ...overrides,
        },
        done: { terminal: true },
      },
    }) as unknown as SkillStateMachine;

  const prepRegistry = (dataChanges: boolean) => {
    const scriptRegistry = makeScriptRegistry();
    scriptRegistry.register("prep", async () => ({ dataChanges }));
    return scriptRegistry;
  };

  it("skips a lens whose when is false — provider not called, lens absent", async () => {
    const { registry, calls } = makeTrackingRegistry();
    const repo = makeRepo();
    const r = await run(lensSkill(), {
      provider: { complete: () => Effect.succeed(resp()) },
      providerRegistry: registry,
      scriptRegistry: prepRegistry(false),
      repository: repo.repo,
    });
    expect(r.success).toBe(true);
    expect(calls).toEqual(["kimi-cli:kimi-k2.6"]);
    const lentes = (repo.lastOutputs().review as { lentes: Array<{ name: string }> }).lentes;
    expect(lentes.map((l) => l.name)).toEqual(["correctness"]);
  });

  it("runs a conditional lens when its condition holds, passing its tool allowlist", async () => {
    const { registry, calls, requests } = makeTrackingRegistry();
    const r = await run(lensSkill(), {
      provider: { complete: () => Effect.succeed(resp()) },
      providerRegistry: registry,
      scriptRegistry: prepRegistry(true),
      repository: makeRepo().repo,
    });
    expect(r.success).toBe(true);
    expect(calls.sort()).toEqual(["claude-cli:claude-sonnet-5", "kimi-cli:kimi-k2.6"]);
    const dataReq = requests.find((q) => q.key === "claude-cli:claude-sonnet-5")!.request;
    expect(dataReq.allowedTools).toEqual(["Read", "Grep", "Glob"]);
    const kimiReq = requests.find((q) => q.key === "kimi-cli:kimi-k2.6")!.request;
    expect(kimiReq.allowedTools).toBeUndefined();
  });

  it("merges a registered custom aggregator's fields over the default envelope", async () => {
    const { registry } = makeTrackingRegistry({ "kimi-cli:kimi-k2.6": JSON.stringify({ approved: true, gaps: [] }) });
    const repo = makeRepo();
    const r = await run(lensSkill({ aggregate: "agg" }), {
      provider: { complete: () => Effect.succeed(resp()) },
      providerRegistry: registry,
      scriptRegistry: prepRegistry(false),
      repository: repo.repo,
      fanoutAggregators: {
        agg: (lentes) => ({ approved: false, gaps: [{ lens: "correctness", description: "x" }], lensCount: lentes.length }),
      },
    });
    expect(r.success).toBe(true);
    const out = repo.lastOutputs().review as { approved: boolean; gaps: unknown[]; lensCount: number; lentes: unknown[] };
    expect(out.approved).toBe(false);
    expect(out.gaps).toHaveLength(1);
    expect(out.lensCount).toBe(1);
    expect(out.lentes).toHaveLength(1);
  });

  it("fails the state loudly when the declared aggregator is not registered", async () => {
    const { registry } = makeTrackingRegistry();
    const r = await run(lensSkill({ aggregate: "missing" }), {
      provider: { complete: () => Effect.succeed(resp()) },
      providerRegistry: registry,
      scriptRegistry: prepRegistry(false),
      repository: makeRepo().repo,
    });
    expect(r.success).toBe(false);
    expect(String(r.output)).toContain("aggregator 'missing' is not registered");
  });

  it("loads a lens prompt from agent_prompt_file and templates it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-lens-"));
    const promptPath = join(dir, "lens.md");
    writeFileSync(promptPath, "review dataChanges={{outputs.prep.dataChanges}}");
    const { registry, requests } = makeTrackingRegistry();
    const skill = lensSkill();
    (skill.states.review.lenses![0] as Record<string, unknown>).agent_prompt = undefined;
    (skill.states.review.lenses![0] as Record<string, unknown>).agent_prompt_file = promptPath;
    const r = await run(skill, {
      provider: { complete: () => Effect.succeed(resp()) },
      providerRegistry: registry,
      scriptRegistry: prepRegistry(false),
      repository: makeRepo().repo,
    });
    expect(r.success).toBe(true);
    const prompt = requests[0].request.messages?.[0]?.content ?? "";
    expect(prompt).toBe("review dataChanges=false");
  });
});
