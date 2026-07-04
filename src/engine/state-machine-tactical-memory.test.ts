/**
 * F5 #166 — tactical memory wired into the runner: learnings persistence across
 * runs, repo-learnings reinjection into a phase prompt, and merged-card
 * precedents on the plan phase. Also asserts the retro-compatible no-op path
 * (no repo / no deps → identical to current behavior).
 */
import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { runStateMachine, type StateMachineConfig } from "./state-machine.js";
import { makeInMemoryRepoLearningRepository } from "../persistence/repo-learnings-in-memory.js";
import type { SkillStateMachine } from "../skill/schema.js";
import type { CompletionRequest, CompletionResponse } from "../provider/types.js";
import type { Routine } from "../routine/types.js";
import type { TriggerEvent } from "../routine/matcher.js";
import type { ExecutionRecord, RepoLearningRepository } from "../persistence/types.js";

const routine: Routine = { id: "r", triggers: [{ type: "api" }], pipeline: { skill: "t" } } as Routine;
const event = (payload: Record<string, unknown>): TriggerEvent => ({ type: "api", payload } as TriggerEvent);

const resp = (content: string): CompletionResponse => ({
  content,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  model: "mock",
  finishReason: "stop",
});

const makeRepo = () => {
  const store = new Map<string, ExecutionRecord>();
  return {
    save: async (rec: ExecutionRecord) => {
      store.set(rec.id, { ...store.get(rec.id), ...rec });
    },
    findById: async (id: string) => store.get(id),
    findByRoutine: async () => [],
    findByTask: async () => [],
    findAll: async () => [],
  };
};

/** Provider that records each phase's user prompt and emits the given learnings. */
const recordingProvider = (learnings: unknown) => {
  const prompts: string[] = [];
  return {
    prompts,
    provider: {
      complete: (req: CompletionRequest) => {
        prompts.push(String(req.messages.find((m) => m.role === "user")?.content ?? ""));
        return Effect.succeed(resp(JSON.stringify({ ok: true, learnings })));
      },
    },
  };
};

const singlePhase: SkillStateMachine = {
  id: "t",
  initial_state: "plan",
  states: {
    plan: { agent_prompt: "Plan: {{inputs.title}}", transitions: [{ to: "done" }] },
    done: { terminal: true },
  },
} as SkillStateMachine;

const run = (config: StateMachineConfig, payload: Record<string, unknown>, execId = "exec1") =>
  Effect.runPromise(runStateMachine(config)(singlePhase, routine, event(payload), execId));

describe("F5 #166 — learnings persistence + reinjection", () => {
  it("two runs of the same repo dedupe an identical learning to freq 2, and the 2nd prompt carries the reinjected block", async () => {
    const repoLearnings = makeInMemoryRepoLearningRepository();
    const rec = recordingProvider([{ fato: "Uses ESM imports with .js", evidencia: "tsconfig.json", escopo: "convenção" }]);
    const config: StateMachineConfig = { provider: rec.provider, repository: makeRepo(), repoLearnings };

    const r1 = await run(config, { repo: "org/repo", title: "First card" }, "exec1");
    const r2 = await run(config, { repo: "org/repo", title: "Second card" }, "exec2");
    expect(r1.success && r2.success).toBe(true);

    const top = await repoLearnings.findTopByRepo("org/repo", 5);
    expect(top).toHaveLength(1);
    expect(top[0].freq).toBe(2); // criterion 1: freq 1 → 2, no duplicate row

    // criterion 3: the FIRST run had no prior learnings (no block); the SECOND
    // run reinjects run 1's fact as delimited low-confidence data.
    expect(rec.prompts[0]).not.toContain("<repo_learnings");
    expect(rec.prompts[1]).toContain('<repo_learnings dados_de_baixa_confianca="true">');
    expect(rec.prompts[1]).toContain("Uses ESM imports with .js");
  });

  it("rejects a phase whose output declares more than 3 learnings", async () => {
    const repoLearnings = makeInMemoryRepoLearningRepository();
    const rec = recordingProvider([1, 2, 3, 4].map((n) => ({ fato: `fact ${n}` })));
    const r = await run({ provider: rec.provider, repository: makeRepo(), repoLearnings }, { repo: "org/repo", title: "x" });
    expect(r.success).toBe(false);
    expect(await repoLearnings.findTopByRepo("org/repo", 5)).toHaveLength(0);
  });

  it("injects up to 2 merged similar cards into the plan phase prompt", async () => {
    const rec = recordingProvider([]);
    const similarCards = async () => [
      { title: "Add rate limiting", prUrl: "https://github.com/org/repo/pull/12", summary: "token bucket" },
      { title: "Cache warmup", prUrl: "https://github.com/org/repo/pull/8" },
    ];
    await run({ provider: rec.provider, repository: makeRepo(), similarCards }, { repo: "org/repo", title: "Rate limit reset" });
    expect(rec.prompts[0]).toContain('<precedentes_cards_similares dados_de_baixa_confianca="true">');
    expect(rec.prompts[0]).toContain("Add rate limiting — PR: https://github.com/org/repo/pull/12");
    expect(rec.prompts[0]).toContain("Cache warmup");
  });

  it("no repo history → the plan prompt has no precedent block and the run still succeeds", async () => {
    const rec = recordingProvider([]);
    const r = await run({ provider: rec.provider, repository: makeRepo(), similarCards: async () => [] }, { repo: "org/repo", title: "x" });
    expect(r.success).toBe(true);
    expect(rec.prompts[0]).not.toContain("precedentes_cards_similares");
  });

  it("no repo in inputs → no injection and no persistence (identical to pre-feature behavior)", async () => {
    let upserts = 0;
    const spy: RepoLearningRepository = {
      upsertByFato: async () => { upserts++; },
      findTopByRepo: async () => { throw new Error("must not read without a repo"); },
      findPromotable: async () => [],
      markPromoted: async () => {},
    };
    const rec = recordingProvider([{ fato: "would-be learning" }]);
    const r = await run({ provider: rec.provider, repository: makeRepo(), repoLearnings: spy }, { title: "no repo here" });
    expect(r.success).toBe(true);
    expect(upserts).toBe(0);
    expect(rec.prompts[0]).not.toContain("<repo_learnings");
  });

  it("with no tactical-memory deps wired the prompt is exactly the rendered template", async () => {
    const rec = recordingProvider([{ fato: "ignored" }]);
    const r = await run({ provider: rec.provider, repository: makeRepo() }, { repo: "org/repo", title: "Hello" });
    expect(r.success).toBe(true);
    expect(rec.prompts[0]).toBe("Plan: Hello");
  });
});
