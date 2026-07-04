/**
 * card-to-pr gate_plano E2E (F4 #185, D9): drives the REAL skill.yaml's
 * plano -> gate_plano -> implementacao wiring through runStateMachine.
 *
 * Starts AT `plano` via the resumed-context seam (preparacao's branch-
 * protection/worktree mechanics are already covered by e2e.test.ts) and stubs
 * implementacao's OWN transition to `done` (verify/revisao/pr are also
 * already covered there) — this file exists purely to exercise the
 * architecture-gate transitions/retry/on_exhausted wiring in the real YAML.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { Effect } from "effect";
import { runStateMachine, type StateMachineContext } from "../../engine/state-machine.js";
import { makeScriptRegistry } from "../../script/registry.js";
import { parseSkillStateMachine } from "../../skill/parser.js";
import { registerCardToPrHandlers } from "./index.js";
import type { CardToPrDeps } from "./index.js";
import { makeInMemoryActionLedgerRepository } from "../../persistence/action-ledger-in-memory.js";
import { makeInMemoryPrLinkRepository } from "../../persistence/pr-links-in-memory.js";
import type { CompletionResponse } from "../../provider/types.js";
import type { ProviderRegistry } from "../../provider/registry.js";
import type { Routine } from "../../routine/types.js";
import type { TriggerEvent } from "../../routine/matcher.js";
import type { ExecutionRecord } from "../../persistence/types.js";

const routine: Routine = { id: "r", triggers: [{ type: "task_source" }], pipeline: { skill: "card-to-pr" } } as Routine;

const resp = (content: string): CompletionResponse => ({
  content,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  model: "mock",
  finishReason: "stop",
});

/** Serves `responses` in order, repeating the last one for any extra call. */
const queueResponder = (responses: string[]) => {
  let calls = 0;
  return () => {
    const content = responses[Math.min(calls, responses.length - 1)];
    calls++;
    return Effect.succeed(resp(content));
  };
};

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
  let lastOutputs: Record<string, unknown> = {};
  return {
    repo: {
      save: async (rec: ExecutionRecord) => {
        const smc = (rec.metadata as { stateMachineContext?: { outputs?: Record<string, unknown> } } | undefined)
          ?.stateMachineContext;
        if (smc?.outputs) lastOutputs = smc.outputs;
        store.set(rec.id, rec);
      },
      findById: async (id: string) => store.get(id),
      findByRoutine: async () => [],
      findAll: async () => [],
    },
    lastOutputs: () => lastOutputs,
  };
};

/**
 * Real card-to-pr skill.yaml, with implementacao's OWN transition stubbed to
 * `done` — its normal verify/revisao/pr continuation is already covered by
 * e2e.test.ts and is irrelevant to the plano/gate_plano wiring under test.
 */
const loadSkillStubbed = () => {
  const skill = parseSkillStateMachine(readFileSync(".gates/skills/card-to-pr/skill.yaml", "utf-8"));
  skill.states.implementacao = { ...skill.states.implementacao, transitions: [{ to: "done" }] };
  return skill;
};

const planoOutput = (needsArchGate: boolean): string =>
  JSON.stringify({
    summary: "plan",
    files: ["src/foo.ts"],
    testStrategy: "unit tests",
    dataChanges: [],
    needsArchGate,
    risks: [],
  });

const gateVerdict = (verdict: "aprovado" | "refutado"): string =>
  JSON.stringify({ verdict, corrections: verdict === "refutado" ? ["ajustar X"] : [], escalate: false });

const implementacaoOutput = JSON.stringify({
  filesTouched: ["src/foo.ts"],
  commits: ["abc123 fix: x"],
  notes: "done",
  openDecisions: [],
});

const startContext = (): StateMachineContext => ({
  currentState: "plano",
  outputs: { preparacao: { worktree: { path: "/tmp/or-gate-plano-e2e-fixture" } } },
});

const event: TriggerEvent = {
  type: "task_source",
  payload: {
    source_id: "trello-main",
    task_id: "card1",
    repo: "acme-widgets",
    title: "Fix the bug",
    description: "Card description",
  },
} as TriggerEvent;

const makeDeps = (): CardToPrDeps => ({
  registry: { repos: {} },
  githubToken: "gh_test",
  worktreeBase: "/tmp/or-gate-plano-e2e-worktrees",
  ledger: makeInMemoryActionLedgerRepository(),
  prLinks: makeInMemoryPrLinkRepository(),
  taskSourceFor: () => undefined,
});

describe("card-to-pr gate_plano E2E (#185)", () => {
  it("needsArchGate:false skips gate_plano entirely — zero calls to architecture-judge, straight to implementacao", async () => {
    const skill = loadSkillStubbed();
    const planoCall = queueResponder([planoOutput(false)]);
    const implCall = queueResponder([implementacaoOutput]);
    let claudeCliCalls = 0;
    let archJudgeCalls = 0;
    const providerRegistry: ProviderRegistry = {
      resolve: (name) => {
        const key = String(name);
        if (key === "claude-cli") {
          return {
            complete: () => {
              claudeCliCalls++;
              return claudeCliCalls === 1 ? planoCall() : implCall();
            },
          };
        }
        if (key === "architecture-judge") {
          archJudgeCalls++;
          return { complete: () => Effect.succeed(resp(gateVerdict("aprovado"))) };
        }
        throw new Error(`gate-plano e2e fixture: unexpected provider '${key}'`);
      },
    };

    const r = await Effect.runPromise(
      runStateMachine({
        provider: { complete: () => Effect.succeed(resp("{}")) },
        providerRegistry,
        repository: makeRepo().repo,
      })(skill, routine, event, "exec1", startContext())
    );

    expect(r.success).toBe(true);
    expect(r.logs.join(" ")).toContain("Reached terminal state: done");
    expect(archJudgeCalls).toBe(0);
    expect(claudeCliCalls).toBe(2); // plano + implementacao only
  });

  it("needsArchGate:true + aprovado on the first pass goes straight to implementacao (never a 'spec' state)", async () => {
    const skill = loadSkillStubbed();
    expect(skill.states.spec).toBeUndefined(); // #185 sends 'aprovado' to implementacao — 'spec' (D28) doesn't exist in F4
    const planoCall = queueResponder([planoOutput(true)]);
    const implCall = queueResponder([implementacaoOutput]);
    let claudeCliCalls = 0;
    let archJudgeCalls = 0;
    const repo = makeRepo();
    const providerRegistry: ProviderRegistry = {
      resolve: (name) => {
        const key = String(name);
        if (key === "claude-cli") {
          return {
            complete: () => {
              claudeCliCalls++;
              return claudeCliCalls === 1 ? planoCall() : implCall();
            },
          };
        }
        if (key === "architecture-judge") {
          archJudgeCalls++;
          return { complete: () => Effect.succeed(resp(gateVerdict("aprovado"))) };
        }
        throw new Error(`gate-plano e2e fixture: unexpected provider '${key}'`);
      },
    };

    const r = await Effect.runPromise(
      runStateMachine({
        provider: { complete: () => Effect.succeed(resp("{}")) },
        providerRegistry,
        repository: repo.repo,
      })(skill, routine, event, "exec1", startContext())
    );

    expect(r.success).toBe(true);
    expect(archJudgeCalls).toBe(1);
    expect(claudeCliCalls).toBe(2); // plano + implementacao
    expect((repo.lastOutputs().gate_plano as { verdict: string }).verdict).toBe("aprovado");
  });

  it("refutado once (escalate:false) sends the plan back to plano, execution continues (no fail)", async () => {
    const skill = loadSkillStubbed();
    const planoCall = queueResponder([planoOutput(true), planoOutput(true)]);
    const implCall = queueResponder([implementacaoOutput]);
    let claudeCliCalls = 0;
    let archJudgeCalls = 0;
    const providerRegistry: ProviderRegistry = {
      resolve: (name) => {
        const key = String(name);
        if (key === "claude-cli") {
          return {
            complete: () => {
              claudeCliCalls++;
              return claudeCliCalls <= 2 ? planoCall() : implCall();
            },
          };
        }
        if (key === "architecture-judge") {
          archJudgeCalls++;
          return { complete: () => Effect.succeed(resp(gateVerdict(archJudgeCalls === 1 ? "refutado" : "aprovado"))) };
        }
        throw new Error(`gate-plano e2e fixture: unexpected provider '${key}'`);
      },
    };

    const r = await Effect.runPromise(
      runStateMachine({
        provider: { complete: () => Effect.succeed(resp("{}")) },
        providerRegistry,
        repository: makeRepo().repo,
      })(skill, routine, event, "exec1", startContext())
    );

    expect(r.success).toBe(true);
    expect(r.logs.join(" ")).toContain("Reached terminal state: done");
    expect(archJudgeCalls).toBe(2); // refuted once, approved on retry
    expect(claudeCliCalls).toBe(3); // plano, plano (retry), implementacao
  });

  it("refutado twice on the SAME edge exhausts to bloqueado (never fails the execution) with outputs.gate_plano.exhausted:true, and bloqueado resolves blockReason 'plano-refutado-2x'", async () => {
    const skill = loadSkillStubbed();
    const planoCall = queueResponder([planoOutput(true), planoOutput(true)]);
    let claudeCliCalls = 0;
    let archJudgeCalls = 0;
    const scriptRegistry = makeScriptRegistry();
    registerCardToPrHandlers(scriptRegistry, makeDeps());
    const repo = makeRepo();
    const providerRegistry: ProviderRegistry = {
      resolve: (name) => {
        const key = String(name);
        if (key === "claude-cli") {
          claudeCliCalls++;
          return { complete: planoCall };
        }
        if (key === "architecture-judge") {
          archJudgeCalls++;
          return { complete: () => Effect.succeed(resp(gateVerdict("refutado"))) };
        }
        throw new Error(`gate-plano e2e fixture: unexpected provider '${key}'`);
      },
    };

    const r = await Effect.runPromise(
      runStateMachine({
        provider: { complete: () => Effect.succeed(resp("{}")) },
        providerRegistry,
        scriptRegistry,
        repository: repo.repo,
      })(skill, routine, event, "exec1", startContext())
    );

    expect(r.success).toBe(true); // escaped to bloqueado -> done, never a hard failure
    expect(r.logs.join(" ")).toContain("Reached terminal state: done");
    expect(archJudgeCalls).toBe(2); // initial + 1 retry, then on_exhausted fires — no 3rd call
    expect(claudeCliCalls).toBe(2); // plano called before each gate_plano pass, never implementacao

    const gatePlanoOut = repo.lastOutputs().gate_plano as { verdict: string; exhausted?: boolean };
    expect(gatePlanoOut.exhausted).toBe(true);
    expect(gatePlanoOut.verdict).toBe("refutado");
    const bloqueadoOut = repo.lastOutputs().bloqueado as { blocked: boolean; blockReason: string };
    expect(bloqueadoOut).toEqual({ blocked: true, blockReason: "plano-refutado-2x" });
  });

  it("a transition WITHOUT on_exhausted still fails outright on exhaustion (regression: F1 behavior preserved elsewhere)", async () => {
    // Sanity check that #185's on_exhausted escape is additive: the verify->
    // implementacao retry edge (no on_exhausted) still fails hard when it
    // exhausts — already covered generically by state-machine-f4.test.ts;
    // this just confirms gate_plano's OWN edge is the one that gained the
    // escape, not every max_retries edge in this skill.
    const skill = parseSkillStateMachine(readFileSync(".gates/skills/card-to-pr/skill.yaml", "utf-8"));
    const revisaoToRefutacao = skill.states.revisao.transitions?.find((t) => t.to === "refutacao");
    expect(revisaoToRefutacao?.on_exhausted).toBe("bloqueado"); // #153's edge already had one
    const gatePlanoToPlano = skill.states.gate_plano.transitions?.find((t) => t.to === "plano");
    expect(gatePlanoToPlano?.max_retries).toBe(1);
    expect(gatePlanoToPlano?.on_exhausted).toBe("bloqueado");
  });
});
